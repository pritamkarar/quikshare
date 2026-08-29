// tests/unit/resume.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey, makeNonce, seal } from '../../client/crypto.js';
import { CHUNK_SIZE, Sender } from '../../client/transfer/sender.js';
import { Receiver } from '../../client/transfer/receiver.js';
import { TransportSwapGate } from '../../client/transport/upgrade.js';
import { FrameType, decodeFrame, encodeControl, encodeFrame, encodeHeader } from '../../client/protocol.js';
import { dataAad } from '../../client/transfer/data-aad.js';
import type { Transport } from '../../client/transport/types.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/**
 * Real-time polling, not a fixed microtask-flush count: Receiver's control
 * and data frames both go through a real crypto.subtle.decrypt, which Node
 * dispatches to the libuv threadpool — see tests/unit/receiver.test.ts's own
 * doc comment on why a tick count that works in isolation still isn't
 * reliable under full-suite load.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeSender(events: Partial<{ onProgress: () => void; onFileDone: () => void }> = {}) {
  const [a, b] = createMemoryPair();
  const frames: Uint8Array[] = [];
  b.onMessage((f) => frames.push(f));
  const sender = new Sender({
    transport: a,
    key: await importKey(generateRawKey()),
    peerId: 'a',
    noncePrefix: generateNoncePrefix(),
    initialSeq: 0n,
    initialFileId: 1,
    gate: new TransportSwapGate(),
    events: { onProgress: vi.fn(), onFileDone: vi.fn(), ...events },
  });
  return { sender, frames };
}

async function setupReceiver() {
  const [a, b] = createMemoryPair();
  const key = await importKey(generateRawKey());
  const prefix = generateNoncePrefix();
  const events = {
    onOffer: vi.fn(), onProgress: vi.fn(), onFileComplete: vi.fn(),
    onText: vi.fn(), onError: vi.fn(),
  };
  const receiver = new Receiver({
    transport: b, key, peerId: 'b', remoteNoncePrefix: prefix, events,
  });
  receiver.start();
  return { sendSide: a as Transport, receiver, key, prefix, events };
}

/** Control frames: the AAD is just the header, exactly as sender.ts's #sendControl seals it. */
async function sealedFrame(
  key: CryptoKey, prefix: Uint8Array, seq: bigint, type: typeof FrameType.Control | typeof FrameType.Data,
  fileId: number, plaintext: Uint8Array,
): Promise<Uint8Array> {
  const header = encodeHeader(type, fileId, seq);
  const sealed = await seal(key, makeNonce('a', prefix, seq), plaintext, header);
  return encodeFrame(type, fileId, seq, sealed);
}

/**
 * Data frames: fix-round-2 binds the byte offset this chunk's plaintext
 * starts at into the AAD (data-aad.ts), exactly as sender.ts's
 * #sendOneFile seals it. A test that wants to simulate a chunk claiming to
 * be at the wrong offset (a dropped earlier chunk, a stale resume) passes
 * that wrong `offset` explicitly — the seal below still succeeds (sealing
 * never checks truth), but the receiver's open() at its own real
 * bytesReceived then fails, which is exactly the property under test.
 */
async function sealedData(
  key: CryptoKey, prefix: Uint8Array, seq: bigint, fileId: number, plaintext: Uint8Array, offset: number,
): Promise<Uint8Array> {
  const header = encodeHeader(FrameType.Data, fileId, seq);
  const sealed = await seal(key, makeNonce('a', prefix, seq), plaintext, dataAad(header, offset));
  return encodeFrame(FrameType.Data, fileId, seq, sealed);
}

describe('resume', () => {
  it('skips bytes the receiver already has', async () => {
    const { sender, frames } = await makeSender();

    const bytes = new Uint8Array(CHUNK_SIZE * 4);
    const meta = { id: 1, name: 'x.bin', size: bytes.length, type: '' };
    await sender.resumeFile(new File([bytes], 'x.bin'), meta, CHUNK_SIZE * 3);
    await flush();

    const data = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data);
    expect(data).toHaveLength(1);
  });

  it('resends nothing when the receiver already has the whole file', async () => {
    const { sender, frames } = await makeSender();

    const bytes = new Uint8Array(1000);
    const meta = { id: 1, name: 'x.bin', size: bytes.length, type: '' };
    await sender.resumeFile(new File([bytes], 'x.bin'), meta, bytes.length);
    await flush();

    expect(frames.map(decodeFrame).filter((f) => f.type === FrameType.Data)).toHaveLength(0);
  });

  it('never rewinds the nonce counter when resuming', async () => {
    const { sender, frames } = await makeSender();

    const bytes = new Uint8Array(CHUNK_SIZE * 2);
    await sender.sendFiles([new File([bytes], 'a.bin')]);
    await flush();
    const before = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).map((f) => f.seq);

    await sender.resumeFile(new File([bytes], 'a.bin'), { id: 1, name: 'a.bin', size: bytes.length, type: '' }, 0);
    await flush();
    const all = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).map((f) => f.seq);

    expect(new Set(all.map(String)).size).toBe(all.length);
    expect(all.slice(0, before.length)).toEqual(before);
  });

  // --- Ruling H: resumePoints() reflects real, in-flight progress -------

  describe('Receiver.resumePoints with real progress', () => {
    it('reflects bytesReceived for a file that is genuinely partway through', async () => {
      const { sendSide, receiver, key, prefix, events } = await setupReceiver();
      // Asserted here rather than on its own: an empty list from a receiver
      // that has never been offered anything is also what a stub returning
      // [] would produce. Paired with the real point below, on the same
      // receiver, it discriminates.
      expect(await receiver.resumePoints()).toEqual([]);
      const meta = { id: 7, name: 'y.bin', size: CHUNK_SIZE * 2, type: '' };
      const offer = encodeControl({ t: 'offer-batch', batchId: 'b1', files: [meta] });
      sendSide.send(await sealedFrame(key, prefix, 0n, FrameType.Control, 0, offer));
      const chunk = new Uint8Array(CHUNK_SIZE);
      sendSide.send(await sealedData(key, prefix, 1n, meta.id, chunk, 0));
      await waitFor(() => events.onProgress.mock.calls.length > 0);

      expect(await receiver.resumePoints()).toEqual([{ fileId: 7, bytesReceived: CHUNK_SIZE }]);
    });

    /*
     * The other half of what a resync has to re-send. A `file-ack` is a
     * control frame like any other and goes down with the transport that
     * was carrying it — and by the time a file is complete there is nothing
     * left in #incoming to produce a resume point for it, so re-sending the
     * acknowledgement is the only thing that can finish the peer's row.
     */
    it('remembers a completed file so its acknowledgement can be sent again', async () => {
      const { sendSide, receiver, key, prefix, events } = await setupReceiver();
      expect(await receiver.completedFiles()).toEqual([]);

      const meta = { id: 5, name: 'w.bin', size: 4, type: '' };
      const offer = encodeControl({ t: 'offer-batch', batchId: 'b1', files: [meta] });
      sendSide.send(await sealedFrame(key, prefix, 0n, FrameType.Control, 0, offer));
      sendSide.send(await sealedData(key, prefix, 1n, meta.id, new Uint8Array(4), 0));
      const end = encodeControl({ t: 'file-end', fileId: meta.id });
      sendSide.send(await sealedFrame(key, prefix, 2n, FrameType.Control, meta.id, end));
      await waitFor(() => events.onFileComplete.mock.calls.length > 0);

      expect(await receiver.completedFiles()).toEqual([5]);
      // And it is genuinely finished, not merely remembered: nothing is
      // still waiting on more bytes for it.
      expect(await receiver.resumePoints()).toEqual([]);
    });

    it('excludes a file that has already failed its integrity check', async () => {
      const { sendSide, receiver, key, prefix, events } = await setupReceiver();
      const meta = { id: 3, name: 'z.bin', size: CHUNK_SIZE * 2, type: '' };
      const offer = encodeControl({ t: 'offer-batch', batchId: 'b1', files: [meta] });
      sendSide.send(await sealedFrame(key, prefix, 0n, FrameType.Control, 0, offer));
      const chunk = new Uint8Array(CHUNK_SIZE);
      const dataFrame = await sealedData(key, prefix, 1n, meta.id, chunk, 0);
      sendSide.send(dataFrame);
      // The exact same frame again: a genuine chunk verifies fine wherever it
      // lands, so replay is only caught by the strictly-increasing seq check
      // (frame.seq <= entry.lastSeq) — which fails the whole file rather
      // than merely dropping the repeat. Ruling H's resumePoints() must not
      // offer a resume point for a file the receiver has already given up
      // on this way.
      sendSide.send(dataFrame);
      await waitFor(() => events.onError.mock.calls.length > 0);

      expect(await receiver.resumePoints()).toEqual([]);
    });

    it('reports one entry per file, independently, for a batch of several', async () => {
      const { sendSide, receiver, key, prefix, events } = await setupReceiver();
      const metaA = { id: 1, name: 'a.bin', size: CHUNK_SIZE * 2, type: '' };
      const metaB = { id: 2, name: 'b.bin', size: CHUNK_SIZE * 2, type: '' };
      const offer = encodeControl({ t: 'offer-batch', batchId: 'b1', files: [metaA, metaB] });
      sendSide.send(await sealedFrame(key, prefix, 0n, FrameType.Control, 0, offer));
      sendSide.send(await sealedData(key, prefix, 1n, metaA.id, new Uint8Array(CHUNK_SIZE), 0));
      await waitFor(() => events.onProgress.mock.calls.length > 0);

      const points = await receiver.resumePoints();
      expect(points).toContainEqual({ fileId: 1, bytesReceived: CHUNK_SIZE });
      expect(points).toContainEqual({ fileId: 2, bytesReceived: 0 });
    });
  });

  // --- fix-round-3 (Important): resumePoints() must not publish a stale ---
  // --- offset while frames from before a disconnect are still queued -----

  describe('resumePoints() is not stale mid-burst (fix-round-3)', () => {
    it('reflects the FINAL byte count, not a snapshot taken while a slow sink is still catching up', async () => {
      const [a, b] = createMemoryPair();
      const key = await importKey(generateRawKey());
      const prefix = generateNoncePrefix();
      let written = 0;
      // A slow sink, standing in for the coordinator's reproduction (a real
      // streaming sink writing to disk): every write takes real, if short,
      // wall-clock time. #chain serializes writes, so while chunk 1 is still
      // "on disk", chunks 2-8 have already arrived and are queued behind it,
      // not yet reflected in entry.bytesReceived.
      const slowSink = {
        write: async (chunk: Uint8Array) => {
          await new Promise((resolve) => { setTimeout(resolve, 15); });
          written += chunk.length;
        },
        close: async () => undefined,
        abort: async () => undefined,
        assertWithinCap: () => undefined,
      };
      const receiver = new Receiver({
        transport: b, key, peerId: 'b', remoteNoncePrefix: prefix, createSink: () => slowSink,
        events: {
          onOffer: vi.fn(), onProgress: vi.fn(), onFileComplete: vi.fn(), onText: vi.fn(), onError: vi.fn(),
        },
      });
      receiver.start();

      const TOTAL_CHUNKS = 8;
      const meta = { id: 1, name: 'x.bin', size: CHUNK_SIZE * TOTAL_CHUNKS, type: '' };
      a.send(await sealedFrame(key, prefix, 0n, FrameType.Control, 0, encodeControl({
        t: 'offer-batch', batchId: 'b1', files: [meta],
      })));
      const frames = await Promise.all(Array.from({ length: TOTAL_CHUNKS }, (_, i) => (
        sealedData(key, prefix, BigInt(i + 1), meta.id, new Uint8Array(CHUNK_SIZE), i * CHUNK_SIZE)
      )));
      for (const frame of frames) a.send(frame);
      // Long enough for every frame to actually be *delivered* (the memory
      // transport's queueMicrotask, plus real crypto.subtle.decrypt) — but
      // far short of 8 * 15ms, so several writes are still queued when
      // resumePoints() below is called, exactly matching the coordinator's
      // "65507 published versus 524056 actual, stale by seven chunks".
      await waitFor(() => written > 0);

      const points = await receiver.resumePoints();

      expect(points).toEqual([{ fileId: meta.id, bytesReceived: CHUNK_SIZE * TOTAL_CHUNKS }]);
      expect(written).toBe(CHUNK_SIZE * TOTAL_CHUNKS);
    });
  });

  // --- Ruling F: fromByte is untrusted input passed to Sender.resumeFile -

  describe('Sender.resumeFile rejects a hostile fromByte (Ruling F)', () => {
    const meta = { id: 1, name: 'x.bin', size: 1000, type: '' };

    it.each([
      ['negative', -1],
      ['negative and large', -999_999],
      ['non-integer', 12.5],
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['past the end of the file', 1_000_000],
    ])('throws instead of acting on a %s fromByte', async (_label, fromByte) => {
      const { sender, frames } = await makeSender();
      const file = new File([new Uint8Array(1000)], 'x.bin');

      await expect(sender.resumeFile(file, meta, fromByte)).rejects.toThrow();
      await flush();

      // The decisive check: a negative fromByte must not have gone on to
      // call file.slice(negative, …) (which counts from the END of the
      // file) and transmit wrong-but-plausible-looking bytes. Nothing at
      // all should have been sent.
      expect(frames).toHaveLength(0);
    });

    it('does not report onFileDone for a rejected fromByte', async () => {
      const onFileDone = vi.fn();
      const { sender } = await makeSender({ onFileDone });
      const file = new File([new Uint8Array(1000)], 'x.bin');

      await expect(sender.resumeFile(file, meta, -1)).rejects.toThrow();
      expect(onFileDone).not.toHaveBeenCalled();
    });

    it('accepts fromByte exactly at file.size (the legitimate "nothing left" case)', async () => {
      const { sender, frames } = await makeSender();
      const file = new File([new Uint8Array(1000)], 'x.bin');
      await sender.resumeFile(file, meta, 1000);
      await flush();
      expect(frames.map(decodeFrame).filter((f) => f.type === FrameType.Data)).toHaveLength(0);
    });

    it('accepts fromByte of 0 (a legitimate full resend)', async () => {
      const { sender, frames } = await makeSender();
      const file = new File([new Uint8Array(1000)], 'x.bin');
      await sender.resumeFile(file, meta, 0);
      await flush();
      expect(frames.map(decodeFrame).filter((f) => f.type === FrameType.Data)).toHaveLength(1);
    });
  });

  // --- Ruling G: #sendControl must be awaited in resumeFile --------------

  describe('resumeFile awaits its control frames (Ruling G)', () => {
    /** Synchronous send, so "was it sent yet" is checkable at any instant. */
    function syncTransport(): { transport: Transport; sent: Uint8Array[] } {
      const sent: Uint8Array[] = [];
      const transport: Transport = {
        kind: 'relay',
        bufferedAmount: 0,
        send: (frame) => { sent.push(frame); },
        onMessage: () => undefined,
        onDrain: () => undefined,
        onClose: () => undefined,
        close: () => undefined,
      };
      return { transport, sent };
    }

    it('has already put file-end on the wire before onFileDone fires (fromByte >= file.size)', async () => {
      const { transport, sent } = syncTransport();
      let controlFrameSentWhenDone = false;
      const sender = new Sender({
        transport, key: await importKey(generateRawKey()), peerId: 'a', noncePrefix: generateNoncePrefix(),
        initialSeq: 0n, initialFileId: 1, gate: new TransportSwapGate(),
        events: {
          onProgress: vi.fn(),
          onFileDone: () => {
            controlFrameSentWhenDone = sent.some((f) => decodeFrame(f).type === FrameType.Control);
          },
        },
      });
      const meta = { id: 1, name: 'x.bin', size: 10, type: '' };
      await sender.resumeFile(new File([new Uint8Array(10)], 'x.bin'), meta, 10);
      // onFileDone now waits on the peer's `file-ack` rather than firing at
      // the end of the send, so the moment being probed has to be provoked.
      // The property under test is unchanged: if #sendControl were not
      // awaited, resumeFile would resolve while the frame was still being
      // sealed and `sent` would still be empty here.
      sender.confirmDelivered(1);
      expect(controlFrameSentWhenDone).toBe(true);
    });

    it('has already put file-end on the wire before onFileDone fires (fromByte < file.size)', async () => {
      const { transport, sent } = syncTransport();
      let controlFrameSentWhenDone = false;
      const sender = new Sender({
        transport, key: await importKey(generateRawKey()), peerId: 'a', noncePrefix: generateNoncePrefix(),
        initialSeq: 0n, initialFileId: 1, gate: new TransportSwapGate(),
        events: {
          onProgress: vi.fn(),
          onFileDone: () => {
            const controls = sent.map(decodeFrame).filter((f) => f.type === FrameType.Control);
            controlFrameSentWhenDone = controls.length > 0;
          },
        },
      });
      const meta = { id: 1, name: 'x.bin', size: CHUNK_SIZE * 2, type: '' };
      await sender.resumeFile(new File([new Uint8Array(CHUNK_SIZE * 2)], 'x.bin'), meta, CHUNK_SIZE);
      // onFileDone now waits on the peer's `file-ack` rather than firing at
      // the end of the send, so the moment being probed has to be provoked.
      // The property under test is unchanged: if #sendControl were not
      // awaited, resumeFile would resolve while the frame was still being
      // sealed and `sent` would still be empty here.
      sender.confirmDelivered(1);
      expect(controlFrameSentWhenDone).toBe(true);
    });

    it('propagates a failed file-end send as a rejection rather than resolving anyway', async () => {
      const failingTransport: Transport = {
        kind: 'relay',
        bufferedAmount: 0,
        send: () => { throw new Error('socket died'); },
        onMessage: () => undefined,
        onDrain: () => undefined,
        onClose: () => undefined,
        close: () => undefined,
      };
      const onFileDone = vi.fn();
      const sender = new Sender({
        transport: failingTransport, key: await importKey(generateRawKey()), peerId: 'a',
        noncePrefix: generateNoncePrefix(), initialSeq: 0n, initialFileId: 1, gate: new TransportSwapGate(),
        events: { onProgress: vi.fn(), onFileDone },
      });
      const meta = { id: 1, name: 'x.bin', size: 10, type: '' };
      await expect(sender.resumeFile(new File([new Uint8Array(10)], 'x.bin'), meta, 10)).rejects.toThrow('socket died');
      expect(onFileDone).not.toHaveBeenCalled();
    });
  });

  // --- Ruling I: Sender.sendResumeFrom exists for Session to call --------

  it('Sender.sendResumeFrom seals a resume-from control message', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendResumeFrom(5, 1234);
    await flush();
    const [frame] = frames;
    expect(frame).toBeDefined();
    const decoded = decodeFrame(frame!);
    expect(decoded.type).toBe(FrameType.Control);
  });

  // --- CRITICAL fix-round-2: fix-round-1's `sawGap` (seq-inference) approach
  // --- had two false negatives — a genuine gap could still go completely
  // --- undetected, not merely "detected but only after the fact" as
  // --- fix-round-1's report incorrectly described it. The fix replaces
  // --- inference with proof: the byte offset a chunk claims to start at is
  // --- now bound into its own AEAD additional data (data-aad.ts), so a
  // --- chunk that lands at the wrong offset simply cannot open, full stop.
  // --- `sawGap` itself is deleted — there is no flag left to reset, which
  // --- is what makes an unlimited number of repeat resumes safe (see the
  // --- "resumed twice" integration test in reconnect-resume.test.ts).

  describe('a genuine gap must fail immediately, never silently corrupt (fix-round-2)', () => {
    it('Hole 1: a dropped FIRST chunk is caught on arrival, not silently accepted as chunk one', async () => {
      const { sendSide, receiver, key, prefix, events } = await setupReceiver();
      const meta = { id: 1, name: 'x.bin', size: CHUNK_SIZE * 4, type: '' };
      const chunk = (n: number): Uint8Array => new Uint8Array(CHUNK_SIZE).fill(n);

      sendSide.send(await sealedFrame(key, prefix, 0n, FrameType.Control, 0, encodeControl({
        t: 'offer-batch', batchId: 'b1', files: [meta],
      })));
      // Chunk 1 (seq 1n, the file's true first chunk, real offset 0) is
      // genuinely dropped — never arrives. Chunk 2 (seq 2n, real offset
      // CHUNK_SIZE) arrives next. Under fix-round-1's `sawGap`, this exact
      // stream went undetected: entry.lastSeq was still NO_SEQ_YET when
      // chunk 2 arrived, so the gap check's own guard
      // (`entry.lastSeq !== NO_SEQ_YET`) was false and no gap was ever
      // recorded — chunk 2 became "chunk one" and 3/4 looked consecutive
      // after it.
      sendSide.send(await sealedData(key, prefix, 2n, meta.id, chunk(2), CHUNK_SIZE));
      sendSide.send(await sealedData(key, prefix, 3n, meta.id, chunk(3), CHUNK_SIZE * 2));
      sendSide.send(await sealedData(key, prefix, 4n, meta.id, chunk(4), CHUNK_SIZE * 3));
      await waitFor(() => events.onError.mock.calls.length > 0);

      // The fix: chunk 2 arrives while entry.bytesReceived is still 0 (no
      // earlier chunk was ever accepted), so the receiver opens it against
      // AAD offset 0 — but it was sealed for its true offset, CHUNK_SIZE.
      // AAD mismatch, decryption fails right there. No resume is needed to
      // even discover this: the file is already failed before
      // resumePoints() is ever consulted, and stays failed — chunks 3 and 4
      // never even get a chance to look "consecutive".
      expect(await receiver.resumePoints()).toEqual([]);
      expect(events.onFileComplete).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: meta.id, message: expect.stringContaining('integrity check') }),
      );
    });

    it('Hole 2: a replayed offer-batch mid-transfer is rejected, not treated as a fresh reset', async () => {
      const { sendSide, receiver, key, prefix, events } = await setupReceiver();
      const meta = { id: 1, name: 'x.bin', size: CHUNK_SIZE * 2, type: '' };
      const chunk = (n: number): Uint8Array => new Uint8Array(CHUNK_SIZE).fill(n);

      const offerFrame = await sealedFrame(key, prefix, 0n, FrameType.Control, 0, encodeControl({
        t: 'offer-batch', batchId: 'b1', files: [meta],
      }));
      sendSide.send(offerFrame);
      sendSide.send(await sealedData(key, prefix, 1n, meta.id, chunk(1), 0));
      await waitFor(() => events.onProgress.mock.calls.length > 0);
      expect(await receiver.resumePoints()).toEqual([{ fileId: meta.id, bytesReceived: CHUNK_SIZE }]);

      // A relay (or an attacker) replays the exact same offer-batch frame
      // verbatim, mid-transfer. It passes its own AEAD check trivially — a
      // byte-for-byte copy of a frame that was already genuinely sealed —
      // and fix-round-1 added no replay/reorder protection for control
      // frames at all, so #handleControl's offer-batch case would reset
      // this file's bookkeeping to bytesReceived: 0, orphaning its already-
      // open sink and corrupting whatever resume happens next.
      sendSide.send(offerFrame);
      await waitFor(() => events.onError.mock.calls.length > 0);

      // The fix: #lastControlSeq already advanced past this frame's seq
      // (0n) when it was first accepted, so the replay is rejected before
      // it is even decrypted — this file's bookkeeping is untouched.
      expect(await receiver.resumePoints()).toEqual([{ fileId: meta.id, bytesReceived: CHUNK_SIZE }]);
    });

    it('a genuine gap in the MIDDLE of a transfer still fails immediately too (not just at the very start)', async () => {
      const { sendSide, receiver, key, prefix, events } = await setupReceiver();
      const meta = { id: 1, name: 'x.bin', size: CHUNK_SIZE * 4, type: '' };
      const chunk = (n: number): Uint8Array => new Uint8Array(CHUNK_SIZE).fill(n);

      sendSide.send(await sealedFrame(key, prefix, 0n, FrameType.Control, 0, encodeControl({
        t: 'offer-batch', batchId: 'b1', files: [meta],
      })));
      sendSide.send(await sealedData(key, prefix, 1n, meta.id, chunk(1), 0));
      // Chunk "2" (seq 2n, real offset CHUNK_SIZE) never arrives. Chunk 3
      // (seq 3n) arrives sealed for its own true offset, 2 * CHUNK_SIZE —
      // but the receiver, having only ever accepted chunk 1, opens it
      // against AAD offset CHUNK_SIZE. Mismatch, fails immediately.
      sendSide.send(await sealedData(key, prefix, 3n, meta.id, chunk(3), CHUNK_SIZE * 2));
      await waitFor(() => events.onError.mock.calls.length > 0);

      expect(await receiver.resumePoints()).toEqual([]);
      expect(events.onFileComplete).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey, makeNonce, open } from '../../client/crypto.js';
import { FrameType, decodeControl, decodeFrame } from '../../client/protocol.js';
import { MAX_TEXT_CHARS, type ControlMessage } from '../../shared/messages.js';
import {
  CHUNK_SIZE, HIGH_WATER_BYTES, MAX_FRAME_BYTES, Sender, TEXT_TOO_LONG, type SenderEvents,
} from '../../client/transfer/sender.js';
import { Receiver } from '../../client/transfer/receiver.js';
import { TransportSwapGate } from '../../client/transport/upgrade.js';
import { dataAad } from '../../client/transfer/data-aad.js';

async function makeSender(): Promise<{ sender: Sender; frames: Uint8Array[]; key: CryptoKey; prefix: Uint8Array }> {
  const [a, b] = createMemoryPair();
  const frames: Uint8Array[] = [];
  b.onMessage((f) => frames.push(f));
  const key = await importKey(generateRawKey());
  const prefix = generateNoncePrefix();
  const sender = new Sender({
    transport: a, key, peerId: 'a', noncePrefix: prefix, initialSeq: 0n, initialFileId: 1, gate: new TransportSwapGate(),
    events: { onProgress: vi.fn(), onFileDone: vi.fn() },
  });
  return { sender, frames, key, prefix };
}

/** Rejects with `message` if `p` has not settled within `ms` — turns a
 * would-be hang into a fast, diagnosable test failure. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

/**
 * A real macrotask wait, not just drained microtasks: work released past the
 * gate runs through a real crypto.subtle.encrypt call, which a microtask-only
 * flush() can outrun — asserting "nothing sent yet" right after a
 * microtask-only flush would pass vacuously whether or not the gate is
 * actually blocking anything, simply because the seal() hadn't resolved yet
 * either way. Matches the file's own `waitFor` rationale above.
 */
const settle = async (ms = 100): Promise<void> => { await new Promise((r) => { setTimeout(r, ms); }); };

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** The frame's own header is its AAD, so opening it proves the header was authenticated too. */
async function openControl(
  key: CryptoKey, prefix: Uint8Array, frame: ReturnType<typeof decodeFrame>,
): Promise<ControlMessage> {
  return decodeControl(await open(key, makeNonce('a', prefix, frame.seq), frame.payload, frame.header));
}

/**
 * A transport whose backpressure is driven manually, so tests can force the
 * Sender into its waiting-on-drain state instead of relying on real network
 * timing. `MemoryTransport.bufferedAmount` is hardcoded to 0, so it can never
 * exercise this path.
 */
function controllableTransport() {
  let onDrainCb: (() => void) | undefined;
  const sent: Uint8Array[] = [];
  return {
    kind: 'relay' as const,
    bufferedAmount: 0,
    sent,
    send(frame: Uint8Array): void { sent.push(frame.slice()); },
    onMessage(): void { /* unused */ },
    onDrain(cb: () => void): void { onDrainCb = cb; },
    onClose(): void { /* unused */ },
    close(): void { /* unused */ },
    drain(): void { this.bufferedAmount = 0; onDrainCb?.(); },
  };
}

/** Settles to a tagged result instead of rejecting, so awaiting it is always safe. */
function settleOf<T>(p: Promise<T>): Promise<{ status: 'resolved'; value: T } | { status: 'rejected'; error: unknown }> {
  return p.then(
    (value) => ({ status: 'resolved' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

/**
 * Real-time polling. A settled-flag check cannot use isStillPending: the work
 * released by a drain runs through real crypto.subtle.encrypt calls, which a
 * setTimeout(0) macrotask can easily beat.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function isStillPending(p: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  // A setTimeout(0) macrotask always loses to an already-settled promise's
  // microtask continuation, and always wins against one that is still pending.
  const outcome = await Promise.race([
    p.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 0)),
  ]);
  return outcome === pending;
}

describe('isStillPending', () => {
  it('reports a settled promise as not pending', async () => {
    expect(await isStillPending(Promise.resolve(1))).toBe(false);
    expect(await isStillPending(Promise.reject(new Error('x')))).toBe(false);
  });

  it('reports an unsettled promise as pending', async () => {
    expect(await isStillPending(new Promise(() => { /* never settles */ }))).toBe(true);
  });
});

describe('Sender', () => {
  it('announces the batch before sending data', async () => {
    const { sender, frames, key, prefix } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array([1, 2, 3])], 'a.bin', { type: 'text/plain' })]);
    await flush();
    const first = decodeFrame(frames[0]!);
    expect(first.type).toBe(FrameType.Control);
    const msg = await openControl(key, prefix, first);
    expect(msg.t).toBe('offer-batch');
    if (msg.t !== 'offer-batch') throw new Error('unreachable');
    expect(msg.files[0]).toMatchObject({ name: 'a.bin', size: 3, type: 'text/plain' });
  });

  it('announces the minted metas synchronously, before the batch finishes', async () => {
    // A queue that learns these ids only once the whole batch resolves would
    // show every row as freshly started at the exact moment the transfer
    // actually completes — backpressure here proves the announcement lands
    // long before that, not just "eventually".
    const transport = controllableTransport();
    transport.bufferedAmount = HIGH_WATER_BYTES + 1;
    const onFilesQueued = vi.fn();
    const sender = new Sender({
      transport,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn(), onFilesQueued },
    });

    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    const pending = sender.sendFiles([new File([bytes], 'big.bin'), new File([new Uint8Array(1)], 'small.bin')]);

    expect(await isStillPending(pending)).toBe(true);
    expect(onFilesQueued).toHaveBeenCalledTimes(1);
    expect(onFilesQueued).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'big.bin', size: CHUNK_SIZE + 10 }),
      expect.objectContaining({ name: 'small.bin', size: 1 }),
    ]);

    transport.drain();
    await pending;
  });

  it('encrypts each chunk so the raw bytes never appear on the wire', async () => {
    const { sender, frames } = await makeSender();
    const plaintext = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await sender.sendFiles([new File([plaintext], 'a.bin')]);
    await flush();
    const data = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data);
    expect(data).toHaveLength(1);
    expect([...data[0]!.payload]).not.toEqual([...plaintext]);
  });

  it('produces chunks the receiver can open with the matching nonce', async () => {
    const { sender, frames, key, prefix } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array([7, 7, 7])], 'a.bin')]);
    await flush();
    const chunk = frames.map(decodeFrame).find((f) => f.type === FrameType.Data)!;
    // fix-round-2: data frames are sealed with the byte offset bound into
    // the AAD alongside the header (data-aad.ts) — this is the file's only
    // (and so first) chunk, offset 0.
    const opened = await open(key, makeNonce('a', prefix, chunk.seq), chunk.payload, dataAad(chunk.header, 0));
    expect([...opened]).toEqual([7, 7, 7]);
  });

  it('splits a file larger than one chunk into sequential data frames', async () => {
    const { sender, frames } = await makeSender();
    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    await sender.sendFiles([new File([bytes], 'big.bin')]);
    await flush();
    const seqs = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).map((f) => f.seq);
    // The session-wide counter starts at 0, but the sealed offer-batch control
    // frame sent first consumes seq 0 under the amendment, so the data chunks
    // for the very first file start at 1, not 0.
    expect(seqs).toEqual([1n, 2n]);
  });

  it('sends no data frames for a zero-byte file but still ends it', async () => {
    const { sender, frames, key, prefix } = await makeSender();
    await sender.sendFiles([new File([], 'empty.bin')]);
    await flush();
    const decoded = frames.map(decodeFrame);
    expect(decoded.filter((f) => f.type === FrameType.Data)).toHaveLength(0);
    const controls = await Promise.all(
      decoded.filter((f) => f.type === FrameType.Control).map((f) => openControl(key, prefix, f)),
    );
    expect(controls.filter((m) => m.t === 'file-end')).toHaveLength(1);
  });

  it('sends exactly one chunk for a file the size of one chunk', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array(CHUNK_SIZE)], 'exact.bin')]);
    await flush();
    const dataFrames = frames.filter((f) => decodeFrame(f).type === FrameType.Data);
    expect(dataFrames).toHaveLength(1);
    // The spec derives CHUNK_SIZE from this ceiling rather than choosing it:
    // 65536 is the largest single message an SCTP DataChannel is guaranteed to
    // carry, so Plan 3's WebRTC transport needs a full frame to land exactly on
    // it — one byte over would force a fragmentation layer.
    expect(dataFrames[0]!.length).toBe(MAX_FRAME_BYTES);
  });

  it('never reuses a sequence number across files in one session', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array(10)], 'a.bin'), new File([new Uint8Array(10)], 'b.bin')]);
    await flush();
    // Covers every frame, control included: a control frame colliding with a
    // data frame's seq is exactly the catastrophic case this test guards.
    const seqs = frames.map(decodeFrame).map((f) => f.seq.toString());
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  // fix-round-3 (Minor): #nextFileId used to reset to 1 on every rebuild
  // while #nextSeq carried — the same shape as the original nonce bug, at
  // lower stakes (the AAD fix fails a colliding fileId's data loudly rather
  // than corrupting it, which is why this is Minor and not Critical). A
  // batch sent right after a reconnect must mint fileIds the receiver has
  // never seen, not ones still in flight from before.
  it("carries the fileId counter across a rebuild, mirroring how initialSeq carries nextSeq", async () => {
    const key = await importKey(generateRawKey());
    const noncePrefix = generateNoncePrefix();
    const [a] = createMemoryPair();
    const oldSender = new Sender({
      transport: a, key, peerId: 'a', noncePrefix, initialSeq: 0n, initialFileId: 1, gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });
    await oldSender.sendFiles([new File([], 'a.bin'), new File([], 'b.bin')]); // mints fileIds 1, 2
    expect(oldSender.nextFileId).toBe(3);

    // Mirrors Session.#buildSender exactly: initialFileId: previous.nextFileId.
    const newSender = new Sender({
      transport: a, key, peerId: 'a', noncePrefix, initialSeq: oldSender.nextSeq,
      initialFileId: oldSender.nextFileId, gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });
    const metas = await newSender.sendFiles([new File([], 'c.bin')]);
    expect(metas[0]!.id).toBe(3);
  });

  it('reports progress and completion', async () => {
    const [a] = createMemoryPair();
    const onProgress = vi.fn();
    const onFileDone = vi.fn();
    const sender = new Sender({
      transport: a,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress, onFileDone },
    });
    await sender.sendFiles([new File([new Uint8Array(CHUNK_SIZE * 2)], 'x.bin')]);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ bytesSent: CHUNK_SIZE * 2, totalBytes: CHUNK_SIZE * 2 }),
    );
    // Progress is what this side did; completion is what the peer confirms.
    sender.confirmDelivered(1);
    expect(onFileDone).toHaveBeenCalledTimes(1);
  });

  it('sends a text snippet as a control frame', async () => {
    const { sender, frames, key, prefix } = await makeSender();
    await sender.sendText('hello');
    await flush();
    expect(await openControl(key, prefix, decodeFrame(frames[0]!))).toEqual({ t: 'text', content: 'hello' });
  });

  it('refuses a text snippet that would not fit in one frame, with copy a person can read', async () => {
    // A snippet is one unchunked control frame. Without this check the
    // ceiling moved with the transport: on the relay a 100 KB paste went out
    // fine (the server's maxPayload is 4 MB), and after a WebRTC upgrade the
    // identical action threw "frame of 100128 bytes exceeds MAX_FRAME_BYTES
    // (65536)" — which useSession's userFacing passes through verbatim,
    // since it is not a protocol token.
    const { sender, frames } = await makeSender();
    await expect(sender.sendText('x'.repeat(CHUNK_SIZE))).rejects.toThrow(TEXT_TOO_LONG);
    await settle(50);
    // Nothing went out, and — the part that matters beyond the error — no
    // sequence number was burned reaching the decision.
    expect(frames).toHaveLength(0);
    expect(sender.nextSeq).toBe(0n);
  });

  it('still sends a snippet that only just fits', async () => {
    // The JSON wrapper `{"t":"text","content":""}` is 25 bytes, so the
    // largest ASCII note that fits is CHUNK_SIZE - 25. Pinned so a future
    // change to the frame layout has to come past this test rather than
    // silently shrinking what a user can send.
    const { sender, frames, key, prefix } = await makeSender();
    const content = 'x'.repeat(CHUNK_SIZE - 25);
    await sender.sendText(content);
    await flush();
    expect(await openControl(key, prefix, decodeFrame(frames[0]!))).toEqual({ t: 'text', content });
  });

  it('accepts the UI ceiling even at its worst-case encoding, so the textarea can never produce a note this rejects', async () => {
    // MAX_TEXT_CHARS is a UTF-16 code-unit count and the frame bound is in
    // bytes; JSON escaping turns a raw control character into six of them.
    // If those two ever stop agreeing, a user who pasted something the
    // textarea accepted would get an error they could do nothing about.
    const { sender } = await makeSender();
    await expect(sender.sendText('\u0001'.repeat(MAX_TEXT_CHARS))).resolves.toBeUndefined();
  });

  // fix-round-3 (Critical, coordinator's own finding on their #lastControlSeq
  // addition): TransportSwapGate.wrap is a *counting* gate, not a mutex, so
  // it serializes nothing between two concurrent #sendControl callers. seq
  // is assigned synchronously but a frame only reaches the wire once its
  // real crypto.subtle.encrypt call resolves — and a bigger payload can take
  // longer — so a large text queued just before a tiny one can still be
  // sealing while the tiny one finishes and reaches the wire first, with a
  // *higher* seq. The receiver's #lastControlSeq check is right to reject
  // whichever lands second in that case; the fix keeps wire order equal to
  // assignment order in the first place.
  //
  // Forced deterministically rather than relied on as a real timing race:
  // the coordinator measured real inversion rates that scale with payload
  // size (~96/100 at 63-64 KB) on their own probe, but that is a property of
  // their hardware/Node build, not of this code — on this machine, calling
  // sendText(big) then sendText(small) back to back did not reproduce it
  // even once in several tries (AES-GCM on a modern CPU is fast enough that
  // 63 KB and 1 byte can complete in the same tick). A flaky-by-hardware
  // test would be worse than no test at all, so crypto.subtle.encrypt is
  // spied on to make a large payload's encrypt take unconditionally longer,
  // while every ciphertext is still the real one from the real algorithm.
  it(
    'does not lose either control frame when the first-assigned seq is the one that seals slower',
    async () => {
      const [a, b] = createMemoryPair();
      const key = await importKey(generateRawKey());
      const prefix = generateNoncePrefix();
      const sender = new Sender({
        transport: a, key, peerId: 'a', noncePrefix: prefix, initialSeq: 0n, initialFileId: 1, gate: new TransportSwapGate(),
        events: { onProgress: vi.fn(), onFileDone: vi.fn() },
      });
      const texts: string[] = [];
      const errors: { fileId?: number; message: string }[] = [];
      const receiver = new Receiver({
        transport: b, key, peerId: 'b', remoteNoncePrefix: prefix,
        events: {
          onOffer: vi.fn(), onProgress: vi.fn(), onFileComplete: vi.fn(),
          onText: (content) => texts.push(content), onError: (e) => errors.push(e),
        },
      });
      receiver.start();

      const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
      // A payload-size-dependent delay standing in for "a bigger payload
      // takes longer to seal" — deterministic and hardware-independent.
      // Trying this with a real 63 KB payload and no mock did not reproduce
      // the race reliably on this machine (AES-GCM is fast enough on a
      // modern CPU that a 63 KB and a 1-byte encrypt can land in the same
      // tick), which would make a real-timing test flaky rather than a
      // faithful RED/GREEN check — this makes the size-dependent delay the
      // bug depends on unconditional instead of a matter of hardware luck.
      // Deliberately *not* keyed to call order/index: under the fix, the
      // second call's encrypt does not even start until the first call's
      // whole #sendControl (encrypt included) has finished, so anything
      // that made call 0 wait on call 1 having already run would deadlock
      // against the very fix it's supposed to verify.
      const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt')
        .mockImplementation(async (...args: Parameters<typeof originalEncrypt>) => {
          if (args[2].byteLength > 1000) await new Promise((resolve) => { setTimeout(resolve, 30); });
          return originalEncrypt(...args);
        });

      try {
        const big = 'x'.repeat(63_000);
        const small = 'y';
        // Genuinely concurrent: neither call is awaited before the other
        // starts, so both race #sendControl's internal seal() before this
        // fix — big is issued (and assigned the lower seq) first.
        await Promise.all([sender.sendText(big), sender.sendText(small)]);
        await waitFor(() => texts.length + errors.length >= 2);

        expect(errors).toEqual([]);
        expect(texts.slice().sort()).toEqual([big, small].sort());
      } finally {
        encryptSpy.mockRestore();
      }
    },
  );

  it('does not put filenames on the wire in the clear', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array([1])], 'medical-results.pdf')]);
    await flush();
    // Guards against the assertions below passing vacuously if some future
    // change stops frames from reaching the peer at all.
    expect(frames.length).toBeGreaterThan(0);
    const wire = frames.map((f) => new TextDecoder().decode(f)).join('');
    expect(wire).not.toContain('medical-results');
    expect(wire).not.toContain('offer-batch');
  });

  it('waits for backpressure and resumes once the transport drains', async () => {
    const transport = controllableTransport();
    transport.bufferedAmount = HIGH_WATER_BYTES + 1;
    const sender = new Sender({
      transport,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });

    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    const pending = sender.sendFiles([new File([bytes], 'big.bin')]);

    expect(await isStillPending(pending)).toBe(true);

    transport.drain();
    await pending;

    const dataFrames = transport.sent.map(decodeFrame).filter((f) => f.type === FrameType.Data);
    expect(dataFrames).toHaveLength(2);
  });

  it('resumes every concurrent send on one drain, not just the last one', async () => {
    // Session.sendFiles is public and unserialized, so two batches can be in
    // flight at once — a second drop while the first is still transferring.
    // A single-slot drain resolver settles only the most recent waiter and
    // strands the earlier one forever: a progress row frozen with no error.
    const transport = controllableTransport();
    transport.bufferedAmount = HIGH_WATER_BYTES + 1;
    const sender = new Sender({
      transport,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });

    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    const first = settleOf(sender.sendFiles([new File([bytes], 'first.bin')]));
    const second = settleOf(sender.sendFiles([new File([bytes], 'second.bin')]));
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => { firstSettled = true; });
    void second.then(() => { secondSettled = true; });

    expect(await isStillPending(first)).toBe(true);
    expect(await isStillPending(second)).toBe(true);

    transport.drain();

    await waitFor(() => firstSettled && secondSettled);
    expect((await first).status).toBe('resolved');
    expect((await second).status).toBe('resolved');
  });

  it('abort rejects every concurrent send, not just the last one', async () => {
    const transport = controllableTransport();
    transport.bufferedAmount = HIGH_WATER_BYTES + 1;
    const sender = new Sender({
      transport,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });

    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    const first = settleOf(sender.sendFiles([new File([bytes], 'first.bin')]));
    const second = settleOf(sender.sendFiles([new File([bytes], 'second.bin')]));
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => { firstSettled = true; });
    void second.then(() => { secondSettled = true; });

    expect(await isStillPending(first)).toBe(true);
    expect(await isStillPending(second)).toBe(true);

    sender.abort('peer left');

    await waitFor(() => firstSettled && secondSettled);
    expect((await first).status).toBe('rejected');
    expect((await second).status).toBe('rejected');
  });

  it('abort rejects an in-flight sendFiles instead of hanging', async () => {
    const transport = controllableTransport();
    transport.bufferedAmount = HIGH_WATER_BYTES + 1;
    const sender = new Sender({
      transport,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });

    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    const settled = settleOf(sender.sendFiles([new File([bytes], 'big.bin')]));

    expect(await isStillPending(settled)).toBe(true);

    sender.abort('peer left');
    const result = await settled;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect((result.error as Error).message).toBe('peer left');
  });

  it('does not report onFileDone for a file aborted mid-transfer', async () => {
    const transport = controllableTransport();
    transport.bufferedAmount = HIGH_WATER_BYTES + 1;
    const onFileDone = vi.fn();
    const sender = new Sender({
      transport,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone },
    });

    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    const settled = settleOf(sender.sendFiles([new File([bytes], 'big.bin')]));

    expect(await isStillPending(settled)).toBe(true);

    sender.abort('peer left');
    await settled;

    expect(onFileDone).not.toHaveBeenCalled();
  });

  describe('TransportSwapGate wiring', () => {
    it('blocks the next chunk send until a pending swap has completed', async () => {
      // Proves #sendOneFile's chunk loop itself is routed through the shared
      // gate, not merely that #sendControl is (sendFiles' first frame is
      // always an offer-batch control frame, so a naive version of this test
      // that engages the gate before calling sendFiles at all would pass even
      // if the chunk loop never touched the gate — it would just be
      // re-testing #sendControl's own wrap via a different call site). This
      // lets the offer-batch and first chunk go out normally, gate idle, then
      // engages the gate only in the gap between chunk 1 and chunk 2 — the
      // gap #awaitDrain already creates.
      const transport = controllableTransport();
      transport.bufferedAmount = HIGH_WATER_BYTES + 1; // parks the loop after chunk 1
      const gate = new TransportSwapGate();
      const sender = new Sender({
        transport,
        key: await importKey(generateRawKey()),
        peerId: 'a',
        noncePrefix: generateNoncePrefix(),
        initialSeq: 0n,
        initialFileId: 1,
        gate,
        events: { onProgress: vi.fn(), onFileDone: vi.fn() },
      });

      const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1); // two chunks
      const pending = sender.sendFiles([new File([bytes], 'big.bin')]);
      await settle();
      // offer-batch + chunk 1, then parked on #awaitDrain before chunk 2.
      expect(transport.sent).toHaveLength(2);

      // Hold the gate's barrier open with unrelated in-flight work, standing
      // in for "a swap negotiation is pending but not yet idle" — runExclusive
      // sets the barrier the instant it's called, before perform() ever runs.
      let releaseUnrelated: () => void = () => undefined;
      const unrelated = gate.wrap(() => new Promise<void>((resolve) => { releaseUnrelated = resolve; }));
      const swapPerform = vi.fn();
      const swap = gate.runExclusive(swapPerform);
      await flush();

      transport.drain(); // releases #awaitDrain; chunk 2's gate.wrap() call should now block
      await settle();
      expect(transport.sent).toHaveLength(2);
      expect(swapPerform).not.toHaveBeenCalled();

      releaseUnrelated();
      await swap;
      await unrelated;
      await pending;
      expect(transport.sent.length).toBeGreaterThan(2);
    });

    it('routes sendText through the shared gate too, since it also goes through #sendControl', async () => {
      // #sendControl backs both sendText and every offer-batch/file-end
      // frame sendFiles emits, so exercising it via sendText alone covers
      // the same private method those go through too.
      const transport = controllableTransport();
      const gate = new TransportSwapGate();
      const sender = new Sender({
        transport,
        key: await importKey(generateRawKey()),
        peerId: 'a',
        noncePrefix: generateNoncePrefix(),
        initialSeq: 0n,
        initialFileId: 1,
        gate,
        events: { onProgress: vi.fn(), onFileDone: vi.fn() },
      });

      let releaseUnrelated: () => void = () => undefined;
      const unrelated = gate.wrap(() => new Promise<void>((resolve) => { releaseUnrelated = resolve; }));
      const swap = gate.runExclusive(vi.fn());
      await flush();

      const pending = sender.sendText('hello');
      await settle();
      expect(transport.sent).toHaveLength(0);

      releaseUnrelated();
      await swap;
      await pending;
      await unrelated;
      expect(transport.sent).toHaveLength(1);
    });

    it('never holds the gate open while parked on backpressure, so a pending swap is not blocked by a stuck drain', async () => {
      // This is the single highest-consequence detail of the design (see
      // TransportSwapGate's doc comment in client/transport/upgrade.ts): a
      // transport worth upgrading away from is, by definition, sometimes
      // backed up. If #awaitDrain were wrapped inside the same gate.wrap()
      // call as the send, a chunk parked waiting for backpressure to clear
      // would hold #inFlight above zero forever on a transport that never
      // drains — and runExclusive would then wait forever for a swap that is
      // the only thing that could relieve that exact backpressure.
      const transport = controllableTransport();
      transport.bufferedAmount = HIGH_WATER_BYTES + 1; // never drains in this test
      const gate = new TransportSwapGate();
      const sender = new Sender({
        transport,
        key: await importKey(generateRawKey()),
        peerId: 'a',
        noncePrefix: generateNoncePrefix(),
        initialSeq: 0n,
        initialFileId: 1,
        gate,
        events: { onProgress: vi.fn(), onFileDone: vi.fn() },
      });

      // Two chunks: the first chunk's send completes and #sendOneFile then
      // parks on #awaitDrain before ever starting the second chunk's wrap.
      const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
      const pending = settleOf(sender.sendFiles([new File([bytes], 'big.bin')]));
      expect(await isStillPending(pending)).toBe(true);

      const perform = vi.fn();
      await withTimeout(
        gate.runExclusive(perform),
        1000,
        'runExclusive did not resolve: a parked #awaitDrain is holding the gate open',
      );
      expect(perform).toHaveBeenCalledTimes(1);

      sender.abort('test teardown');
      await pending;
    });

    it('does not fork the sequence counter when a peer-left rebuild races a #sendControl call parked behind a pending swap', async () => {
      // Reproduces the exact race: Session's #unpair() snapshots the old
      // Sender's nextSeq as the new Sender's initialSeq while a #sendControl
      // call from the old Sender is parked behind TransportSwapGate's
      // barrier (a pending swap and a peer-left can each be in flight
      // independently). #nextSeq++ happens *after* the park point, so the
      // snapshot is taken before the parked call has consumed its seq. If
      // that parked call is still allowed to emit its frame once the barrier
      // releases, both the old (aborted) and new Sender put the same seq on
      // the wire under the shared key — the exact nonce-reuse class this
      // project has already had to fix once (see session.ts's #buildSender
      // comment on why the counter must never fork).
      const transport = controllableTransport();
      const gate = new TransportSwapGate();
      const key = await importKey(generateRawKey());
      const noncePrefix = generateNoncePrefix();

      const oldSender = new Sender({
        transport, key, peerId: 'a', noncePrefix, initialSeq: 0n, initialFileId: 1, gate,
        events: { onProgress: vi.fn(), onFileDone: vi.fn() },
      });

      // Warm-up: consume seq 0 for real, so nextSeq is 1 going into the race
      // — matching the scenario as actually reported.
      await oldSender.sendText('warm-up');
      expect(oldSender.nextSeq).toBe(1n);

      // Hold the gate's barrier open, as a pending swap negotiation would.
      let releaseUnrelated: () => void = () => undefined;
      const unrelated = gate.wrap(() => new Promise<void>((resolve) => { releaseUnrelated = resolve; }));
      const swap = gate.runExclusive(vi.fn());
      await flush();

      // A control send starts and parks behind the barrier before it can
      // mint its seq — #nextSeq++ is inside the wrapped callback.
      const parked = settleOf(oldSender.sendText('during the race'));
      await settle();
      expect(oldSender.nextSeq).toBe(1n); // still unconsumed: parked before the increment

      // Session's #unpair(): abort the old Sender, then #buildSender snapshots
      // its (still pre-increment) nextSeq for the replacement. Same prefix as
      // oldSender, not a fresh one: #buildSender never regenerates it (see
      // session.ts's #noncePrefix comment), and a fresh prefix here would
      // make every nonce trivially distinct regardless of whether the seq
      // itself forked — turning this into a test of seq-uniqueness rather
      // than the nonce-uniqueness this near-miss was actually about.
      oldSender.abort('peer-left');
      const newSender = new Sender({
        transport, key, peerId: 'a', noncePrefix, initialSeq: oldSender.nextSeq,
        initialFileId: oldSender.nextFileId, gate,
        events: { onProgress: vi.fn(), onFileDone: vi.fn() },
      });

      // The swap completes, releasing everything parked behind the barrier —
      // including the old Sender's parked call.
      releaseUnrelated();
      await swap;
      await unrelated;
      await parked; // settled (rejected, since oldSender is aborted) — never left pending

      // The new Sender sends its own control frame using the snapshotted seq.
      await newSender.sendText('after the race');

      const seqs = transport.sent.map((f) => decodeFrame(f).seq.toString());
      expect(new Set(seqs).size).toBe(seqs.length);
    });
  });
});


/**
 * A sender whose events are the test's own, so a cancel can be fired from
 * inside the very callbacks that report the batch moving — the only place a
 * test can hit the narrow window this feature is about.
 */
async function makeCancellableSender(events: Partial<SenderEvents> = {}) {
  const [a, b] = createMemoryPair();
  const frames: Uint8Array[] = [];
  b.onMessage((f) => frames.push(f));
  const key = await importKey(generateRawKey());
  const prefix = generateNoncePrefix();
  const onFileDone = vi.fn();
  const onFileCancelled = vi.fn();
  const sender = new Sender({
    transport: a, key, peerId: 'a', noncePrefix: prefix, initialSeq: 0n, initialFileId: 1,
    gate: new TransportSwapGate(),
    events: { onProgress: vi.fn(), onFileDone, onFileCancelled, ...events },
  });
  return { sender, frames, key, prefix, onFileDone, onFileCancelled };
}

/** Every fileId a `file-end` went out for, in order. */
async function fileEndIds(key: CryptoKey, prefix: Uint8Array, frames: Uint8Array[]): Promise<number[]> {
  const ids: number[] = [];
  for (const raw of frames) {
    const frame = decodeFrame(raw);
    if (frame.type !== FrameType.Control) continue;
    const msg = await openControl(key, prefix, frame);
    if (msg.t === 'file-end') ids.push(msg.fileId);
  }
  return ids;
}

/*
 * "Sent" has to mean the other device has it.
 *
 * It used to mean "the last frame was handed to transport.send()", which is
 * a different claim and can be false without anything noticing: both
 * transports drop a frame silently when their channel is not open, and a
 * WebRTC data channel whose network path has died stays `readyState:
 * 'open'` for as long as ICE takes to give up — every byte accepted into a
 * buffer nothing will ever drain. A real session on 2026-08-29 lost a file
 * exactly that way: every row on the sender read Sent, every row on the
 * receiver sat at 0 bytes, and no error was raised on either side. The only
 * thing that can distinguish the two is the peer saying so.
 */
describe('Sender: a file is done when the peer says it arrived', () => {
  async function senderWithEvents(over: Partial<SenderEvents> = {}) {
    const [a, b] = createMemoryPair();
    const frames: Uint8Array[] = [];
    b.onMessage((f) => frames.push(f));
    const key = await importKey(generateRawKey());
    const prefix = generateNoncePrefix();
    const onFileDone = vi.fn();
    const sender = new Sender({
      transport: a, key, peerId: 'a', noncePrefix: prefix, initialSeq: 0n, initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone, ...over },
    });
    return { sender, frames, key, prefix, onFileDone };
  }

  it('writes the whole file, and still does not call it done', async () => {
    const { sender, frames, key, prefix, onFileDone } = await senderWithEvents();

    await sender.sendFiles([new File([new Uint8Array([1, 2, 3])], 'a.bin')]);
    await flush();

    // The bytes and the file-end really are on the wire — this is not a
    // Sender that stopped early, it is one that has not been told yet.
    expect(await fileEndIds(key, prefix, frames)).toEqual([1]);
    expect(onFileDone).not.toHaveBeenCalled();
  });

  it('calls it done on the peer\'s acknowledgement, once', async () => {
    const { sender, onFileDone } = await senderWithEvents();
    await sender.sendFiles([new File([new Uint8Array([1])], 'a.bin')]);
    await flush();

    sender.confirmDelivered(1);
    sender.confirmDelivered(1); // a duplicate ack must not double-report
    expect(onFileDone).toHaveBeenCalledTimes(1);
    expect(onFileDone).toHaveBeenCalledWith(1);
  });

  it('ignores an acknowledgement for a file it never sent', async () => {
    const { sender, onFileDone } = await senderWithEvents();
    // Attacker-controlled: the id comes off the wire, and a relay can put
    // any number there. Nothing to report, and nothing to throw about.
    sender.confirmDelivered(99);
    expect(onFileDone).not.toHaveBeenCalled();
  });

  it('carries what it is still waiting on across a rebuild', async () => {
    const first = await senderWithEvents();
    await first.sender.sendFiles([new File([new Uint8Array([1])], 'a.bin')]);
    await flush();

    // A reconnect or a re-pair rebuilds the Sender (Session.#buildSender).
    // An ack that arrives after that still belongs to the file it names.
    const [a] = createMemoryPair();
    const onFileDone = vi.fn();
    const rebuilt = new Sender({
      transport: a,
      key: first.key,
      peerId: 'a',
      noncePrefix: first.prefix,
      initialSeq: first.sender.nextSeq,
      initialFileId: first.sender.nextFileId,
      initialAwaitingAck: first.sender.awaitingAck,
      gate: new TransportSwapGate(),
      events: { onProgress: vi.fn(), onFileDone },
    });

    rebuilt.confirmDelivered(1);
    expect(onFileDone).toHaveBeenCalledWith(1);
  });

  it('sends an acknowledgement of its own for a file it received', async () => {
    const { sender, frames, key, prefix } = await senderWithEvents();
    await sender.sendFileAck(7);
    await flush();

    const acks = [];
    for (const raw of frames) {
      const frame = decodeFrame(raw);
      if (frame.type !== FrameType.Control) continue;
      const msg = await openControl(key, prefix, frame);
      if (msg.t === 'file-ack') acks.push(msg.fileId);
    }
    expect(acks).toEqual([7]);
  });
});

describe('cancelling one file out of a batch', () => {
  it('stops the cancelled file and keeps sending the rest of the batch', async () => {
    let sender!: Sender;
    const harness = await makeCancellableSender({
      // Fired the moment the first chunk of the first file lands, which is
      // the only window where the file is genuinely mid-flight.
      onProgress: (p) => { if (p.fileId === 1) sender.cancel([1]); },
    });
    sender = harness.sender;
    const { frames, key, prefix, onFileDone, onFileCancelled } = harness;

    await sender.sendFiles([
      new File([new Uint8Array(CHUNK_SIZE * 4)], 'big.bin'),
      new File([new Uint8Array([9])], 'small.bin'),
    ]);

    expect(onFileCancelled).toHaveBeenCalledWith(1);
    // The whole point of a cancel being a per-file skip rather than an
    // abort: the second file still went. A cancelled file is never waiting
    // on an ack, so this can only report the one that finished.
    sender.confirmDelivered(1);
    sender.confirmDelivered(2);
    expect(onFileDone).toHaveBeenCalledWith(2);
    expect(onFileDone).not.toHaveBeenCalledWith(1);
    // file-end is what tells the receiver a file is whole. A cancelled file
    // must never get one, or the partial arrives looking complete.
    expect(await fileEndIds(key, prefix, frames)).toEqual([2]);
  });

  it('never puts a byte of a file cancelled before it started on the wire', async () => {
    let sender!: Sender;
    const harness = await makeCancellableSender({
      // Queued fires before the first byte of the batch goes out.
      onFilesQueued: () => sender.cancel([2]),
    });
    sender = harness.sender;
    const { frames, key, prefix, onFileDone, onFileCancelled } = harness;

    await sender.sendFiles([
      new File([new Uint8Array([1])], 'a.bin'),
      new File([new Uint8Array([2])], 'b.bin'),
    ]);

    expect(onFileCancelled).toHaveBeenCalledWith(2);
    sender.confirmDelivered(1);
    expect(onFileDone).toHaveBeenCalledWith(1);
    expect(await fileEndIds(key, prefix, frames)).toEqual([1]);
    const dataIds = frames.map((f) => decodeFrame(f)).filter((f) => f.type === FrameType.Data).map((f) => f.fileId);
    expect(dataIds).not.toContain(2);
  });

  it('refuses to resume a file that was cancelled, so a reconnect cannot undo it', async () => {
    const { sender, frames, key, prefix, onFileDone, onFileCancelled } = await makeCancellableSender();
    const meta = { id: 1, name: 'a.bin', size: 4, type: 'text/plain' };
    sender.cancel([1]);

    await sender.resumeFile(new File([new Uint8Array(4)], 'a.bin'), meta, 2);

    expect(onFileCancelled).toHaveBeenCalledWith(1);
    expect(onFileDone).not.toHaveBeenCalled();
    expect(await fileEndIds(key, prefix, frames)).toEqual([]);
    expect(sender.isCancelled(1)).toBe(true);
  });

  it('leaves an unrelated file alone', async () => {
    const { sender, onFileDone } = await makeCancellableSender();
    sender.cancel([99]);
    await sender.sendFiles([new File([new Uint8Array([1])], 'a.bin')]);
    sender.confirmDelivered(1);
    expect(onFileDone).toHaveBeenCalledWith(1);
  });
});

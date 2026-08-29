// tests/unit/receiver.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey, makeNonce, seal } from '../../client/crypto.js';
import { FrameType, HEADER_BYTES, encodeControl, encodeFrame, encodeHeader } from '../../client/protocol.js';
import { Receiver } from '../../client/transfer/receiver.js';
import { dataAad } from '../../client/transfer/data-aad.js';
import type { SaveSink } from '../../client/save/types.js';
import type { Transport } from '../../client/transport/types.js';
import type { ControlMessage, FileMeta, SaveCapability } from '../../shared/messages.js';
import { BLOB_SINK_MAX_BYTES } from '../../client/save/blob.js';

/**
 * Every frame the Receiver handles here passes through a real
 * crypto.subtle.decrypt inside the message-driven promise chain (control
 * frames included, under the sealed-control amendment), which the test
 * cannot directly await — it can only observe an effect (a mock call) after
 * the fact. A fixed-count microtask/macrotask flush (`for (...) await
 * Promise.resolve()` or a bounded run of `setImmediate`) turned out not to
 * be reliable here: under this suite's full concurrent run, Node's WebCrypto
 * dispatches AES-GCM work to the shared libuv threadpool, and that
 * threadpool's completion latency varies with how many other test files are
 * doing crypto work at the same moment — a tick/round count that is ample in
 * isolation was empirically still flaky (~1 in 5-10 runs) under full-suite
 * load even at 500 rounds. Polling a real predicate against a generous
 * wall-clock budget is robust to that variance instead of guessing a count.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeEvents() {
  return {
    onOffer: vi.fn(), onProgress: vi.fn(), onFileComplete: vi.fn(),
    onText: vi.fn(), onError: vi.fn(),
  };
}

async function setup(
  createSink?: (meta: FileMeta) => SaveSink | Promise<SaveSink>,
  saveCapability?: SaveCapability,
) {
  const [a, b] = createMemoryPair();
  const key = await importKey(generateRawKey());
  const prefix = generateNoncePrefix();
  const events = makeEvents();
  const receiver = new Receiver({
    transport: b, key, peerId: 'b', remoteNoncePrefix: prefix, createSink, saveCapability, events,
  });
  receiver.start();
  return { sendSide: a as Transport, receiver, key, prefix, events };
}

/**
 * Control payloads are sealed under Task 10's amendment (offer-batch carries
 * filenames, text carries user content). The sending side in these tests is
 * peer 'a' and the receiver is 'b', so the nonce is built with 'a'. Every
 * frame in a test must carry a distinct seq — two frames sharing a nonce
 * under the same key is the catastrophic case sealing exists to prevent.
 */
async function sealedControl(
  key: CryptoKey, prefix: Uint8Array, seq: bigint, msg: ControlMessage,
): Promise<Uint8Array> {
  const header = encodeHeader(FrameType.Control, 0, seq);
  const sealed = await seal(key, makeNonce('a', prefix, seq), encodeControl(msg), header);
  return encodeFrame(FrameType.Control, 0, seq, sealed);
}

/**
 * A legitimately sealed data frame, exactly as a well-behaved sender emits
 * it: fix-round-2 binds the byte offset this chunk's plaintext starts at
 * into the AAD (data-aad.ts), so callers sending more than one chunk for
 * the same file must pass the real running offset — 0 covers every
 * call site here that only ever sends a single chunk per file.
 */
async function sealedData(
  key: CryptoKey, prefix: Uint8Array, seq: bigint, fileId: number, plaintext: Uint8Array, offset = 0,
): Promise<Uint8Array> {
  const header = encodeHeader(FrameType.Data, fileId, seq);
  const sealed = await seal(key, makeNonce('a', prefix, seq), plaintext, dataAad(header, offset));
  return encodeFrame(FrameType.Data, fileId, seq, sealed);
}

/** Rewrites the fileId in an already-sealed frame's header, as a hostile relay would. */
function rewriteFileId(frame: Uint8Array, fileId: number): Uint8Array {
  const copy = frame.slice();
  new DataView(copy.buffer).setUint32(1, fileId, false);
  return copy;
}

/** Rewrites the type byte in an already-sealed frame's header. */
function rewriteType(frame: Uint8Array, type: FrameType): Uint8Array {
  const copy = frame.slice();
  copy[0] = type;
  return copy;
}

const meta = { id: 1, name: 'a.bin', size: 3, type: 'text/plain' };
/** A second offered file, so a rewritten fileId has somewhere to land. */
const otherMeta = { id: 2, name: 'b.bin', size: 3, type: 'text/plain' };
/** Two chunks' worth, for the reorder and truncation cases. */
const twoChunkMeta = { id: 1, name: 'two.bin', size: 6, type: 'text/plain' };

describe('waitFor', () => {
  it('throws when the condition never holds', async () => {
    await expect(waitFor(() => false, 20)).rejects.toThrow();
  });
});

describe('Receiver', () => {
  it('surfaces an incoming batch offer', async () => {
    const { sendSide, key, prefix, events } = await setup();
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    await waitFor(() => events.onOffer.mock.calls.length > 0);
    expect(events.onOffer).toHaveBeenCalledWith([meta]);
  });

  it('decrypts chunks and completes the file', async () => {
    const { sendSide, key, prefix, events } = await setup();
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
    await waitFor(() => events.onFileComplete.mock.calls.length > 0);

    expect(events.onFileComplete).toHaveBeenCalledTimes(1);
    const arg = events.onFileComplete.mock.calls[0]![0] as { blob?: Blob };
    expect([...new Uint8Array(await arg.blob!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('reports an error and does not complete when a chunk fails its auth tag', async () => {
    const { sendSide, key, prefix, events } = await setup();
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    const frame = await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3]));
    frame[HEADER_BYTES]! ^= 0xff;
    sendSide.send(frame);
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
    // onError fires while handling the data frame, strictly before file-end
    // is handled by the chain. Gating on onError alone would let the
    // assertion below run in the window before file-end's failed-entry
    // short-circuit executes — exactly the property this test exists to
    // guard. The chain is serialized, so a sentinel sent after file-end
    // whose effect (onText) has landed proves file-end was fully handled.
    sendSide.send(await sealedControl(key, prefix, 3n, { t: 'text', content: 'sentinel' }));
    await waitFor(() => events.onText.mock.calls.length > 0);

    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 1, message: expect.stringContaining('a.bin') }),
    );
    expect(events.onFileComplete).not.toHaveBeenCalled();
  });

  it('surfaces a text snippet', async () => {
    const { sendSide, key, prefix, events } = await setup();
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'text', content: 'hi' }));
    await waitFor(() => events.onText.mock.calls.length > 0);
    expect(events.onText).toHaveBeenCalledWith('hi');
  });

  it('reports an error for a data frame with no matching offer', async () => {
    const { sendSide, events } = await setup();
    sendSide.send(encodeFrame(FrameType.Data, 99, 0n, new Uint8Array(20)));
    await waitFor(() => events.onError.mock.calls.length > 0);
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 99, message: expect.stringContaining('never offered') }),
    );
  });

  it('rejects a control frame whose ciphertext was tampered with', async () => {
    const { sendSide, key, prefix, events } = await setup();
    const frame = await sealedControl(key, prefix, 0n, { t: 'text', content: 'hi' });
    frame[frame.length - 1]! ^= 0xff;
    sendSide.send(frame);
    await waitFor(() => events.onError.mock.calls.length > 0);
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('control message') }),
    );
    expect(events.onText).not.toHaveBeenCalled();
  });

  it('processes an offer before the chunks that depend on it', async () => {
    const { sendSide, key, prefix, events } = await setup();
    // Sent back-to-back with no await between: the receiver's chain must not
    // let the faster-to-decrypt data frame overtake the offer.
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([9, 9, 9])));
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
    await waitFor(() => events.onFileComplete.mock.calls.length > 0 || events.onError.mock.calls.length > 0);
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onFileComplete).toHaveBeenCalledTimes(1);
  });

  /**
   * The relay is an active adversary: it sees every frame and can drop, delay,
   * duplicate, reorder and rewrite them at will. Each attack below is mounted
   * with *genuine* frames the sender really produced — every individual auth
   * tag still verifies — so nothing here is caught by per-chunk authentication
   * alone. A file that completes under any of them is silent corruption.
   */
  describe('under a hostile relay', () => {
    it('refuses a file whose data frames were reordered', async () => {
      const { sendSide, key, prefix, events } = await setup();
      sendSide.send(await sealedControl(key, prefix, 0n, {
        t: 'offer-batch', batchId: 'b1', files: [twoChunkMeta],
      }));
      const first = await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3]));
      // Sealed for its true position (offset 3, right after `first`'s 3
      // bytes) — a well-behaved sender always would. Sent before `first`
      // anyway, so it still arrives while entry.bytesReceived is 0 and
      // fails its AAD check immediately, same as before this fix bound the
      // offset in: the two frames were already swapped on the wire.
      const second = await sealedData(key, prefix, 2n, 1, new Uint8Array([4, 5, 6]), 3);
      // Swapped: both tags verify, but the file would reassemble backwards.
      sendSide.send(second);
      sendSide.send(first);
      sendSide.send(await sealedControl(key, prefix, 3n, { t: 'file-end', fileId: 1 }));
      await waitFor(() => events.onError.mock.calls.length > 0 || events.onFileComplete.mock.calls.length > 0);

      expect(events.onFileComplete).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 1, message: expect.stringContaining('two.bin') }),
      );
    });

    it('refuses a file whose final data frame was dropped', async () => {
      const { sendSide, key, prefix, events } = await setup();
      sendSide.send(await sealedControl(key, prefix, 0n, {
        t: 'offer-batch', batchId: 'b1', files: [twoChunkMeta],
      }));
      sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
      // The relay swallows seq 2 and forwards the file-end, so the file would
      // otherwise finish three bytes short with every tag intact.
      sendSide.send(await sealedControl(key, prefix, 3n, { t: 'file-end', fileId: 1 }));
      await waitFor(() => events.onError.mock.calls.length > 0 || events.onFileComplete.mock.calls.length > 0);

      expect(events.onFileComplete).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 1, message: expect.stringContaining('two.bin') }),
      );
    });

    it('discards every replayed control frame but reports it once, so a flood cannot pin an error banner', async () => {
      // The check itself stays per frame — each replay must still be
      // discarded — but the *message* is once per Receiver. A relay
      // replaying one captured frame in a loop would otherwise drive
      // onError at whatever rate the socket allows, and the user would sit
      // behind a permanent error banner for a session that is otherwise fine.
      const { sendSide, key, prefix, events } = await setup();
      const text = await sealedControl(key, prefix, 0n, { t: 'text', content: 'hello' });
      sendSide.send(text);
      await waitFor(() => events.onText.mock.calls.length > 0);

      for (let i = 0; i < 20; i++) sendSide.send(text.slice());
      await waitFor(() => events.onError.mock.calls.length > 0);
      // A later, genuinely-new control frame still gets through, proving the
      // replays were rejected rather than the receiver being wedged.
      sendSide.send(await sealedControl(key, prefix, 1n, { t: 'text', content: 'second' }));
      await waitFor(() => events.onText.mock.calls.length > 1);

      // 20 replays, one snippet each if they had been accepted.
      expect(events.onText).toHaveBeenCalledTimes(2);
      expect(events.onError).toHaveBeenCalledTimes(1);
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('out of order or duplicated') }),
      );
    });

    it('refuses a file with a duplicated data frame', async () => {
      const { sendSide, key, prefix, events } = await setup();
      sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
      const chunk = await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3]));
      sendSide.send(chunk);
      sendSide.send(chunk.slice());
      sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
      await waitFor(() => events.onError.mock.calls.length > 0 || events.onFileComplete.mock.calls.length > 0);

      expect(events.onFileComplete).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 1, message: expect.stringContaining('a.bin') }),
      );
    });

    it('refuses a chunk whose fileId was rewritten into another file', async () => {
      const { sendSide, key, prefix, events } = await setup();
      sendSide.send(await sealedControl(key, prefix, 0n, {
        t: 'offer-batch', batchId: 'b1', files: [meta, otherMeta],
      }));
      // A genuine chunk of a.bin, relabelled by the relay as a chunk of b.bin.
      const chunk = await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3]));
      sendSide.send(rewriteFileId(chunk, 2));
      sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 2 }));
      await waitFor(() => events.onError.mock.calls.length > 0 || events.onFileComplete.mock.calls.length > 0);

      expect(events.onFileComplete).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 2, message: expect.stringContaining('b.bin') }),
      );
    });

    it('refuses a control frame relabelled as file data', async () => {
      const { sendSide, key, prefix, events } = await setup();
      sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
      // A genuine sealed text snippet, retyped and readdressed by the relay so
      // its JSON would be written into a.bin as if it were file content.
      const snippet = await sealedControl(key, prefix, 1n, { t: 'text', content: 'xyz' });
      sendSide.send(rewriteFileId(rewriteType(snippet, FrameType.Data), 1));
      sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
      await waitFor(() => events.onError.mock.calls.length > 0 || events.onFileComplete.mock.calls.length > 0);

      expect(events.onFileComplete).not.toHaveBeenCalled();
      expect(events.onText).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 1, message: expect.stringContaining('a.bin') }),
      );
    });
  });

  it('completes a zero-byte file, which needs no data frames at all', async () => {
    const { sendSide, key, prefix, events } = await setup();
    const empty = { id: 1, name: 'empty.bin', size: 0, type: '' };
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [empty] }));
    sendSide.send(await sealedControl(key, prefix, 1n, { t: 'file-end', fileId: 1 }));
    await waitFor(() => events.onFileComplete.mock.calls.length > 0 || events.onError.mock.calls.length > 0);

    // The length check must read "zero bytes is complete", not "nothing arrived".
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onFileComplete).toHaveBeenCalledTimes(1);
  });

  it('fails the file, with its id, when the sink rejects a write', async () => {
    // The blob sink cannot reject, but Plan 2's File System Access and Service
    // Worker sinks do — disk full, revoked permission, a cancelled download.
    // Left to the chain's catch this reports no fileId, leaves the entry live,
    // and lets later chunks keep writing into a file that then "completes".
    const aborted: string[] = [];
    const sink: SaveSink = {
      write: async () => { throw new Error('no space left on device'); },
      close: async () => undefined,
      abort: async (reason: string) => { aborted.push(reason); },
      assertWithinCap: () => undefined,
    };
    const { sendSide, key, prefix, events } = await setup(() => sink);
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
    sendSide.send(await sealedControl(key, prefix, 3n, { t: 'text', content: 'sentinel' }));
    await waitFor(() => events.onText.mock.calls.length > 0);

    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 1, message: expect.stringContaining('no space left on device') }),
    );
    expect(aborted).toHaveLength(1);
    expect(events.onFileComplete).not.toHaveBeenCalled();
  });

  it('awaits an async sink factory before writing into it', async () => {
    // The File System Access and Service Worker sinks are both built
    // asynchronously — a Save-As dialog, a handshake with the download helper.
    // Not awaiting one puts a *promise* in the entry and every write is lost.
    const written: number[] = [];
    const { sendSide, key, prefix, events } = await setup(async (m) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        write: async (chunk: Uint8Array) => { written.push(...chunk); },
        close: async () => new Blob([new Uint8Array(written)], { type: m.type }),
        abort: async () => undefined,
        assertWithinCap: () => undefined,
      };
    });
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
    await waitFor(() => events.onFileComplete.mock.calls.length > 0 || events.onError.mock.calls.length > 0);

    expect(events.onError).not.toHaveBeenCalled();
    expect(written).toEqual([1, 2, 3]);
  });

  it('reports a rejected sink factory against its own file and leaves the batch alone', async () => {
    // A cancelled Save-As dialog, or a download helper that never answers.
    // Left to the chain's catch this reports no fileId and leaves the entry
    // live, so every later chunk keeps writing into a file that then
    // "completes" with a hole.
    const { sendSide, key, prefix, events } = await setup(async (m) => {
      if (m.id === 1) throw new Error('the user cancelled the save dialog');
      return {
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => undefined,
        assertWithinCap: () => undefined,
      };
    });
    sendSide.send(await sealedControl(key, prefix, 0n, {
      t: 'offer-batch', batchId: 'b1', files: [meta, otherMeta],
    }));
    // The build happens on the first chunk, so that is where the failure lands.
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
    sendSide.send(await sealedData(key, prefix, 2n, 2, new Uint8Array([1, 2, 3])));
    sendSide.send(await sealedControl(key, prefix, 3n, { t: 'file-end', fileId: 2 }));
    await waitFor(() => events.onFileComplete.mock.calls.length > 0);

    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 1, message: expect.stringContaining('cancelled') }),
    );
    // The offer still reported every file, and the second file is unaffected.
    expect(events.onOffer).toHaveBeenCalledWith([meta, otherMeta]);
    expect(events.onFileComplete).toHaveBeenCalledTimes(1);

    // The failed file stays failed: a later chunk must not resurrect it by
    // building a second sink.
    sendSide.send(await sealedData(key, prefix, 4n, 1, new Uint8Array([4, 5, 6])));
    sendSide.send(await sealedControl(key, prefix, 5n, { t: 'file-end', fileId: 1 }));
    sendSide.send(await sealedControl(key, prefix, 6n, { t: 'text', content: 'sentinel' }));
    await waitFor(() => events.onText.mock.calls.length > 0);
    expect(events.onFileComplete).toHaveBeenCalledTimes(1);
  });

  it('does not advance a file that was torn down while its write was in flight', async () => {
    // abortAll can mark a file failed and abort its sink *during* a write. The
    // in-memory sink resolves instantly, but a real streaming sink resolves
    // only as the disk drains, so the resumed continuation would advance the
    // counters and report progress for a file that no longer exists.
    let writeStarted = false;
    let releaseWrite = (): void => undefined;
    const held = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const sink: SaveSink = {
      write: () => { writeStarted = true; return held; },
      close: async () => undefined,
      abort: async () => undefined,
      assertWithinCap: () => undefined,
    };
    const { sendSide, receiver, key, prefix, events } = await setup(() => sink);
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
    await waitFor(() => writeStarted);

    receiver.abortAll('session closed');
    releaseWrite();
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'text', content: 'sentinel' }));
    await waitFor(() => events.onText.mock.calls.length > 0);

    expect(events.onProgress).not.toHaveBeenCalled();
  });

  it('does not report a write that failed only because the file was torn down', async () => {
    // The mirror of the case above: the sink rejects *because* abortAll aborted
    // it. That is the teardown, not a save failure, and reporting it would
    // surface an error for a file the session has already abandoned.
    let writeStarted = false;
    let failWrite = (_reason: Error): void => undefined;
    const held = new Promise<void>((_resolve, reject) => { failWrite = reject; });
    const sink: SaveSink = {
      write: () => { writeStarted = true; return held; },
      close: async () => undefined,
      abort: async () => undefined,
      assertWithinCap: () => undefined,
    };
    const { sendSide, receiver, key, prefix, events } = await setup(() => sink);
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
    await waitFor(() => writeStarted);

    receiver.abortAll('session closed');
    failWrite(new Error('the download was cancelled'));
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'text', content: 'sentinel' }));
    await waitFor(() => events.onText.mock.calls.length > 0);

    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onProgress).not.toHaveBeenCalled();
  });

  describe('sink lifetime', () => {
    /** A sink whose every call is observable, plus the factory that builds it. */
    function trackingFactory() {
      const events = { built: [] as number[], closed: 0, aborted: [] as string[], written: [] as number[] };
      const factory = (m: FileMeta): SaveSink => {
        events.built.push(m.id);
        return {
          write: async (chunk: Uint8Array) => { events.written.push(...chunk); },
          close: async () => { events.closed += 1; return undefined; },
          abort: async (reason: string) => { events.aborted.push(reason); },
          assertWithinCap: () => undefined,
        };
      };
      return { factory, events: events };
    }

    it('builds no sink until a file has data to write', async () => {
      // Offer time builds nothing: N files would otherwise mean N Save-As
      // dialogs or N browser downloads before a byte arrives — and all of it
      // inside the chain that serializes every frame, control frames included.
      const sinks = trackingFactory();
      const { sendSide, key, prefix, events } = await setup(sinks.factory);
      sendSide.send(await sealedControl(key, prefix, 0n, {
        t: 'offer-batch', batchId: 'b1', files: [meta, otherMeta],
      }));
      await waitFor(() => events.onOffer.mock.calls.length > 0);
      expect(sinks.events.built).toEqual([]);

      sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2])));
      await waitFor(() => events.onProgress.mock.calls.length > 0);
      expect(sinks.events.built).toEqual([1]);

      // And exactly one sink per file, however many chunks arrive. Offset 2:
      // right after the first chunk's 2 bytes.
      sendSide.send(await sealedData(key, prefix, 2n, 1, new Uint8Array([3]), 2));
      await waitFor(() => events.onProgress.mock.calls.length > 1);
      expect(sinks.events.built).toEqual([1]);
      expect(sinks.events.written).toEqual([1, 2, 3]);
    });

    it('accounts for a chunk whose buffer the sink took ownership of', async () => {
      // The transfer worker's proxy sink moves the plaintext's buffer to the
      // page instead of copying it, which detaches it here. A detached buffer
      // reports a length of 0, so a byte count read *after* the write would
      // never advance and the file would be failed as incomplete at file-end —
      // silently, on every transfer, for every file.
      const { sendSide, key, prefix, events } = await setup((): SaveSink => ({
        assertWithinCap: (): void => undefined,
        write: async (chunk: Uint8Array): Promise<void> => {
          structuredClone(chunk.buffer, { transfer: [chunk.buffer as ArrayBuffer] });
        },
        close: async (): Promise<undefined> => undefined,
        abort: async (): Promise<void> => undefined,
      }));
      sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
      sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
      sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
      await waitFor(() => events.onFileComplete.mock.calls.length > 0 || events.onError.mock.calls.length > 0);

      expect(events.onError).not.toHaveBeenCalled();
      expect(events.onProgress).toHaveBeenLastCalledWith({ fileId: 1, bytesReceived: 3, totalBytes: 3 });
      expect(events.onFileComplete).toHaveBeenCalledTimes(1);
    });

    it('releases a sink that finished building after the session tore down', async () => {
      // The build is where this now yields — a Save-As dialog can sit open for
      // as long as the user likes. A sink handed back after teardown holds a
      // real file handle or a real browser download, so it must be released
      // rather than inserted into a Receiver the session has already dropped.
      let buildStarted = false;
      let releaseBuild = (): void => undefined;
      const gate = new Promise<void>((resolve) => { releaseBuild = resolve; });
      const aborted: string[] = [];
      const written: number[] = [];
      const { sendSide, receiver, key, prefix, events } = await setup(async () => {
        buildStarted = true;
        await gate;
        return {
          write: async (chunk: Uint8Array) => { written.push(...chunk); },
          close: async () => undefined,
          abort: async (reason: string) => { aborted.push(reason); },
          assertWithinCap: () => undefined,
        };
      });
      sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
      sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
      await waitFor(() => buildStarted);

      receiver.abortAll('session closed');
      releaseBuild();
      sendSide.send(await sealedControl(key, prefix, 2n, { t: 'text', content: 'sentinel' }));
      await waitFor(() => events.onText.mock.calls.length > 0);

      expect(aborted).toHaveLength(1);
      expect(written).toEqual([]);
      expect(events.onProgress).not.toHaveBeenCalled();
      expect(events.onFileComplete).not.toHaveBeenCalled();
    });

    it('still saves a zero-byte file, which never has a chunk to build a sink on', async () => {
      const sinks = trackingFactory();
      const empty = { id: 1, name: 'empty.bin', size: 0, type: '' };
      const { sendSide, key, prefix, events } = await setup(sinks.factory);
      sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [empty] }));
      sendSide.send(await sealedControl(key, prefix, 1n, { t: 'file-end', fileId: 1 }));
      await waitFor(() => events.onFileComplete.mock.calls.length > 0 || events.onError.mock.calls.length > 0);

      // Built at file-end, the only moment it can be, and closed so the file
      // actually lands rather than vanishing.
      expect(events.onError).not.toHaveBeenCalled();
      expect(sinks.events.built).toEqual([1]);
      expect(sinks.events.closed).toBe(1);
      expect(events.onFileComplete).toHaveBeenCalledTimes(1);
    });

    it('still lets the sink refuse a file the tier ceiling let through', async () => {
      // The disk-backed tiers advertise no ceiling, because free disk space is
      // not knowable from here — so the sink itself is the only thing that can
      // refuse, and it does so when it is finally built.
      const written: number[] = [];
      const aborted: string[] = [];
      const { sendSide, key, prefix, events } = await setup(() => ({
        write: async (chunk: Uint8Array) => { written.push(...chunk); },
        close: async () => undefined,
        abort: async (reason: string) => { aborted.push(reason); },
        assertWithinCap: () => { throw new Error('not enough free space on the selected disk'); },
      }), 'fs-access');
      sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
      await waitFor(() => events.onOffer.mock.calls.length > 0);
      // The tier has no ceiling, so the offer itself is accepted.
      expect(events.onError).not.toHaveBeenCalled();

      sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2, 3])));
      sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
      await waitFor(() => events.onError.mock.calls.length > 0);

      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 1, message: expect.stringContaining('free space') }),
      );
      // Refused means refused: nothing written, the sink released, no completion.
      expect(written).toEqual([]);
      expect(aborted).toHaveLength(1);
      expect(events.onFileComplete).not.toHaveBeenCalled();
    });

    it('refuses a file larger than the tier can hold, before any sink exists', async () => {
      // The ceiling is the tier's, checked at offer time with no sink built.
      // The sink's own assertWithinCap stays as the second line of defence.
      const sinks = trackingFactory();
      const huge = { id: 1, name: 'huge.bin', size: BLOB_SINK_MAX_BYTES + 1, type: '' };
      const { sendSide, key, prefix, events } = await setup(sinks.factory);
      sendSide.send(await sealedControl(key, prefix, 0n, {
        t: 'offer-batch', batchId: 'b1', files: [huge, otherMeta],
      }));
      await waitFor(() => events.onOffer.mock.calls.length > 0);

      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 1, message: expect.stringContaining('too large') }),
      );
      expect(sinks.events.built).toEqual([]);

      // The offer still lists every file, and the second one is unaffected.
      expect(events.onOffer).toHaveBeenCalledWith([huge, otherMeta]);
      sendSide.send(await sealedData(key, prefix, 1n, 2, new Uint8Array([1, 2, 3])));
      sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 2 }));
      await waitFor(() => events.onFileComplete.mock.calls.length > 0);
      expect(events.onFileComplete).toHaveBeenCalledTimes(1);

      // A chunk for the refused file is refused too: it was never registered.
      sendSide.send(await sealedData(key, prefix, 3n, 1, new Uint8Array([1])));
      await waitFor(() => events.onError.mock.calls.length > 1);
      expect(events.onError).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 1, message: expect.stringContaining('never offered') }),
      );
    });
  });

  it('aborts every in-flight sink when the session tears it down', async () => {
    const aborted: string[] = [];
    const sink: SaveSink = {
      write: async () => undefined,
      close: async () => undefined,
      abort: async (reason: string) => { aborted.push(reason); },
      assertWithinCap: () => undefined,
    };
    const { sendSide, receiver, key, prefix, events } = await setup(() => sink);
    sendSide.send(await sealedControl(key, prefix, 0n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    // A chunk first: sinks are built on demand, so a file that has had no data
    // has nothing to release yet.
    sendSide.send(await sealedData(key, prefix, 1n, 1, new Uint8Array([1, 2])));
    await waitFor(() => events.onProgress.mock.calls.length > 0);

    receiver.abortAll('session closed');
    await waitFor(() => aborted.length > 0);
    expect(aborted).toEqual(['session closed']);

    // The entry is gone, so a late file-end cannot resurrect and complete it.
    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
    sendSide.send(await sealedControl(key, prefix, 3n, { t: 'text', content: 'sentinel' }));
    await waitFor(() => events.onText.mock.calls.length > 0);
    expect(events.onFileComplete).not.toHaveBeenCalled();
  });
});

describe('cancelling an incoming file', () => {
  /** A sink that records what happened to it, so a test can tell abort from close. */
  function trackingSink() {
    const state = { written: 0, closed: false, aborted: undefined as string | undefined };
    const sink: SaveSink = {
      assertWithinCap() {},
      async write(chunk) { state.written += chunk.length; },
      async close() { state.closed = true; return undefined; },
      async abort(reason) { state.aborted = reason; },
    };
    return { sink, state };
  }

  it('aborts the sink rather than closing it, so no truncated file is left behind', async () => {
    const { sink, state } = trackingSink();
    const { sendSide, receiver, key, prefix, events } = await setup(() => sink);
    const onFileCancelled = vi.fn();
    Reflect.set(events, 'onFileCancelled', onFileCancelled);

    sendSide.send(await sealedControl(key, prefix, 1n, { t: 'offer-batch', batchId: 'b1', files: [twoChunkMeta] }));
    sendSide.send(await sealedData(key, prefix, 2n, 1, new Uint8Array([1, 2, 3])));
    await waitFor(() => state.written === 3);

    await receiver.cancelIncoming([1]);

    // A close() would leave three bytes on disk under the real filename,
    // indistinguishable from a whole file. This is the same path a failed
    // integrity check takes.
    expect(state.aborted).toBeDefined();
    expect(state.closed).toBe(false);
  });

  it('drops chunks that were already in flight, instead of alarming about them', async () => {
    const { sink, state } = trackingSink();
    const { sendSide, receiver, key, prefix, events } = await setup(() => sink);

    sendSide.send(await sealedControl(key, prefix, 1n, { t: 'offer-batch', batchId: 'b1', files: [twoChunkMeta] }));
    sendSide.send(await sealedData(key, prefix, 2n, 1, new Uint8Array([1, 2, 3])));
    await waitFor(() => state.written === 3);
    await receiver.cancelIncoming([1]);

    // The peer's send loop has not noticed yet — exactly what happens on a
    // real connection, once per chunk still in the pipe.
    sendSide.send(await sealedData(key, prefix, 3n, 1, new Uint8Array([4, 5, 6]), 3));
    await new Promise((r) => setTimeout(r, 50));

    expect(state.written).toBe(3);
    // Without the remembered-cancelled set this is "Received data for a file
    // that was never offered", once per late chunk.
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('never completes a cancelled file, even when its file-end arrives', async () => {
    const { sink } = trackingSink();
    const { sendSide, receiver, key, prefix, events } = await setup(() => sink);

    sendSide.send(await sealedControl(key, prefix, 1n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    await waitFor(() => events.onOffer.mock.calls.length === 1);
    await receiver.cancelIncoming([1]);

    sendSide.send(await sealedControl(key, prefix, 2n, { t: 'file-end', fileId: 1 }));
    await new Promise((r) => setTimeout(r, 50));

    expect(events.onFileComplete).not.toHaveBeenCalled();
  });

  it('is a no-op for a file it has no entry for', async () => {
    const { receiver, events } = await setup();
    await expect(receiver.cancelIncoming([404])).resolves.toBeUndefined();
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('routes the peer cancel frame out to Session rather than acting on it here', async () => {
    const { sendSide, key, prefix, events } = await setup();
    const onCancel = vi.fn();
    Reflect.set(events, 'onCancel', onCancel);

    sendSide.send(await sealedControl(key, prefix, 1n, { t: 'cancel', side: 'yours', fileIds: [7] }));
    await waitFor(() => onCancel.mock.calls.length === 1);

    // Handed over unvalidated on purpose: only Session knows which fileIds
    // this device actually queued for sending.
    expect(onCancel).toHaveBeenCalledWith('yours', [7]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { DEFERRED_OVERFLOW, MALFORMED_HELLO, Session, UNVERIFIED } from '../../client/session.js';
import { FrameType, decodeControl, decodeFrame, encodeControl, encodeFrame, encodeHeader } from '../../client/protocol.js';
import {
  deriveSession, exportPublicKey, generateKeyPair, importKey, makeNonce, seal, toBase64Url,
} from '../../client/crypto.js';
import {
  agreedKey, confirmBoth, helloPub, rawConfirm, rawHello, rawIdentity, sealedControl,
  type RawIdentity,
} from '../pairing.js';
import { CHUNK_SIZE } from '../../client/transfer/sender.js';
import type { ControlMessage } from '../../shared/messages.js';

(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

/**
 * getRandomValues rejects requests over 65536 bytes, so a single call over a
 * larger buffer would leave the tail as zeros — and corruption confined to
 * those chunks would be invisible to a byte comparison.
 */
// The explicit ArrayBuffer type argument keeps the result usable as a BlobPart:
// TS 5.7+ widens a bare Uint8Array to Uint8Array<ArrayBufferLike>, which File
// rejects. Same reason as the `as BufferSource` casts in client/crypto.ts.
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const MAX_PER_CALL = 65_536;
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += MAX_PER_CALL) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + MAX_PER_CALL, length)));
  }
  return bytes;
}

/** Real-time polling: crypto.subtle work cannot be observed by flushing microtasks. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface RawPeer {
  socket: WebSocket;
  /** Every binary frame the peer has received, in arrival order. */
  frames: Uint8Array[];
}

/**
 * A bare relay peer, so a test can put arbitrary bytes on the wire and read
 * back exactly what the session under test transmitted.
 */
async function rawPeer(url: string, code: string): Promise<RawPeer> {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const frames: Uint8Array[] = [];
  await new Promise<void>((resolve) => { socket.addEventListener('open', () => resolve()); });
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') return;
    frames.push(new Uint8Array(event.data as ArrayBuffer));
  });
  const joined = new Promise<void>((resolve) => {
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      if ((JSON.parse(event.data) as { t: string }).t === 'joined') resolve();
    });
  });
  socket.send(JSON.stringify({ t: 'join', code }));
  await joined;
  return { socket, frames };
}

/**
 * Sequence numbers off the wire. Hello frames are excluded: they are unsealed,
 * carry a fixed seq of 0n, and derive no nonce.
 */
function seqsOf(frames: Uint8Array[]): bigint[] {
  return frames.map((f) => decodeFrame(f)).filter((f) => f.type !== FrameType.Hello).map((f) => f.seq);
}

function sealedText(key: CryptoKey, prefix: Uint8Array, seq: bigint, content: string): Promise<Uint8Array> {
  return sealedControl(key, prefix, seq, { t: 'text', content });
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('end-to-end over the relay', () => {
  it('transfers a file byte-identically between two sessions', async () => {
    const url = await start();
    const host = await Session.create(url);

    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    const bytes = randomBytes(200_000);

    const received = new Promise<Uint8Array>((resolve, reject) => {
      guest.events.onFileComplete = async ({ blob }) => {
        if (!blob) { reject(new Error('no blob')); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
      guest.events.onError = (e) => reject(new Error(e.message));
    });

    await host.sendFiles([new File([bytes], 'big.bin', { type: 'application/octet-stream' })]);
    expect(Buffer.compare(Buffer.from(await received), Buffer.from(bytes))).toBe(0);

    host.close();
    guest.close();
  }, 20_000);

  /*
   * The ordering IS the test. "Sent" used to fire the instant the last frame
   * was handed to transport.send(), which says nothing about whether
   * anything received it — both transports drop a frame silently when their
   * channel is not open, and a WebRTC channel with a dead network path stays
   * open for as long as ICE takes to give up. A real session (2026-08-29)
   * lost a batch to exactly that: sender all "Sent", receiver all 0 bytes,
   * no error anywhere. So the arrival must come first, always.
   */
  it('reports a file sent only once the other device says it has it', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    const order: string[] = [];
    guest.events.onFileComplete = () => { order.push('arrived'); };
    host.events.onSendFileDone = () => { order.push('reported sent'); };

    await host.sendFiles([new File([randomBytes(50_000)], 'a.bin')]);
    await waitFor(() => order.includes('reported sent'));
    expect(order).toEqual(['arrived', 'reported sent']);

    host.close();
    guest.close();
  }, 20_000);

  it('carries a text snippet in the other direction', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    const got = new Promise<string>((resolve, reject) => {
      host.events.onText = resolve;
      // Without this, a decryption or routing failure shows up as a 20-second
      // timeout instead of the actual message.
      host.events.onError = (e) => reject(new Error(e.message));
    });
    await guest.sendText('from the guest');
    expect(await got).toBe('from the guest');

    host.close();
    guest.close();
  }, 20_000);

  it('re-pairs with a replacement peer after the first one leaves', async () => {
    const url = await start();
    const host = await Session.create(url);

    const firstGuest = await Session.join(url, host.code);
    await confirmBoth(host, firstGuest);
    const departed = new Promise<string>((resolve) => { host.events.onPeerLeft = resolve; });
    firstGuest.close();
    expect(await departed).toBe('peer-left');

    // The room outlives the departing peer because the host is still attached,
    // so a replacement takes the free slot with the same code and key.
    const secondGuest = await Session.join(url, host.code);
    await confirmBoth(host, secondGuest);

    const bytes = randomBytes(120_000);
    const received = new Promise<Uint8Array>((resolve, reject) => {
      secondGuest.events.onFileComplete = async ({ blob }) => {
        if (!blob) { reject(new Error('no blob')); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
      secondGuest.events.onError = (e) => reject(new Error(e.message));
    });

    // The host's original Sender was aborted on peer-left; this only works if
    // it was rebuilt, and only decrypts if both sides re-handshook.
    await host.sendFiles([new File([bytes], 'again.bin', { type: 'application/octet-stream' })]);
    expect(Buffer.compare(Buffer.from(await received), Buffer.from(bytes))).toBe(0);

    const echoed = new Promise<string>((resolve, reject) => {
      host.events.onText = resolve;
      host.events.onError = (e) => reject(new Error(e.message));
    });
    await secondGuest.sendText('second guest speaking');
    expect(await echoed).toBe('second guest speaking');

    host.close();
    secondGuest.close();
  }, 20_000);

  it('transfers a zero-byte file, which never has a chunk to build a sink on', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    const received: { name: string; bytes: number }[] = [];
    const errors: string[] = [];
    guest.events.onError = (e) => { errors.push(e.message); };
    guest.events.onFileComplete = ({ meta, blob }) => {
      received.push({ name: meta.name, bytes: blob?.size ?? -1 });
    };

    await host.sendFiles([new File([], 'empty.bin')]);
    await waitFor(() => received.length > 0 || errors.length > 0);

    expect(errors).toEqual([]);
    expect(received).toEqual([{ name: 'empty.bin', bytes: 0 }]);

    host.close();
    guest.close();
  }, 20_000);

  it('applies the ceiling of the tier it advertised, not a default one', async () => {
    const url = await start();
    const prefix = Uint8Array.from([1, 2, 3]);
    // Bigger than tab memory can hold, small enough to describe in one frame:
    // the offer is just metadata, so no bytes have to exist for this.
    const huge = { id: 1, name: 'huge.bin', size: 600 * 1024 * 1024, type: '' };
    const offer: ControlMessage = { t: 'offer-batch', batchId: 'b1', files: [huge] };

    // The in-memory tier holds the whole file in the tab, so an offer past its
    // ceiling is refused at offer time — before a byte moves, which is the
    // entire point of announcing the tier in the hello.
    const memory = await Session.create(url, { saveCapability: 'blob' });
    const memoryErrors: { fileId?: number; message: string }[] = [];
    memory.events.onError = (e) => { memoryErrors.push(e); };
    const memoryPeer = await rawPeer(url, memory.code);
    const memoryId = await rawIdentity();
    memoryPeer.socket.send(rawHello(toBase64Url(prefix), memoryId.pub));
    const memoryKey = await agreedKey(memoryPeer.frames, memoryId, memory.code);
    memoryPeer.socket.send(await sealedControl(memoryKey, prefix, 0n, offer));
    await waitFor(() => memoryErrors.length > 0);
    expect(memoryErrors[0]).toMatchObject({ fileId: 1, message: expect.stringContaining('too large') });

    // The streaming tier is bounded by free disk space, which this side cannot
    // know, so the same offer must pass. A session that fell back to the
    // in-memory ceiling here would refuse files it had just told the peer it
    // could take.
    const streamed = await Session.create(url, { saveCapability: 'sw-stream' });
    const streamedErrors: { fileId?: number; message: string }[] = [];
    const offered: string[] = [];
    streamed.events.onError = (e) => { streamedErrors.push(e); };
    streamed.events.onOffer = (files) => { offered.push(...files.map((f) => f.name)); };
    const streamedPeer = await rawPeer(url, streamed.code);
    const streamedId = await rawIdentity();
    streamedPeer.socket.send(rawHello(toBase64Url(prefix), streamedId.pub));
    const streamedKey = await agreedKey(streamedPeer.frames, streamedId, streamed.code);
    streamedPeer.socket.send(await sealedControl(streamedKey, prefix, 0n, offer));
    await waitFor(() => offered.length > 0);
    expect(streamedErrors).toEqual([]);

    memoryPeer.socket.close();
    streamedPeer.socket.close();
    memory.close();
    streamed.close();
  }, 20_000);

  it('advertises the save tier this device can actually use', async () => {
    const url = await start();
    // The hello is what the *sender* plans around: it decides whether to warn
    // about a file that will not survive before it starts pushing gigabytes.
    // A hard-coded 'blob' here makes every peer warn about every large file.
    const host = await Session.create(url, { saveCapability: 'sw-stream' });
    const peer = await rawPeer(url, host.code);
    await waitFor(() => peer.frames.length > 0);

    const frame = decodeFrame(peer.frames[0]!);
    expect(frame.type).toBe(FrameType.Hello);
    const hello = decodeControl(frame.payload);
    expect(hello.t).toBe('hello');
    expect(hello).toMatchObject({ saveCapability: 'sw-stream' });

    host.close();
  }, 20_000);

  it('saves with the tier it advertised rather than falling back to memory', async () => {
    const url = await start();
    const host = await Session.create(url);
    // Claims the streaming tier with no download helper registered. Every file
    // must fail loudly: a quiet fall back to the in-memory sink would cap this
    // device at 512 MB after telling the peer it could take any size.
    const guest = await Session.join(url, host.code, { saveCapability: 'sw-stream' });
    await confirmBoth(host, guest);

    const errors: { fileId?: number; message: string }[] = [];
    const completed: string[] = [];
    guest.events.onError = (e) => { errors.push(e); };
    guest.events.onFileComplete = ({ meta }) => { completed.push(meta.name); };

    await host.sendFiles([new File([new Uint8Array([1, 2, 3])], 'x.bin')]);
    await waitFor(() => errors.length > 0);

    expect(errors[0]).toMatchObject({ fileId: 1, message: expect.stringContaining('not registered') });
    expect(completed).toEqual([]);

    host.close();
    guest.close();
  }, 20_000);

  it('rejects a send when the session closes before a peer ever arrives', async () => {
    const url = await start();
    const host = await Session.create(url);

    const pendingFiles = host.sendFiles([new File([new Uint8Array([1])], 'never.bin')]);
    const pendingText = host.sendText('never');
    host.close();

    await expect(pendingFiles).rejects.toThrow(/session closed/);
    await expect(pendingText).rejects.toThrow(/session closed/);

    // A send issued *after* the close must fail too, rather than registering a
    // waiter that nothing is left to settle.
    await expect(host.sendFiles([new File([new Uint8Array([1])], 'later.bin')]))
      .rejects.toThrow(/session closed/);
  }, 20_000);

  it('reports a malformed frame instead of wedging the handshake', async () => {
    const url = await start();
    const host = await Session.create(url);

    const errors: string[] = [];
    host.events.onError = (e) => { errors.push(e.message); };

    const peer = await rawPeer(url, host.code);
    const identity = await rawIdentity();
    const pending = host.sendFiles([new File([new Uint8Array([1, 2, 3])], 'x.bin')]);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    // Shorter than a frame header, so decodeFrame throws; then a hello whose
    // noncePrefix is not a string, so fromBase64Url would throw after the
    // 'hello' check passes and before #remoteNoncePrefix is assigned. Both run
    // inside the WebSocket listener, where an escaping throw would leave the
    // handshake unsettled and the session wedged forever.
    peer.socket.send(new Uint8Array([1, 2, 3]));
    await waitFor(() => errors.some((m) => /too short/i.test(m)));

    // Each bad hello must be rejected by its own guard and reported as such —
    // not merely land in the catch, and not be accepted as a nonce prefix.
    peer.socket.send(rawHello(7, identity.pub));
    await waitFor(() => errors.filter((m) => m === MALFORMED_HELLO).length >= 1);

    peer.socket.send(rawHello('not-three-bytes-long', identity.pub));
    await waitFor(() => errors.filter((m) => m === MALFORMED_HELLO).length >= 2);

    // A hello with no usable public key in it is the same class of failure,
    // and reaches the same guard: without a peer key there is no session key,
    // so accepting it would leave a paired session that can never decrypt.
    peer.socket.send(rawHello(toBase64Url(new Uint8Array([1, 2, 3])), 7 as unknown as string));
    await waitFor(() => errors.filter((m) => m === MALFORMED_HELLO).length >= 3);

    // The decisive check: none of the above may complete the handshake. A
    // 15-byte prefix accepted here would settle this send with a nonce prefix
    // that can never decrypt.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    // Still live: a well-formed hello completes the handshake and releases the
    // send that was waiting on it. It is released as a rejection, not a
    // transfer — nobody has compared the verification number yet, and
    // `Session` refuses to put bytes on the wire until both ends have — but
    // released is the point: the handshake settled rather than wedging.
    const prefix = new Uint8Array([1, 2, 3]);
    peer.socket.send(rawHello(toBase64Url(prefix), identity.pub));
    await expect(pending).rejects.toThrow(UNVERIFIED);

    // And once both ends confirm, the same send works.
    const key = await agreedKey(peer.frames, identity, host.code);
    await rawConfirm(host, (f) => peer.socket.send(f), key, prefix, 0n);
    await expect(host.sendFiles([new File([new Uint8Array([1, 2, 3])], 'x.bin')])).resolves.toHaveLength(1);

    peer.socket.close();
    host.close();
  }, 20_000);

  it('rejects a hello claiming this session\'s own peer id', async () => {
    const url = await start();
    const host = await Session.create(url);
    const errors: string[] = [];
    host.events.onError = (e) => { errors.push(e.message); };

    const peer = await rawPeer(url, host.code);
    const pending = host.sendText('waiting on the handshake');
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    // Two peers sharing an id would share a nonce space under one key — the
    // catastrophic case. Caught at the handshake, where it can be named,
    // rather than as an unexplained integrity failure on the first chunk.
    const identity = await rawIdentity();
    const prefix = new Uint8Array([1, 2, 3]);
    peer.socket.send(rawHello(toBase64Url(prefix), identity.pub, 'a'));
    await waitFor(() => errors.filter((m) => m === MALFORMED_HELLO).length >= 1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    // A hello from a properly distinct peer still completes the handshake —
    // settling the waiting send rather than leaving it pending forever. It
    // settles as a rejection because the verification number has not been
    // confirmed at either end yet; the send that follows the confirmation is
    // the one that goes.
    peer.socket.send(rawHello(toBase64Url(prefix), identity.pub, 'b'));
    await expect(pending).rejects.toThrow(UNVERIFIED);

    const key = await agreedKey(peer.frames, identity, host.code);
    await rawConfirm(host, (f) => peer.socket.send(f), key, prefix, 0n);
    await expect(host.sendText('after both ends confirmed')).resolves.toBeUndefined();

    peer.socket.close();
    host.close();
  }, 20_000);

  it('replays frames that arrived before the handshake, in order', async () => {
    const url = await start();
    const host = await Session.create(url);
    const prefix = new Uint8Array([1, 2, 3]);

    const texts: string[] = [];
    const errors: string[] = [];
    host.events.onText = (c) => { texts.push(c); };
    host.events.onError = (e) => { errors.push(e.message); };

    const peer = await rawPeer(url, host.code);
    const identity = await rawIdentity();
    // The raw peer can derive the session key as soon as the host's own hello
    // lands — the host cannot derive it back until this peer says hello,
    // which is exactly the window this test fires into.
    const key = await agreedKey(peer.frames, identity, host.code);
    // Sealed under a prefix the host has not been told yet, so it cannot open
    // them on arrival. They must be buffered rather than dropped, and replayed
    // in arrival order once the hello supplies the prefix.
    peer.socket.send(await sealedText(key, prefix, 0n, 'one'));
    peer.socket.send(await sealedText(key, prefix, 1n, 'two'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(texts).toEqual([]);

    peer.socket.send(rawHello(toBase64Url(prefix), identity.pub));
    await waitFor(() => texts.length >= 2);
    expect(texts).toEqual(['one', 'two']);
    expect(errors).toEqual([]);

    peer.socket.close();
    host.close();
  }, 20_000);

  it('caps the pre-handshake buffer instead of growing it without limit', async () => {
    const url = await start();
    const host = await Session.create(url);
    const errors: string[] = [];
    host.events.onError = (e) => { errors.push(e.message); };

    const peer = await rawPeer(url, host.code);
    // A hello always precedes data on the real protocol path, so a relay that
    // sends only data frames is holding unauthenticated bytes in memory on our
    // behalf. Past the cap they are dropped, and said once rather than 300 times.
    for (let i = 0; i < 300; i++) {
      peer.socket.send(encodeFrame(FrameType.Control, 0, BigInt(i), new Uint8Array(32)));
    }
    await waitFor(() => errors.includes(DEFERRED_OVERFLOW));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors.filter((m) => m === DEFERRED_OVERFLOW)).toHaveLength(1);

    peer.socket.close();
    host.close();
  }, 20_000);

  it('does not claim the peer left when the close is local', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    const hostSawPeerLeave: string[] = [];
    host.events.onPeerLeft = (reason) => { hostSawPeerLeave.push(reason); };
    const guestSawPeerLeave = new Promise<string>((resolve) => { guest.events.onPeerLeft = resolve; });

    host.close();

    // The guest genuinely did lose its peer and must be told.
    expect(await guestSawPeerLeave).toBe('peer-left');
    // The side that closed must not be: Plan 2 binds this event to "Other
    // device disconnected", so firing it here would have closing your own tab
    // claim the other device vanished.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hostSawPeerLeave).toEqual([]);

    guest.close();
  }, 20_000);

  it('never restarts the sequence counter when the Sender is rebuilt', async () => {
    const url = await start();
    const host = await Session.create(url);

    // Three pairings in one session. Each rebuild mints a fresh 3-byte prefix,
    // which can collide — the 2^24 space is small and an untrusted relay can
    // force unbounded rebuilds by synthesising peer-left. What must never
    // repeat is the seq, so the counter has to carry across every rebuild.
    const perPairing: bigint[][] = [];
    for (const prefix of [[1, 2, 3], [4, 5, 6], [7, 8, 9]]) {
      const peer = await rawPeer(url, host.code);
      const identity = await rawIdentity();
      const bytes = Uint8Array.from(prefix);
      peer.socket.send(rawHello(toBase64Url(bytes), identity.pub));
      // Each pairing is a different peer, so each agrees a different key and
      // shows a different number — and each has to be confirmed again.
      await rawConfirm(host, (f) => peer.socket.send(f), await agreedKey(peer.frames, identity, host.code), bytes, 0n);

      await host.sendFiles([new File([new Uint8Array([9, 9, 9])], 'x.bin')]);
      // the host's own 'verified', offer-batch, one data chunk, file-end.
      await waitFor(() => seqsOf(peer.frames).length >= 4);
      perPairing.push(seqsOf(peer.frames));

      const departed = new Promise<void>((resolve) => { host.events.onPeerLeft = () => resolve(); });
      peer.socket.close();
      await departed;
    }

    const first = perPairing[0]!;
    const second = perPairing[1]!;
    const third = perPairing[2]!;

    // A restarted counter would put 0n at the head of every pairing.
    expect(first[0]).toBe(0n);
    expect(second[0]! > first.at(-1)!).toBe(true);
    expect(third[0]! > second.at(-1)!).toBe(true);
    expect(second[0]! > 0n).toBe(true);

    // Strictly increasing across the whole session, so no nonce can repeat
    // even if two pairings drew the same prefix.
    const all = perPairing.flat();
    for (let i = 1; i < all.length; i++) expect(all[i]! > all[i - 1]!).toBe(true);
    expect(new Set(all.map(String)).size).toBe(all.length);

    host.close();
  }, 20_000);

  it('puts nothing in the share link but the room code', async () => {
    const url = await start();
    const host = await Session.create(url);
    // The link used to end in `#<43 characters of key>`, which is what made
    // it the only way in. It is now short enough to read out.
    expect(host.shareUrl).toMatch(/\/s\/[0-9A-Z]{6}$/);
    expect(new URL(host.shareUrl).hash).toBe('');
    expect(new URL(host.shareUrl).search).toBe('');
    host.close();
  });

  it('never transmits the agreed key, only the public halves of the exchange', async () => {
    const url = await start();
    const transmitted: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: unknown) {
      if (typeof data === 'string') transmitted.push(data);
      else if (data instanceof ArrayBuffer) transmitted.push(new TextDecoder().decode(data));
      else if (ArrayBuffer.isView(data)) transmitted.push(new TextDecoder().decode(data as Uint8Array));
      return originalSend.call(this, data as never);
    };

    try {
      const host = await Session.create(url);
      // A raw peer rather than a second Session, for one reason: it is the
      // only side of a pairing whose private key this test can hold, so it
      // is the only way to name the agreed key and then look for it in the
      // traffic. What travels is each side's PUBLIC key; the 32 bytes both
      // sides compute from them must never appear.
      const peer = await rawPeer(url, host.code);
      const identity = await rawIdentity();
      const prefix = new Uint8Array([4, 5, 6]);
      peer.socket.send(rawHello(toBase64Url(prefix), identity.pub));
      const key = await agreedKey(peer.frames, identity, host.code);
      await rawConfirm(host, (f) => peer.socket.send(f), key, prefix, 0n);
      await host.sendFiles([new File([new Uint8Array([1, 2, 3])], 'x.bin')]);

      const { rawKey } = await deriveSession(identity.pair.privateKey, helloPub(peer.frames)!, host.code);
      const agreed = toBase64Url(rawKey);
      // Without this guard the assertion below passes vacuously.
      expect(transmitted.length).toBeGreaterThan(0);
      expect(transmitted.join('\n')).not.toContain(agreed);
      // The digits shown on screen are derived from that same secret, so they
      // must not be on the wire either — a relay that could read them could
      // pass its own machine-in-the-middle off as the real peer.
      expect(transmitted.join('\n')).not.toContain(host.verification);

      peer.socket.close();
      host.close();
    } finally {
      WebSocket.prototype.send = originalSend;
    }
  }, 20_000);

  // Fix-round-1, Important: #sendResumePoints() can fire twice for one
  // reconnect episode — once directly from #resumeAfterReconnect, once more
  // when the peer's own reply hello arrives at #route's samePeerReconnected
  // branch — so the reconnecting side can end up sending two resume-from
  // messages for the same file. A hostile peer can also just spam
  // resume-from directly for the same effect (Ruling F amplification).
  // Either way, #handleResumeFrom must not let a second one start a second,
  // concurrent resumeFile() call while the first is still in flight.
  it('ignores a second resume-from for a fileId while the first is still resuming it', async () => {
    const url = await start();
    const host = await Session.create(url);
    const prefix = new Uint8Array([9, 9, 9]);

    const peer = await rawPeer(url, host.code);
    const identity = await rawIdentity();
    peer.socket.send(rawHello(toBase64Url(prefix), identity.pub));
    const key = await agreedKey(peer.frames, identity, host.code);
    await rawConfirm(host, (f) => peer.socket.send(f), key, prefix, 0n);

    const CHUNKS = 6;
    const bytes = randomBytes(CHUNK_SIZE * CHUNKS);
    const peerLeft = new Promise<void>((resolve) => { host.events.onPeerLeft = () => resolve(); });
    // Not awaited: the peer disconnects (below) before this gets anywhere,
    // aborting it — Sender.abort means onFileDone never fires for it, so
    // fileId 1 stays in Session's #queuedFiles map forever, exactly as it
    // would after a genuine reconnect-worthy disconnect (Ruling I).
    void host.sendFiles([new File([bytes], 'x.bin')]).catch(() => undefined);
    peer.socket.close();
    await peerLeft;

    // The peer "reconnects" — same room slot, same prefix, so #route
    // recognises it as the same peer. This test is about resume-from
    // handling specifically, not about the prefix-comparison logic.
    const peer2 = await rawPeer(url, host.code);
    // The same public key as well as the same prefix: a reconnecting peer
    // re-sends the key it already agreed, so the host re-derives nothing and
    // both confirmations survive the round trip.
    peer2.socket.send(rawHello(toBase64Url(prefix), identity.pub));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Two resume-from requests for the same fileId, back to back — exactly
    // what a double-fire of #sendResumePoints (or a hostile peer) produces.
    peer2.socket.send(await sealedControl(key, prefix, 1n, { t: 'resume-from', fileId: 1, bytesReceived: 0 }));
    peer2.socket.send(await sealedControl(key, prefix, 2n, { t: 'resume-from', fileId: 1, bytesReceived: 0 }));

    const dataFrameCount = (): number => peer2.frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).length;
    // The decisive check: a broken guard lets two concurrent resumeFile()
    // calls each resend the whole file, landing 2×CHUNKS data frames on the
    // wire; the fix leaves exactly CHUNKS, from a single resume.
    await waitFor(() => dataFrameCount() >= CHUNKS);
    // Give a second, redundant resumeFile() call a real chance to also have
    // put frames on the wire by now, if the guard were not there.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dataFrameCount()).toBe(CHUNKS);

    host.close();
    peer2.socket.close();
  }, 20_000);
});

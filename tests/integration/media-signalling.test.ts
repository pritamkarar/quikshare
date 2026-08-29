import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { Session } from '../../client/session.js';
import { FrameType, decodeControl, decodeFrame } from '../../client/protocol.js';
import { toBase64Url } from '../../client/crypto.js';
import type { MediaControl } from '../../shared/messages.js';
import { agreedKey, confirmBoth, rawConfirm, rawHello, rawIdentity } from '../pairing.js';

(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

afterEach(async () => { await app?.close(); app = undefined; });

/** Real-time polling: crypto.subtle work cannot be observed by flushing microtasks. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/*
 * A real SDP is multi-line and full of punctuation a naive substring search
 * could miss for the wrong reason (e.g. only checking one line). This one is
 * short but exercises the same shape `createOffer` produces.
 */
const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n';

describe('media signalling: session to session', () => {
  it('carries a media offer between peers, sealed', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    let seen: MediaControl | undefined;
    guest.events.onMediaSignal = (signal) => { seen = signal; };

    await host.sendMediaSignal({ t: 'media-offer', offer: { sdp: SDP, kind: 'camera' } });
    await waitFor(() => seen !== undefined);
    expect(seen).toEqual({ t: 'media-offer', offer: { sdp: SDP, kind: 'camera' } });

    host.close(); guest.close();
  }, 20_000);

  /*
   * The other three shapes carried by the same path, condensed into one
   * test rather than three near-duplicates of the one above: an answer, a
   * trickled ICE candidate, and the payload-less stop.
   */
  it('carries an answer, an ice candidate, and a stop, each already-parsed', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    const seen: MediaControl[] = [];
    guest.events.onMediaSignal = (signal) => { seen.push(signal); };

    await host.sendMediaSignal({ t: 'media-answer', answer: { sdp: SDP } });
    await host.sendMediaSignal({
      t: 'media-ice',
      ice: { candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    await host.sendMediaSignal({ t: 'media-stop' });
    await waitFor(() => seen.length === 3);

    expect(seen[0]).toEqual({ t: 'media-answer', answer: { sdp: SDP } });
    expect(seen[1]).toEqual({
      t: 'media-ice',
      ice: { candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(seen[2]).toEqual({ t: 'media-stop' });

    host.close(); guest.close();
  }, 20_000);

  /*
   * The claim in shared/messages.ts, tested rather than asserted: media SDP
   * must never appear in the clear on the wire. Same discipline as
   * device-exchange.test.ts, which does this for the device panel — reusing
   * its raw-peer harness rather than writing a new one.
   */
  it('never puts media sdp on the wire in the clear', async () => {
    const url = await start();
    const host = await Session.create(url);

    // A bare relay peer, so this test reads exactly the bytes the session
    // transmitted rather than what a second Session says it received.
    const socket = new NodeWebSocket(url);
    socket.binaryType = 'arraybuffer';
    const frames: Uint8Array[] = [];
    await new Promise<void>((resolve) => { socket.on('open', () => resolve()); });
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) frames.push(new Uint8Array(data));
    });
    const joined = new Promise<void>((resolve) => {
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary && (JSON.parse(data.toString()) as { t: string }).t === 'joined') resolve();
      });
    });
    socket.send(JSON.stringify({ t: 'join', code: host.code }));
    await joined;

    // A hello is what completes the pairing that host.sendMediaSignal below
    // needs, so this raw peer has to send one, exactly as the device-exchange
    // harness does — carrying a real public key, since the session derives
    // its key from it.
    const identity = await rawIdentity();
    const prefix = new Uint8Array([0, 0, 0]);
    socket.send(rawHello(toBase64Url(prefix), identity.pub));
    // And both ends have to confirm the verification number, because nothing
    // — media signalling included — goes out before they do.
    await rawConfirm(
      host, (frame) => socket.send(frame),
      await agreedKey(frames, identity, host.code), prefix, 0n,
    );

    // `sendMediaSignal` awaits the handshake itself (see Session.sendMediaSignal's
    // doc comment), so this resolves only once the hello above has actually
    // landed — no separate wait is needed here.
    await host.sendMediaSignal({ t: 'media-offer', offer: { sdp: SDP, kind: 'camera' } });

    // One sealed control frame is the offer; without waiting for it this
    // test would pass on an empty wire and prove nothing.
    await waitFor(() => frames.some((f) => decodeFrame(f).type === FrameType.Control));

    const hellos = frames.filter((f) => decodeFrame(f).type === FrameType.Hello);
    expect(hellos.length).toBeGreaterThan(0);
    for (const frame of hellos) {
      const msg = decodeControl(decodeFrame(frame).payload) as Record<string, unknown>;
      expect(Object.keys(msg).sort()).toEqual(
        ['maxBufferedBytes', 'noncePrefix', 'peerId', 'pub', 'saveCapability', 't'],
      );
    }

    // And nowhere else either: the SDP must not appear as plaintext bytes in
    // ANY frame the relay handled, sealed or otherwise.
    const wire = Buffer.concat(frames.map((f) => Buffer.from(f))).toString('latin1');
    expect(wire).not.toContain(SDP);
    expect(wire).not.toContain('v=0');

    socket.close();
    host.close();
  }, 20_000);

  /*
   * A peer can put anything at all in a sealed frame — the AEAD check only
   * proves it came from someone holding the session key, not that its
   * contents are sane. `Session.sendMediaSignal`'s `msg` type does not stop
   * this at compile time (the cast below is standing in for a hostile or
   * simply buggy peer implementation, which owns no TypeScript compiler);
   * the Receiver's whitelist is what has to catch it at runtime.
   */
  it('drops a malformed offer instead of surfacing it', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    let seen: MediaControl | undefined;
    let sawError = false;
    guest.events.onMediaSignal = (signal) => { seen = signal; };
    guest.events.onError = () => { sawError = true; };

    await host.sendMediaSignal({
      t: 'media-offer',
      offer: { sdp: 42, kind: 'camera' },
    } as unknown as MediaControl);

    // Nothing to wait for that would ever resolve — the malformed offer is
    // dropped in silence, so this waits out a window in which a wrongly-lenient
    // parser would have fired onMediaSignal, then asserts it never did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toBeUndefined();
    // A malformed peer payload is not a transfer error either — see this
    // task's global constraints.
    expect(sawError).toBe(false);

    host.close(); guest.close();
  }, 20_000);
});

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { Session } from '../../client/session.js';
import { FrameType, decodeControl, decodeFrame } from '../../client/protocol.js';
import type { DeviceInfo } from '../../shared/device.js';
import { confirmBoth, rawHello, rawIdentity } from '../pairing.js';

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

const HOST_DEVICE: DeviceInfo = {
  id: 'host-1111-2222', kind: 'desktop', os: 'Linux', browser: 'Firefox', screen: '2560 × 1440',
};
const GUEST_DEVICE: DeviceInfo = {
  id: 'guest-3333-4444', kind: 'mobile', os: 'Android', browser: 'Chrome', screen: '412 × 915',
};

describe('device exchange over the relay', () => {
  it('swaps descriptions in both directions and fills in each address from the relay', async () => {
    const url = await start();
    const host = await Session.create(url, { device: HOST_DEVICE });

    let hostSaw: DeviceInfo | undefined;
    host.events.onPeerDevice = (info) => { hostSaw = info; };

    const guest = await Session.join(url, host.code, { device: GUEST_DEVICE });
    let guestSaw: DeviceInfo | undefined;
    // Installed before the confirmation, not after: the announcement rides
    // the same hello exchange the verification number comes from, so a
    // listener attached after `confirmBoth` has already missed it.
    guest.events.onPeerDevice = (info) => { guestSaw = info; };
    await confirmBoth(host, guest);

    await waitFor(() => hostSaw !== undefined && guestSaw !== undefined);

    expect(hostSaw).toMatchObject({ id: 'guest-3333-4444', kind: 'mobile', browser: 'Chrome' });
    expect(guestSaw).toMatchObject({ id: 'host-1111-2222', kind: 'desktop', browser: 'Firefox' });

    /*
     * The half a browser cannot supply for itself. Both sockets come from
     * the loopback address this server is listening on, and each side is
     * told its own -- so the fact that it arrives at the *peer* is proof it
     * travelled the whole way round: relay to device, device to peer.
     */
    expect(host.selfDevice?.ip).toBe('127.0.0.1');
    expect(hostSaw?.ip).toBe('127.0.0.1');
    expect(guestSaw?.ip).toBe('127.0.0.1');

    host.close();
    guest.close();
  }, 20_000);

  /*
   * The claim made in shared/messages.ts, tested rather than asserted: this
   * feature must not hand the relay in plaintext the very pairing the rest
   * of the design goes to some length to deny it. A device fingerprint and
   * two addresses on the hello -- which travels in the clear by necessity --
   * would have done exactly that.
   */
  it('never puts the description on the wire in the clear', async () => {
    const url = await start();
    const host = await Session.create(url, { device: HOST_DEVICE });

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

    // A hello is what prompts the announcement, so this peer has to send one
    // — and a hello now has to carry a real public key, since the session
    // derives its key from it before it can seal the announcement at all.
    socket.send(rawHello('AAAA', (await rawIdentity()).pub));

    // One sealed control frame is the announcement; without waiting for it
    // this test would pass on an empty wire and prove nothing.
    await waitFor(() => frames.some((f) => decodeFrame(f).type === FrameType.Control));

    const hellos = frames.filter((f) => decodeFrame(f).type === FrameType.Hello);
    expect(hellos.length).toBeGreaterThan(0);
    for (const frame of hellos) {
      // Parsed rather than string-searched: the point is that the hello
      // carries the handshake and nothing else, not merely that one
      // particular id is missing from it.
      const msg = decodeControl(decodeFrame(frame).payload) as Record<string, unknown>;
      // `pub` is the one addition, and it is public by definition: half of
      // an ECDH exchange tells the relay nothing it can use. The device
      // fingerprint and the addresses still travel sealed.
      expect(Object.keys(msg).sort()).toEqual(
        ['maxBufferedBytes', 'noncePrefix', 'peerId', 'pub', 'saveCapability', 't'],
      );
    }

    // And nowhere else either: the id and the address must not appear as
    // plaintext bytes in ANY frame the relay handled, sealed or otherwise.
    const wire = Buffer.concat(frames.map((f) => Buffer.from(f))).toString('latin1');
    expect(wire).not.toContain('host-1111-2222');
    expect(wire).not.toContain('127.0.0.1');

    socket.close();
    host.close();
  }, 20_000);

  /*
   * A session whose caller never described it still pairs and still
   * transfers. The panel renders an unknown card, which is the whole cost.
   */
  it('pairs normally when neither side describes itself', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    let sawDevice = false;
    host.events.onPeerDevice = () => { sawDevice = true; };

    const got = new Promise<string>((resolve, reject) => {
      host.events.onText = resolve;
      host.events.onError = (e) => reject(new Error(e.message));
    });
    await guest.sendText('still works');
    expect(await got).toBe('still works');
    expect(sawDevice).toBe(false);
    expect(host.selfDevice).toBeUndefined();

    host.close();
    guest.close();
  }, 20_000);
});

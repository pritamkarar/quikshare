import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import { RelayTransport } from '../../client/transport/relay.js';

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('RelayTransport', () => {
  it('creates a room and reports the code', async () => {
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    expect(created.code).toHaveLength(6);
    expect(created.peerId).toBe('a');
    expect(created.peerPresent).toBe(false);
    created.transport.close();
  });

  it('joins an existing room and carries frames both ways', async () => {
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    const joined = await RelayTransport.connect(url, { t: 'join', code: created.code });
    expect(joined.peerId).toBe('b');
    expect(joined.peerPresent).toBe(true);

    const atB = new Promise<Uint8Array>((r) => joined.transport.onMessage(r));
    created.transport.send(new Uint8Array([4, 5, 6]));
    expect([...(await atB)]).toEqual([4, 5, 6]);

    const atA = new Promise<Uint8Array>((r) => created.transport.onMessage(r));
    joined.transport.send(new Uint8Array([7]));
    expect([...(await atA)]).toEqual([7]);

    created.transport.close();
    joined.transport.close();
  });

  it('sends only the frame, not the buffer it is a view into', async () => {
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    const joined = await RelayTransport.connect(url, { t: 'join', code: created.code });

    // A view into the middle of a larger allocation: aliasing would leak the rest.
    const backing = new Uint8Array(1024).fill(0xaa);
    const frame = backing.subarray(100, 103);
    frame.set([1, 2, 3]);

    const atB = new Promise<Uint8Array>((r) => joined.transport.onMessage(r));
    created.transport.send(frame);
    const received = await atB;
    expect(received).toHaveLength(3);
    expect([...received]).toEqual([1, 2, 3]);

    created.transport.close();
    joined.transport.close();
  });

  it('rejects a join for an unknown code', async () => {
    const url = await start();
    await expect(RelayTransport.connect(url, { t: 'join', code: 'ZZZZZZ' })).rejects.toThrow(/not-found/);
  });

  it('rejects, instead of hanging forever, when the socket opens and is then closed with no error', async () => {
    // A relay that accepts the upgrade and drops it, or a proxy that times
    // the upgrade out, fires 'close' with no 'error' at all. connect()
    // listened only for 'error', so its promise stayed pending forever —
    // and Reconnector.#schedule awaits it before scheduling the next retry,
    // so one such close ended the retry chain outright: no further attempt,
    // and onGaveUp never fired, leaving the session waiting on nothing.
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    try {
      await new Promise((resolve) => wss.once('listening', resolve));
      wss.on('connection', (socket) => socket.close());
      const { port } = wss.address() as AddressInfo;

      await expect(RelayTransport.connect(`ws://127.0.0.1:${port}`, { t: 'create' }))
        .rejects.toThrow(/socket-closed/);
    } finally {
      await new Promise((resolve) => wss.close(resolve));
    }
  });

  it('fires onPeerLeft when the peer disconnects', async () => {
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    const joined = await RelayTransport.connect(url, { t: 'join', code: created.code });
    const left = new Promise<void>((r) => created.transport.onPeerLeft(r));
    joined.transport.close();
    await left;
    created.transport.close();
  });

  it('does not fire onClose for a peer leaving, only for its own socket closing', async () => {
    // Session wraps this transport in a SwitchableTransport that claims the
    // single onClose slot to decide whether a swap should end the session.
    // 'peer-left' is a room-presence signal, not "this data path died" — it
    // must reach Session (via a dedicated callback, symmetric with
    // onPeerJoined) even while the switchable has upgraded away from this
    // transport and detached it. Routing it through onClose instead would
    // make it indistinguishable from a real transport death and would be
    // silently dropped once detached.
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    const joined = await RelayTransport.connect(url, { t: 'join', code: created.code });
    const onClose = vi.fn();
    created.transport.onClose(onClose);
    joined.transport.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(onClose).not.toHaveBeenCalled();
    created.transport.close();
  });
});

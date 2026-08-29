import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import type { ServerSignal } from '../../shared/signals.js';

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolves with the next text frame, decoded. */
function nextSignal(ws: WebSocket): Promise<ServerSignal> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) throw new Error('expected a text frame');
      resolve(JSON.parse(data.toString()) as ServerSignal);
    });
  });
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('pairing', () => {
  it('issues a code to the creator', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const signal = await nextSignal(a);
    expect(signal).toMatchObject({ t: 'created', peerId: 'a' });
    if (signal.t !== 'created') throw new Error('unreachable');
    expect(signal.code).toHaveLength(6);
    a.close();
  });

  it('notifies both peers when the second joins', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const aNotified = nextSignal(a);
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: created.code }));

    expect(await nextSignal(b)).toMatchObject({ t: 'joined', peerId: 'b' });
    expect(await aNotified).toEqual({ t: 'peer-joined' });
    a.close();
    b.close();
  });

  it('accepts a lowercase, dashed code', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const messy = `${created.code.slice(0, 3)}-${created.code.slice(3)}`.toLowerCase();
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: messy }));
    expect(await nextSignal(b)).toMatchObject({ t: 'joined' });
    a.close();
    b.close();
  });

  it('rejects an unknown code', async () => {
    const url = await start();
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: 'ZZZZZZ' }));
    expect(await nextSignal(b)).toEqual({ t: 'error', reason: 'not-found' });
    b.close();
  });

  it('rejects a third peer', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: created.code }));
    await nextSignal(b);

    const c = await connect(url);
    c.send(JSON.stringify({ t: 'join', code: created.code }));
    expect(await nextSignal(c)).toEqual({ t: 'error', reason: 'full' });
    a.close(); b.close(); c.close();
  });

  it('tells the remaining peer when the other disconnects', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const aNotified = nextSignal(a);
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: created.code }));
    await nextSignal(b);
    await aNotified;

    const aLeft = nextSignal(a);
    b.close();
    expect(await aLeft).toEqual({ t: 'peer-left' });
    a.close();
  });
});

describe('malformed input does not crash the server', () => {
  const crashVectors: Array<{ label: string; frame: string }> = [
    { label: 'a JSON null', frame: 'null' },
    { label: 'a join with a numeric code', frame: JSON.stringify({ t: 'join', code: 123 }) },
    { label: 'non-JSON text', frame: 'not json at all' },
    { label: 'an unknown signal type', frame: JSON.stringify({ t: 'nope' }) },
  ];

  for (const { label, frame } of crashVectors) {
    it(`replies bad-request for ${label} instead of throwing`, async () => {
      const url = await start();
      const ws = await connect(url);
      ws.send(frame);
      expect(await nextSignal(ws)).toEqual({ t: 'error', reason: 'bad-request' });
      ws.close();
    });
  }

  it('keeps serving new connections after every malformed frame', async () => {
    const url = await start();
    const attacker = await connect(url);
    for (const { frame } of crashVectors) {
      attacker.send(frame);
      expect(await nextSignal(attacker)).toEqual({ t: 'error', reason: 'bad-request' });
    }
    attacker.close();

    // If any of the frames above had crashed the process, there would be no
    // server left to accept this connection.
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const signal = await nextSignal(a);
    expect(signal).toMatchObject({ t: 'created', peerId: 'a' });
    a.close();
  });
});

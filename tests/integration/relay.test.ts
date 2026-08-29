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
    ws.binaryType = 'nodebuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextSignal(ws: WebSocket): Promise<ServerSignal> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) throw new Error('expected a text frame');
      resolve(JSON.parse(data.toString()) as ServerSignal);
    });
  });
}

function nextBinary(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (!isBinary) throw new Error('expected a binary frame');
      resolve(data as Buffer);
    });
  });
}

async function pair(url: string): Promise<[WebSocket, WebSocket]> {
  const a = await connect(url);
  a.send(JSON.stringify({ t: 'create' }));
  const created = await nextSignal(a);
  if (created.t !== 'created') throw new Error('unreachable');
  const aNotified = nextSignal(a);
  const b = await connect(url);
  b.send(JSON.stringify({ t: 'join', code: created.code }));
  await nextSignal(b);
  await aNotified;
  return [a, b];
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('binary relay', () => {
  it('forwards a binary frame verbatim from a to b', async () => {
    const url = await start();
    const [a, b] = await pair(url);
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
    const received = nextBinary(b);
    a.send(payload);
    expect(Buffer.compare(await received, payload)).toBe(0);
    a.close(); b.close();
  });

  it('forwards in both directions', async () => {
    const url = await start();
    const [a, b] = await pair(url);
    const payload = Buffer.from('reply bytes');
    const received = nextBinary(a);
    b.send(payload);
    expect(Buffer.compare(await received, payload)).toBe(0);
    a.close(); b.close();
  });

  it('preserves order across many frames', async () => {
    const url = await start();
    const [a, b] = await pair(url);
    const count = 200;
    const seen: number[] = [];
    const done = new Promise<void>((resolve) => {
      b.on('message', (data, isBinary) => {
        if (!isBinary) return;
        seen.push((data as Buffer).readUInt32BE(0));
        if (seen.length === count) resolve();
      });
    });
    for (let i = 0; i < count; i++) {
      const frame = Buffer.alloc(4);
      frame.writeUInt32BE(i, 0);
      a.send(frame);
    }
    await done;
    expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
    a.close(); b.close();
  });

  it('drops binary frames from an unpaired peer instead of crashing', async () => {
    const url = await start();
    const lonely = await connect(url);
    lonely.send(JSON.stringify({ t: 'create' }));
    await nextSignal(lonely);
    lonely.send(Buffer.from([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 50));
    expect(lonely.readyState).toBe(WebSocket.OPEN);
    lonely.close();
  });
});

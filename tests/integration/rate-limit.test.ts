import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import type { ServerSignal } from '../../shared/signals.js';

let app: FastifyInstance | undefined;

async function start(
  limits?: { createPerMinute?: number; joinPerMinute?: number; rtcPerMinute?: number },
): Promise<string> {
  app = await buildServer(limits);
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

function nextSignal(ws: WebSocket): Promise<ServerSignal> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) throw new Error('expected a text frame');
      resolve(JSON.parse(data.toString()) as ServerSignal);
    });
  });
}

/** Creates a room and joins it, returning both peers paired and ready. */
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

describe('rate limiting', () => {
  it('rejects room creation past the per-IP budget', async () => {
    const url = await start({ createPerMinute: 2 });
    const sockets: WebSocket[] = [];
    const reasons: string[] = [];

    for (let i = 0; i < 3; i++) {
      const ws = await connect(url);
      sockets.push(ws);
      ws.send(JSON.stringify({ t: 'create' }));
      const signal = await nextSignal(ws);
      reasons.push(signal.t === 'error' ? signal.reason : signal.t);
    }

    expect(reasons).toEqual(['created', 'created', 'rate-limited']);
    for (const ws of sockets) ws.close();
  });

  it('rejects join attempts past the per-IP budget', async () => {
    const url = await start({ joinPerMinute: 2 });
    const sockets: WebSocket[] = [];
    const reasons: string[] = [];

    for (let i = 0; i < 3; i++) {
      const ws = await connect(url);
      sockets.push(ws);
      ws.send(JSON.stringify({ t: 'join', code: 'ZZZZZZ' }));
      const signal = await nextSignal(ws);
      reasons.push(signal.t === 'error' ? signal.reason : signal.t);
    }

    expect(reasons).toEqual(['not-found', 'not-found', 'rate-limited']);
    for (const ws of sockets) ws.close();
  });

  it('charges the join budget even for codes that never resolve', async () => {
    const url = await start({ joinPerMinute: 2 });
    const sockets: WebSocket[] = [];
    const reasons: string[] = [];

    // Malformed on purpose: normalizeCode returns '' for these. If the limiter
    // ran after normalization, these would short-circuit to not-found without
    // spending budget and the third attempt would also be not-found.
    for (let i = 0; i < 3; i++) {
      const ws = await connect(url);
      sockets.push(ws);
      ws.send(JSON.stringify({ t: 'join', code: '!!!!!!' }));
      const signal = await nextSignal(ws);
      reasons.push(signal.t === 'error' ? signal.reason : signal.t);
    }

    expect(reasons).toEqual(['not-found', 'not-found', 'rate-limited']);
    for (const ws of sockets) ws.close();
  });

  it('lets a real negotiation-sized burst of rtc signals through unthrottled', async () => {
    // A real negotiation is an offer/answer plus ICE trickle — dozens of
    // small signals in a tight burst right after pairing, then silence. This
    // budget must absorb that burst without dropping a single candidate.
    const url = await start({ rtcPerMinute: 40 });
    const [a, b] = await pair(url);

    const NEGOTIATION_SIGNAL_COUNT = 32; // offer/answer + a generous handful of ICE candidates each way
    const received: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      b.on('message', (data, isBinary) => {
        if (isBinary) return;
        const signal = JSON.parse(data.toString()) as ServerSignal;
        if (signal.t !== 'rtc') return;
        received.push(signal.payload);
        if (received.length === NEGOTIATION_SIGNAL_COUNT) resolve();
      });
    });

    for (let i = 0; i < NEGOTIATION_SIGNAL_COUNT; i++) {
      a.send(JSON.stringify({ t: 'rtc', payload: { i } }));
    }
    await done;

    expect(received).toEqual(Array.from({ length: NEGOTIATION_SIGNAL_COUNT }, (_, i) => ({ i })));
    a.close(); b.close();
  });

  it('cuts off an rtc flood past the per-IP budget instead of forwarding it forever', async () => {
    const url = await start({ rtcPerMinute: 5 });
    const [a, b] = await pair(url);

    const forwardedToB: unknown[] = [];
    b.on('message', (data, isBinary) => {
      if (isBinary) return;
      const signal = JSON.parse(data.toString()) as ServerSignal;
      if (signal.t === 'rtc') forwardedToB.push(signal.payload);
    });

    const FLOOD_COUNT = 8;
    const repliesToA: ServerSignal[] = [];
    const gotAllReplies = new Promise<void>((resolve) => {
      a.on('message', (data, isBinary) => {
        if (isBinary) return;
        repliesToA.push(JSON.parse(data.toString()) as ServerSignal);
        // Every message past the budget draws its own rate-limited reply
        // back to the sender; a rejected send never gets forwarded, so this
        // is the only signal on `a`'s socket in this test.
        if (repliesToA.length === FLOOD_COUNT - 5) resolve();
      });
    });

    for (let i = 0; i < FLOOD_COUNT; i++) {
      a.send(JSON.stringify({ t: 'rtc', payload: { i } }));
    }
    await gotAllReplies;

    // Exactly the budget's worth reached the other peer...
    expect(forwardedToB).toEqual(Array.from({ length: 5 }, (_, i) => ({ i })));
    // ...and the flooding peer is told why the rest were dropped, using the
    // same reason create/join already use, rather than being left to guess
    // why its later candidates never arrive.
    expect(repliesToA).toEqual(
      Array.from({ length: FLOOD_COUNT - 5 }, () => ({ t: 'error', reason: 'rate-limited' })),
    );

    a.close(); b.close();
  });

  it('has headroom for two negotiation-sized bursts back to back, as a flaky-network reconnect would produce', async () => {
    // Reconnector's first retry is ~300ms after a drop (BASE_DELAY_MS in
    // client/transport/reconnect.ts), and a reconnect re-runs the *entire*
    // WebRTC upgrade handshake. So the realistic worst case for one peer's
    // rtc budget isn't one negotiation, it's two, close together — this
    // measures that headroom against the real default budget rather than
    // assuming it, instead of only testing a single negotiation in isolation.
    const url = await start(); // real default budget — no override
    const [a, b] = await pair(url);

    const PER_NEGOTIATION = 32; // same size as the single-negotiation burst test above
    const total = PER_NEGOTIATION * 2;

    const forwardedToB: unknown[] = [];
    const repliesToA: ServerSignal[] = [];
    const seenEverything = new Promise<void>((resolve) => {
      const maybeDone = (): void => { if (forwardedToB.length + repliesToA.length === total) resolve(); };
      b.on('message', (data, isBinary) => {
        if (isBinary) return;
        const signal = JSON.parse(data.toString()) as ServerSignal;
        if (signal.t === 'rtc') { forwardedToB.push(signal.payload); maybeDone(); }
      });
      a.on('message', (data, isBinary) => {
        if (isBinary) return;
        repliesToA.push(JSON.parse(data.toString()) as ServerSignal);
        maybeDone();
      });
    });

    for (let i = 0; i < PER_NEGOTIATION; i++) a.send(JSON.stringify({ t: 'rtc', payload: { round: 1, i } }));
    await new Promise((resolve) => { setTimeout(resolve, 300); }); // Reconnector's real BASE_DELAY_MS
    for (let i = 0; i < PER_NEGOTIATION; i++) a.send(JSON.stringify({ t: 'rtc', payload: { round: 2, i } }));
    await seenEverything;

    // Both rounds land in full, with nothing rejected — the headroom is real,
    // not just enough for the first round.
    expect(repliesToA).toEqual([]);
    expect(forwardedToB).toHaveLength(total);

    a.close(); b.close();
  });
});

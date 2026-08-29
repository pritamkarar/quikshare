// tests/integration/trust-proxy.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import type { ServerSignal } from '../../shared/signals.js';

const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;

let app: FastifyInstance | undefined;

async function start(limits?: { createPerMinute?: number }): Promise<string> {
  app = await buildServer(limits);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

/**
 * Connects with an X-Forwarded-For header. Every connection in this file
 * really comes from 127.0.0.1, which is exactly the point: that is the
 * address a reverse proxy running on the same host connects from (see
 * docs/deployment.md, whose Caddy and nginx examples both proxy to
 * localhost), so the *header* is the only thing that distinguishes a
 * proxy's honest report from a client's forgery — and the chain's shape is
 * the only thing the server can judge it by.
 */
function connectAs(url: string, forwardedFor: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-forwarded-for': forwardedFor } });
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

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY;
});

describe('TRUST_PROXY', () => {
  it('defaults to ignoring X-Forwarded-For, so a spoofed header cannot evade the per-IP budget', async () => {
    delete process.env.TRUST_PROXY;
    const url = await start({ createPerMinute: 1 });

    const first = await connectAs(url, '1.1.1.1');
    first.send(JSON.stringify({ t: 'create' }));
    const firstSignal = await nextSignal(first);

    // A second connection claiming a *different* forged address, from the
    // same real socket the test itself is on. Off by default, the relay
    // must judge both by their real connection address and treat them as
    // the same client — otherwise the header alone would buy unlimited budget.
    const second = await connectAs(url, '2.2.2.2');
    second.send(JSON.stringify({ t: 'create' }));
    const secondSignal = await nextSignal(second);

    expect(firstSignal).toEqual(expect.objectContaining({ t: 'created' }));
    expect(secondSignal).toEqual({ t: 'error', reason: 'rate-limited' });

    first.close();
    second.close();
  });

  it('when explicitly enabled, attributes each address the trusted proxy reports its own budget', async () => {
    process.env.TRUST_PROXY = 'true';
    const url = await start({ createPerMinute: 1 });

    // What a same-host proxy that *overwrites* the header sends (nginx's
    // `proxy_set_header X-Forwarded-For $remote_addr` form): one entry, put
    // there by the trusted hop itself. Two different clients through that
    // proxy must be two independent budgets, or one abusive client behind
    // the proxy locks out everyone else.
    const first = await connectAs(url, '1.1.1.1');
    first.send(JSON.stringify({ t: 'create' }));
    const firstSignal = await nextSignal(first);

    const second = await connectAs(url, '2.2.2.2');
    second.send(JSON.stringify({ t: 'create' }));
    const secondSignal = await nextSignal(second);

    expect(firstSignal).toEqual(expect.objectContaining({ t: 'created' }));
    expect(secondSignal).toEqual(expect.objectContaining({ t: 'created' }));

    // And a repeat from the *same* forwarded address is still throttled —
    // proving this isn't just "every connection gets a fresh budget".
    const third = await connectAs(url, '1.1.1.1');
    third.send(JSON.stringify({ t: 'create' }));
    const thirdSignal = await nextSignal(third);
    expect(thirdSignal).toEqual({ t: 'error', reason: 'rate-limited' });

    first.close();
    second.close();
    third.close();
  });

  it('when explicitly enabled, a forged leftmost entry does not buy its own budget', async () => {
    process.env.TRUST_PROXY = 'true';
    const url = await start({ createPerMinute: 1 });

    // The shape a *appending* proxy produces — Caddy's `reverse_proxy` and
    // nginx's `$proxy_add_x_forwarded_for` both append rather than
    // overwrite, so anything the client sent stays in front of the address
    // the proxy actually saw. Here one abusive host (9.9.9.9) invents a
    // different leftmost entry per connection. Trusting the whole chain
    // would read the invention and hand out a fresh 20-create/30-join/
    // 120-rtc budget every time; trusting only the hops we can vouch for
    // stops at the first untrusted entry — 9.9.9.9 — and attributes both
    // connections to the one host that really made them.
    const first = await connectAs(url, '1.1.1.1, 9.9.9.9');
    first.send(JSON.stringify({ t: 'create' }));
    const firstSignal = await nextSignal(first);

    const second = await connectAs(url, '2.2.2.2, 9.9.9.9');
    second.send(JSON.stringify({ t: 'create' }));
    const secondSignal = await nextSignal(second);

    expect(firstSignal).toEqual(expect.objectContaining({ t: 'created' }));
    expect(secondSignal).toEqual({ t: 'error', reason: 'rate-limited' });

    first.close();
    second.close();
  });

  it('ignores X-Forwarded-For entirely when the connection is not from a trusted proxy address', async () => {
    // The escape hatch for a proxy that is *not* on this host — a container
    // network, a load balancer on another node. The connection below really
    // comes from 127.0.0.1, which this setting does not vouch for, so its
    // header carries no weight at all and both connections are judged by
    // the socket they actually arrived on.
    process.env.TRUST_PROXY = '10.0.0.0/8';
    const url = await start({ createPerMinute: 1 });

    const first = await connectAs(url, '1.1.1.1');
    first.send(JSON.stringify({ t: 'create' }));
    const firstSignal = await nextSignal(first);

    const second = await connectAs(url, '2.2.2.2');
    second.send(JSON.stringify({ t: 'create' }));
    const secondSignal = await nextSignal(second);

    expect(firstSignal).toEqual(expect.objectContaining({ t: 'created' }));
    expect(secondSignal).toEqual({ t: 'error', reason: 'rate-limited' });

    first.close();
    second.close();
  });
});

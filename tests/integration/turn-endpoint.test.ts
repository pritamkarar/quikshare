import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';

// Restored after every test so NODE_ENV=production (used below to prove the
// route survives the static/SPA-fallback registration) never leaks into
// other test files — same pattern as tests/integration/spa-fallback.test.ts.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let app: FastifyInstance | undefined;

// Also cleared BEFORE each test, not only after: afterEach only protects
// tests that run after this file's own tests, not the first test in this
// file against whatever a developer's shell already exports. Without this,
// "answers 200 with an empty list when TURN is not configured" silently
// passes or fails depending on ambient TURN_URLS/TURN_SECRET.
beforeEach(() => {
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  delete process.env.TURN_USERNAME;
  delete process.env.TURN_CREDENTIAL;
  delete process.env.TURN_TTL_SECONDS;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  delete process.env.TURN_USERNAME;
  delete process.env.TURN_CREDENTIAL;
  delete process.env.TURN_TTL_SECONDS;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

async function build(env: Record<string, string> = {}, limits = {}): Promise<FastifyInstance> {
  Object.assign(process.env, env);
  app = await buildServer(limits);
  return app;
}

describe('GET /turn', () => {
  it('answers 200 with an empty list when TURN is not configured', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/turn' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ iceServers: [], ttl: 0 });
    // The dangerous one of the three response shapes to leave cacheable: a
    // proxy that cached this would keep answering "no TURN" long after an
    // operator fixed the configuration.
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('returns credentials in the shape RTCConfiguration wants', async () => {
    const res = await (await build({
      TURN_URLS: 'turn:t.example.com:3478,turns:t.example.com:5349',
      TURN_SECRET: 's3cret',
    })).inject({ method: 'GET', url: '/turn' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { iceServers: { urls: string[]; username: string; credential: string }[]; ttl: number };
    expect(body.iceServers).toHaveLength(1);
    expect(body.iceServers[0]!.urls).toEqual(['turn:t.example.com:3478', 'turns:t.example.com:5349']);
    expect(body.iceServers[0]!.username).toMatch(/^\d+:quikshare$/);
    expect(body.iceServers[0]!.credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(body.ttl).toBe(600);
  });

  it('serves a managed provider\'s pair verbatim, in the same response shape', async () => {
    // Metered and every other managed provider issue a long-lived username
    // and password rather than a secret to sign with. The response shape the
    // client parses must not change with the credential style — nothing in
    // client/media/ice.ts knows which kind of TURN server it is talking to.
    const res = await (await build({
      TURN_URLS: 'turn:relay.example.com:80,turns:relay.example.com:443?transport=tcp',
      TURN_USERNAME: 'user123',
      TURN_CREDENTIAL: 'pass456',
    })).inject({ method: 'GET', url: '/turn' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      iceServers: [{
        urls: ['turn:relay.example.com:80', 'turns:relay.example.com:443?transport=tcp'],
        username: 'user123',
        credential: 'pass456',
      }],
      ttl: 600,
    });
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  /*
   * The one assertion that protects the secret itself. A response that
   * leaked it would hand every visitor a permanent key to the operator's
   * relay, which is strictly worse than having no TURN at all.
   */
  it('never includes the shared secret in the response', async () => {
    const res = await (await build({
      TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 'super-secret-value',
    })).inject({ method: 'GET', url: '/turn' });
    expect(res.body).not.toContain('super-secret-value');
  });

  /*
   * Credentials are time-limited and minted per request. A shared cache —
   * a CDN, a corporate proxy — holding one response would serve expired
   * credentials to everyone behind it, and the failure would look like
   * "TURN is broken" rather than "something cached it".
   */
  it('forbids caching', async () => {
    const res = await (await build({
      TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret',
    })).inject({ method: 'GET', url: '/turn' });
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('mints a fresh credential per request rather than reusing one', async () => {
    const server = await build({ TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret' });
    const first = await server.inject({ method: 'GET', url: '/turn' });
    await new Promise((r) => setTimeout(r, 1100));
    const second = await server.inject({ method: 'GET', url: '/turn' });
    expect(second.json().iceServers[0].credential).not.toBe(first.json().iceServers[0].credential);
  }, 10_000);

  /*
   * Unauthenticated by necessity — the client needs credentials before any
   * session exists — so this budget is the only thing bounding how many
   * credentials a single address can mint. It is one of four bounds on the
   * endpoint (see server/index.ts); the two that bound where and how much a
   * credential may relay live in coturn's configuration, so nothing in this
   * file can cover them.
   */
  it('rate-limits per client', async () => {
    const server = await build(
      { TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret' },
      { turnPerMinute: 2 },
    );
    const responses: { statusCode: number; cacheControl: string | undefined }[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await server.inject({ method: 'GET', url: '/turn' });
      responses.push({ statusCode: res.statusCode, cacheControl: res.headers['cache-control'] as string | undefined });
    }
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 429, 429]);
    // A cacheable 429 is the other dangerous shape: a proxy that cached it
    // would keep rejecting a client long after that client's own budget
    // refilled.
    for (const r of responses) expect(r.cacheControl).toMatch(/no-store/);
  });

  /*
   * The one property proven only in a throwaway script during development,
   * not by any committed test — until now. Follows the NODE_ENV=production
   * pattern in tests/integration/spa-fallback.test.ts.
   *
   * IMPORTANT CAVEAT, found while writing this test: registration ORDER
   * turns out not to matter here. Fastify's router (find-my-way) resolves
   * an exact literal path like `/turn` ahead of @fastify/static's wildcard
   * route (registered as `GET prefix + '*'`, see node_modules/@fastify/static
   * /index.js) regardless of which was registered first — verified directly
   * against a minimal Fastify app with the exact route registered both
   * before and after a wildcard route; both orders resolved to the exact
   * handler. Moving `/turn`'s registration below the `NODE_ENV ===
   * 'production'` block in server/index.ts and re-running this test still
   * produced a 200 with the correct JSON body, not a fallback response.
   *
   * What DOES trip the fallback, and what this test actually guards against:
   * the `/turn` route not being registered at all — an accidental deletion,
   * or a future refactor that gates it behind a condition that excludes
   * production. Verified: removing the route entirely makes this test fail
   * with a 200 `text/html` SPA-shell response instead of JSON, exactly the
   * failure mode this test is written to catch. server/index.ts's doc
   * comment on this route has the corrected version of this same story —
   * keeping the route ahead of the static block is still good practice (it
   * doesn't rely on router-specific precedence that could change in a
   * future Fastify/find-my-way major version), but the position itself is
   * not what this test — or the route's own correctness — depends on.
   *
   * Distinguishing signal: a request with Accept: text/html to a route the
   * SPA fallback WOULD catch gets a 200 with an HTML body (see spa-fallback
   * .test.ts's "serves the app shell..." test). Asserting only status 200
   * here would not catch a regression — the fallback also answers 200 for
   * an HTML-accepting request. Asserting the JSON shape and content-type is
   * the actual distinguishing signal.
   */
  it('is not shadowed by the production SPA fallback', async () => {
    process.env.NODE_ENV = 'production';
    const res = await (await build({
      TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret',
    })).inject({
      method: 'GET',
      url: '/turn',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).not.toContain('<title>Quik Share</title>');
    const body = res.json() as { iceServers: { urls: string[]; username: string; credential: string }[]; ttl: number };
    expect(body.iceServers[0]!.username).toMatch(/^\d+:quikshare$/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import { devRoutingMiddleware } from '../../vite.config.js';
// The canonical constant. Both routing layers keep their own copy so neither
// build has to reach into the other's realm; driving their tests from this
// one is what stops those copies from drifting silently.
import { DOWNLOAD_PATH_PREFIX } from '../../client/save/swstream.js';
import { SHARE_MISSED_PATH, SHARE_TARGET_PATH } from '../../client/share/inbox.js';

// Only the production branch of buildServer() registers the static file
// server and the SPA fallback (see server/index.ts) — in development Vite
// serves the client and dist/client may not even exist. NODE_ENV is
// restored after every test so this doesn't leak into other test files.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('production SPA fallback', () => {
  it('serves the app shell for an HTML-accepting request to an unregistered client route', async () => {
    process.env.NODE_ENV = 'production';
    app = await buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/join',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body).toContain('<title>Quik Share</title>');
  });

  it('still serves the explicit /s/:code route for a share link', async () => {
    process.env.NODE_ENV = 'production';
    app = await buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/s/K7M3QP',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>Quik Share</title>');
  });

  it('404s a missing asset rather than answering it with the app shell', async () => {
    process.env.NODE_ENV = 'production';
    app = await buildServer();

    // A <script>/<link> request typically sends `Accept: */*`, not
    // `text/html` — exactly the case the fallback must NOT catch, since an
    // HTML body in place of a missing script is a far more confusing
    // failure than a 404.
    const response = await app.inject({
      method: 'GET',
      url: '/nope.js',
      headers: { accept: '*/*' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<title>Quik Share</title>');
  });

  it('404s an unregistered route even when the request has no Accept header at all', async () => {
    process.env.NODE_ENV = 'production';
    app = await buildServer();

    const response = await app.inject({ method: 'GET', url: '/nope.png' });

    expect(response.statusCode).toBe(404);
  });

  // A download iframe navigation sends `Accept: text/html`, so this is the one
  // case where the fallback's heuristic actively does the wrong thing: served
  // the app shell, the hidden iframe boots a SECOND full App — a new room, a
  // second WebSocket, another service worker registration — invisibly. The
  // path belongs to the service worker; if it did not intercept the fetch,
  // nothing on the server can answer it.
  it('404s a download path instead of booting a second app inside the iframe', async () => {
    process.env.NODE_ENV = 'production';
    app = await buildServer();

    const response = await app.inject({
      method: 'GET',
      url: `${DOWNLOAD_PATH_PREFIX}0123456789abcdef`,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<title>Quik Share</title>');
  });
});

/**
 * Vite's dev server has its own SPA fallback and therefore the same hole. The
 * middleware is unit-tested directly rather than through a real dev server:
 * what matters is the two routing decisions, and booting Vite to observe them
 * would test Vite.
 */
describe('development routing middleware', () => {
  function run(url: string): { statusCode: number; ended: boolean; nexted: boolean; url: string | undefined } {
    const req = { url };
    const res = { statusCode: 200, end: vi.fn() };
    const next = vi.fn();
    devRoutingMiddleware(req, res, next);
    return { statusCode: res.statusCode, ended: res.end.mock.calls.length > 0, nexted: next.mock.calls.length > 0, url: req.url };
  }

  it('404s a download path rather than letting it reach the SPA fallback', () => {
    const result = run(`${DOWNLOAD_PATH_PREFIX}0123456789abcdef`);

    expect(result.statusCode).toBe(404);
    expect(result.ended).toBe(true);
    expect(result.nexted).toBe(false);
  });

  it('still rewrites a share link to the app shell', () => {
    const result = run('/s/K7M3QP');

    expect(result.url).toBe('/index.html');
    expect(result.nexted).toBe(true);
  });

  it('leaves every other request alone', () => {
    const result = run('/assets/index-abc123.js');

    expect(result.url).toBe('/assets/index-abc123.js');
    expect(result.nexted).toBe(true);
    expect(result.ended).toBe(false);
  });
});

describe('the share target with no worker to intercept it', () => {
  it('redirects to a screen that can explain itself, not a 404', async () => {
    process.env.NODE_ENV = 'production';
    app = await buildServer();

    // A POST that reaches the server at all means no worker was controlling,
    // so the files are already gone. What must not also be gone is the way
    // out: an installed window has no address bar to recover a 404 from.
    //
    // Driven from the client's own constants, so this doubles as the drift
    // check for the two copies server/index.ts keeps — a stale copy of
    // either fails here rather than in production.
    const response = await app.inject({
      method: 'POST',
      url: SHARE_TARGET_PATH,
      headers: { accept: 'text/html' },
      payload: '',
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(SHARE_MISSED_PATH);
  });
});

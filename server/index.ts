import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { RoomRegistry, type Peer, type PeerId } from './rooms.js';
import { normalizeCode } from '../shared/codes.js';
import { parseClientSignal, type ServerSignal } from '../shared/signals.js';
import { RateLimiter } from './rate-limit.js';
import { mintTurnCredential, resolveTurnConfig } from './turn.js';

const SWEEP_INTERVAL_MS = 30_000;
const MAX_IDLE_MS = 10 * 60_000;

/**
 * The virtual path the service worker answers for a streamed download. It
 * must match `DOWNLOAD_PATH_PREFIX` in client/save/swstream.ts — a copy
 * rather than an import so the server build stays free of client modules;
 * tests/integration/spa-fallback.test.ts imports the client's constant and
 * drives these routes with it, so the two cannot drift apart unnoticed.
 */
const DOWNLOAD_PATH_PREFIX = '/__download/';

/**
 * The manifest's share target, and where to send a share that missed it.
 * Both must match `client/share/inbox.ts` — copies rather than imports so the
 * server build stays free of client modules, exactly as DOWNLOAD_PATH_PREFIX
 * above; tests/integration/spa-fallback.test.ts drives its test from the
 * client's own constants, so a stale copy of either fails there.
 */
const SHARE_TARGET_PATH = '/share-target';
const SHARE_MISSED_PATH = '/new?shared=missed';

export interface ServerLimits {
  createPerMinute?: number;
  joinPerMinute?: number;
  rtcPerMinute?: number;
  turnPerMinute?: number;
}

/**
 * Turns `TRUST_PROXY` into a Fastify `trustProxy` value. Off by default: with
 * the server directly exposed, trusting `X-Forwarded-For` would let any client
 * forge it and evade every limiter below entirely. Behind a real reverse proxy
 * an operator must opt in, or `request.ip` collapses to the proxy's own
 * address for every client and merges all their rate-limit buckets into one.
 *
 * `TRUST_PROXY=true` maps to `'loopback'` — trust the *address* of the hop we
 * are talking to — rather than to Fastify's `true`, which is spoofable in
 * exactly the deployment docs/deployment.md recommends. `true` trusts every
 * hop and returns the LEFTMOST entry, and both Caddy's `reverse_proxy` and
 * nginx's `$proxy_add_x_forwarded_for` *append* rather than overwrite, so
 * whatever the client sent stays leftmost and stays trusted: one host sending
 * `X-Forwarded-For: <random>` per connection earns a fresh create/join/rtc
 * budget every time. Address trust instead walks the chain from the right and
 * stops at the first entry it cannot vouch for, which lands on the address the
 * proxy itself observed — the real client — under both append and overwrite
 * styles, and ignores the header outright when the connection did not come
 * from the trusted proxy at all.
 *
 * A hop count (`trustProxy: 1`) does NOT work here, despite reading like the
 * natural fix: this Fastify's `getTrustProxyFn` treats a number as "trust
 * nothing" (`fastify/lib/request.js`: "Hop-count-only trust cannot validate
 * the immediate peer. Fail closed"), so it would silently make `TRUST_PROXY=true`
 * identical to leaving it off — closing the spoof by re-opening the
 * everyone-shares-one-bucket failure it exists to prevent.
 *
 * Any other value is passed through to Fastify as an IP/CIDR/keyword list
 * (comma-separated), for a proxy that is not on this host — a container
 * network, a load balancer on another node. An unparseable one fails at
 * startup rather than quietly falling back to a weaker setting.
 *
 * A bare number is rejected outright rather than passed through, because it
 * is the one wrong value an operator is most likely to reach for — every
 * other framework's `trust proxy` takes a hop count, and so did the fix this
 * one replaced. `ipaddr.js` would parse "1" as the address 0.0.0.1/32, trust
 * nobody, and merge every client behind the proxy into a single rate-limit
 * bucket with no error and no log: silently the exact outage this setting
 * exists to prevent. Case and surrounding whitespace are normalised first,
 * because `TRUE`, `False` and a trailing newline out of an env file or
 * heredoc are all ordinary ways to write a boolean, and none of them is a
 * reason to refuse to boot.
 */
export function resolveTrustProxy(value: string | undefined): boolean | string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') return 'loopback';
  if (/^\d+$/.test(normalized)) {
    throw new Error(
      `TRUST_PROXY: a hop count (${JSON.stringify(value)}) is not supported — it would trust nobody and put `
      + 'every client in one rate-limit bucket. Use true (a proxy on this host), false, or an IP/CIDR list.',
    );
  }
  // Not the normalised copy: an address list is case-insensitive in practice
  // but is the operator's own text, and Fastify splits it on commas itself.
  return value!;
}

export async function buildServer(limits: ServerLimits = {}): Promise<FastifyInstance> {
  // Resolved outside the try below: its own rejection already names the
  // variable and says what to do, and re-wrapping would bury that inside a
  // second, vaguer message.
  const trustProxy = resolveTrustProxy(process.env.TRUST_PROXY);
  // Resolved here, next to TRUST_PROXY, for the same reason: a bad value
  // should stop the process at startup where an operator is watching, not
  // surface as a broken feature hours later.
  const turnConfig = resolveTurnConfig(process.env);
  // Fastify's own failure for a bad address list is a bare `TypeError:
  // invalid IP address: X` that never mentions TRUST_PROXY, leaving an
  // operator with a stack trace and no hint which setting produced it.
  let app: FastifyInstance;
  try {
    app = Fastify({ logger: false, trustProxy });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TRUST_PROXY: ${JSON.stringify(process.env.TRUST_PROXY)} is not a valid setting — `
      + `use true, false, or a comma-separated IP/CIDR list (${detail})`,
    );
  }
  const registry = new RoomRegistry();

  const createLimiter = new RateLimiter({
    capacity: limits.createPerMinute ?? 20,
    refillPerMs: (limits.createPerMinute ?? 20) / 60_000,
  });
  const joinLimiter = new RateLimiter({
    capacity: limits.joinPerMinute ?? 30,
    refillPerMs: (limits.joinPerMinute ?? 30) / 60_000,
  });
  // rtc is the one message type a peer can send repeatedly and indefinitely
  // after a single successful join — create/join are one-shot per socket,
  // so rtc is the actually-unbounded path. SDP+ICE negotiation is bursty
  // right after pairing (offer/answer plus dozens of trickled candidates)
  // and then silent for the rest of the session, so the budget favors a
  // generous burst over a high sustained rate. One negotiation alone needs
  // well under half of this: the realistic worst case is a flaky-network
  // reconnect shortly after the first negotiation (Reconnector's first retry
  // is ~300ms later — see client/transport/reconnect.ts's BASE_DELAY_MS) that
  // re-runs the full upgrade handshake, i.e. two full negotiations close
  // together from the same peer. 120 comfortably covers two, while still
  // bounding a flood to roughly two messages per second once the burst is
  // spent.
  const rtcLimiter = new RateLimiter({
    capacity: limits.rtcPerMinute ?? 120,
    refillPerMs: (limits.rtcPerMinute ?? 120) / 60_000,
  });
  // Far tighter than the others, because the shape of legitimate use is
  // different: a real client fetches this ONCE per share attempt, not in
  // bursts the way rtc negotiation does. There is no honest reason to ask
  // ten times a minute, and this endpoint is unauthenticated — this budget is
  // the only thing bounding how many credentials one address can mint.
  const turnLimiter = new RateLimiter({
    capacity: limits.turnPerMinute ?? 10,
    refillPerMs: (limits.turnPerMinute ?? 10) / 60_000,
  });

  await app.register(websocket, {
    options: { maxPayload: 4 * 1024 * 1024 },
  });

  /**
   * Short-lived TURN credentials for the live-media connection.
   *
   * Unauthenticated by necessity: the client needs ICE servers before any
   * room exists, so there is nothing to authenticate against. Four separate
   * bounds constrain the abuse that invites, and each bounds a different
   * axis — they are not interchangeable and no one of them stands in for
   * another:
   *
   *   - *how long* one leaked response stays usable — the TTL, and its
   *     ceiling (server/turn.ts);
   *   - *how many* credentials one address can mint — the per-IP budget
   *     above;
   *   - *where* a minted credential may relay to — coturn's
   *     `denied-peer-ip` rules (docker-compose.yml);
   *   - *how much* it may relay — coturn's `--max-bps` / `--total-quota` /
   *     `--user-quota` (docker-compose.yml).
   *
   * What none of them does is make this a closed relay. With all four in
   * place, anyone who can reach this URL can still relay bounded traffic to
   * arbitrary *public* peers, which is inherent to running an unauthenticated
   * TURN endpoint at all. What the deny rules prevent is the hop into the
   * operator's *private* network, and that is the claim worth defending — it
   * is a real protection and it is not the same as "not an open relay".
   *
   * Registered here, ahead of the `NODE_ENV === 'production'` block below —
   * but that position is NOT load-bearing. Verified against fastify 5.12.1 /
   * find-my-way 9.9.0: an exact route like this one is matched ahead of
   * @fastify/static's wildcard (`GET prefix + '*'`) regardless of which was
   * registered first, because find-my-way resolves routes by trie
   * specificity, not registration order. It is kept above the static block
   * anyway, for reading order — that costs nothing, and precedence rules
   * like this are exactly the kind of thing a future major version could
   * change. What DOES break, and what tests/integration/turn-endpoint.test.ts
   * ('is not shadowed by the production SPA fallback') actually guards
   * against, is this route being ABSENT — deleted, or gated out of
   * production by a future refactor — in which case the request falls
   * through to `setNotFoundHandler` below and gets the SPA shell
   * (`text/html`) instead of a JSON response.
   *
   * Answers 200 with an empty list when TURN is not configured, rather than
   * 404 or 503: running without TURN is a supported deployment, and the
   * caller's handling of "no TURN available" should not have to be spelled
   * differently from "TURN configured but empty".
   */
  app.get('/turn', (request, reply) => {
    // Never cached. These are time-limited and minted per request, so a
    // shared cache — a CDN, a corporate proxy — holding one response would
    // serve expired credentials to everyone behind it, and the symptom would
    // read as "TURN is broken" rather than "something cached it".
    void reply.header('cache-control', 'no-store');

    if (!turnLimiter.tryConsume(request.ip)) {
      return reply.code(429).send({ error: 'rate-limited' });
    }
    if (!turnConfig) return reply.send({ iceServers: [], ttl: 0 });

    const { username, credential, ttl } = mintTurnCredential(turnConfig, Date.now());
    // Shaped as RTCConfiguration.iceServers so the caller can hand it
    // straight to an RTCPeerConnection without reshaping it.
    return reply.send({
      iceServers: [{ urls: turnConfig.urls, username, credential }],
      ttl,
    });
  });

  // Production only: in development Vite serves the client and proxies /ws
  // here, and dist/client does not exist yet — registering against a missing
  // root would throw at startup.
  if (process.env.NODE_ENV === 'production') {
    const clientDir = join(dirname(fileURLToPath(import.meta.url)), '../client');
    await app.register(fastifyStatic, { root: clientDir });
    // A share link is a client-side route; the key lives in the fragment and
    // never reaches here, so the same page is served for every code. Kept as
    // an explicit route (rather than folded into the fallback below) because
    // it's the one path the fallback's Accept-header heuristic must not be
    // the only thing standing behind — it's explicit, and it's tested.
    app.get('/s/:code', (_request, reply) => {
      // A room code is a credential — it is the whole of it — and a share
      // link gets pasted into chats, issue trackers and pastebins that
      // crawlers do read. `noindex` is sent as a header rather than as a
      // <meta> tag because the tag would live in the shared index.html and
      // would therefore have to be written by JavaScript, which a crawler is
      // not obliged to run; and it is sent rather than the path being
      // disallowed in robots.txt because a disallowed URL is never fetched,
      // so its directive is never read, and can still be indexed from a link
      // alone. Allowing the crawl is what makes the refusal stick.
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      return reply.sendFile('index.html');
    });

    // Only ever reached when no service worker was controlling — the worker
    // answers this POST from client/sw.ts and nothing gets this far. The body
    // is deliberately not read: the files are unrecoverable by now, since the
    // worker is the only thing that could have read them before the
    // navigation discarded them. This exists to land the user on a screen
    // that says so, rather than on a 404 in a window with no address bar.
    app.post(SHARE_TARGET_PATH, (_request, reply) => reply.redirect(SHARE_MISSED_PATH, 303));

    // Every other client-side route (/join, and whatever Tasks 8-12 add) has
    // no server-side handler of its own — @fastify/static's default wildcard
    // calls this for any GET that doesn't match a real file. Serve the SPA
    // shell for those SO LONG AS the request is actually asking for a page
    // (a real browser navigation sends `Accept: text/html`); a missing
    // asset — a stale script/stylesheet/font URL from an old build — must
    // still 404 rather than get an HTML body wired to the wrong bundle,
    // which is a far more confusing failure than a plain 404.
    app.setNotFoundHandler((request, reply) => {
      // Ahead of the Accept check, because a download iframe navigation sends
      // `Accept: text/html` and would otherwise be answered with the SPA
      // shell: the hidden iframe would boot a SECOND full App, allocate a
      // room, open another WebSocket and re-register the service worker,
      // entirely invisibly. This path is the service worker's alone — if the
      // worker is not controlling at fetch time (an update in progress, an
      // unregistration, a controller lost mid-flight), nothing here can serve
      // it and 404 is the honest answer.
      if (request.url.startsWith(DOWNLOAD_PATH_PREFIX)) {
        reply.code(404).send();
        return;
      }

      const accept = request.headers.accept ?? '';
      if (request.method === 'GET' && accept.includes('text/html')) {
        reply.sendFile('index.html');
        return;
      }
      reply.code(404).send();
    });
  }

  const sweeper = setInterval(() => {
    registry.sweep(Date.now(), MAX_IDLE_MS);
    createLimiter.sweep(MAX_IDLE_MS);
    joinLimiter.sweep(MAX_IDLE_MS);
    rtcLimiter.sweep(MAX_IDLE_MS);
    turnLimiter.sweep(MAX_IDLE_MS);
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  app.get('/ws', { websocket: true }, (socket, request) => {
    const clientIp = request.ip;
    let code: string | undefined;
    let peerId: PeerId | undefined;

    const peer: Peer = {
      send: (data) => { if (socket.readyState === socket.OPEN) socket.send(data); },
      close: (statusCode, reason) => socket.close(statusCode, reason),
    };

    const reply = (signal: ServerSignal): void => peer.send(JSON.stringify(signal));
    const tellOther = (signal: ServerSignal): void => {
      if (!code || !peerId) return;
      registry.other(code, peerId)?.send(JSON.stringify(signal));
    };

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      try {
        // Binary frames are opaque application ciphertext. Forward, never inspect.
        //
        // Forwarded unconditionally: this never checks the receiving socket's
        // bufferedAmount and never pauses the sender, so the relay imposes no
        // backpressure of its own. A receiver whose disk is slower than the
        // wire therefore accumulates the deficit in its own memory — see the
        // comment on Receiver.start. Fixing that needs a credit control frame
        // in the protocol (Plan 3), not a change here.
        if (isBinary) {
          if (!code || !peerId) return;
          registry.touch(code);
          registry.other(code, peerId)?.send(new Uint8Array(raw));
          return;
        }

        const signal = parseClientSignal(raw.toString());
        if (!signal) {
          reply({ t: 'error', reason: 'bad-request' });
          return;
        }

        switch (signal.t) {
          case 'create': {
            if (code) { reply({ t: 'error', reason: 'bad-request' }); return; }
            if (!createLimiter.tryConsume(clientIp)) {
              reply({ t: 'error', reason: 'rate-limited' });
              return;
            }
            const created = registry.create(peer);
            code = created.code;
            peerId = created.peerId;
            // The address this connection came from, told to the device it
            // belongs to and to nobody else. `request.ip` already honours
            // TRUST_PROXY (see resolveTrustProxy above), so behind a
            // correctly configured proxy this is the real client rather than
            // the proxy's own address — the same value the rate limiters key
            // on, which is exactly the one worth showing.
            reply({ t: 'created', code, peerId, ip: clientIp });
            return;
          }
          case 'join': {
            if (code) { reply({ t: 'error', reason: 'bad-request' }); return; }
            if (!joinLimiter.tryConsume(clientIp)) {
              reply({ t: 'error', reason: 'rate-limited' });
              return;
            }
            const normalized = normalizeCode(signal.code);
            if (!normalized) { reply({ t: 'error', reason: 'not-found' }); return; }
            const result = registry.join(normalized, peer);
            if (!result.ok) { reply({ t: 'error', reason: result.reason }); return; }
            code = normalized;
            peerId = result.peerId;
            reply({ t: 'joined', code, peerId, ip: clientIp });
            tellOther({ t: 'peer-joined' });
            return;
          }
          case 'rtc': {
            if (!code || !peerId) return;
            if (!rtcLimiter.tryConsume(clientIp)) {
              reply({ t: 'error', reason: 'rate-limited' });
              return;
            }
            registry.touch(code);
            tellOther({ t: 'rtc', payload: signal.payload });
            return;
          }
          default:
            reply({ t: 'error', reason: 'bad-request' });
        }
      } catch {
        reply({ t: 'error', reason: 'bad-request' });
        socket.close(1011, 'internal error');
      }
    });

    socket.on('close', () => {
      tellOther({ t: 'peer-left' });
      if (code && peerId) registry.leave(code, peerId);
      code = undefined;
      peerId = undefined;
    });
  });

  return app;
}

/**
 * True when this module is being executed directly (e.g.
 * `node dist/server/index.js`), not merely imported. Exported (rather than
 * inlined below) so tests/unit/entry-point-guard.test.ts can exercise the
 * comparison itself with synthetic paths, without spawning a process.
 *
 * Compares resolved absolute file URLs, not a suffix of argv1, because a
 * suffix match (e.g. "does import.meta.url end in index.js?") is also true
 * for any runner whose own entry file happens to be named index.js too —
 * including, in principle, a test runner's — which would make this module
 * bind a real port as a side effect of being merely imported by the test
 * suite and collide with tests that listen on `port: 0`.
 */
export function isDirectEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // realpathSync throws for a path that does not exist — an argv[1] that
    // is a bare command name resolved from PATH, a deleted file, a runner
    // that puts something other than a path there. None of those are this
    // module, so the answer is false; throwing here would take the whole
    // process (or, worse, an importing test suite) down at module load.
    return false;
  }
}

/**
 * Validated, not coerced. `Number('')` is 0 — which binds an arbitrary
 * ephemeral port nothing is proxying to — and `Number('87 87')` is NaN,
 * which Node also treats as port 0. Both look like a perfectly healthy
 * start-up, log a line saying so, and are unreachable; a typo has to fail
 * here rather than at the first user. Exported for the same reason
 * `isDirectEntry` is: so a test can exercise the rule without spawning a
 * process or binding anything.
 */
export function resolvePort(value: string | undefined): number {
  if (value === undefined) return 8787;
  const port = Number(value);
  // The blank check is not redundant: `Number('')` and `Number('   ')` are
  // both 0, an integer in range, so the numeric test alone would wave them
  // through. 0 itself is rejected for the same reason it would be a bug —
  // it means "any free port", i.e. one no proxy is pointed at.
  if (value.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

// Started directly, not imported: listen on the configured address.
if (isDirectEntry(process.argv[1], import.meta.url)) {
  const app = await buildServer();
  const port = resolvePort(process.env.PORT);
  const host = process.env.HOST ?? '0.0.0.0';
  const trust = resolveTrustProxy(process.env.TRUST_PROXY);
  // Said out loud for the same reason the proxy setting is: a misconfigured
  // TURN is invisible from outside — the server starts, the endpoint answers,
  // and every credential it mints is rejected by coturn. One line, at the one
  // moment an operator is looking.
  //
  // Counts, the TTL, and which credential style is live. Never a secret, not
  // even a prefix: a log line is the easiest place for one to end up
  // somewhere it should not. The style is worth saying because configuring
  // the wrong one for your TURN server is the failure this line exists to
  // catch, and it looks identical from outside either way.
  const turn = resolveTurnConfig(process.env);
  const turnSummary = turn
    ? `TURN: ${turn.urls.length} server(s), `
      + (turn.kind === 'hmac' ? `${turn.ttlSeconds}s signed credentials` : 'provider credentials (fixed pair)')
    : 'TURN: not configured (live video will rely on a direct path)';
  await app.listen({ port, host });
  // Said out loud because there is otherwise no way to tell from a running
  // server whether X-Forwarded-For is being honoured — and the failure is
  // silent in both directions. The container case is the trap this line
  // exists for: a relay in a container behind a host proxy sees the bridge
  // gateway (172.17.0.1), not loopback, so TRUST_PROXY=true quietly puts
  // every client in one rate-limit bucket. One log line, at the one moment
  // an operator is looking.
  // eslint-disable-next-line no-console
  console.log(
    `Quik Share listening on ${host}:${port} — X-Forwarded-For `
    + (trust === false
      ? 'ignored (per-IP limits key on the socket address)'
      : `trusted from ${trust} only`)
    + ` — ${turnSummary}`,
  );
}

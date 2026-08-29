# TURN Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the relay a `GET /turn` endpoint that mints short-lived TURN credentials, and ship a coturn service and the deployment documentation an operator needs to run one.

**Architecture:** `TURN_SECRET` and `TURN_URLS` are read at startup and validated the way `PORT` and `TRUST_PROXY` already are — loudly, at boot, never coerced. `GET /turn` returns an `iceServers` array in the shape `RTCConfiguration` wants, with a username of `<unix-expiry>:quikshare` and a credential of `base64(HMAC-SHA1(secret, username))` — coturn's standard `use-auth-secret` REST convention, which managed providers also speak. The secret never leaves the server. With the config unset the endpoint still answers `200`, with an empty list.

**Tech Stack:** TypeScript 5.6, Fastify 5, Node ≥22 (`node:crypto`), Vitest 3, coturn (container).

**Spec:** [`docs/superpowers/specs/2026-08-27-live-media-and-session-layout-design.md`](../specs/2026-08-27-live-media-and-session-layout-design.md) — §5 "TURN credentials", §9 phase 3, §10 Deployment.

**Plan 03 of 4.** Plans 01 (transport realm fix) and 02 (session layout) are merged. Plan 04 builds `MediaPeer` and the live UI, and is the first thing that will actually *call* this endpoint.

**Nothing user-visible ships in this plan.** No client file is touched. If the app looks or behaves differently after this, something is wrong. The endpoint is inert until plan 04 fetches it.

## Global Constraints

- Node **≥ 22**. On this machine `node` is not on the default `PATH`; prefix commands with `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"`.
- **`TURN_SECRET` must never reach a client.** Not in a response body, not in a log line, not in an error message. A leaked secret is an open TURN relay for anyone who finds it.
- **This endpoint is an abuse surface and must be treated as one.** It is necessarily unauthenticated — the client needs credentials before any session exists — so anyone who finds it can mint working TURN credentials and relay arbitrary traffic through the operator's server. Three things bound that, and all three are required: a short TTL, a per-IP rate limit, and coturn's own peer restrictions. Do not ship any one of them alone.
- Config is **validated, not coerced**, matching `resolvePort` and `resolveTrustProxy` in `server/index.ts`. A malformed value fails at startup with a message naming the variable, rather than silently degrading — the existing code has long comments explaining why, and they apply here verbatim.
- The server build stays free of client modules (`tsconfig.server.json`). Do not import anything under `client/`.
- This codebase's commenting standard is unusually high — doc comments explain *why*, at length, including rationale for rejected alternatives.
- Conventional commit messages. Commit after every task.
- Baseline: 822 tests across 65 files, `npm run typecheck` clean, `npm run build` succeeding, e2e 18 passing.

## File Structure

| File | Responsibility |
| --- | --- |
| `server/turn.ts` *(create)* | Config resolution and credential minting. Pure, no Fastify |
| `server/index.ts` *(modify)* | `GET /turn`, its rate limiter, and the startup log line |
| `tests/unit/turn.test.ts` *(create)* | Config validation and HMAC correctness |
| `tests/integration/turn-endpoint.test.ts` *(create)* | The route: shapes, rate limiting, unset config, cache headers |
| `docker-compose.yml` *(create)* | Relay + coturn, with the port range spelled out |
| `docs/deployment.md` *(modify)* | TURN section, env table rows, hardening |
| `README.md` *(modify)* | The env table gains the three new variables |

---

### Task 1: Resolve and validate the TURN configuration

**Files:**
- Create: `server/turn.ts`
- Test: `tests/unit/turn.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TurnConfig { urls: string[]; secret: string; ttlSeconds: number }
  export function resolveTurnConfig(env: NodeJS.ProcessEnv): TurnConfig | undefined
  export const DEFAULT_TURN_TTL_SECONDS = 600;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/turn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_TURN_TTL_SECONDS, resolveTurnConfig } from '../../server/turn.js';

describe('resolveTurnConfig', () => {
  it('is undefined when nothing is configured', () => {
    expect(resolveTurnConfig({})).toBeUndefined();
  });

  /*
   * Half-configured is the dangerous state, not the harmless one: URLs with
   * no secret would mint credentials nothing can verify, and a secret with no
   * URLs is a secret sitting in the environment for no reason. Both are
   * far more likely to be a deployment mistake than an intention.
   */
  it('refuses a half-configured pair rather than silently disabling', () => {
    // Matched on the whole sentence, not on a single variable name. Both
    // messages deliberately name BOTH variables — which is right for the
    // operator reading the failure, and useless for a test: `/TURN_SECRET/`
    // matches either message, so swapping the two throws would leave this
    // pair green while reporting the wrong cause.
    expect(() => resolveTurnConfig({ TURN_URLS: 'turn:t.example.com:3478' }))
      .toThrow(/TURN_URLS is set but TURN_SECRET is not/);
    expect(() => resolveTurnConfig({ TURN_SECRET: 's3cret' }))
      .toThrow(/TURN_SECRET is set but TURN_URLS is not/);
  });

  it('reads a single URL', () => {
    expect(resolveTurnConfig({ TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret' }))
      .toEqual({ urls: ['turn:t.example.com:3478'], secret: 's3cret', ttlSeconds: DEFAULT_TURN_TTL_SECONDS });
  });

  it('splits a comma-separated list and trims each entry', () => {
    const config = resolveTurnConfig({
      TURN_URLS: 'turn:t.example.com:3478, turns:t.example.com:5349 ',
      TURN_SECRET: 's3cret',
    });
    expect(config?.urls).toEqual(['turn:t.example.com:3478', 'turns:t.example.com:5349']);
  });

  /*
   * A `stun:` URL here is almost certainly a misunderstanding: STUN needs no
   * credentials, is baked into the client bundle at build time via
   * VITE_STUN_URLS, and putting one here would produce an ICE server with a
   * username and password that mean nothing. Failing names the confusion.
   */
  it('rejects a URL that is not turn: or turns:', () => {
    expect(() => resolveTurnConfig({ TURN_URLS: 'stun:s.example.com:3478', TURN_SECRET: 's3cret' }))
      .toThrow(/turn:/);
    expect(() => resolveTurnConfig({ TURN_URLS: 'https://t.example.com', TURN_SECRET: 's3cret' }))
      .toThrow(/turn:/);
  });

  it('accepts a custom TTL', () => {
    expect(resolveTurnConfig({
      TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret', TURN_TTL_SECONDS: '120',
    })?.ttlSeconds).toBe(120);
  });

  /*
   * Same discipline as resolvePort: Number('') is 0 and Number('12 12') is
   * NaN, and both would read as a plausible-looking startup that mints
   * already-expired credentials for every client, forever.
   */
  it('rejects a TTL that is empty, non-numeric, zero or negative', () => {
    for (const bad of ['', '   ', 'abc', '0', '-5', '12.5']) {
      expect(() => resolveTurnConfig({
        TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret', TURN_TTL_SECONDS: bad,
      })).toThrow(/TURN_TTL_SECONDS/);
    }
  });

  /*
   * An hour is already generous for something the client re-fetches per
   * share. A very long TTL turns one leaked response into a durable key to
   * the operator's relay, so the ceiling is a guardrail, not a preference.
   */
  it('rejects a TTL beyond an hour', () => {
    expect(() => resolveTurnConfig({
      TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret', TURN_TTL_SECONDS: '7200',
    })).toThrow(/TURN_TTL_SECONDS/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/turn.test.ts
```

Expected: FAIL — `server/turn.ts` does not exist.

- [ ] **Step 3: Implement**

Read `resolvePort` and `resolveTrustProxy` in `server/index.ts` first — they are the house pattern for this exact job, and their comments explain at length why validation happens at boot rather than at use. Then create `server/turn.ts`:

```ts
/**
 * TURN credentials, and the configuration that produces them.
 *
 * Kept out of server/index.ts so the arithmetic and the validation can be
 * tested without building a Fastify instance — the same reason `resolvePort`
 * and `resolveTrustProxy` are exported pure functions rather than inline
 * checks.
 */

/**
 * Ten minutes. A client fetches this once per share attempt, so nothing needs
 * a long life; and every second of TTL is a second a leaked response stays
 * usable against the operator's relay.
 */
export const DEFAULT_TURN_TTL_SECONDS = 600;

/** An hour. See `resolveTurnConfig` for why there is a ceiling at all. */
const MAX_TURN_TTL_SECONDS = 3600;

export interface TurnConfig {
  urls: string[];
  /** Never leaves this process. Not in a response, not in a log line. */
  secret: string;
  ttlSeconds: number;
}

/**
 * Reads TURN configuration from the environment, or returns undefined when
 * there is none — which is a fully supported way to run this app: without
 * TURN, live video is attempted anyway and often succeeds on a LAN, and file
 * transfer is unaffected either way because it has the WebSocket relay.
 *
 * Throws rather than degrading for three cases, all of which are far more
 * likely to be a deployment mistake than an intention:
 *
 *   - A HALF-CONFIGURED PAIR. URLs with no secret mints credentials nothing
 *     can verify; a secret with no URLs is a secret sitting in the
 *     environment for no reason. Silently disabling either would hand the
 *     operator a server that looks healthy and cannot relay media, with
 *     nothing anywhere saying why.
 *   - A URL THAT IS NOT `turn:` OR `turns:`. A `stun:` entry here is the
 *     likely mistake, and it is a category error: STUN needs no credentials
 *     at all and is baked into the client bundle at build time via
 *     VITE_STUN_URLS. Accepting one would produce an ICE server carrying a
 *     username and password that mean nothing.
 *   - A TTL THAT IS NOT A SENSIBLE INTEGER. `Number('')` is 0 and
 *     `Number('12 12')` is NaN — the same trap `resolvePort` documents. A
 *     zero or negative TTL mints already-expired credentials for every client
 *     forever, while looking like a perfectly healthy startup. The ceiling is
 *     a guardrail rather than a preference: this endpoint is unauthenticated,
 *     so a very long TTL turns one leaked response into a durable key.
 */
export function resolveTurnConfig(env: NodeJS.ProcessEnv): TurnConfig | undefined {
  const rawUrls = env.TURN_URLS?.trim();
  const secret = env.TURN_SECRET?.trim();

  if (!rawUrls && !secret) return undefined;
  if (!rawUrls) throw new Error('TURN_SECRET is set but TURN_URLS is not — TURN cannot be used without both.');
  if (!secret) throw new Error('TURN_URLS is set but TURN_SECRET is not — TURN cannot be used without both.');

  const urls = rawUrls.split(',').map((url) => url.trim()).filter(Boolean);
  for (const url of urls) {
    if (!/^turns?:/.test(url)) {
      throw new Error(
        `TURN_URLS: ${JSON.stringify(url)} is not a turn: or turns: URL. STUN servers do not belong here — `
        + 'they need no credentials and are set at build time via VITE_STUN_URLS.',
      );
    }
  }

  return { urls, secret, ttlSeconds: resolveTtl(env.TURN_TTL_SECONDS) };
}

function resolveTtl(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TURN_TTL_SECONDS;
  const ttl = Number(value);
  // The blank check is not redundant: `Number('')` and `Number('   ')` are
  // both 0, an integer, so the numeric test alone would wave them through.
  if (value.trim() === '' || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TURN_TTL_SECONDS) {
    throw new Error(
      `TURN_TTL_SECONDS must be an integer between 1 and ${MAX_TURN_TTL_SECONDS}, got ${JSON.stringify(value)}`,
    );
  }
  return ttl;
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npx vitest run tests/unit/turn.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add server/turn.ts tests/unit/turn.test.ts
git commit -m "feat(server): validate TURN configuration at startup"
```

---

### Task 2: Mint a credential

coturn's `use-auth-secret` REST convention: the username is an expiry timestamp, the password is an HMAC of that username under the shared secret. coturn recomputes the same HMAC to verify, so no credential is ever stored anywhere.

**Files:**
- Modify: `server/turn.ts`
- Test: `tests/unit/turn.test.ts`

**Interfaces:**
- Produces: `export function mintTurnCredential(config: TurnConfig, nowMs: number): { username: string; credential: string; ttl: number }`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/turn.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { mintTurnCredential } from '../../server/turn.js';

const CONFIG = { urls: ['turn:t.example.com:3478'], secret: 's3cret', ttlSeconds: 600 };

describe('mintTurnCredential', () => {
  /*
   * The interop contract, not an implementation detail. coturn recomputes
   * exactly this HMAC to verify the password it was handed, so a change to
   * the algorithm, the encoding, or the username format is a change every
   * deployed coturn has to agree with. Asserted against an independently
   * computed value rather than a recorded constant, so the test states the
   * convention rather than merely pinning today's output.
   */
  it('follows coturn REST: username is <expiry>:quikshare, credential is base64 HMAC-SHA1 of it', () => {
    const nowMs = 1_700_000_000_000;
    const { username, credential, ttl } = mintTurnCredential(CONFIG, nowMs);

    expect(username).toBe(`${1_700_000_000 + 600}:quikshare`);
    expect(ttl).toBe(600);
    expect(credential).toBe(createHmac('sha1', 's3cret').update(username).digest('base64'));
  });

  it('moves the expiry with the clock', () => {
    const a = mintTurnCredential(CONFIG, 1_700_000_000_000);
    const b = mintTurnCredential(CONFIG, 1_700_000_060_000);
    expect(Number(b.username.split(':')[0]) - Number(a.username.split(':')[0])).toBe(60);
  });

  it('honours a custom TTL', () => {
    const { username, ttl } = mintTurnCredential({ ...CONFIG, ttlSeconds: 120 }, 1_700_000_000_000);
    expect(username).toBe(`${1_700_000_000 + 120}:quikshare`);
    expect(ttl).toBe(120);
  });

  /*
   * Two mints a second apart must differ, or a cached response would be
   * indistinguishable from a fresh one and the TTL would mean nothing.
   */
  it('produces a different credential once the expiry moves', () => {
    const a = mintTurnCredential(CONFIG, 1_700_000_000_000);
    const b = mintTurnCredential(CONFIG, 1_700_000_001_000);
    expect(b.credential).not.toBe(a.credential);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/turn.test.ts -t 'mintTurnCredential'
```

- [ ] **Step 3: Implement**

Add to `server/turn.ts`:

```ts
import { createHmac } from 'node:crypto';

/**
 * One credential, in coturn's `use-auth-secret` REST form.
 *
 * The shape is an interop contract, not a design choice. coturn stores no
 * credentials at all: it takes the username it was handed, recomputes
 * `base64(HMAC-SHA1(secret, username))` under its own `static-auth-secret`,
 * and compares. That is *why* the username has to be the expiry timestamp —
 * it is the only channel available for communicating one — and why the
 * algorithm and encoding are not ours to prefer. Managed TURN providers speak
 * the same convention, so pointing TURN_URLS at one is a deployment choice
 * rather than a code change.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call inside, matching
 * `RoomRegistry`'s injectable `now`: it is what lets the expiry arithmetic be
 * tested without freezing time globally.
 *
 * The `:quikshare` suffix is decoration — coturn ignores everything after the
 * colon — but it makes a credential recognisable in a coturn log, which is
 * worth one constant.
 */
export function mintTurnCredential(
  config: TurnConfig,
  nowMs: number,
): { username: string; credential: string; ttl: number } {
  const expiry = Math.floor(nowMs / 1000) + config.ttlSeconds;
  const username = `${expiry}:quikshare`;
  return {
    username,
    credential: createHmac('sha1', config.secret).update(username).digest('base64'),
    ttl: config.ttlSeconds,
  };
}
```

- [ ] **Step 4: Run the tests, then commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
git add server/turn.ts tests/unit/turn.test.ts
git commit -m "feat(server): mint coturn REST credentials"
```

---

### Task 3: The `GET /turn` endpoint

**Files:**
- Modify: `server/index.ts`
- Test: `tests/integration/turn-endpoint.test.ts`

**Interfaces:**
- Consumes: `resolveTurnConfig`, `mintTurnCredential` (Tasks 1–2)
- Produces: `ServerLimits.turnPerMinute?: number`; the route `GET /turn`
- Response shape, which plan 04 consumes:
  ```ts
  { iceServers: [{ urls: string[]; username: string; credential: string }], ttl: number }
  // unconfigured: { iceServers: [], ttl: 0 }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/integration/turn-endpoint.test.ts`. Use Fastify's `app.inject()` rather than a real listen — these are HTTP request/response assertions and need no socket:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  delete process.env.TURN_TTL_SECONDS;
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
   * session exists — so the rate limit is one of only three things standing
   * between this endpoint and an open relay.
   */
  it('rate-limits per client', async () => {
    const server = await build(
      { TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret' },
      { turnPerMinute: 2 },
    );
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await server.inject({ method: 'GET', url: '/turn' })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/integration/turn-endpoint.test.ts
```

Expected: FAIL — the route 404s.

- [ ] **Step 3: Implement**

In `server/index.ts`, add to `ServerLimits`:

```ts
  turnPerMinute?: number;
```

Resolve the config beside `resolveTrustProxy` at the top of `buildServer`, so a malformed value fails at boot rather than on the first request that needs it:

```ts
  // Resolved here, next to TRUST_PROXY, for the same reason: a bad value
  // should stop the process at startup where an operator is watching, not
  // surface as a broken feature hours later.
  const turnConfig = resolveTurnConfig(process.env);
```

Add the limiter beside the existing three:

```ts
  // Far tighter than the others, because the shape of legitimate use is
  // different: a real client fetches this ONCE per share attempt, not in
  // bursts the way rtc negotiation does. There is no honest reason to ask
  // ten times a minute, and this endpoint is unauthenticated — the budget is
  // one of only three things standing between it and an open relay.
  const turnLimiter = new RateLimiter({
    capacity: limits.turnPerMinute ?? 10,
    refillPerMs: (limits.turnPerMinute ?? 10) / 60_000,
  });
```

Register the route **before** the `if (process.env.NODE_ENV === 'production')` block, for reading order — though verify before trusting registration order as a safety property: on fastify 5.12.1 / find-my-way 9.9.0, an exact route like `/turn` is matched ahead of `@fastify/static`'s wildcard (`GET prefix + '*'`) regardless of which was registered first, since find-my-way resolves by trie specificity, not registration order. The real failure mode is the route being **absent** — deleted, or gated out of production by a later refactor — in which case the request falls through to the SPA fallback and gets `text/html` instead of JSON; that is what `tests/integration/turn-endpoint.test.ts`'s `'is not shadowed by the production SPA fallback'` test guards against:

```ts
  /**
   * Short-lived TURN credentials for the live-media connection.
   *
   * Unauthenticated by necessity: the client needs ICE servers before any
   * room exists, so there is nothing to authenticate against. Four bounds
   * constrain the abuse that invites, each on a different axis: how long a
   * leaked response stays usable (the TTL, server/turn.ts), how many
   * credentials one address can mint (the per-IP budget above), where a
   * credential may relay (coturn's `denied-peer-ip`), and how much
   * (coturn's `--max-bps` and quotas). What none of them does is close the
   * relay: with all four in place a stranger can still reach arbitrary
   * PUBLIC peers, which is inherent to an unauthenticated TURN endpoint.
   * What the deny rules prevent is the hop into the operator's PRIVATE
   * network — a real protection, and a narrower claim than "not an open
   * relay". (Corrected during final review; the shipped server/index.ts is
   * the source of truth.)
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
```

Add `turnLimiter.sweep(MAX_IDLE_MS)` to the existing sweeper interval alongside the other three, or its buckets grow for every IP that ever asks.

- [ ] **Step 4: Extend the startup log**

The existing line reports the resolved `TRUST_PROXY` because there is otherwise no way to tell from a running server whether `X-Forwarded-For` is honoured. TURN has exactly that property too: an operator who fat-fingers `TURN_SECRET` gets a server that looks healthy and mints credentials coturn will reject, with nothing anywhere saying so.

In the `isDirectEntry` block at the bottom of `server/index.ts`, resolve the config again for the log and append to the existing message:

```ts
  // Said out loud for the same reason the proxy setting is: a misconfigured
  // TURN is invisible from outside — the server starts, the endpoint answers,
  // and every credential it mints is rejected by coturn. One line, at the one
  // moment an operator is looking.
  //
  // Counts and the TTL only. The secret is never logged, not even a prefix:
  // a log line is the easiest place for it to end up somewhere it should not.
  const turn = resolveTurnConfig(process.env);
  const turnSummary = turn
    ? `TURN: ${turn.urls.length} server(s), ${turn.ttlSeconds}s credentials`
    : 'TURN: not configured (live video will rely on a direct path)';
```

Append `turnSummary` to the existing `console.log`. **Never log the secret**, or any prefix of it.

- [ ] **Step 5: Run everything, then commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test && npm run build
git add server/index.ts tests/integration/turn-endpoint.test.ts
git commit -m "feat(server): GET /turn mints short-lived credentials

Unauthenticated by necessity, so it is bounded by a short TTL, a per-IP
rate limit, and coturn's own peer restrictions — all three, not one."
```

---

### Task 4: coturn in a compose file

**Files:**
- Create: `docker-compose.yml`
- Test: none automated — verified by the manual check in Step 3

There is no compose file today; the repo ships a `Dockerfile` and a `render.yaml`. This adds the two-service local and self-host story without changing either.

- [ ] **Step 1: Write the compose file**

> **The shipped `docker-compose.yml` is the source of truth, not this snippet.**
> A final review of this branch found four defects in the version below and
> they were fixed in the file, not here: the secret was passed on coturn's
> argv (world-readable via `/proc/<pid>/cmdline` and echoed by `docker
> inspect`) and now lives in a bind-mounted `coturn/turnserver.conf` read with
> `-c`; the deny list was missing `100.64.0.0/10`, the IPv6 ranges and the
> IPv4-in-IPv6 encodings; nothing bounded relay *volume*, so `--max-bps` and
> the allocation quotas were added; and `TURN_URLS` defaulted to
> `turn:localhost:3478`, which is right on one machine and silently wrong
> everywhere else. The snippet is corrected below on those four points, but
> read the real file for the comments that explain them — copy from it, not
> from here.

```yaml
# Two services: the relay this repo builds, and a TURN server for live media.
#
# TURN exists only for the live camera/screen path. File transfer never uses
# it — that has the WebSocket relay as its always-works baseline, and putting
# multi-gigabyte transfers on a TURN server would be a bandwidth bill for no
# benefit (see the design spec, D2). Media has no such fallback, which is the
# whole reason this file exists.
services:
  relay:
    build:
      context: .
      # Baked into the client bundle at build time — it cannot be set at run
      # time, unlike everything under `environment` below.
      args:
        VITE_STUN_URLS: ${VITE_STUN_URLS:-}
    ports:
      - "8787:8787"
    environment:
      NODE_ENV: production
      # The relay sits behind whatever TLS terminator you put in front of it.
      # Left unset here on purpose: with no proxy in this file, trusting one
      # would put every client in a single rate-limit bucket.
      # Dialled by the BROWSER, never by this container. The relay only mints
      # credentials; it never connects to coturn. So `localhost` is correct
      # for a dev machine running both, and pointing it at a compose service
      # name — the obvious "fix" if you reason about container-to-container
      # reachability — would break every real client, because the name is
      # resolved by the browser and not by Docker.
      #
      # Required, not defaulted: a `turn:localhost:3478` default hands every
      # browser its own loopback while the relay logs a healthy `TURN: 1
      # server(s)` — the exact state server/turn.ts throws four times to
      # prevent, reintroduced at the compose layer.
      TURN_URLS: ${TURN_URLS:?TURN_URLS must be set — the address the BROWSER dials; see docs/deployment.md}
      TURN_SECRET: ${TURN_SECRET:?TURN_SECRET must be set — see docs/deployment.md}

    # No depends_on: the relay never connects to coturn, so there is no
    # ordering to express and declaring one states a dependency that does not
    # exist.

  coturn:
    image: coturn/coturn:latest
    # Host networking, not published ports. TURN allocates a fresh relay port
    # per session out of the range below, and Docker's userland proxy does not
    # forward UDP well enough for that to work reliably through a bridge. If
    # host networking is unavailable (Docker Desktop on macOS/Windows), publish
    # 3478 AND the whole 49160-49200 range explicitly and expect to debug it.
    network_mode: host
    volumes:
      # Holds one line, `static-auth-secret=<value>`. Created by the operator
      # ((umask 077; printf ... > coturn/turnserver.conf)) and gitignored. NOT
      # passed as --static-auth-secret: argv is world-readable through
      # /proc/<pid>/cmdline and echoed by `docker inspect`, while a process's
      # environment is uid-restricted. coturn has no --static-auth-secret-file
      # and no env expansion, so a parsed config file is its only non-argv
      # input for this value.
      - ./coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
    command:
      - -c
      - /etc/coturn/turnserver.conf
      - --listening-port=3478
      # THE RELAY PORT RANGE. This is the operational sharp edge of the whole
      # setup: it is what gets forgotten in a firewall, and the symptom is
      # media that negotiates successfully and then never arrives — which
      # looks like an app bug, not a network one. Whatever you set here must
      # be open as UDP end to end.
      - --min-port=49160
      - --max-port=49200
      # The REST convention the relay's GET /turn mints against. coturn stores
      # no credentials: it recomputes base64(HMAC-SHA1(secret, username)) and
      # compares, so the secret in turnserver.conf must be byte-identical to
      # the relay's TURN_SECRET.
      - --use-auth-secret
      - --realm=${TURN_REALM:-quikshare.local}
      # Hardening, and none of it is optional. Anyone who can reach GET /turn
      # can mint a working credential — that endpoint is unauthenticated by
      # necessity — so without these a stranger can use this server as a hop
      # into the operator's own private network.
      - --no-multicast-peers
      - --denied-peer-ip=0.0.0.0-0.255.255.255
      - --denied-peer-ip=10.0.0.0-10.255.255.255
      # RFC 6598 shared address space: CGNAT, several managed cloud networks,
      # and the entire Tailscale range. Not optional on a cloud VM.
      - --denied-peer-ip=100.64.0.0-100.127.255.255
      - --denied-peer-ip=127.0.0.0-127.255.255.255
      - --denied-peer-ip=169.254.0.0-169.254.255.255
      - --denied-peer-ip=172.16.0.0-172.31.255.255
      - --denied-peer-ip=192.168.0.0-192.168.255.255
      # --denied-peer-ip matches only its own address family, and coturn with
      # no --listening-ip binds every IPv6 address on the host too — so an
      # IPv4-only list leaves the whole IPv6 private space open. See the
      # shipped file for the full reasoning on these and the four
      # IPv4-in-IPv6 encoding rules that follow them.
      - --denied-peer-ip=::1
      - --denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      - --denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      - --denied-peer-ip=fec0::-feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      - --denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255
      - --denied-peer-ip=2002::-2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      - --denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
      - --denied-peer-ip=::0.0.0.0-::255.255.255.255
      # The deny rules bound WHERE a credential may relay; nothing above
      # bounds HOW MUCH. Without these, one in-budget credential can relay
      # unlimited traffic to arbitrary public peers for its whole lifetime.
      # --max-bps is per session and in BYTES per second. --user-quota is kept
      # loose on purpose: the REST username is the expiry second, so a tight
      # value punishes same-second cohorts of multi-homed clients without
      # inconveniencing an abuser, who simply mints again a second later.
      - --max-bps=1000000
      - --total-quota=100
      - --user-quota=30
      # No local control interface, and no obsolete TLS. No --cert/--pkey is
      # set, so this service does not serve `turns:` at all.
      - --no-cli
      - --no-tlsv1
      - --no-tlsv1_1
```

Two things to confirm rather than assume while writing it:

- **TCP as well as UDP on 3478.** Some networks block UDP outright, and TURN over TCP is exactly the fallback that rescues them. `--listening-port` covers both by default in coturn; verify that against the image you pin rather than trusting this comment.
- **`TURN_SECRET` no longer comes from one place, and that is the cost of keeping it off argv.** The relay reads the environment variable; coturn reads `coturn/turnserver.conf`. They can drift, and a drift is undetectable from either process — it shows only as TURN never working. Derive the file from the variable rather than typing it twice. The `:?` syntax still makes compose refuse to start on an unset variable, which is worth keeping: an empty secret would produce a TURN server that accepts nothing and a relay that mints credentials for it anyway.
- **The secret is still in `docker compose config`.** Compose interpolates variables when it renders the file, so anything it substitutes into the relay's `environment:` is echoed regardless of how a container consumes it. Moving coturn's copy into a file closes coturn's argv; it does not close this. Do not paste rendered compose output into a log or an issue.
- **`.dockerignore` must exclude the secret files.** The `Dockerfile` build stage is `COPY . .`, so `.env` and `coturn/` would otherwise land in that stage's layer and stay reachable through `--target build`, a cache export, or `docker history`, even though the runtime stage copies only `dist`.

- [ ] **Step 2: Validate the file parses**

```bash
docker compose -f docker-compose.yml config >/dev/null && echo "compose file is valid"
```

If `docker compose` is unavailable in this environment, say so in your report rather than skipping the check silently — and validate the YAML with any parser available instead.

- [ ] **Step 3: Manual verification, and be honest about its limits**

A full end-to-end TURN relay check needs two hosts on networks that actually block peer-to-peer, which this environment cannot provide. What you *can* verify, and should:

- the relay container starts and `GET /turn` returns a populated `iceServers` when `TURN_SECRET`/`TURN_URLS` are set from the compose environment;
- coturn starts and logs that it is listening on 3478.

Report exactly what you verified and what you could not. Do not describe an untested path as working.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: compose file with coturn, hardened and port-ranged"
```

---

### Task 5: Document it

**Files:**
- Modify: `docs/deployment.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/deployment.md`**

Add three rows to the Environment table (`TURN_URLS`, `TURN_SECRET`, `TURN_TTL_SECONDS`), matching the existing rows' level of detail — they are unusually thorough and the new ones should not be the thin ones.

Then a `## TURN` section covering:

- **What it is for**, in one paragraph: WebRTC media has no relay fallback the way file transfer does, so on a network that blocks peer-to-peer, live video simply cannot connect without TURN. File transfer is unaffected either way — it keeps using the WebSocket relay.
- **The port range**, prominently. It is the thing that gets forgotten, and the symptom — media that negotiates then silently never arrives — does not look like a firewall problem.
- **Why the endpoint is unauthenticated**, and the three bounds on it. An operator who does not understand this may "helpfully" raise the TTL or drop the rate limit.
- **The `denied-peer-ip` hardening**, and what it prevents: without it the TURN server relays to the operator's own private network for anyone who can mint a credential.
- **How to verify after deploying**: `curl https://your-host/turn` should return a populated `iceServers`, and the startup log line says whether TURN resolved.
- **Running without TURN**, which is fully supported: leave both variables unset, live video is attempted anyway and often succeeds on a LAN, and file transfer is completely unaffected.

- [ ] **Step 2: `README.md`**

Add the three variables to its environment table. Keep the entries shorter than the deployment doc's — the README's table is a summary and its existing rows set that tone.

Do **not** add a feature bullet claiming live video works. It does not until plan 04, and the landing page and README must not promise it early — the same discipline that kept "Direct" off the landing page until it was true.

- [ ] **Step 3: Verify and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm test   # tests/unit/index-html.test.ts and friends read repo files; make sure nothing broke
git add docs/deployment.md README.md
git commit -m "docs: TURN deployment, hardening, and the port range that gets forgotten"
```

---

## Verification

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test && npm run build && CI=1 npm run test:e2e
```

Plus two checks no test performs:

1. Start the server with `TURN_URLS` and `TURN_SECRET` set and `curl localhost:8787/turn`. Confirm a populated `iceServers`, a `<digits>:quikshare` username, and no trace of the secret.
2. Start it with neither set and confirm `{"iceServers":[],"ttl":0}` and a startup log line saying TURN is not configured — the "runs fine without it" path is the one most people will be on.

## What this plan deliberately does not do

- **No client code.** `MediaPeer`, `getUserMedia`, `getDisplayMedia` and the live UI are all plan 04. Nothing fetches `/turn` yet.
- **No TURN for the file path.** `DataPeer` stays STUN-only by design (spec §4 D2): a multi-gigabyte transfer must never land on metered TURN, and the WebSocket relay already covers those networks.
- **No managed-provider integration.** The REST convention this implements is what Cloudflare, Twilio and Metered also speak, so pointing `TURN_URLS` at one of them is a deployment choice, not a code change.

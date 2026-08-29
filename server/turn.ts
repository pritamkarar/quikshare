/**
 * TURN credentials, and the configuration that produces them.
 *
 * Kept out of server/index.ts so the arithmetic and the validation can be
 * tested without building a Fastify instance — the same reason `resolvePort`
 * and `resolveTrustProxy` are exported pure functions rather than inline
 * checks.
 */

import { createHmac } from 'node:crypto';

/**
 * Ten minutes. A client fetches this once per share attempt, so nothing needs
 * a long life; and every second of TTL is a second a leaked response stays
 * usable against the operator's relay.
 */
export const DEFAULT_TURN_TTL_SECONDS = 600;

/** An hour. See `resolveTurnConfig` for why there is a ceiling at all. */
const MAX_TURN_TTL_SECONDS = 3600;

/**
 * The two ways a deployment can hand a browser a working TURN credential.
 *
 * A discriminated union rather than one interface with optional fields,
 * because the invalid states are the interesting ones: a config carrying
 * both a shared secret and a fixed username, or neither, is a deployment
 * mistake this file exists to refuse — and an optional-field shape would
 * make both representable and push the check to every reader.
 *
 * `ttlSeconds` is on both, and means something slightly different on each.
 * On 'hmac' it is the credential's actual lifetime, because this process
 * chose the expiry it signed. On 'static' the provider decides how long the
 * pair lives and this process cannot know, so it is only how long a client
 * should treat the response as fresh — which is what the client does with
 * it either way (client/media/ice.ts refetches per share attempt and
 * ignores the field).
 */
export type TurnConfig =
  | {
    kind: 'hmac';
    urls: string[];
    /** Never leaves this process. Not in a response, not in a log line. */
    secret: string;
    ttlSeconds: number;
  }
  | {
    kind: 'static';
    urls: string[];
    /**
     * A long-lived pair issued by a managed provider (Metered, and anything
     * else whose dashboard hands you a username and password rather than a
     * secret to sign with). Unlike `secret`, `credential` DOES leave this
     * process — that is the whole point of it — so it is a password to one
     * provider account, not a key that mints unlimited credentials the way
     * `secret` is. Rotate it in the provider's dashboard, not here.
     */
    username: string;
    credential: string;
    ttlSeconds: number;
  };

/**
 * Reads TURN configuration from the environment, or returns undefined when
 * there is none — which is a fully supported way to run this app: without
 * TURN, live video is attempted anyway and often succeeds on a LAN, and file
 * transfer is unaffected either way because it has the WebSocket relay.
 *
 * Two credential styles, and a deployment picks exactly one. `TURN_SECRET`
 * is coturn's `use-auth-secret` convention, where this process signs a
 * short-lived credential the server recomputes and verifies. `TURN_USERNAME`
 * + `TURN_CREDENTIAL` is what every managed provider hands you instead: a
 * long-lived pair minted in their dashboard, which this endpoint only
 * forwards. Neither is more correct; they are what the two kinds of TURN
 * server accept.
 *
 * Throws rather than degrading for six cases, all of which are far more
 * likely to be a deployment mistake than an intention:
 *
 *   - A HALF-CONFIGURED PAIR. URLs with no credentials of either style mints
 *     nothing anything can verify; credentials with no URLs are a secret
 *     sitting in the environment for no reason. Silently disabling either
 *     would hand the operator a server that looks healthy and cannot relay
 *     media, with nothing anywhere saying why.
 *   - BOTH STYLES AT ONCE. A secret and a fixed username describe two
 *     different TURN servers, and picking one for the operator would mean
 *     half their configuration silently does nothing.
 *   - HALF OF THE STATIC PAIR. A username with no credential, or the
 *     reverse, is the same mistake as the first case one level down.
 *   - A URL THAT IS NOT `turn:` OR `turns:`. A `stun:` entry here is the
 *     likely mistake, and it is a category error: STUN needs no credentials
 *     at all and is baked into the client bundle at build time via
 *     VITE_STUN_URLS. Accepting one would produce an ICE server carrying a
 *     username and password that mean nothing.
 *   - TURN_URLS CONTAINING ONLY COMMAS AND WHITESPACE. After splitting and
 *     trimming, the variable is set but yields no usable URLs, producing a
 *     "valid" config with an empty array — indistinguishable at runtime from
 *     "no TURN configured at all", masking the misconfiguration entirely.
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
  const username = env.TURN_USERNAME?.trim();
  const credential = env.TURN_CREDENTIAL?.trim();
  const anyStatic = Boolean(username || credential);

  if (!rawUrls && !secret && !anyStatic) return undefined;
  if (secret && anyStatic) {
    throw new Error(
      'TURN_SECRET and TURN_USERNAME/TURN_CREDENTIAL are both set — they are two different credential styles for two '
      + 'different kinds of TURN server. Keep TURN_SECRET for coturn, or the pair for a managed provider, not both.',
    );
  }
  if (!rawUrls) {
    throw new Error(
      secret
        ? 'TURN_SECRET is set but TURN_URLS is not — TURN cannot be used without both.'
        : 'TURN_USERNAME/TURN_CREDENTIAL is set but TURN_URLS is not — TURN cannot be used without both.',
    );
  }
  if (!secret && !anyStatic) {
    throw new Error(
      'TURN_URLS is set but TURN_SECRET is not — TURN cannot be used without both. For a managed provider that issues '
      + 'a long-lived username and password instead of a signing secret, set TURN_USERNAME and TURN_CREDENTIAL.',
    );
  }
  if (anyStatic && !(username && credential)) {
    throw new Error(
      username
        ? 'TURN_USERNAME is set but TURN_CREDENTIAL is not — a provider credential needs both halves.'
        : 'TURN_CREDENTIAL is set but TURN_USERNAME is not — a provider credential needs both halves.',
    );
  }

  const urls = rawUrls.split(',').map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0) {
    throw new Error(
      'TURN_URLS is set but contains no usable URL — only commas and whitespace. Remove it or add at least one turn: or turns: URL.',
    );
  }

  for (const url of urls) {
    if (!/^turns?:/.test(url)) {
      throw new Error(
        `TURN_URLS: ${JSON.stringify(url)} is not a turn: or turns: URL. STUN servers do not belong here — `
        + 'they need no credentials and are set at build time via VITE_STUN_URLS.',
      );
    }
  }

  const ttlSeconds = resolveTtl(env.TURN_TTL_SECONDS);
  return username && credential
    ? { kind: 'static', urls, username, credential, ttlSeconds }
    : { kind: 'hmac', urls, secret: secret!, ttlSeconds };
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

/**
 * One credential for the browser, in whichever form this deployment's TURN
 * server accepts.
 *
 * A 'static' config has nothing to mint: the provider already issued the
 * pair, and this returns it unchanged. Everything below describes the 'hmac'
 * case, which is the one with an interop contract to keep.
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
  if (config.kind === 'static') {
    return { username: config.username, credential: config.credential, ttl: config.ttlSeconds };
  }
  const expiry = Math.floor(nowMs / 1000) + config.ttlSeconds;
  const username = `${expiry}:quikshare`;
  return {
    username,
    credential: createHmac('sha1', config.secret).update(username).digest('base64'),
    ttl: config.ttlSeconds,
  };
}

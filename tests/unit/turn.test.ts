import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TURN_TTL_SECONDS, mintTurnCredential, resolveTurnConfig, type TurnConfig } from '../../server/turn.js';

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

  /*
   * The second credential style: a long-lived username and password minted
   * in a managed provider's dashboard (Metered and friends), which this
   * endpoint forwards rather than signs. A deployment picks one style or the
   * other — the checks below are about refusing every way of picking both,
   * or half of one.
   */
  it('accepts a provider pair instead of a signing secret', () => {
    expect(resolveTurnConfig({
      TURN_URLS: 'turn:relay.example.com:80',
      TURN_USERNAME: 'user123',
      TURN_CREDENTIAL: 'pass456',
    })).toEqual({
      kind: 'static',
      urls: ['turn:relay.example.com:80'],
      username: 'user123',
      credential: 'pass456',
      ttlSeconds: DEFAULT_TURN_TTL_SECONDS,
    });
  });

  it('refuses both credential styles at once rather than picking one', () => {
    // Two styles configured describes two different TURN servers. Choosing
    // for the operator would leave half their configuration silently inert.
    expect(() => resolveTurnConfig({
      TURN_URLS: 'turn:t.example.com:3478',
      TURN_SECRET: 's3cret',
      TURN_USERNAME: 'user123',
      TURN_CREDENTIAL: 'pass456',
    })).toThrow(/both set/);
  });

  it('refuses half of a provider pair, naming which half is missing', () => {
    // Matched on the specific half, not on a shared substring: a single
    // /TURN_CREDENTIAL/ would match either message and leave the two throws
    // swappable without failing.
    expect(() => resolveTurnConfig({ TURN_URLS: 'turn:t.example.com:80', TURN_USERNAME: 'user123' }))
      .toThrow(/TURN_USERNAME is set but TURN_CREDENTIAL is not/);
    expect(() => resolveTurnConfig({ TURN_URLS: 'turn:t.example.com:80', TURN_CREDENTIAL: 'pass456' }))
      .toThrow(/TURN_CREDENTIAL is set but TURN_USERNAME is not/);
  });

  it('refuses a provider pair with no URLs, and says so in its own terms', () => {
    expect(() => resolveTurnConfig({ TURN_USERNAME: 'user123', TURN_CREDENTIAL: 'pass456' }))
      .toThrow(/TURN_USERNAME\/TURN_CREDENTIAL is set but TURN_URLS is not/);
  });

  it('reads a single URL', () => {
    expect(resolveTurnConfig({ TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret' }))
      .toEqual({ kind: 'hmac', urls: ['turn:t.example.com:3478'], secret: 's3cret', ttlSeconds: DEFAULT_TURN_TTL_SECONDS });
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

  /*
   * A TURN_URLS containing only whitespace or commas (e.g., ',', ' , ')
   * passes the initial half-configured check — the raw string is truthy —
   * but after split/trim/filter yields an empty array. This would produce a
   * "valid" config with zero URLs, indistinguishable from "no TURN configured"
   * at runtime, masking the misconfiguration entirely. Reject it explicitly.
   */
  it('rejects TURN_URLS that contains only commas and whitespace', () => {
    for (const bad of [',', ' , ', ',,', ' , , ']) {
      expect(() => resolveTurnConfig({
        TURN_URLS: bad, TURN_SECRET: 's3cret',
      })).toThrow(/TURN_URLS is set but contains no usable URL/);
    }
  });
});

const CONFIG: TurnConfig = { kind: 'hmac', urls: ['turn:t.example.com:3478'], secret: 's3cret', ttlSeconds: 600 };

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

  it('forwards a provider pair unchanged, identically on every call', () => {
    // Nothing to mint: the provider issued this pair and only it can revoke
    // or rotate it, so two calls a day apart must produce the same values.
    // The hmac case asserts the opposite a few tests below, deliberately.
    const config: TurnConfig = {
      kind: 'static',
      urls: ['turn:relay.example.com:80'],
      username: 'user123',
      credential: 'pass456',
      ttlSeconds: 600,
    };

    expect(mintTurnCredential(config, 1_700_000_000_000))
      .toEqual({ username: 'user123', credential: 'pass456', ttl: 600 });
    expect(mintTurnCredential(config, 1_700_086_400_000))
      .toEqual({ username: 'user123', credential: 'pass456', ttl: 600 });
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

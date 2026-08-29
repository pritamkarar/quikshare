import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTurnServer, mediaRtcConfig } from '../../client/media/ice.js';
import { defaultRtcConfig } from '../../client/transport/webrtc.js';

const STUN_URLS = (defaultRtcConfig().iceServers?.[0] as { urls: string[] }).urls;

function stubFetch(impl: typeof fetch): void {
  vi.stubGlobal('fetch', impl);
}

/** A minimal Response-shaped stand-in: only what mediaRtcConfig reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mediaRtcConfig', () => {
  it('appends a successful /turn response after the build-time STUN list', async () => {
    const turnServer = { urls: ['turn:t.example.com:3478'], username: '123:quikshare', credential: 'abc==' };
    stubFetch(() => Promise.resolve(jsonResponse(200, { iceServers: [turnServer], ttl: 600 })));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([{ urls: STUN_URLS }, turnServer]);
  });

  it('yields a STUN-only config, without throwing, when TURN is not configured', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(200, { iceServers: [], ttl: 0 })));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([{ urls: STUN_URLS }]);
  });

  it('degrades to STUN-only when the fetch rejects', async () => {
    stubFetch(() => Promise.reject(new Error('network down')));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([{ urls: STUN_URLS }]);
  });

  it('degrades to STUN-only on a non-200 response', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(500, { iceServers: [] })));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([{ urls: STUN_URLS }]);
  });

  it('degrades to STUN-only when the body is malformed JSON', async () => {
    stubFetch(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as Response));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([{ urls: STUN_URLS }]);
  });

  it('drops an entry whose urls is not a non-empty array of strings', async () => {
    const bad = [
      { urls: 'turn:t.example.com:3478', username: 'u', credential: 'c' }, // urls not an array
      { urls: [], username: 'u', credential: 'c' }, // empty array
      { urls: [123], username: 'u', credential: 'c' }, // non-string entry
    ];
    stubFetch(() => Promise.resolve(jsonResponse(200, { iceServers: bad, ttl: 600 })));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([{ urls: STUN_URLS }]);
  });

  it('drops an entry missing a string username or credential', async () => {
    const bad = [
      { urls: ['turn:t.example.com:3478'], credential: 'c' }, // missing username
      { urls: ['turn:t.example.com:3478'], username: 'u' }, // missing credential
      { urls: ['turn:t.example.com:3478'], username: 123, credential: 'c' }, // non-string username
    ];
    stubFetch(() => Promise.resolve(jsonResponse(200, { iceServers: bad, ttl: 600 })));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([{ urls: STUN_URLS }]);
  });

  it('whitelists a valid entry into a fresh object rather than passing the response through', async () => {
    const turnServer = {
      urls: ['turn:t.example.com:3478'],
      username: '123:quikshare',
      credential: 'abc==',
      extra: 'should not survive',
    };
    stubFetch(() => Promise.resolve(jsonResponse(200, { iceServers: [turnServer], ttl: 600 })));

    const config = await mediaRtcConfig();

    expect(config.iceServers).toEqual([
      { urls: STUN_URLS },
      { urls: ['turn:t.example.com:3478'], username: '123:quikshare', credential: 'abc==' },
    ]);
  });
});

/*
 * `hasTurnServer` is the whole no-TURN caution, compressed into one
 * comparison. It exists because TransferPanel used to answer this question
 * with a second `fetch('/turn')` on mount, which broke the "an idle session
 * makes no request" contract; the answer is now derived from the config the
 * first share attempt already fetched. Nothing else pins it, so a change to
 * either side of the comparison would silently stop the caution ever
 * appearing — the failure would be invisible, because a missing warning
 * looks exactly like a working deployment.
 */
describe('hasTurnServer', () => {
  it('is false for the STUN-only config an unconfigured deployment produces', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(200, { iceServers: [], ttl: 0 })));

    expect(hasTurnServer(await mediaRtcConfig())).toBe(false);
  });

  it('is true once /turn contributes a relay', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(200, {
      iceServers: [{ urls: ['turn:t.example.com:3478'], username: '123:quikshare', credential: 'abc==' }],
      ttl: 600,
    })));

    expect(hasTurnServer(await mediaRtcConfig())).toBe(true);
  });

  it('is false when every failure path degrades to STUN-only', async () => {
    // The three ways /turn can let us down all land on the same config, so
    // they must all read as "no TURN" rather than one of them reading as
    // TURN-present and hiding the caution.
    for (const fail of [
      () => Promise.reject(new Error('unreachable')),
      () => Promise.resolve(jsonResponse(429, {})),
      () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) } as unknown as Response),
    ]) {
      stubFetch(fail as typeof fetch);
      expect(hasTurnServer(await mediaRtcConfig())).toBe(false);
    }
  });

  /*
   * Pins the comparison to defaultRtcConfig()'s actual length rather than a
   * literal 1. If the build-time STUN list ever gains an entry, a hardcoded
   * threshold would report TURN present on every deployment.
   */
  it('measures against the build-time STUN list rather than a hardcoded count', () => {
    const base = defaultRtcConfig().iceServers ?? [];

    expect(hasTurnServer({ iceServers: base })).toBe(false);
    expect(hasTurnServer({ iceServers: [...base, { urls: ['turn:t.example.com:3478'] }] })).toBe(true);
  });
});

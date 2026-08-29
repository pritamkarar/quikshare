import { describe, expect, it } from 'vitest';
import {
  deriveSession, exportPublicKey, formatVerification, fromBase64Url, generateKeyPair,
  generateNoncePrefix, generateRawKey, importKey, makeNonce, open, seal, toBase64Url,
} from '../../client/crypto.js';

describe('key material', () => {
  it('generates a 256-bit key', () => {
    expect(generateRawKey()).toHaveLength(32);
  });

  it('round-trips a key through base64url', () => {
    const raw = generateRawKey();
    expect([...fromBase64Url(toBase64Url(raw))]).toEqual([...raw]);
  });

  it('produces URL-fragment-safe text with no padding', () => {
    for (let i = 0; i < 50; i++) {
      const encoded = toBase64Url(generateRawKey());
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    // A short key would silently weaken every seal in the session; a long one
    // is a sign the fragment was mangled. Both must fail loudly at import.
    expect(() => importKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => importKey(new Uint8Array(33))).toThrow(/32 bytes/);
    expect(() => importKey(new Uint8Array(0))).toThrow(/32 bytes/);
  });
});

describe('nonce construction', () => {
  it('is 12 bytes', () => {
    expect(makeNonce('a', generateNoncePrefix(), 0n)).toHaveLength(12);
  });

  it('tags peer a and peer b differently', () => {
    const prefix = new Uint8Array([1, 2, 3]);
    expect(makeNonce('a', prefix, 5n)[0]).toBe(0x01);
    expect(makeNonce('b', prefix, 5n)[0]).toBe(0x02);
  });

  it('never collides across peers even with an identical prefix and counter', () => {
    const prefix = new Uint8Array([7, 7, 7]);
    const seen = new Set<string>();
    for (let seq = 0n; seq < 500n; seq++) {
      for (const peer of ['a', 'b'] as const) {
        seen.add(makeNonce(peer, prefix, seq).join(','));
      }
    }
    expect(seen.size).toBe(1000);
  });

  it('never repeats within one sender', () => {
    const prefix = generateNoncePrefix();
    const seen = new Set<string>();
    for (let seq = 0n; seq < 5000n; seq++) seen.add(makeNonce('a', prefix, seq).join(','));
    expect(seen.size).toBe(5000);
  });

  it('encodes the counter big-endian in the trailing 8 bytes', () => {
    const nonce = makeNonce('a', new Uint8Array([0, 0, 0]), 258n);
    expect([...nonce.slice(4)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
  });

  it('generates a 3-byte prefix', () => {
    expect(generateNoncePrefix()).toHaveLength(3);
  });

  it('places the prefix at bytes 1-3 and the counter at 4-11', () => {
    expect([...makeNonce('b', new Uint8Array([0xaa, 0xbb, 0xcc]), 258n)])
      .toEqual([0x02, 0xaa, 0xbb, 0xcc, 0, 0, 0, 0, 0, 0, 1, 2]);
  });

  it('rejects a prefix that is not 3 bytes', () => {
    expect(() => makeNonce('a', new Uint8Array(2), 0n)).toThrow(/3 bytes/);
    expect(() => makeNonce('a', new Uint8Array(4), 0n)).toThrow(/3 bytes/);
  });

  it('rejects a counter outside the 64-bit range', () => {
    // Either boundary would wrap inside setBigUint64 and hand back a nonce
    // already used earlier in the session — the catastrophic case.
    const prefix = new Uint8Array([1, 2, 3]);
    expect(() => makeNonce('a', prefix, -1n)).toThrow(/out of range/);
    expect(() => makeNonce('a', prefix, 2n ** 64n)).toThrow(/out of range/);
    // The boundaries themselves stay valid.
    expect(makeNonce('a', prefix, 0n)).toHaveLength(12);
    expect(makeNonce('a', prefix, 2n ** 64n - 1n)).toHaveLength(12);
  });

  it('rejects a peer id it has no byte for', () => {
    // The relay supplies this field. An unknown id would look up undefined,
    // which Uint8Array assignment coerces to 0, collapsing the two peers'
    // provably-disjoint nonce spaces onto the shared 3-byte prefix.
    const prefix = new Uint8Array([1, 2, 3]);
    for (const bad of ['c', '', 'A', 'toString', '__proto__']) {
      expect(() => makeNonce(bad as 'a' | 'b', prefix, 0n)).toThrow(/unknown peer id/);
    }
    expect(() => makeNonce(undefined as unknown as 'a', prefix, 0n)).toThrow(/unknown peer id/);
  });

  it('draws a fresh prefix and a fresh key per call', () => {
    const prefixes = new Set(Array.from({ length: 64 }, () => generateNoncePrefix().join(',')));
    expect(prefixes.size).toBeGreaterThan(1);
    expect(generateRawKey().join(',')).not.toBe(generateRawKey().join(','));
  });
});

describe('seal and open', () => {
  it('round-trips a chunk', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    expect([...(await open(key, nonce, await seal(key, nonce, plaintext)))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips a full 64 KB chunk', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 1n);
    const plaintext = new Uint8Array(65536).fill(0x5a);
    expect(await open(key, nonce, await seal(key, nonce, plaintext))).toHaveLength(65536);
  });

  it('adds a 16-byte authentication tag', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const sealed = await seal(key, nonce, new Uint8Array(100));
    expect(sealed).toHaveLength(116);
  });

  it('rejects a tampered ciphertext', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const sealed = await seal(key, nonce, new Uint8Array([9, 9, 9]));
    sealed[2] = sealed[2]! ^ 0xff;
    await expect(open(key, nonce, sealed)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const sealed = await seal(await importKey(generateRawKey()), nonce, new Uint8Array([1]));
    await expect(open(await importKey(generateRawKey()), nonce, sealed)).rejects.toThrow();
  });

  it('rejects the wrong nonce', async () => {
    const key = await importKey(generateRawKey());
    const prefix = generateNoncePrefix();
    const sealed = await seal(key, makeNonce('a', prefix, 0n), new Uint8Array([1]));
    await expect(open(key, makeNonce('a', prefix, 1n), sealed)).rejects.toThrow();
  });
});

describe('key agreement', () => {
  it('derives the same key and verification number on both sides', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const fromA = await deriveSession(a.privateKey, await exportPublicKey(b), 'K7M3QP');
    const fromB = await deriveSession(b.privateKey, await exportPublicKey(a), 'K7M3QP');
    expect([...fromA.rawKey]).toEqual([...fromB.rawKey]);
    expect(fromA.rawKey).toHaveLength(32);
    expect(fromA.verification).toBe(fromB.verification);
    expect(fromA.verification).toMatch(/^\d{6}$/);
  });

  it('derives a different key for a different room code', async () => {
    // The code is the HKDF salt: the same exchange spliced into another room
    // must not yield a working key, or a relay could relay one pairing's
    // handshake into a second session and read both.
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const here = await deriveSession(a.privateKey, await exportPublicKey(b), 'K7M3QP');
    const there = await deriveSession(a.privateKey, await exportPublicKey(b), 'ZZ9999');
    expect([...here.rawKey]).not.toEqual([...there.rawKey]);
    expect(here.verification).not.toBe(there.verification);
  });

  it('gives a machine-in-the-middle two different verification numbers', async () => {
    // The relay swaps both public keys for its own. It ends up sharing a
    // different secret with each device, so the numbers on the two screens
    // disagree — which is the whole reason the confirmation gate exists.
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const relay = await generateKeyPair();
    const seenByA = await deriveSession(a.privateKey, await exportPublicKey(relay), 'K7M3QP');
    const seenByB = await deriveSession(b.privateKey, await exportPublicKey(relay), 'K7M3QP');
    expect(seenByA.verification).not.toBe(seenByB.verification);
  });

  it('rejects a public key that is not a 65-byte point', async () => {
    const a = await generateKeyPair();
    await expect(deriveSession(a.privateKey, toBase64Url(generateRawKey()), 'K7M3QP'))
      .rejects.toThrow('65 bytes');
  });

  it('groups the digits for reading aloud', () => {
    expect(formatVerification('482193')).toBe('482 193');
  });
});

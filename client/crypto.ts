const KEY_BYTES = 32;
const NONCE_PREFIX_BYTES = 3;
const NONCE_BYTES = 12;
const TAG_BITS = 128;

const PEER_BYTE: Record<'a' | 'b', number> = { a: 0x01, b: 0x02 };

export function generateRawKey(): Uint8Array {
  const raw = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(raw);
  return raw;
}

export function generateNoncePrefix(): Uint8Array {
  const prefix = new Uint8Array(NONCE_PREFIX_BYTES);
  globalThis.crypto.getRandomValues(prefix);
  return prefix;
}

// `as BufferSource`: TS 5.7+ types a bare Uint8Array as Uint8Array<ArrayBufferLike>,
// which is not assignable to lib.dom's BufferSource = ArrayBufferView<ArrayBuffer>.
// Type-only. Always pass the view itself, NEVER `.buffer` — for any view at a
// non-zero offset that would encrypt or authenticate the wrong bytes.
export function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error('session key must be 32 bytes');
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Nonce layout: [peerByte:1][prefix:3][seq:8].
 * The peer byte guarantees the two senders in a session occupy disjoint
 * nonce space even though they share one key. Reuse would be catastrophic.
 */
export function makeNonce(peerId: 'a' | 'b', prefix: Uint8Array, seq: bigint): Uint8Array {
  // PEER_BYTE is a plain record lookup, so an id from outside the process — the
  // relay's `peerId` field reaches here through Session — would otherwise yield
  // undefined, which Uint8Array assignment coerces to 0, silently collapsing
  // the provably-disjoint peer separation onto the 24-bit prefix.
  // hasOwn, not `in`: `in` also answers true for inherited keys like
  // 'toString' and '__proto__', which look up to a non-number and land in
  // exactly the coercion this guard exists to prevent.
  if (!Object.hasOwn(PEER_BYTE, peerId)) throw new Error('unknown peer id');
  if (prefix.length !== NONCE_PREFIX_BYTES) throw new Error('nonce prefix must be 3 bytes');
  if (seq < 0n || seq >= 1n << 64n) throw new Error('nonce counter out of range');
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce[0] = PEER_BYTE[peerId];
  nonce.set(prefix, 1);
  new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).setBigUint64(4, seq, false);
  return nonce;
}

/**
 * `aad` is authenticated but not encrypted and never travels on the wire —
 * the receiver must arrive at the exact same bytes some other way. For
 * control frames and the frame header itself, that "other way" is trivial:
 * the header is right there on the wire, unencrypted, so the receiver
 * already holds it and just replays it back as `aad`. For a data frame's
 * chunk offset (see client/transfer/data-aad.ts), it is not replayed at
 * all — the receiver *derives* it from its own running byte count instead.
 * That is the entire mechanism the offset-binding fix relies on: a chunk
 * sealed for one offset cannot open against a different one the receiver
 * computes for itself, which is a stronger property than merely repeating
 * bytes back. Optional only so unit tests can exercise the primitive in
 * isolation; every production call site passes some form of `aad`.
 */
export async function seal(
  key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array,
): Promise<Uint8Array> {
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: TAG_BITS, additionalData: aad as BufferSource | undefined },
    key, plaintext as BufferSource,
  );
  return new Uint8Array(sealed);
}

export async function open(
  key: CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array,
): Promise<Uint8Array> {
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: TAG_BITS, additionalData: aad as BufferSource | undefined },
    key, ciphertext as BufferSource,
  );
  return new Uint8Array(opened);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64Url(s: string): Uint8Array {
  const padded = s.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Key agreement, so the session key never travels in the URL.
 *
 * It used to: the whole 32-byte key rode in the link fragment, which kept it
 * away from the relay (a fragment is never sent to a server) at the cost of
 * making the link the only way in — 43 unguessable characters nobody can
 * read down a phone line or type off another screen. The code alone was
 * useless. Now both devices generate an ephemeral P-256 pair, exchange
 * public keys in the hello frame, and derive the same key from the shared
 * secret; the link is just `/s/CODE` and the six-character code is the whole
 * credential.
 *
 * What that trades away, and what pays for it: the relay now sits between
 * the two public keys and can swap both for its own, which is a
 * machine-in-the-middle the fragment design made impossible. So the same
 * secret also derives a six-digit VERIFICATION number, and Session refuses
 * to send anything until the people at both ends have confirmed they see the
 * same one. A relay that swapped the keys ends up with two different
 * secrets, so the two devices show two different numbers and the comparison
 * fails — which is the entire security of this design, and why the
 * confirmation is a gate rather than a badge.
 */
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
/** An uncompressed P-256 point: the 0x04 tag byte plus a 32-byte X and Y. */
const PUBLIC_KEY_BYTES = 65;
const VERIFICATION_DIGITS = 6;

export function generateKeyPair(): Promise<CryptoKeyPair> {
  // extractable: false covers the PRIVATE key only — WebCrypto always marks a
  // generated public key extractable, which is what exportPublicKey needs.
  return globalThis.crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
}

export async function exportPublicKey(pair: CryptoKeyPair): Promise<string> {
  return toBase64Url(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey)));
}

/**
 * The shared secret, expanded into the two things a session needs from it.
 *
 * `code` is mixed in as the HKDF salt so a secret agreed for one room can
 * never be replayed into another: a relay that splices two live sessions
 * together gets two different keys out of the same ECDH exchange rather than
 * one working one.
 *
 * The verification number is derived from the same secret with a different
 * `info` label, so it is a fingerprint of the key both sides actually hold —
 * not a separate value either side could choose. Both devices run this with
 * mirrored inputs and get identical output; there is no ordering to agree on
 * because ECDH is symmetric.
 *
 * Throws on a public key that is not a well-formed point: `importKey`
 * rejects anything off the curve, and the length check in front of it turns
 * the most likely garbage (a truncated or padded field from a hostile relay)
 * into a clear error rather than a DataError from deep inside WebCrypto.
 */
export async function deriveSession(
  privateKey: CryptoKey, peerPublicKey: string, code: string,
): Promise<{ rawKey: Uint8Array; verification: string }> {
  const raw = fromBase64Url(peerPublicKey);
  if (raw.length !== PUBLIC_KEY_BYTES) throw new Error('peer public key must be 65 bytes');
  const publicKey = await globalThis.crypto.subtle.importKey('raw', raw as BufferSource, ECDH, false, []);
  const secret = await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);

  const hkdf = await globalThis.crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const encoder = new TextEncoder();
  const salt = encoder.encode(`quik-share/v1/${code}`);
  const expand = async (label: string, bits: number): Promise<Uint8Array> => new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: encoder.encode(label) as BufferSource },
      hkdf, bits,
    ),
  );

  const rawKey = await expand('key', KEY_BYTES * 8);
  const digits = await expand('verify', 32);
  const number = new DataView(digits.buffer, digits.byteOffset, digits.byteLength).getUint32(0, false);
  return {
    rawKey,
    // Modulo 10^6 on a uniform 32-bit value is very slightly biased (2^32 is
    // not a multiple of 10^6); the bias is ~1 part in 4295 on the least
    // likely digit, which changes nothing about a one-shot comparison an
    // attacker gets exactly one guess at.
    verification: (number % 10 ** VERIFICATION_DIGITS).toString().padStart(VERIFICATION_DIGITS, '0'),
  };
}

/** `482 193` — grouped for reading aloud, which is how it gets compared. */
export function formatVerification(digits: string): string {
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

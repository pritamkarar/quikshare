export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

/** Crockford base32 decodes I and L as 1, and O as 0. */
const AMBIGUOUS: Record<string, string> = { I: '1', L: '1', O: '0' };

export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  // The non-null assertion is safe: b % 32 is always a valid index.
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]!;
  return out;
}

export function normalizeCode(input: string): string {
  let out = '';
  for (const raw of input.toUpperCase()) {
    if (raw === ' ' || raw === '-' || raw === '_') continue;
    const ch = AMBIGUOUS[raw] ?? raw;
    if (!ALPHABET.includes(ch)) return '';
    out += ch;
  }
  return out.length === CODE_LENGTH ? out : '';
}

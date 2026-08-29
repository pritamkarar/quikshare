import { describe, expect, it } from 'vitest';
import { ALPHABET, CODE_LENGTH, generateCode, normalizeCode } from '../../shared/codes.js';

describe('generateCode', () => {
  it('produces a code of the required length', () => {
    expect(generateCode()).toHaveLength(CODE_LENGTH);
  });

  it('only uses alphabet characters', () => {
    for (let i = 0; i < 200; i++) {
      for (const ch of generateCode()) expect(ALPHABET).toContain(ch);
    }
  });

  it('excludes visually ambiguous characters', () => {
    for (const ch of 'ILOU') expect(ALPHABET).not.toContain(ch);
  });

  it('does not obviously repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, generateCode));
    expect(seen.size).toBeGreaterThan(490);
  });
});

describe('normalizeCode', () => {
  it('uppercases input', () => {
    expect(normalizeCode('k7m3qp')).toBe('K7M3QP');
  });

  it('strips spaces and dashes people type or paste', () => {
    expect(normalizeCode(' K7M-3QP ')).toBe('K7M3QP');
  });

  it('maps ambiguous characters per Crockford', () => {
    expect(normalizeCode('I7M3QP')).toBe('17M3QP');
    expect(normalizeCode('l7M3QP')).toBe('17M3QP');
    expect(normalizeCode('O7M3QP')).toBe('07M3QP');
  });

  it('returns empty string when the result is the wrong length', () => {
    expect(normalizeCode('K7M')).toBe('');
    expect(normalizeCode('K7M3QPX')).toBe('');
  });

  it('returns empty string for characters outside the alphabet', () => {
    expect(normalizeCode('K7M3Q!')).toBe('');
  });
});

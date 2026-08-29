import { describe, expect, it } from 'vitest';
import { formatBytes, formatRate } from '../../client/ui/format.js';

// NBSP below is a real non-breaking space (U+00A0, UTF-8 bytes C2 A0), not
// an ordinary space (U+0020) -- verified byte-for-byte, since a normal space
// would look identical in an editor or terminal.
const NBSP = ' ';

/**
 * Every assertion below pins a locale explicitly. formatBytes now renders
 * through Intl.NumberFormat, so an un-pinned call would format with whatever
 * the machine running the suite defaults to — these would pass on a
 * decimal-point laptop and fail on a decimal-comma one.
 */
const EN = 'en-US';

describe('formatBytes', () => {
  it('joins value and unit with a non-breaking space', () => {
    expect(formatBytes(10 * 1024 * 1024, EN)).toBe(`10${NBSP}MB`);
  });

  it('shows bytes below one kilobyte', () => {
    expect(formatBytes(512, EN)).toBe(`512${NBSP}B`);
  });

  it('handles zero', () => {
    expect(formatBytes(0, EN)).toBe(`0${NBSP}B`);
  });

  it('keeps one decimal place for partial units', () => {
    expect(formatBytes(1536, EN)).toBe(`1.5${NBSP}KB`);
  });

  // AGENTS.md: locale-aware numbers. The hand-rolled formatting this replaced
  // rendered "1.5 KB" everywhere, including for the many locales that write
  // the decimal separator as a comma.
  it('uses the decimal separator the locale actually writes', () => {
    expect(formatBytes(1536, 'de-DE')).toBe(`1,5${NBSP}KB`);
  });

  it('scales to gigabytes', () => {
    expect(formatBytes(3 * 1024 ** 3, EN)).toBe(`3${NBSP}GB`);
  });
});

describe('formatRate', () => {
  it('appends a per-second suffix', () => {
    expect(formatRate(2.4 * 1024 * 1024, EN)).toBe(`2.4${NBSP}MB/s`);
  });

  it('reports a stalled transfer plainly', () => {
    expect(formatRate(0)).toBe('—');
  });
});

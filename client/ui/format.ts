/**
 * A literal U+00A0, written as an escape on purpose: as a raw character it is
 * indistinguishable from an ordinary space in every editor and diff, and one
 * careless retype silently breaks the `10&nbsp;MB` guarantee AGENTS.md asks
 * for (tests/unit/format.test.ts asserts it byte-for-byte).
 */
const NBSP = '\u00a0';
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * AGENTS.md: numbers are locale-aware (`Intl.NumberFormat`). Hand-rolled
 * `Math.round(value * 10) / 10` always rendered `1.5 MB`, including for the
 * many locales that write `1,5 MB`.
 *
 * The separator between the number and its unit stays a literal non-breaking
 * space rather than Intl's `style: 'unit'`, for two reasons: these are binary
 * units (KB here means 1024 B, which `unit: 'kilobyte'` does not mean), and
 * the spacing `unit` emits varies by locale, which would break the
 * non-breaking-space guarantee AGENTS.md asks for.
 *
 * `locale` is an explicit parameter with no default: the app passes nothing
 * and follows the browser, while tests pin one — an assertion that renders
 * through the machine's own default passes on one laptop and fails on the
 * next, which is worse than the bug this replaces.
 */
function formatNumber(value: number, maximumFractionDigits: number, locale?: Intl.LocalesArgument): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

export function formatBytes(bytes: number, locale?: Intl.LocalesArgument): string {
  if (bytes < 1024) return `${formatNumber(bytes, 0, locale)}${NBSP}B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  // One decimal only when it carries information. Intl drops a trailing zero
  // by itself (3 GB, never 3.0 GB), so this only decides whether a decimal is
  // worth offering at all.
  return `${formatNumber(value, value >= 10 ? 0 : 1, locale)}${NBSP}${UNITS[unitIndex]}`;
}

export function formatRate(bytesPerSecond: number, locale?: Intl.LocalesArgument): string {
  // The one em-dash left in anything a visitor reads, and it is not prose:
  // in a numeric column a dash means "no value yet", where a hyphen would
  // read as a minus sign and an empty cell as a rendering fault.
  if (bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond, locale)}/s`;
}

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

/*
 * Hover/active/focus-visible all shift the fill toward --color-text (via
 * color-mix), never toward the label color:
 *
 *   - --color-text is calibrated, in both themes, to sit at the opposite
 *     lightness extreme from --color-bg (near-black in light, near-white in
 *     dark; see client/styles/tokens.css). --color-accent/--color-danger
 *     point the same direction as --color-text relative to --color-bg (both
 *     are "text-on-bg" tokens), so mixing a fill toward --color-text always
 *     moves it further FROM --color-bg — i.e. the button gets more, not
 *     less, distinguishable from the page in both themes, with one formula.
 *   - The label color (--color-accent-fg / --color-bg) sits at the opposite
 *     pole from --color-text, so the same shift simultaneously increases the
 *     fill-vs-label contrast too.
 *   - active mixes in more than hover; focus-visible matches hover's amount
 *     so a keyboard-focused button is at least as prominent as a hovered
 *     one, on top of the ring the global `:focus-visible` rule in app.css
 *     already draws (never overridden here) — the ring is a shape change,
 *     so a focused button is distinguishable by more than color alone.
 *
 * See the task report for the browser-measured background colors and
 * contrast ratios this produces in each state, in both themes.
 *
 * On top of that, each variant carries a soft-UI press class from
 * client/styles/app.css. The split is not cosmetic: `neo-fill` presses with
 * neutral black/white alphas, which land correctly on ANY fill, while
 * `neo-press` presses with the page's own light/dark tones, which is what a
 * surface-colored button needs and what an accent fill would render as a
 * white smear. So filled variants take `neo-fill`, the surface variant takes
 * `neo-press`, and the color shifts above stay exactly as they were — the
 * depth change is added to the contrast change, never instead of it.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    'neo-fill bg-[var(--color-accent)] text-[var(--color-accent-fg)] ' +
    'hover:bg-[color-mix(in_oklab,var(--color-accent)_88%,var(--color-text)_12%)] ' +
    'active:bg-[color-mix(in_oklab,var(--color-accent)_74%,var(--color-text)_26%)] ' +
    'focus-visible:bg-[color-mix(in_oklab,var(--color-accent)_88%,var(--color-text)_12%)]',
  // Fills with --color-surface, not --color-surface-2: surface is the raised
  // tone (equal to the page background) and surface-2 is the RECESSED one,
  // so filling a raised button with the well color fought its own shadow.
  ghost:
    'neo-press bg-[var(--color-surface)] text-[var(--color-text)] ' +
    'hover:bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-text)_8%)] ' +
    'active:bg-[color-mix(in_oklab,var(--color-surface)_82%,var(--color-text)_18%)] ' +
    'focus-visible:bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-text)_8%)]',
  danger:
    // Not text-white: --color-danger is a *light* salmon in the dark theme
    // (calibrated as text-on-bg, not as a solid fill), so white-on-it would
    // be low contrast. --color-bg is, like --color-accent-fg, always the
    // opposite lightness extreme from the fill tokens in whichever theme is
    // active, so it reads correctly as a fill's label in both themes.
    'neo-fill bg-[var(--color-danger)] text-[var(--color-bg)] ' +
    'hover:bg-[color-mix(in_oklab,var(--color-danger)_88%,var(--color-text)_12%)] ' +
    'active:bg-[color-mix(in_oklab,var(--color-danger)_74%,var(--color-text)_26%)] ' +
    'focus-visible:bg-[color-mix(in_oklab,var(--color-danger)_88%,var(--color-text)_12%)]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  /**
   * A decorative glyph shown before the label — a rendered element, not a
   * character, for the same reason `Badge.icon` is (see Badge.tsx): Unicode
   * glyphs fall back unpredictably across platforms, ignore the stroke weight
   * of everything around them, and cannot be sized or coloured as artwork.
   *
   * Decorative is the whole contract. Every button here keeps its visible
   * text label, the icons in client/ui/icons.tsx set their own `aria-hidden`,
   * and the wrapper below sets it again — so a screen reader hears the word
   * once, never a glyph description followed by the word. A button that ever
   * loses its text label needs an `aria-label`, not an icon carrying the
   * meaning on its own.
   */
  icon?: ReactNode;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  loading = false,
  icon,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      // min-h-11 is 44px: the touch target floor.
      // A disabled button must not look raised: an extruded surface is an
      // affordance, and leaving it on while the button cannot be pressed is
      // the same lie as leaving the label black. `disabled:shadow-none`
      // flattens it back into the sheet.
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] px-5 text-base font-medium transition-colors duration-[var(--duration-fast)] disabled:opacity-60 disabled:shadow-none disabled:pointer-events-none ${VARIANTS[variant]} ${className}`}
      aria-busy={loading || undefined}
      disabled={loading || disabled}
      {...rest}
    >
      {/* The spinner takes the icon's slot rather than sitting beside it:
          two glyphs before one label reads as a rendering fault, and swapping
          in place keeps the button's width steady through the state change —
          the same reason the label itself never moves. */}
      {loading ? (
        <span
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : icon !== undefined && (
        <span aria-hidden="true" className="inline-flex shrink-0 text-[1.1em]">{icon}</span>
      )}
      {/* The label stays put while loading, so the button never changes
          width and never loses its affordance. */}
      {children}
    </button>
  );
}

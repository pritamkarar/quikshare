/*
 * The mark: two QR finder patterns, offset along the diagonal.
 *
 * A finder pattern is the square-in-a-square that sits in three corners of
 * every QR code, and it is what the eye — and a camera — actually locks onto.
 * It is the right mark for this app because it is not a metaphor for what the
 * product does: it IS what the product puts on screen. Two of them, one at
 * each end of a diagonal, are the two devices.
 *
 * Drawn rather than shipped as the PNG it replaces, for the reason
 * client/ui/HeroArt.tsx gives: the PNG was a dark tile with a baked-in
 * gradient, which sat in the light header as a dark sticker and could not
 * follow the theme. This inherits `currentColor`, so one file is correct in
 * both themes and at every size.
 *
 * The lower pattern is drawn twice: once in the page's own background color
 * at a heavier stroke, then again in the ink. That under-stroke is what cuts
 * the gap between the two patterns where they would otherwise touch at
 * (16,16) — a knockout, not a coincidence of spacing, so it survives any
 * color the mark is placed on.
 *
 * Decorative wherever it appears next to the wordmark; the caller decides.
 * scripts/make-icons.py draws this same geometry for the favicon and the
 * touch icon, so the mark is one shape in three places.
 */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      // Sized by the caller's font-size unless overridden, matching the icon
      // family in client/ui/icons.tsx.
      width="1em"
      height="1em"
    >
      {/* Upper finder pattern. */}
      <rect x="2.6" y="2.6" width="13.8" height="13.8" rx="4.4" stroke="currentColor" strokeWidth="2.6" />
      <rect x="7.4" y="7.4" width="4.2" height="4.2" rx="1.4" fill="currentColor" />

      {/* The knockout: the page showing through, cutting the two apart. */}
      <rect
        x="15.6"
        y="15.6"
        width="13.8"
        height="13.8"
        rx="4.4"
        stroke="var(--color-bg)"
        strokeWidth="6"
      />

      {/* Lower finder pattern, on top of its own knockout. */}
      <rect x="15.6" y="15.6" width="13.8" height="13.8" rx="4.4" stroke="currentColor" strokeWidth="2.6" />
      <rect x="20.4" y="20.4" width="4.2" height="4.2" rx="1.4" fill="currentColor" />
    </svg>
  );
}

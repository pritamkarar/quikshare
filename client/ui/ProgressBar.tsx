import { formatBytes } from './format.js';

export interface ProgressBarProps {
  value: number;
  max: number;
  label: string;
  /**
   * Widens rather than forks: a caller that needs per-instance layout (e.g.
   * spacing inside a file row) adds a class here instead of a second
   * progress bar component that can drift from this one. Mirrors Button's
   * own `className` prop.
   */
  className?: string;
}

export function ProgressBar({ value, max, label, className = '' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(value, max));
  const ratio = max > 0 ? clamped / max : 0;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      // The values above are raw byte counts, so without this a screen reader
      // announces "2147483648 of 4294967296". Same formatting the sighted user
      // gets one element over, so both hear the same thing.
      aria-valuetext={`${formatBytes(clamped)} of ${formatBytes(max)}`}
      // A recessed track with a raised fill: the two shadows do the work of
      // saying "this much is done" before the color does, which is the
      // redundant cue AGENTS.md asks for.
      className={`neo-inset-sm h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)] ${className}`}
    >
      <div
        data-progress-fill
        // scaleX runs on the compositor; animating width would force layout
        // on every progress update. The reduced-motion media query in
        // tokens.css collapses this transition globally.
        style={{ transform: `scaleX(${ratio})` }}
        // `shimmer` sweeps a light band across the fill (background-position
        // only — it paints, it never reflows) so an in-flight transfer is
        // visibly moving even while the byte count is between updates.
        className="shimmer h-full w-full origin-left rounded-full bg-[var(--color-accent)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)]"
      />
    </div>
  );
}

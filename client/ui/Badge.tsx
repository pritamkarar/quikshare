import type { ReactNode } from 'react';

type Tone = 'neutral' | 'live' | 'relayed';

const TONES: Record<Tone, string> = {
  neutral: 'text-[var(--color-text-muted)] border-[var(--color-border)]',
  live: 'text-[var(--color-success)] border-[color-mix(in_oklab,var(--color-success)_40%,transparent)]',
  relayed: 'text-[var(--color-warning)] border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)]',
};

export interface BadgeProps {
  tone: Tone;
  /**
   * A rendered icon element, not a character.
   *
   * This was a `string` holding a Unicode arrow ('⇄' / '↔'). Those are font
   * glyphs: they fall back unpredictably across platforms, ignore the stroke
   * weight of everything around them, and cannot be sized or coloured as
   * artwork. See client/ui/icons.tsx.
   */
  icon: ReactNode;
  label: string;
  /**
   * Widens rather than forks: a caller that needs per-instance layout (e.g.
   * `shrink-0` so a badge in a tight flex row survives a long sibling) adds
   * a class here instead of a second badge component that can drift from
   * this one. Mirrors Button's own `className` prop.
   */
  className?: string;
}

export function Badge({ tone, icon, label, className = '' }: BadgeProps) {
  return (
    <span className={`neo inline-flex items-center gap-1.5 rounded-full border bg-[var(--color-surface)] px-3 py-1.5 text-sm ${TONES[tone]} ${className}`}>
      {/* Icon is decorative: the label carries the meaning, so status is
          never color-only, and a screen reader hears the word once, not a
          glyph description followed by the word. The icons set their own
          `aria-hidden`; this wrapper only handles layout. */}
      <span className="inline-flex text-base">{icon}</span>
      <span>{label}</span>
    </span>
  );
}

import type { MouseEvent } from 'react';
import { navigateTo } from '../routing.js';
import { IconGitHub } from './icons.js';
import { Logo } from './Logo.js';
import { ThemeToggle } from './ThemeToggle.js';

/**
 * Where the source lives. A constant rather than three inline hrefs: the
 * README links it, the header links it, and a repo that moves should move in
 * one place.
 */
export const REPO_URL = 'https://github.com/pritamkarar/quikshare';

/**
 * The one piece of chrome every screen shares: what this is, and where its
 * source is.
 *
 * Rendered by App outside <main>, so it sits outside the skip link's target
 * and a keyboard user can jump straight past it — and so the single <h1>
 * each screen owns stays the document's first heading. The wordmark is a
 * link rather than a heading for the same reason.
 *
 * Deliberately NOT sticky. AGENTS.md is explicit that a fixed element must
 * never cover focus, and the screens underneath are short enough that a bar
 * following the scroll would buy nothing but that risk — the session screen
 * in particular puts a live file queue right where a sticky header's shadow
 * would fall.
 *
 * Full-bleed, and no longer sharing `App`'s `shellWidth`. It used to take
 * that width as a prop so the bar and the content below it lined up — which
 * is right for a narrow shell and wrong for a wide window: at 1600px the
 * wordmark sat 350px in from the left edge, floating in the middle of an
 * empty bar with nothing to anchor it. A bar spans its window; the column
 * beneath it does not have to.
 */
export function AppHeader() {
  function handleHomeClick(event: MouseEvent<HTMLAnchorElement>): void {
    // Same rule as JoinLink: a plain left-click routes client-side, while a
    // modified click (Cmd/Ctrl/Shift/middle) is left to the browser so
    // "open in a new tab" still works — which is
    // only possible because this is a real <a> with a real href.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateTo('/');
  }

  return (
    <header className="neo-bar">
      <div className="mx-auto flex w-full max-w-[100rem] items-center justify-between gap-3 px-4 py-2.5 sm:px-8">
        <a
          href="/"
          onClick={handleHomeClick}
          className="inline-flex min-h-11 items-center gap-2.5 rounded-[var(--radius-md)] px-2.5"
        >
          {/* Decorative: the wordmark beside it already says the name, and a
              screen reader should hear "Quik Share" once, not twice.
              An inline SVG rather than the PNG this replaced — that file was
              a dark tile with a baked-in gradient, which sat in a light bar
              as a dark sticker and could not follow the theme. This inherits
              the accent, so it is correct in both. */}
          <Logo className="text-[1.75rem] text-[var(--color-accent)]" />
          {/* translate="no": an auto-translating browser otherwise renders
              the product name as two ordinary words in the target language. */}
          <span translate="no" className="text-[0.95rem] font-semibold tracking-[-0.02em]">
            Quik Share
          </span>
        </a>

        <div className="flex items-center gap-2">
          <a
            href={REPO_URL}
            target="_blank"
            // noreferrer implies noopener in every browser that matters, but
            // both are named so a future edit cannot drop the security half by
            // deleting what looks like a privacy preference.
            rel="noreferrer noopener"
            // min-w-11 as well as min-h-11: below `sm` the label is visually
            // hidden and the link collapses to a 24px-wide icon, which clears
            // AGENTS.md's 44px floor in one dimension and misses it in the
            // other. Caught by the real-geometry tap-target check in
            // tests/e2e/accessibility.spec.ts, which axe has no rule for.
            className="neo-press inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[var(--radius-md)] px-3 text-sm text-[var(--color-text-muted)]"
          >
            <IconGitHub className="text-base" />
            {/* The label is what carries the meaning (the mark is aria-hidden),
                so it is never icon-only — but it is redundant on a phone, where
                the mark alone is unmistakable and the bar is tight. Hidden
                visually there rather than removed, so the accessible name
                survives at every width. */}
            <span className="sr-only sm:not-sr-only">GitHub</span>
            {/* Opening a new tab without warning is a surprise a screen reader
                user gets no other cue about. */}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>

          {/* Last in the bar, and the only control here that changes the page
              rather than leaving it. tokens.css has always had three theme
              states and no way to reach two of them; this is that way. */}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

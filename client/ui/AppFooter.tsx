import { REPO_URL } from './AppHeader.js';
import { Logo } from './Logo.js';

/**
 * The end of the landing page.
 *
 * Rendered by App on the home route only, and outside <main> — both
 * deliberate. Outside, because a <footer> nested inside <main> is not the
 * page's `contentinfo` landmark, it is a footer *for that section*, so a
 * screen reader user jumping by landmark would never find it. Home only,
 * because every other route in this app is someone in the middle of moving a
 * file, and a column of links under a live transfer is noise at exactly the
 * moment attention is worth the most.
 *
 * The honest line at the bottom is checked, not asserted: nothing in
 * server/ or client/ sets a cookie or loads an analytics script, and the two
 * `localStorage` keys this app writes (the device id, the theme choice) never
 * leave the machine.
 */
export function AppFooter() {
  return (
    <footer className="mx-auto w-full max-w-6xl px-4 pb-10 pt-4 sm:px-6 lg:px-8">
      {/* A hairline rather than a raised bar: the soft-UI shelf treatment
          belongs to the header, and repeating it here would frame the page in
          two identical edges. */}
      <div className="flex flex-col gap-6 border-t border-[var(--color-border-strong)] pt-8 opacity-90 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <Logo className="text-2xl text-[var(--color-accent)]" />
          <span translate="no" className="text-sm font-semibold tracking-[-0.02em]">Quik Share</span>
        </div>

        <p className="text-sm text-[var(--color-text-muted)]">
          No cookies. No analytics. No accounts.
        </p>

        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          // min-h-11 for the same reason the header's link carries it: this
          // is a tap target on a phone, and a bare line of 14px text is not
          // one. Inline-flex + items-center keeps it optically on the
          // baseline of the row despite the 44px box.
          className="inline-flex min-h-11 items-center text-sm text-[var(--color-text-muted)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:text-[var(--color-text)] hover:decoration-[var(--color-accent)]"
        >
          Star on GitHub
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </footer>
  );
}

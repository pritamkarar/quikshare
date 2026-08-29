import type { MouseEvent } from 'react';
import { navigateTo } from '../routing.js';

/**
 * A user who was read a code over the phone has nothing to scan, so this
 * route out has to exist on every screen a session can reach — including
 * ones where the session failed, or where it is already paired and mid
 * transfer — which would otherwise be dead ends. Shared rather than
 * duplicated per screen: two copies of the modifier-key handling below is
 * exactly the kind of drift a single component avoids.
 */
export function JoinLink() {
  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    // A plain left-click stays client-side so the router handles it without
    // a page load. A modified click (Cmd/Ctrl/Shift/middle-click, i.e.
    // "open in a new tab") is left alone so the browser's native behavior —
    // which a real <a> supports and a div onClick would not — still works.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateTo('/join');
  }

  return (
    <p className="text-sm text-[var(--color-text-muted)]">
      Have a code instead of a QR to scan?{' '}
      {/* inline-flex + min-h-11: AGENTS.md's 24px desktop / 44px mobile tap
          target floor. A bare text-sm link is about 20px tall and misses it —
          and axe has no tap-target rule, so nothing caught this. See
          tests/ui/a11y.test.tsx, which now checks the class it cannot see. */}
      <a
        href="/join"
        onClick={handleClick}
        className="inline-flex min-h-11 items-center underline underline-offset-4"
      >
        Join a session
      </a>
    </p>
  );
}

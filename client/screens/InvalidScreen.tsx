import type { MouseEvent } from 'react';
import { Button } from '../ui/Button.js';
import { IconAlert, IconPlus } from '../ui/icons.js';
import { navigateTo } from '../routing.js';

export interface InvalidScreenProps {
  reason: 'bad-code' | 'expired' | 'disconnected';
  /**
   * What "Start a new session" should do, for a caller that is *already* on
   * the route it would otherwise send the user to. CreateScreen renders this
   * screen inline at '/new', where navigating to '/new' pushes the same route
   * and React reconciles instead of remounting — leaving the button inert and
   * the screen a dead end. Such a caller hands in the recovery it can
   * actually perform; everyone else reaching this screen from a different
   * route keeps the plain navigation.
   */
  onRestart?: () => void;
}

/**
 * Three failures, three different facts, and three different next steps:
 * `bad-code` — check the code you typed; `expired` — the room itself is gone
 * (a reconnect attempt reached the relay and got `not-found` back), so no
 * code or link for it will work again; `disconnected` — a reconnect attempt
 * exhausted every retry without ever reaching the relay again. That last one
 * is deliberately *not* worded as "the room is gone" — a
 * `Reconnector` giving up only proves this device's own connection is
 * broken, and the room may be perfectly fine from the other device's side.
 *
 * Distinct copy for each rather than one generic "invalid link" message.
 * `expired`'s button starts a session for *this* device rather than telling
 * the user to go find the other one — restarting from either side produces
 * a working, shareable link just the same, so the copy below says "start a
 * new session" rather than "ask the other device to", matching what the
 * button beneath it actually does.
 */
const COPY: Record<InvalidScreenProps['reason'], { heading: string; body: string }> = {
  'bad-code': {
    heading: 'That code does not look right',
    body: 'Session codes are six characters. Check the other device and try again.',
  },
  expired: {
    heading: 'This session no longer exists',
    body: 'The room this code pointed to is gone. Start a new session and share its fresh code or link.',
  },
  disconnected: {
    heading: 'Could not reconnect',
    body: 'This device lost its connection and could not get back to the session after several attempts. Start a new one.',
  },
};

export function InvalidScreen({ reason, onRestart }: InvalidScreenProps) {
  const copy = COPY[reason];

  function handleTryAgain(event: MouseEvent<HTMLAnchorElement>): void {
    // A modified click (new tab, etc.) keeps the browser's native behavior;
    // only a plain click is intercepted for the client-side router.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateTo('/join');
  }

  return (
    <section aria-labelledby="invalid-heading" className="mx-auto w-full max-w-3xl flex flex-1 flex-col justify-center items-center gap-4 py-16 text-center">
      {/* Decorative; the heading below states the failure. Warning-toned
          rather than danger: none of these four is destructive, and all four
          have a way forward right underneath. */}
      <span className="inline-flex size-14 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--color-warning)_16%,transparent)] text-3xl text-[var(--color-warning)]">
        <IconAlert />
      </span>
      <h1 id="invalid-heading" className="text-2xl font-semibold">{copy.heading}</h1>
      <p className="max-w-sm text-pretty text-[var(--color-text-muted)]">{copy.body}</p>

      <div className="flex flex-col items-center gap-3">
        {/* No dead ends: every failure state offers a next step. */}
        {/* '/new', not '/': the root is the landing page and starts nothing,
            so routing there would leave this button one click short of what
            its label promises. */}
        <Button icon={<IconPlus />} onClick={onRestart ?? (() => navigateTo('/new'))}>Start a new session</Button>
        {/* A bad code is most likely a mistyped/miscopied one — a mistake made
            trying to join, not a reason to abandon joining altogether — so
            this is the one reason that also gets a direct way back to retry
            entry, rather than only the fresh-start button above. */}
        {reason === 'bad-code' && (
          <a
            href="/join"
            onClick={handleTryAgain}
            // inline-flex + min-h-11 for the tap-target floor; see JoinLink.
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 text-[var(--color-text-muted)]"
          >
            Or try the code again
          </a>
        )}
      </div>
    </section>
  );
}

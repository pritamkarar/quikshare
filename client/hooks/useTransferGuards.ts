import { useEffect, useRef } from 'react';
import { setNavigationGuard } from '../routing.js';
import type { TrackedFile } from './useSession.js';

/** Written by this hook and stripped before it writes again — see below. */
const PROGRESS_PREFIX = /^\d+% · /;

/**
 * What the completion notification says on a lock screen.
 *
 * TODO(product): decide the wording. A count reads well for a batch but
 * poorly for one file, and a bare filename on a lock screen is more than some
 * people want visible from across a room. Kept as one function so the choice
 * is made in a single place, and so the tests above assert that a
 * notification fired rather than what it said.
 */
function completionTitle(delivered: readonly TrackedFile[]): string {
  const sent = delivered.filter((f) => f.direction === 'send').length;
  const verb = sent === delivered.length ? 'sent' : 'received';
  return delivered.length === 1
    ? `${delivered[0]!.meta.name} ${verb}`
    : `${delivered.length} files ${verb}`;
}

/** There is no resume: leaving cancels the transfer outright, so say so. */
const LEAVE_PROMPT = 'A transfer is still running. Leaving this screen cancels it. Leave anyway?';

/**
 * There is no server-side copy of a transfer in flight: closing the tab
 * destroys it. This hook installs a `beforeunload` guard for exactly that
 * window, and mirrors aggregate progress into `document.title` so a
 * backgrounded tab still shows it (AGENTS.md MUSTs: warn before navigation
 * loses work; `<title>` matches current context).
 *
 * It decorates the title, it does not own it — App.tsx and CreateScreen.tsx
 * already write `document.title` for routing and for the session code. This
 * hook only ever prefixes or strips its own `NN% · ` marker off whatever is
 * there, so it composes with either owner without knowing it exists. If one
 * of them overwrites the title mid-transfer, the prefix simply reappears on
 * the next progress tick — no coordination needed.
 */
export function useTransferGuards(files: TrackedFile[]): void {
  /*
   * A cancelled file is `{ cancelled: true, done: false }` (useSession.ts's
   * `file-cancelled` case: the byte count is deliberately left where it
   * stopped rather than completed). Keyed on `!done` alone, every guard below
   * therefore stayed armed for the rest of the session on a transfer that was
   * definitively over — the prompt kept firing, the wake lock kept the screen
   * lit, and the title kept a percentage that would never move again.
   *
   * `TransferRecord` has always read the pair correctly
   * (`moving = !complete && !cancelled`); this is the same reading, in the
   * other consumer of the same two fields.
   */
  const inFlight = files.some((f) => !f.done && f.cancelled !== true);
  // Over every file, not just the ones still moving: dropping a finished file
  // from both the numerator and denominator the instant it completes would
  // make the percentage fall right after it just rose.
  const moved = files.reduce((sum, f) => sum + (f.done ? f.meta.size : f.bytesMoved), 0);
  const total = files.reduce((sum, f) => sum + f.meta.size, 0);
  const percent = total > 0 ? Math.floor((moved / total) * 100) : 0;

  useEffect(() => {
    if (!inFlight) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // `returnValue = ''` also triggers preventDefault() via its legacy
      // setter (the spec cancels on a falsy value), but the real contract is
      // preventDefault() — set both and let them be redundant.
      event.preventDefault();
      event.returnValue = '';
    };
    addEventListener('beforeunload', onBeforeUnload);
    // The other half of the same MUST. `beforeunload` never fires for
    // `history.pushState`, and the only route off this screen is an in-app
    // one (SessionHeader's "End session") — so clicking it unmounted the
    // panel and terminated the worker mid-transfer, silently. The native
    // dialog is deliberate: it is keyboard-operable and announced
    // everywhere, which a hand-rolled modal would have to earn.
    setNavigationGuard(() => confirm(LEAVE_PROMPT));
    // KNOWN GAP: this covers pushState (every in-app link and button) and the
    // handler above covers closing or reloading the tab. It does NOT cover the
    // browser's own Back/Forward. `popstate` fires *after* the traversal has
    // already happened and is not cancelable, and by the time it runs App has
    // re-routed, this panel has unmounted and the worker is terminated — so a
    // listener here could only apologise, not prevent. Actually preventing it
    // means App re-pushing the previous entry and skipping its own re-route,
    // which leaves a spare history entry per declined Back, depends on
    // `confirm` being honoured mid-traversal (Safari does not guarantee it),
    // and cannot be tested at the real seam in jsdom, where a dispatched
    // `popstate` does not move history. Left as a documented gap rather than a
    // guard that half-works; see the fix-wave report.
    return () => {
      removeEventListener('beforeunload', onBeforeUnload);
      setNavigationGuard(undefined);
    };
  }, [inFlight]);

  /**
   * Keeps the screen awake for as long as bytes are moving.
   *
   * On a phone this is not a comfort feature. There is no resume: a screen
   * that sleeps mid-transfer suspends the page, drops the connection, and the
   * transfer is simply gone — the same loss the `beforeunload` guard above
   * exists to prevent, arriving through the one door that guard cannot cover,
   * because the user never navigated anywhere.
   *
   * It lives in this hook rather than one of its own because it is the same
   * window, off the same `inFlight`, for the same reason: everything here is
   * "a transfer is running, protect it".
   */
  useEffect(() => {
    if (!inFlight) return;
    // Typed non-optional by lib.dom, but absent on Safari below 16.4 and on
    // any insecure origin — a LAN address served over plain http is one, and
    // that is a normal way to reach this app.
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (wakeLock === undefined) return;

    let sentinel: WakeLockSentinel | undefined;
    let done = false;

    const acquire = (): void => {
      // A request made while the document is hidden rejects by spec; the
      // visibility listener below is what covers coming back.
      if (done || sentinel !== undefined || document.visibilityState !== 'visible') return;
      void wakeLock.request('screen').then(
        (granted) => {
          // This effect can have been cleaned up while the request was in
          // flight, and a sentinel nobody releases keeps the screen lit for
          // good.
          if (done) { void granted.release(); return; }
          sentinel = granted;
        },
        // Refused, or the document went hidden between the check and the
        // call. Nothing to report: the transfer is unaffected, and there is
        // nothing the user could do about it from here.
        () => {},
      );
    };

    /*
     * The OS drops the lock whenever the document is hidden, and never gives
     * it back. Without this, switching to another app for two seconds
     * mid-transfer silently removes the very protection this effect exists
     * for — and someone who just switched back to a still-running transfer is
     * precisely the person whose screen was seconds from sleeping.
     */
    const onVisibilityChange = (): void => {
      sentinel = undefined;
      acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      done = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
    };
  }, [inFlight]);

  /**
   * Tells the user their transfer landed when they are not on the tab to see
   * it — the one moment the title prefix above cannot reach, because nobody
   * is looking at the title either.
   *
   * Fires on the `inFlight` true -> false edge rather than on a count, so a
   * batch notifies once when the last file lands, not once per file. Silent
   * when the tab is visible (the record on screen already said so), when
   * nothing was actually delivered (a wholly cancelled batch is not news),
   * and when permission was never granted — this hook never prompts, it only
   * spends a grant that TransferPanel's send gesture already asked for.
   */
  const wasInFlight = useRef(false);
  useEffect(() => {
    const justFinished = wasInFlight.current && !inFlight;
    wasInFlight.current = inFlight;
    if (!justFinished) return;

    // Same reading the wake lock effect uses. `document.hidden` is a separate
    // getter that does not necessarily track a shadowed `visibilityState`.
    if (document.visibilityState === 'visible') return;

    // Absent on iOS Safari outside an installed PWA, and on any insecure
    // origin — the same shape of gap as `navigator.wakeLock` above.
    const notification = (globalThis as { Notification?: typeof Notification }).Notification;
    if (notification === undefined || notification.permission !== 'granted') return;

    const delivered = files.filter((f) => f.done);
    if (delivered.length === 0) return;

    new notification(completionTitle(delivered));
    // `files` is deliberately not a dependency: it changes identity on every
    // progress tick, and this effect must run on the edge only. The render
    // that flips `inFlight` carries the final `files`, so the closure is
    // current at the one moment this reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight]);

  useEffect(() => {
    const rest = document.title.replace(PROGRESS_PREFIX, '');
    document.title = inFlight ? `${percent}% · ${rest}` : rest;
    // Strips its own decoration back off on unmount (or before reapplying on
    // the next dep change) — never asserts a base string, just undoes what
    // this effect itself added. Without this, a TransferPanel that unmounts
    // mid-transfer (a peer disconnects) leaves a stale "43% · " prefix on the
    // title forever, with nothing downstream ever rewriting it.
    return () => { document.title = document.title.replace(PROGRESS_PREFIX, ''); };
  }, [files, inFlight, percent]);
}

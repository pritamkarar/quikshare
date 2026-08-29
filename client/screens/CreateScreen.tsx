import { useEffect, useRef, useState } from 'react';
import { useSession, type SessionState } from '../hooks/useSession.js';
import { sessionTitle, titleFor } from '../routing.js';
import { QRPanel } from '../ui/QRPanel.js';
import { Button } from '../ui/Button.js';
import { JoinLink } from '../ui/JoinLink.js';
import { InvalidScreen } from './InvalidScreen.js';
import { TransferPanel } from './TransferPanel.js';
import { IconCheck, IconCopy } from '../ui/icons.js';
import { SHARE_FLAG, takeShare, type SharedPayload } from '../share/inbox.js';

/** How long the copy button stays confirmed before returning to its label. */
const COPIED_MS = 2000;

/**
 * What this screen is doing, in one line. `hasCode` matters: a session that
 * failed *after* it was created still has a working code on screen, so telling
 * that user it "could not be started" would be plainly false.
 */
function statusLine(state: SessionState, hasCode: boolean): string {
  switch (state) {
    case 'connecting': return 'Starting a session…';
    case 'waiting': return 'Waiting for the other device…';
    // Not rendered by this branch of the screen, but the switch is exhaustive
    // so a new state cannot silently produce a blank line.
    case 'paired': return '';
    case 'ended': return 'The other device disconnected. This code still works if they scan it again.';
    // Not rendered by this branch either (see the early return in
    // CreateScreen below) — 'gone' is a confirmed, permanent outcome and
    // must not keep showing this code at all, let alone with a status line
    // implying it might still work.
    case 'gone': return '';
    // With a code on screen the alert below carries the specific reason, and a
    // vague second sentence above it would only add noise.
    case 'error': return hasCode ? '' : 'The session could not be started.';
  }
}

/**
 * Matches the QR card, so the layout does not jump when the code arrives.
 *
 * `skeleton` (client/styles/app.css) sweeps a light band across both blocks
 * so this reads as something still arriving rather than an empty card that is
 * all this screen has to offer — the wait is a round trip to the relay, short
 * on a good connection and long enough to look broken on a bad one. Still
 * `aria-hidden`: a screen reader is told the same thing in words by the
 * "Starting a session…" live region below, and a shimmering placeholder is
 * nothing to describe twice.
 */
function QRSkeleton() {
  return (
    <div className="flex flex-col items-center gap-4" aria-hidden="true">
      <div className="neo rounded-[var(--radius-xl)] bg-[var(--color-surface)] p-5">
        <div className="skeleton neo-inset size-[288px] max-w-full rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
      </div>
      <div className="skeleton neo-inset h-9 w-48 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)]" />
    </div>
  );
}

/** What is waiting, in the words the user would use for it. */
function waitingLine(pending: SharedPayload): string {
  const parts: string[] = [];
  if (pending.files.length > 0) {
    parts.push(`${pending.files.length} file${pending.files.length === 1 ? '' : 's'}`);
  }
  if (pending.note !== undefined) parts.push('1 link');
  return `${parts.join(' and ')} ready — they'll send once you've both confirmed the number.`;
}

export interface CreateScreenProps {
  /**
   * Restarts this screen's session. Optional only so the screen can still be
   * rendered on its own (its own test suite does); App passes one, and
   * without it the terminal-state button below falls back to a route change
   * that cannot recover — see App's `createGeneration`.
   */
  onRestart?: () => void;
}

export function CreateScreen({ onRestart }: CreateScreenProps) {
  const session = useSession({ t: 'create' });
  const [pending, setPending] = useState<SharedPayload | undefined>(undefined);
  const [shareMissed, setShareMissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * Picks up whatever the OS share sheet left for this launch.
   *
   * Runs once, on mount, keyed off a query flag the service worker's redirect
   * put there (client/share/inbox.ts). The flag is stripped immediately: it
   * has done its entire job by being read, and leaving it would make a reload
   * look like a second share of files that have already been taken.
   */
  useEffect(() => {
    const flag = new URL(location.href).searchParams.get(SHARE_FLAG);
    if (flag === null) return;
    history.replaceState(null, '', '/new');

    if (flag === 'missed') { setShareMissed(true); return; }
    // Undefined on an insecure origin, where the worker could not have run
    // either — so there is nothing to claim and the same message applies.
    const storage = (globalThis as { caches?: CacheStorage }).caches;
    if (storage === undefined) { setShareMissed(true); return; }
    void takeShare(storage).then(
      (payload) => {
        // The worker redirected, so something WAS shared: an empty stash
        // means it was evicted or the write was torn, not that this was an
        // ordinary visit.
        if (payload === undefined) setShareMissed(true);
        else setPending(payload);
      },
      () => setShareMissed(true),
    );
  }, []);

  useEffect(() => {
    // The tab is how someone finds this session again among a dozen others,
    // so it carries the code as soon as there is one.
    document.title = session.code ? sessionTitle(session.code) : titleFor({ t: 'new' });
  }, [session.code]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  function handleCopy(): void {
    // Undefined on an insecure origin — which a LAN address served over plain
    // http is. Reading through it would throw inside the click handler.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setCopied(false);
      setCopyFailed(true);
      return;
    }
    void clipboard.writeText(session.shareUrl).then(
      () => {
        setCopyFailed(false);
        setCopied(true);
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      // Denied permission, or an insecure origin. Silence would look exactly
      // like a successful copy and lose the link.
      () => { setCopied(false); setCopyFailed(true); },
    );
  }

  if (session.state === 'paired') {
    return (
      <TransferPanel
        session={session}
        pending={pending}
        // Dropped here rather than inside the panel: the panel's own
        // once-only guard is a ref that dies with it, and it is rebuilt
        // whenever a peer leaves and rejoins.
        onPendingSent={() => setPending(undefined)}
      />
    );
  }

  // Fix-round-1, Important: a confirmed, permanent outcome (Session.
  // onSessionEnded) — unlike 'ended', the code on screen must not keep
  // being offered, since neither reason it fires ('gave-up': this device's
  // own connectivity; 'room-gone': the relay said the room no longer
  // exists) can be fixed by scanning it again.
  if (session.state === 'gone') {
    return (
      <InvalidScreen
        reason={session.endedReason === 'room-gone' ? 'expired' : 'disconnected'}
        // This screen is rendered at '/new' already, so InvalidScreen's
        // default "route to /new" recovery would reconcile straight back into
        // this same dead session. Remounting is the only thing that restarts it.
        onRestart={onRestart}
      />
    );
  }

  // Keyed off the code rather than the state: a session that ran into trouble
  // after it was created still has a code the other device can use, and
  // hiding it behind a blank skeleton would throw that away.
  const hasCode = session.code !== '';

  return (
    <section aria-labelledby="create-heading" className="mx-auto w-full max-w-3xl flex flex-1 flex-col justify-center items-center gap-6 py-8">
      <h1 id="create-heading" className="text-2xl font-semibold">Scan to connect</h1>

      {pending !== undefined && (
        <p className="neo-inset max-w-md rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3 text-center text-sm">
          {waitingLine(pending)}
        </p>
      )}
      {shareMissed && (
        <p role="alert" className="max-w-md text-center text-sm text-[var(--color-danger)]">
          That share did not come through — the app had not finished starting up. Open it once, then
          try sharing again.
        </p>
      )}

      {hasCode ? <QRPanel shareUrl={session.shareUrl} code={session.code} /> : <QRSkeleton />}

      <p className="max-w-md text-center text-pretty text-[var(--color-text-muted)]">
        Open the camera on the other device, send it this link, or just read out the six
        characters. Any of the three gets in, and both screens will then show a number to compare
        before anything can move. Files go directly between the two devices and are never stored.
      </p>

      {/* The glyph changes with the label, not instead of it: the state is
          still carried in words, and the tick is what makes the change
          visible at a glance from across a desk. */}
      {hasCode && (
        <Button variant="ghost" icon={copied ? <IconCheck /> : <IconCopy />} onClick={handleCopy}>
          {copied ? 'Link copied' : 'Copy link'}
        </Button>
      )}

      {/* Present before it has anything to say, so the announcement is made
          when the text changes rather than when the element appears. */}
      <p role="status" aria-live="polite" className="sr-only">
        {copied ? 'Link copied to clipboard' : ''}
      </p>
      {copyFailed && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          This browser would not let the page copy the link. Select the address bar and copy it by hand.
        </p>
      )}

      {/* One region that always exists and whose text changes, rather than a
          region per state: a live region inserted at the same moment as its
          content is not reliably announced. */}
      <p aria-live="polite" className="min-h-5 text-center text-sm text-[var(--color-text-muted)]">
        {statusLine(session.state, hasCode)}
      </p>

      {session.notice !== undefined && (
        // Not an alert and not danger-colored: a downgraded save tier is
        // something to know, not something that went wrong.
        <p className="neo-inset max-w-sm rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3 text-center text-sm text-[var(--color-text-muted)]">
          {session.notice}
        </p>
      )}

      {session.error !== undefined && (
        <p role="alert" className="max-w-sm text-center text-sm text-[var(--color-danger)]">
          {session.error}
        </p>
      )}

      <JoinLink />
    </section>
  );
}

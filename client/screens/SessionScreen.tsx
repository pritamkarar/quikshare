import { useEffect } from 'react';
import { useSession, type TrackedFile } from '../hooks/useSession.js';
import { leaveTo, navigateTo } from '../routing.js';
import { Button } from '../ui/Button.js';
import { IconPlus } from '../ui/icons.js';
import { JoinLink } from '../ui/JoinLink.js';
import { InvalidScreen } from './InvalidScreen.js';
import { PeerLeftPanel } from './PeerLeftPanel.js';
import { SessionEndedPanel } from './SessionEndedPanel.js';
import { TransferPanel } from './TransferPanel.js';

export interface SessionScreenProps {
  code: string;
}

/**
 * A received file whose only copy is a Blob in this document.
 *
 * The in-memory save tier hands the record a `blobUrl` and a Save link
 * instead of writing anywhere, so navigating away revokes the URL and the
 * file is gone. There is no way to know whether the user already clicked
 * Save, so the presence of the link is taken as "not yet".
 */
function heldInThisTabOnly(file: TrackedFile): boolean {
  return file.direction === 'receive' && file.blobUrl !== undefined;
}

/**
 * The joiner's side of a session, reached from a scanned QR code or a typed
 * code. Unlike CreateScreen, this side never sees 'waiting': `useSession`
 * flips straight from 'connecting' to 'paired' the moment its own hello is
 * answered, since a joiner cannot exist without a peer already there.
 */
export function SessionScreen({ code }: SessionScreenProps) {
  const session = useSession({ t: 'join', code });

  /*
   * The other device's user chose to end this, and said so before going
   * (shared/messages.ts's `end-session`). Staying on the link of a session
   * that no longer exists is the dead end AGENTS.md rules out, so this leaves
   * for the landing page on its own.
   *
   * Not for a plain disconnect, which is a different thing entirely: the room
   * outlives a dropped socket and `PeerLeftPanel` below is right to offer the
   * code again. Only a deliberate end is unrecoverable.
   *
   * `leaveTo`, not `navigateTo`: the guard exists to warn that leaving
   * cancels a transfer, and the transfer has already stopped — the peer is
   * gone. Asking would be a prompt about work that no longer exists.
   */
  const unsaved = session.files.filter(heldInThisTabOnly);
  const peerEnded = session.state === 'gone' && session.endedReason === 'peer-ended';
  const holdForUnsaved = peerEnded && unsaved.length > 0;

  useEffect(() => {
    if (peerEnded && !holdForUnsaved) leaveTo('/');
  }, [peerEnded, holdForUnsaved]);

  if (session.state === 'connecting') {
    return (
      <section aria-labelledby="session-heading" className="mx-auto w-full max-w-3xl flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
        <h1 id="session-heading" className="sr-only">Joining a session</h1>
        <p aria-live="polite" className="text-[var(--color-text-muted)]">
          Connecting to <span className="mono">{code}</span>…
        </p>
      </section>
    );
  }

  if (session.state === 'ended') {
    // The room outlives the peer that left (server/rooms.ts only deletes a
    // room once every peer has gone) — so this is recoverable, not the dead
    // end it used to be described as. Re-showing the code and QR lets the
    // same device, or a different one, scan straight back into this same
    // room; "Start a new session" would silently abandon it for no reason.
    return <PeerLeftPanel code={session.code} shareUrl={session.shareUrl} onEnd={() => navigateTo('/')} />;
  }

  if (holdForUnsaved) {
    return (
      <SessionEndedPanel
        files={session.files}
        notes={session.notes}
        onDone={() => leaveTo('/')}
      />
    );
  }

  // Fix-round-1, Important: unlike 'ended', this is a confirmed, permanent
  // outcome (Session.onSessionEnded) — the same QR/code must not be
  // re-offered, since neither reason it fires ('gave-up': this device's own
  // connectivity; 'room-gone': the relay said the room no longer exists)
  // can be fixed by scanning it again.
  if (session.state === 'gone') {
    // 'peer-ended' never reaches here: the effect above has already left for
    // the landing page, and this render is the frame before that lands.
    // Rendering nothing beats flashing "this session could not be reached" at
    // someone whose session ended perfectly normally.
    if (peerEnded) return null;
    return <InvalidScreen reason={session.endedReason === 'room-gone' ? 'expired' : 'disconnected'} />;
  }

  // 'error' means the session never got going (see `afterSessionError` in
  // useSession: once paired, a failure stays an alert inside the transfer
  // panel and never becomes this state). Falling through to TransferPanel
  // here — as this screen used to — put the heading "Connected", a live
  // "Relayed" badge and an active drop zone in front of someone whose
  // session had failed, which is the same reading CreateScreen has always
  // refused. Both screens now agree: 'error' is never the transfer panel.
  if (session.state === 'error') {
    return (
      <section aria-labelledby="join-failed-heading" className="mx-auto w-full max-w-3xl flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
        <h1 id="join-failed-heading" className="text-2xl font-semibold">This session could not be joined</h1>
        <p role="alert" className="max-w-sm text-pretty text-sm text-[var(--color-danger)]">
          {session.error ?? 'Something went wrong before the connection was ready.'}
        </p>
        <Button icon={<IconPlus />} onClick={() => navigateTo('/')}>Start a new session</Button>
        {/* A failed join is most often a code that was mistyped or has since
            expired, so the retry path belongs here next to the fresh start. */}
        <JoinLink />
      </section>
    );
  }

  return <TransferPanel session={session} />;
}

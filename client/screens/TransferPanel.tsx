import { useCallback, useEffect, useRef, useState } from 'react';
import { DropZone } from '../ui/DropZone.js';
import { TextSnippet } from '../ui/TextSnippet.js';
import { TransferRecord } from '../ui/TransferRecord.js';
import { DevicePanel } from '../ui/DevicePanel.js';
import { Button } from '../ui/Button.js';
import { LiveSection, TurnCaution, failureText } from '../ui/LiveSection.js';
import { VerifyPanel } from '../ui/VerifyPanel.js';
import { SessionHeader } from '../ui/SessionHeader.js';
import { LiveSession, type Slot } from '../media/live-session.js';
import { IconCamera, IconDesktop, IconFolder } from '../ui/icons.js';
import { navigateTo } from '../routing.js';
import { useTransferGuards } from '../hooks/useTransferGuards.js';
import type { SessionHandle } from '../hooks/useSession.js';
import type { SharedPayload } from '../share/inbox.js';
import type { CaptureFailure } from '../media/capture.js';
import type { SharePreset } from '../media/share-quality.js';
import type { ShareStats } from '../media/stats.js';
import type { MediaKind } from '../../shared/media-signal.js';

export interface TransferPanelProps {
  session: SessionHandle;
  /**
   * What the OS share sheet handed this app, staged by CreateScreen and
   * waiting on the verification gate. Undefined for every session that was
   * started by hand, which is nearly all of them.
   */
  pending?: SharedPayload;
  /**
   * Told once `pending` has been sent, so the owner can drop it. Necessary
   * because the once-only guard below is a ref: it dies with this component,
   * and this component is torn down and rebuilt every time a peer leaves and
   * rejoins the same session.
   */
  onPendingSent?: () => void;
}

/**
 * The paired-session UI: drop a file or paste a note, and watch it move.
 * Reached from both CreateScreen (once a peer joins) and SessionScreen (once
 * the join completes), so a bug fixed here is fixed on both sides at once.
 *
 * Files can only transfer while paired — this is the only screen a per-file
 * error, a save-tier notice, or a stalled handshake can ever surface on — so
 * unlike the placeholder it replaces, it renders both `session.error` and
 * `session.notice`, never just a silent "Connected". The way out is
 * SessionHeader's "End session" — a paired session has nothing to join.
 */
export function TransferPanel({ session, pending, onPendingSent }: TransferPanelProps) {
  useTransferGuards(session.files);

  /** Both users have compared the six digits. Nothing sends before this. */
  const verified = session.verifiedByMe && session.verifiedByPeer;

  /**
   * Asks for notification permission, once, from the act of sending.
   *
   * Sending is the only moment the request is honest: it is the first sign
   * the user intends to wait for something, and it rides a real click. Asking
   * on mount would prompt anyone who merely opened a session — including
   * someone who only ever receives, and someone who came to look at the QR —
   * which is the pattern browsers added prompt-throttling to punish.
   *
   * Only from `'default'`: re-asking after a denial cannot re-prompt (the
   * browser answers from its own record) and re-asking after a grant is
   * pointless. Nothing here is awaited or reported. A refusal costs the user
   * one lock-screen line they did not ask for, and the transfer is entirely
   * unaffected either way — which is why every failure mode below is
   * swallowed rather than surfaced.
   */
  const armNotifications = useCallback((): void => {
    // Absent on iOS Safari outside an installed PWA, and on any insecure
    // origin — a LAN address over plain http is one.
    const notification = (globalThis as { Notification?: typeof Notification }).Notification;
    if (notification === undefined || notification.permission !== 'default') return;
    try {
      // Promise-returning in every current browser, callback-only in old
      // Safari, where this returns undefined — hence the Promise.resolve
      // rather than a bare `.catch` on the return value.
      void Promise.resolve(notification.requestPermission()).catch(() => {});
    } catch {
      // Some embedded webviews throw outright rather than reject.
    }
  }, []);

  /*
   * Every send on this screen goes through these two, so arming happens once
   * per path with no call site having to remember it: the drop zone, the
   * paste handler, the note composer, and the share-target auto-send below.
   * The auto-send is the one that carries no click of its own — the browser
   * will simply refuse it there, which is the correct outcome rather than a
   * case worth branching on.
   */
  const sendFiles = useCallback((files: File[]): void => {
    armNotifications();
    session.sendFiles(files);
  }, [armNotifications, session.sendFiles]);

  const sendText = useCallback((content: string): void => {
    armNotifications();
    session.sendText(content);
  }, [armNotifications, session.sendText]);

  /**
   * Sends a shared payload the moment the gate opens, and exactly once.
   *
   * Auto-sending is the right default here and only here: choosing Quik Share
   * in the OS share sheet *is* the instruction to send these files, and the
   * six-digit comparison both users have just made is what decides it is safe
   * to honour it. Nothing about the share sheet weakens that gate — it only
   * removes the second, redundant "now pick the files" step.
   */
  const pendingSent = useRef(false);
  useEffect(() => {
    if (!verified || pending === undefined || pendingSent.current) return;
    pendingSent.current = true;
    if (pending.files.length > 0) sendFiles(pending.files);
    // An absent note is not an empty one: sending it would put a blank row on
    // the other device's record.
    if (pending.note !== undefined) sendText(pending.note);
    onPendingSent?.();
  }, [verified, pending, sendFiles, sendText, onPendingSent]);

  /**
   * ⌘/Ctrl+V sends whatever files are on the clipboard.
   *
   * The gap this closes is the screenshot: taking one puts it on the
   * clipboard and nowhere else, so sending it through the drop zone means
   * saving it to disk first, hunting it down in a picker, and deleting it
   * afterwards — three steps to move something that was already in hand.
   *
   * Listened for on `document` rather than on a container, because a paste
   * with nothing focused targets `body`. Requiring a click into a zone first
   * would put the gesture behind exactly the step it exists to remove.
   */
  useEffect(() => {
    if (!verified) return;
    const onPaste = (event: ClipboardEvent): void => {
      // Never intercept a paste aimed at a field. The note composer on this
      // very screen is a textarea, and swallowing its ⌘V would make it
      // impossible to paste a link into the control built for sending links.
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable]')) return;

      const files = [...(event.clipboardData?.files ?? [])];
      // An ordinary text paste is not this handler's business, and must not
      // be prevented on its way to whatever else would have handled it.
      if (files.length === 0) return;

      event.preventDefault();
      sendFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [verified, sendFiles]);

  const [slot, setSlot] = useState<Slot>({ state: 'idle' });
  const [liveFailure, setLiveFailure] = useState<CaptureFailure | { reason: 'connect-failed' } | undefined>(undefined);
  /**
   * Optimistic until a real share attempt learns otherwise: this device
   * has no way to know whether the deployment has TURN without a `/turn`
   * request, and per spec §5 that request only ever happens lazily, on
   * the first share attempt of a session — an idle session makes no
   * request. So there is nothing to probe on mount; `turnAvailable` stays
   * `true` (no caution) until `LiveSession`'s `onTurnAvailable` reports
   * what the first `MediaPeer.offer()`/`answer()` actually found, which it
   * derives from the very `mediaRtcConfig()` call that attempt already
   * makes (client/media/live-session.ts's `#makePeerEvents`) rather than a
   * second request of this component's own. Consequence, matching spec
   * §6's no-TURN row: the caution can appear only from the first share
   * attempt onward, never before one.
   */
  const [turnAvailable, setTurnAvailable] = useState(true);
  /**
   * What the outgoing stream is measurably doing, published on a timer by
   * `LiveSession` while sending and cleared the moment it stops. Its own
   * state rather than a field on `slot`, because a slot change is how an
   * in-flight negotiation learns it was overtaken — see
   * `LiveSessionEvents.onStats`.
   */
  const [shareStats, setShareStats] = useState<ShareStats | undefined>(undefined);
  const liveSessionRef = useRef<LiveSession | undefined>(undefined);

  /**
   * One `LiveSession` per paired session, built the instant `peerId` is
   * known (see `SessionHandle.peerId`'s doc comment for why that is always
   * true by the time this effect can do anything) and torn down on
   * unmount. Built here rather than inside `useSession` — where the
   * worker-backed file-transfer machinery lives — because
   * `RTCPeerConnection` must never cross into that worker realm
   * (client/media/media-peer.ts's own class doc comment, and spec §6's
   * "Every production session has been permanently relayed" finding this
   * whole plan exists to fix); this is the one place on the page that both
   * has a real `peerId` and can render a `<video>`.
   *
   * The cleanup function is the privacy-critical half of this component.
   * Whatever this device is sending or receiving must stop the instant
   * TransferPanel goes away — leaving the screen via End session or the
   * join link (both route through `navigateTo`, which unmounts this
   * component), or a peer disconnecting (CreateScreen/SessionScreen swap
   * TransferPanel out the moment `session.state` leaves `'paired'`, so a
   * departing peer already unmounts this component before it could ever
   * observe the new state — see the effect below for the explicit
   * peer-left path anyway) — not only when a Stop sharing/Cancel button
   * happens to get clicked. `LiveSession.stop()` funnels into the same
   * `#release()` every other teardown path uses, which is what actually
   * closes the `RTCPeerConnection` and calls `stop()` on every local
   * track — the step that makes the camera's recording light go out.
   *
   * The `onMediaSignal` unsubscribe matters independently of the
   * `LiveSession` teardown: `useSession`'s subscriber set
   * (`mediaSignalListeners`) outlives this component (it belongs to the
   * hook, called one level up in CreateScreen/SessionScreen), so a
   * forgotten unsubscribe here would leak a listener into every future
   * remount — exactly the `<StrictMode>` double-mount hazard
   * `SessionHandle.onMediaSignal`'s own doc comment calls out.
   */
  useEffect(() => {
    if (session.peerId === undefined) return;
    const live = new LiveSession(session.peerId, {
      onSlotChanged: setSlot,
      onSignal: session.sendMediaSignal,
      onFailure: setLiveFailure,
      onTurnAvailable: setTurnAvailable,
      onStats: setShareStats,
    });
    liveSessionRef.current = live;
    const unsubscribe = session.onMediaSignal((signal) => { void live.onMediaSignal(signal); });

    return () => {
      unsubscribe();
      live.stop();
      liveSessionRef.current = undefined;
    };
  }, [session.peerId, session.onMediaSignal, session.sendMediaSignal]);

  /**
   * Explicit peer-left wiring, kept separate from the unmount cleanup
   * above even though — given how CreateScreen/SessionScreen gate
   * TransferPanel on `session.state === 'paired'` — a departing peer
   * unmounts this component before this effect could ever see `'ended'`
   * or `'gone'`, making the transition currently unreachable through the
   * real screens. Written anyway, deliberately: `LiveSession.onPeerLeft()`
   * is one of the seven documented exits from a claimed slot (see its
   * class doc comment), the intent here is "the peer left," not "React
   * happened to remove this tree for an unrelated reason," and a future
   * screen that keeps TransferPanel mounted across a departed peer (an
   * inline notice instead of swapping the whole panel, say) would
   * otherwise silently lose the one piece of teardown that actually
   * matters — a stream that would otherwise render forever.
   */
  useEffect(() => {
    if (session.state === 'ended' || session.state === 'gone') {
      liveSessionRef.current?.onPeerLeft();
    }
  }, [session.state]);

  function startLive(kind: MediaKind): void {
    // This component owns clearing a stale failure, same contract
    // LiveSectionProps.failure used to document before the buttons (and
    // this alert) moved here: a fresh attempt must not still be showing
    // the reason the *previous* one failed.
    setLiveFailure(undefined);
    void liveSessionRef.current?.start(kind);
  }

  function stopLive(): void {
    liveSessionRef.current?.stop();
  }

  // Both fire-and-forget onto the LiveSession, which publishes every result
  // — success, failure, the busy flag in between — through the same
  // onSlotChanged/onFailure this component already listens to. There is
  // nothing for a caller to await and nothing extra to render.
  function flipCamera(): void {
    setLiveFailure(undefined);
    void liveSessionRef.current?.flipCamera();
  }

  function setTorch(on: boolean): void {
    setLiveFailure(undefined);
    void liveSessionRef.current?.setTorch(on);
  }

  function setPreset(preset: SharePreset): void {
    setLiveFailure(undefined);
    void liveSessionRef.current?.setSharePreset(preset);
  }

  return (
    <section aria-labelledby="transfer-heading" className="flex flex-col gap-6 py-6">
      {/* The heading, the transport chip and the way out are all still here —
          they moved into SessionHeader, which draws the pair itself around
          them and adds the one thing the connected screen never showed: the
          session code. What the session has moved is the record's job below,
          not the header's — see its own doc comment. */}
      <SessionHeader
        code={session.code}
        transportKind={session.transportKind}
        self={session.selfDevice}
        peer={session.peerDevice}
        // The frame that tells the peer this was deliberate goes out between
        // the guard and the navigation — see navigateTo's `before`. Sent from
        // the call site instead, it would either ask the guard twice or tell
        // the peer the session is over and then leave the user sitting on it.
        onEnd={() => navigateTo('/', session.endSession)}
      />

      {/*
       * Live promotes above the two-column grid the instant a stream
       * starts and collapses back the instant it ends (spec §6): idle
       * renders `null` (LiveSection.tsx's own doc comment), so this line
       * costs nothing on screen while nothing is live. Deliberately still
       * above the grid, in the gap the comment below describes, rather
       * than inside either column — a stream is the one time-sensitive
       * thing on this page (spec §6) and both Share and Transfers stay put
       * underneath it either way.
       */}
      <LiveSection
        slot={slot}
        turnAvailable={turnAvailable}
        onStop={stopLive}
        onFlipCamera={flipCamera}
        onTorch={setTorch}
        onPreset={setPreset}
        stats={shareStats}
      />

      {/*
       * One screen at a time: while the gate stands it is the ONLY thing
       * here, and Share, Transfers and Devices arrive together the moment
       * both devices have confirmed.
       *
       * `verified` is both sides, not this one. Session refuses every send
       * until both have confirmed (client/session.ts's `#requireVerified`),
       * so revealing the workspace on this device's own click alone would
       * hand back a drop zone that can still only produce errors. Between
       * the two clicks the panel says "Confirmed here. Waiting for the other
       * device…", which is the honest state of a half-open gate.
       *
       * This replaces an earlier ruling that kept the Transfers column
       * mounted throughout, on the grounds that an empty record beside the
       * number was honest rather than hidden and that the folder picker had
       * work to do during the wait. Both were true; the call went the other
       * way anyway, because six digits to be read off two screens and
       * compared are the whole job at that moment and everything else on the
       * page is something to look at instead of doing it. The costs are
       * real and named here so they are not rediscovered as bugs: the folder
       * picker is no longer offered before files can arrive, and the Devices
       * panel — "did I pair with the device I meant to?" — is not on screen
       * while that is exactly the question being asked.
       */}
      {!verified ? (
        <VerifyPanel
          digits={session.verification}
          verifiedByMe={session.verifiedByMe}
          verifiedByPeer={session.verifiedByPeer}
          onConfirm={session.confirmVerification}
        />
      ) : (
      /*
       * Share and Transfers side by side rather than stacked: TransferRecord
       * used to sit below a scroll's worth of drop zone and composer, so
       * "did that go?" meant scrolling past the controls to find out. Two
       * columns keep the record visible next to the thing that fills it.
       *
       * 5/7 rather than 1/1 from `lg` up, and the even split below it. The
       * two columns hold different kinds of thing: Share is a fixed stack of
       * controls whose width changes nothing about it, while Transfers holds
       * filenames — which truncate, so every pixel taken off that column is
       * characters of a name nobody gets to read. An even split was giving
       * the fixed half the same room as the elastic one. `sm:grid-cols-2`
       * stays as the tablet step, where 5/7 would leave the record too
       * narrow to be worth the asymmetry.
       *
       * Both sections carry `min-w-0`, and it is load-bearing. A grid item
       * defaults to `min-width: auto`, i.e. it refuses to shrink below its
       * min-content width — and TransferRecord's filenames are `truncate`d,
       * which means `white-space: nowrap`, which means their min-content
       * width is the WHOLE name. `overflow: hidden` caps what gets painted,
       * never what gets measured. So without this a single long filename
       * set the floor for this column (and, at mobile width where both
       * sections share one column, for the Share column beside it), pushing
       * the sections past the grid and scrolling the whole page sideways.
       * The `min-w-0` already on the row's inner flex child cannot help:
       * it releases the flex level, and this floor is a grid one.
       */
      <div data-session-columns className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-6">
        <section aria-labelledby="share-heading" className="flex min-w-0 flex-col gap-4">
          <h2 id="share-heading" className="text-[0.9375rem] font-semibold">Share</h2>
          <DropZone onFiles={sendFiles} />
          <TextSnippet onSend={sendText} />

          {/*
           * Ruling (overrides the task brief's original placement, and
           * LiveSection.tsx's own doc comment explains why): spec §6's
           * layout mock puts `[◉ Camera][▭ Screen]` inside Share, always
           * present — not only while Live is idle — because the Watching
           * row's own promise ("a note that starting your own replaces
           * theirs") is unreachable if the only start control disappears
           * the moment a stream is already running. Clicking either while
           * already sharing is not a no-op: LiveSession.start() replaces
           * whatever this session currently holds (its own class doc
           * comment), which is exactly what that promise describes.
           *
           * The failure alert and one-stream note travel with the buttons
           * for the same reason they were bundled with them before this
           * hoist: both are about "what happens when you try to start,"
           * not about anything Live's own promoted card renders.
           *
           * A hairline above the pair, which the stack did not have before:
           * files, a note and a live stream are three different things to
           * send, and with nothing between them the column read as one
           * undifferentiated run of controls.
           */}
          <div className="flex flex-col gap-2 border-t border-[var(--color-border-strong)] pt-4">
            {liveFailure && (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {failureText(liveFailure)}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* IconDesktop is the device-kind glyph reused deliberately:
                  "share screen" and "this is a computer" are the same monitor,
                  and a second, subtly different monitor drawing would read as
                  a different thing rather than the same one. */}
              {/* Both ghost, where camera used to be the filled variant. The
                  Share column already carries two accent fills above this row
                  (Choose files, and Send under the note box), and a third
                  competing for the same attention made none of them read as
                  the primary action. Live media is an alternative to sending
                  a file, not a louder version of it, and the two buttons are
                  a pair — one filled and one not said they were different
                  kinds of thing, which they are not. */}
              <Button variant="ghost" icon={<IconCamera />} onClick={() => startLive('camera')}>Share camera</Button>
              <Button variant="ghost" icon={<IconDesktop />} onClick={() => startLive('screen')}>Share screen</Button>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              Only one live stream at a time. Starting one replaces whatever is already running.
            </p>
            {/* Only while idle: LiveSection's own promoted card already
                shows this same caution for every non-idle state (still
                mounted, right above this grid), and showing it in both
                places at once would be the same sentence twice on one
                screen. */}
            {!turnAvailable && slot.state === 'idle' && <TurnCaution />}
          </div>
        </section>

        <section aria-labelledby="transfers-heading" className="flex min-w-0 flex-col gap-4">
          <h2 id="transfers-heading" className="text-[0.9375rem] font-semibold">Transfers</h2>
          <SaveFolder session={session} />
          <TransferRecord files={session.files} notes={session.notes} onCancel={session.cancelFiles} />
        </section>
      </div>
      )}

      {session.notice !== undefined && (
        // Not an alert and not danger-colored: a downgraded save tier is
        // something to know, not something that went wrong.
        <p className="neo-inset rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3 text-center text-sm text-[var(--color-text-muted)]">
          {session.notice}
        </p>
      )}

      {session.error !== undefined && (
        <p role="alert" className="text-center text-sm text-[var(--color-danger)]">
          {session.error}
        </p>
      )}

      {/* Last of the content, below the two alert slots above rather than
          between them and the transfer they describe: this is reference
          material — "which of my devices is this?" — that a user consults
          once and then scrolls past, not part of the send/receive flow. */}
      {/* Gated with the workspace above, not with the alerts between them:
          this describes the pair you are about to move files between, so it
          belongs to the same moment those controls do. */}
      {verified && <DevicePanel self={session.selfDevice} peer={session.peerDevice} />}
    </section>
  );
}

/**
 * The one click that buys every incoming file a home. Without it a batch
 * arrives as one browser download per file, and desktop Chromium interrupts
 * the second one with "Allow this site to download multiple files?" — a
 * prompt no page can request, query, or even detect being denied, so the
 * files after it fail silently. A directory handle sidesteps the downloader
 * entirely.
 *
 * Rendered only where it can work (Chromium desktop), and above the record
 * rather than below it: it is worth acting on BEFORE files arrive, and it is
 * the same column the arriving files land in.
 *
 * Its own component from when it rendered in two places, kept as one
 * because the Transfers column reads better for it. Note that it is no
 * longer offered during the verification wait — which is when a folder
 * could most usefully be picked, since nothing can arrive until both
 * devices confirm — because the whole column is gated on that confirmation
 * now. See the gate's own comment above.
 */
function SaveFolder({ session }: { session: SessionHandle }) {
  if (!session.canChooseFolder) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="ghost" icon={<IconFolder />} onClick={session.chooseFolder}>
        {session.saveFolder === undefined ? 'Save to a folder…' : 'Change folder…'}
      </Button>
      {/* Polite, not assertive: the folder changing is a status update on an
          action the user just took, not an alert. */}
      <p aria-live="polite" className="text-xs text-[var(--color-text-muted)]">
        {session.saveFolder === undefined
          ? 'Files arrive as browser downloads, one at a time. Pick a folder and they are written straight into it instead.'
          : `Files are written straight into “${session.saveFolder}”.`}
      </p>
    </div>
  );
}

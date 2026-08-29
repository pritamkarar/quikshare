import { useEffect, useRef, useState } from 'react';
import type { MediaKind } from '../../shared/media-signal.js';
import type { CaptureFailure } from '../media/capture.js';
import type { CameraState, Slot } from '../media/live-session.js';
import { SHARE_PRESETS, SHARE_PRESET_COPY, type SharePreset } from '../media/share-quality.js';
import { hasAnyStat, type ShareStats } from '../media/stats.js';
import { Button } from './Button.js';
import { IconClose, IconFlash, IconFlashOff, IconFlip, IconMic, IconMicOff, IconStop } from './icons.js';

/**
 * Shared card chrome for every non-idle presentation, matching
 * DevicePanel/TransferRecord's own card (client/ui/DevicePanel.tsx,
 * client/ui/TransferRecord.tsx). Idle deliberately does *not* use this —
 * see the component doc comment below for why.
 *
 * `pulse-glow` is the one breathing animation in the app, and this is the
 * only card that gets it: a stream is the single time-sensitive thing on the
 * page, and this card only exists while one is running. It is decorative on
 * top of state that is always also written out in words, and it collapses to
 * a static lit halo under prefers-reduced-motion (client/styles/app.css).
 */
const CARD = 'neo pulse-glow flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5';

/** The fixed-ratio box both the "connecting" placeholder and the two real
 * <video> elements share, so a stream arriving mid-attempt does not shift
 * anything else on the page (AGENTS.md: skeletons mirror final content). */
const VIDEO_BOX = 'neo-inset aspect-video w-full overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-surface-2)]';

/**
 * Recovery text for every way a share attempt can fail to start or connect —
 * `CaptureFailure` from client/media/capture.ts, plus LiveSession's own
 * `connect-failed`. Each reason gets genuinely different wording rather than
 * one shared "something went wrong", because the recovery differs per
 * reason (task brief): 'denied' is fixed from the browser's own permission
 * UI, 'no-device' cannot be retried into working at all, and so on.
 *
 * 'denied' deliberately does not say "you refused" or "permission denied" —
 * capture.ts's classify() folds the user simply dismissing the
 * getDisplayMedia screen-picker into this same reason (there is no way to
 * tell the two apart from the DOMException alone), and that is an ordinary
 * cancellation, not a mistake to be scolded for.
 *
 * Exported: Task 8 renders the failure alert in TransferPanel's Share
 * section, alongside the two start buttons (spec §6's layout mock puts
 * `[◉ Camera][▭ Screen]` there, always present, not gated on Live's idle
 * state) — see this file's own component doc comment below for why the
 * buttons and this text moved out of LiveSection but the wording logic did
 * not need to move with them into a second copy.
 */
export function failureText(failure: CaptureFailure | { reason: 'connect-failed' }): string {
  switch (failure.reason) {
    case 'denied':
      return "Camera or microphone access isn't allowed for this site right now (or the sharing prompt was closed). "
        + "Click the icon in your browser's address bar to check the permission, then try again.";
    case 'no-device':
      return 'No camera was found on this device. Plug one in and try again, or share your screen instead.';
    case 'unsupported':
      return "This browser, or this connection, doesn't support live camera or screen sharing here.";
    case 'failed':
      return `The share couldn't be started (${failure.detail}). Try again.`;
    case 'connect-failed':
      // Spec §7: a live-media failure is never a transfer error — this is
      // the connection failing, not a file, and the copy says so.
      return "The live connection to the other device didn't go through. Your files aren't affected. Try again.";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

export interface LiveSectionProps {
  /** The session's one live-media slot — every state this component renders is one variant of it. */
  slot: Slot;
  /**
   * Points the camera the other way. Optional so a caller with no
   * `LiveSession` to drive — every test that renders this component off a
   * hand-built slot — is unaffected; the control is simply absent.
   */
  onFlipCamera?: () => void;
  /** Turns the camera's lamp on or off. Optional for the same reason. */
  onTorch?: (on: boolean) => void;
  /** Chooses what a screen share protects when the network tightens. */
  onPreset?: (preset: SharePreset) => void;
  /**
   * What the outgoing stream is measurably doing, or undefined before the
   * first reading. Reporting only — see client/media/share-quality.ts for
   * why nothing on this screen tries to manage the bitrate itself.
   */
  stats?: ShareStats;
  /**
   * False when this deployment's `/turn` returned no usable relay (see
   * client/media/ice.ts's mediaRtcConfig). Spec §6's amended guidance, not
   * its §3 summary: this never disables anything, it only adds one line of
   * caution, because a phone and a laptop on one wifi network connect over
   * host candidates without STUN or TURN — refusing outright would break
   * the app's most common setup to guard against the hotel-wifi case.
   */
  turnAvailable: boolean;
  /** Ends whatever is currently shared/received, or cancels an attempt still connecting — all three are `LiveSession.stop()`. */
  onStop: () => void;
}

/**
 * Renders every *active* state spec §6 defines for the session's one
 * live-media slot — offering, sending, connecting, watching. A pure
 * props-in component on purpose (task brief): nothing here touches
 * `navigator.mediaDevices`, `RTCPeerConnection`, or `session.error` — Task 8
 * owns wiring a real `LiveSession` and `useSession` to these props, which is
 * what makes every state below reachable from a plain render call.
 *
 * Idle renders nothing at all (`null`), not even a bordered card — matching
 * spec §6 ("Live is absent from the DOM when idle apart from its two
 * buttons"). Those two buttons, and the failure alert and one-stream note
 * that travel with them, are *not* idle-only content anymore: spec §6's
 * layout mock places `[◉ Camera][▭ Screen]` inside the Share panel,
 * always present regardless of Live's state (the Watching row's own promise
 * — "a note that starting your own replaces theirs" — is unreachable if the
 * only way to start a share is a button that disappears the moment one is
 * already running). Task 8 renders them there instead, in
 * client/screens/TransferPanel.tsx, reusing this file's exported
 * `failureText`/`TurnCaution` rather than a second copy of either. Every
 * *non-idle* state still gets the full card here, because there is
 * something worth naming and grouping — a stream, a placeholder, a failure
 * — and a landmark name (`aria-labelledby`) an idle screen reader user has
 * no use for.
 *
 * A live-media failure is never a transfer error (spec §7, and the global
 * constraint list this task was built against): the failure alert Task 8
 * renders alongside the Share buttons is its own `role="alert"`, with no
 * connection whatsoever to `SessionHandle.error` — a refused camera
 * permission must not look like a failed file transfer.
 */
export function LiveSection({
  slot, turnAvailable, onStop, onFlipCamera, onTorch, onPreset, stats,
}: LiveSectionProps) {
  if (slot.state === 'idle') return null;

  return (
    <section aria-labelledby="live-heading" className={CARD}>
      <h2 id="live-heading" className="text-sm font-semibold text-[var(--color-text-muted)]">Live</h2>
      {!turnAvailable && <TurnCaution />}
      {slot.state === 'receiving'
        ? (slot.stream ? <Watching kind={slot.kind} stream={slot.stream} onStop={onStop} /> : <Connecting kind={slot.kind} onCancel={onStop} />)
        // key={slot.stream.id}: forces a remount, and therefore a fresh
        // `muted` state derived straight from the new track, whenever the
        // underlying MediaStream changes — switching camera<->screen while
        // already sharing calls LiveSession.start() again, which is a brand
        // new capture(), not a mutation of the one in hand. Without this,
        // stale local `muted` state could disagree with the new track's own
        // `enabled`, which is exactly the drift requirement 3 exists to rule
        // out.
        : (
          <Sharing
            key={slot.stream.id}
            state={slot.state}
            kind={slot.kind}
            stream={slot.stream}
            camera={slot.camera}
            preset={slot.preset}
            stats={stats}
            onStop={onStop}
            onFlipCamera={onFlipCamera}
            onTorch={onTorch}
            onPreset={onPreset}
          />
        )}
    </section>
  );
}

/**
 * Spec §6's amended guidance: no TURN configured is a caution, not a lock.
 * Neutral tone (muted text, no danger color, no alert role) matches how
 * TransferPanel already presents a non-failure notice (its own
 * `session.notice` paragraph) — this is a fact worth knowing, not
 * something that has gone wrong yet.
 *
 * Exported: rendered here for every non-idle state, and separately by
 * TransferPanel's Share section while idle (Live itself renders nothing
 * then, so there is nowhere else on screen for this line to live) — never
 * both at once, since the two call sites are mutually exclusive with slot
 * state, which is what keeps this from ever reading as the same sentence
 * twice.
 */
export function TurnCaution() {
  return (
    <p className="text-xs text-[var(--color-text-muted)]">
      This connection has no relay configured, so live video may not connect on some networks (like hotel wifi).
      It should still work between two devices on the same network.
    </p>
  );
}

interface SharingProps {
  state: 'offering' | 'sending';
  kind: MediaKind;
  stream: MediaStream;
  onStop: () => void;
  camera?: CameraState;
  onFlipCamera?: () => void;
  onTorch?: (on: boolean) => void;
  preset?: SharePreset;
  onPreset?: (preset: SharePreset) => void;
  stats?: ShareStats;
}

/**
 * The local preview, shown identically the instant capture succeeds
 * ('offering') and once the peer has actually accepted it ('sending') —
 * the stream itself never changes between the two, and a viewer sees no
 * gap either way, so splitting them into two presentations would be a
 * distinction the UI has no use for. Only the status line names which one
 * this is.
 */
function Sharing({
  state, kind, stream, camera, preset, stats, onStop, onFlipCamera, onTorch, onPreset,
}: SharingProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // A flip swaps the video track inside the SAME MediaStream object
  // (MediaPeer.replaceVideoTrack), so `stream` alone never changes identity
  // and an effect keyed on it would not re-run. Re-assigning srcObject is
  // what makes the element latch onto the new track rather than keep
  // painting the last frame of the stopped one.
  const videoTrackId = stream.getVideoTracks()[0]?.id;
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, videoTrackId]);

  // getAudioTracks()[0], not a switch on `kind`: captureCamera() always asks
  // for audio and captureScreen() never does (capture.ts), so in practice
  // this and `kind === 'camera'` agree — but reading the *stream itself*
  // is what stays correct if that ever changes, and it is what requirement
  // 3 asks for: the control's presence follows the real track, not a label.
  const audioTrack = stream.getAudioTracks()[0];
  const [muted, setMuted] = useState(() => (audioTrack ? !audioTrack.enabled : true));

  function toggleMute(): void {
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
    // Track state is the source of truth; React state only mirrors it,
    // because the track can also be ended or replaced from outside this
    // component (LiveSession swapping the whole slot out from under it).
    setMuted(!audioTrack.enabled);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {state === 'offering' ? `Waiting for the other device to accept your ${kind}…` : `Sharing your ${kind}, live`}
      </p>
      {/* Preview beside the controls, not above them at the full width of
          the card. This card spans the whole session shell (TransferPanel
          promotes it above the two-column grid), and a `w-full aspect-video`
          box there is a ~900px-tall picture of your own face or your own
          screen — the one thing on this page you are already looking at
          directly. Capped from `sm` up, full width below it, where there is
          no room to put anything beside it anyway. `Watching` deliberately
          keeps the full-width box: the other device's stream is the thing
          you cannot see any other way. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className={`${VIDEO_BOX} sm:w-72 sm:shrink-0 lg:w-96`}>
          {/*
           * ALWAYS muted, and not optional — see the task brief and requirement
           * 2. Camera capture carries the microphone (capture.ts), and both
           * devices are usually sitting in the same room: an unmuted local
           * preview would play this device's own microphone back through its
           * own speakers a few feet from the mic that is picking it up, which
           * is a feedback loop, not a preview. `controls` is deliberately
           * absent here too — the browser's native mute toggle would only
           * silence local playback, leaving the outgoing track (and the
           * browser's own recording indicator) untouched, which is exactly the
           * "hot mic the user believes is off" the Mute mic button below exists
           * to prevent.
           */}
          <video ref={videoRef} muted autoPlay playsInline aria-label={`Your ${kind}, previewed muted`} className="size-full object-cover" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {/* Absent, not disabled, when there is no audio track (a screen
                share): a disabled Mute button next to a silent stream is a
                question the user has to answer for themselves — requirement 3. */}
            {/* Struck-through while muted, open while live: one control in two
                states, and the glyph changes with the label rather than replacing
                what the label says. */}
            {audioTrack && (
              <Button variant="ghost" icon={muted ? <IconMicOff /> : <IconMic />} onClick={toggleMute}>
                {muted ? 'Unmute mic' : 'Mute mic'}
              </Button>
            )}
            {/* Both camera controls are absent, never disabled, where the
                hardware cannot do them — the same rule the Mute button follows.
                A greyed-out Flash on a laptop is a question the user has to
                answer for themselves, and the answer is always "no". `canFlip`
                and `canTorch` are read off the live track, so they follow the
                camera actually in use rather than a guess about the device:
                flipping to a front camera with no lamp takes Flash away with
                it. */}
            {camera?.canFlip && onFlipCamera && (
              <Button
                variant="ghost"
                icon={<IconFlip />}
                loading={camera.busy}
                onClick={onFlipCamera}
              >
                {/* Names the camera it will switch TO, not the one in hand: a
                    button labelled with the current state reads as a status
                    line, and the user has the preview for that. */}
                {camera.facing === 'environment' ? 'Front camera' : 'Rear camera'}
              </Button>
            )}
            {camera?.canTorch && onTorch && (
              <Button
                variant="ghost"
                icon={camera.torchOn ? <IconFlashOff /> : <IconFlash />}
                onClick={() => onTorch(!camera.torchOn)}
              >
                {camera.torchOn ? 'Flash off' : 'Flash on'}
              </Button>
            )}
            <Button variant="danger" icon={<IconStop />} onClick={onStop}>Stop sharing</Button>
          </div>
          {/* Screen only. A camera share has its own controls above, and a
              preset that talked about "sharp text" beside a camera preview
              would be describing something nobody is looking at. */}
          {kind === 'screen' && preset && onPreset && (
            <QualityPresets preset={preset} onPreset={onPreset} />
          )}
          {stats && hasAnyStat(stats) && <StatsLine stats={stats} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Which trade the screen share is making.
 *
 * Radio semantics, not three independent buttons: exactly one is in force
 * at any moment, and `aria-checked` on a radiogroup is what says so — a row
 * of `aria-pressed` toggles would tell a screen reader three separate
 * on/off facts and leave the exclusivity to be inferred.
 *
 * The trade each one makes is written out rather than left in the label.
 * "Sharp text" alone does not tell anyone what it costs, and the cost is
 * the whole decision.
 */
function QualityPresets({ preset, onPreset }: {
  preset: SharePreset;
  onPreset: (preset: SharePreset) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-[var(--color-text-muted)]">
        When the connection tightens, keep:
      </p>
      <div role="radiogroup" aria-label="Screen share quality" className="flex flex-wrap gap-2">
        {SHARE_PRESETS.map((option) => {
          const { label, detail } = SHARE_PRESET_COPY[option];
          const active = option === preset;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              // The trade is the tooltip and the accessible description
              // both, so it is available without hovering.
              title={detail}
              aria-label={`${label}. ${detail}`}
              onClick={() => onPreset(option)}
              className={`inline-flex min-h-11 items-center rounded-full px-3.5 text-sm transition-[box-shadow,color] duration-[var(--duration-fast)] ${
                active
                  ? 'neo-inset bg-[var(--color-surface-2)] font-semibold text-[var(--color-text)]'
                  : 'neo-press bg-[var(--color-surface)] text-[var(--color-text-muted)]'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">{SHARE_PRESET_COPY[preset].detail}</p>
    </div>
  );
}

/**
 * What the stream is actually doing.
 *
 * Every number is omitted rather than zeroed when the browser has not
 * reported it — a report taken seconds after connecting often has no frame
 * rate yet, and "0 fps" beside a moving picture is worse than saying
 * nothing. Polite live region: these change every couple of seconds, and an
 * assertive one would interrupt continuously.
 */
function StatsLine({ stats }: { stats: ShareStats }) {
  const parts = [
    stats.kbps === undefined ? undefined : `${formatRate(stats.kbps)}`,
    stats.width && stats.height ? `${stats.width}×${stats.height}` : undefined,
    stats.fps === undefined ? undefined : `${stats.fps} fps`,
    stats.rttMs === undefined ? undefined : `${stats.rttMs} ms`,
  ].filter((part): part is string => part !== undefined);

  return (
    <p role="status" aria-live="polite" className="mono numeric text-xs text-[var(--color-text-muted)]">
      {parts.join(' · ')}
    </p>
  );
}

/** kbps into something readable, switching to Mbps where the number gets long. */
function formatRate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

/**
 * `Slot.receiving.stream` undefined — spec §6's "connecting" state.
 * Answering an offer and the first frame arriving are two different
 * moments (see `Slot`'s own doc comment in live-session.ts); this is
 * deliberately not rendered as a failure or left blank while nothing shows,
 * because neither is true yet — a connection is genuinely in progress.
 */
function Connecting({ kind, onCancel }: { kind: MediaKind; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className={`${VIDEO_BOX} flex items-center justify-center`}>
        {/* No spinner: an animated one would need its own reduced-motion
            fallback on top of tokens.css's global collapse, to say nothing
            this text doesn't already say just as clearly. */}
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-text-muted)]">
          Connecting to their {kind}…
        </p>
      </div>
      <div>
        {/* Not a UI-only dismissal: this calls the same LiveSession.stop()
            that a Stop sharing / Cancel click always calls, which actually
            closes the RTCPeerConnection this attempt opened. */}
        <Button variant="ghost" icon={<IconClose />} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** `Slot.receiving.stream` present — spec §6's "watching" state. */
function Watching({ kind, stream, onStop }: { kind: MediaKind; stream: MediaStream; onStop: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="flex flex-col gap-3">
      <div className={VIDEO_BOX}>
        {/*
         * Not muted — this is the other device's audio, and there is no
         * feedback risk on this side (only the sender's mic is the one that
         * can hear this device's speakers). `controls` gives volume and
         * fullscreen for free from the browser's own player (spec §6):
         * building bespoke buttons for both would duplicate accessible,
         * keyboard-operable controls the platform already provides, for no
         * behaviour this app needs that differs from the native ones.
         */}
        <video ref={videoRef} autoPlay playsInline controls aria-label={`Live ${kind} from the other device`} className="size-full object-contain" />
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Starting your own share will replace this with what you send instead.
      </p>
      {/* Ending an incoming stream needs its own control — AGENTS.md forbids
          a dead end, and a stream you cannot stop watching (short of leaving
          the session) is one. Same LiveSession.stop() as every other Stop/
          Cancel button: it releases *this* device's receiving slot and
          sends media-stop, which is the only way to end someone else's
          share from this side — there is nothing here to "stop sharing",
          only to stop watching. */}
      <div>
        <Button variant="ghost" icon={<IconStop />} onClick={onStop}>Stop watching</Button>
      </div>
    </div>
  );
}

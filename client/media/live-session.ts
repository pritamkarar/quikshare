import type { MediaControl } from '../../shared/messages.js';
import type { MediaKind } from '../../shared/media-signal.js';
import {
  CaptureError, type CaptureFailure, type Facing, captureCamera, captureCameraVideo, captureScreen,
  countCameras, facingOf, hasTorch, onStreamEnded, setTorch as applyTorch,
} from './capture.js';
import { MediaPeer, type MediaPeerEvents } from './media-peer.js';
import { hasTurnServer } from './ice.js';
import { DEFAULT_SHARE_PRESET, SHARE_QUALITY, type SharePreset } from './share-quality.js';
import { readShareStats, type ShareStats, type StatsSample } from './stats.js';

/**
 * The session's one live-media slot, as `LiveSession` sees it and as
 * `LiveSection` (Task 7) renders it. Every state the UI has to show is one
 * variant here — a state spec §6 needs that this union can't express would
 * be a bug in this file, not the UI's.
 *
 * `peer` is exposed on every non-idle variant because `LiveSession` is the
 * only thing that ever needs it (to route a signal, to close it) and a
 * parallel UI-facing shape would just be a second state to keep in step
 * with this one.
 *
 * `receiving.stream` is optional on purpose. Answering an offer and
 * actually receiving the first frame are two different moments —
 * `MediaPeer.accept()` returns once the answer is sent, but the track only
 * shows up later through `onRemoteStream`. That gap *is* spec §6's
 * "connecting" state; filling it with a placeholder stream would hide the
 * exact moment the UI needs to render, rather than express it.
 */
/**
 * What the two camera controls need to know, derived from the live track
 * rather than remembered from what was asked for — the same principle
 * LiveSection's mute button follows. Both facts are properties of the
 * TRACK, not of the device: the same phone reports a torch on its rear
 * camera and none on its front one, so this is rebuilt after every flip.
 *
 * Present only while this device is sharing a camera. A screen share has no
 * camera state, and neither has a session that is only receiving one.
 */
export interface CameraState {
  /** Which way it points, or undefined on hardware that will not say. */
  facing: Facing | undefined;
  /** There is a second camera to flip to. */
  canFlip: boolean;
  /** This track drives a lamp. Chromium on Android, rear camera, in practice. */
  canTorch: boolean;
  torchOn: boolean;
  /** A flip is in flight. The control is disabled rather than able to start a second. */
  busy: boolean;
}

export type Slot =
  | { state: 'idle' }
  | {
    state: 'offering'; kind: MediaKind; peer: MediaPeer; stream: MediaStream;
    camera?: CameraState; preset?: SharePreset;
  }
  | {
    state: 'sending'; kind: MediaKind; peer: MediaPeer; stream: MediaStream;
    camera?: CameraState; preset?: SharePreset;
  }
  | { state: 'receiving'; kind: MediaKind; peer: MediaPeer; stream?: MediaStream };

export interface LiveSessionEvents {
  onSlotChanged(slot: Slot): void;
  /** Seal and send to the peer — same contract as MediaPeerEvents.onSignal. */
  onSignal(signal: MediaControl): void;
  onFailure(failure: CaptureFailure | { reason: 'connect-failed' }): void;
  /**
   * What the outgoing stream is measurably doing, roughly every two seconds
   * while this device is sending, and `undefined` the moment it stops.
   *
   * Deliberately NOT part of `Slot`. A slot change bumps `#generation`,
   * which is how an in-flight `start()` or `accept()` learns it was
   * overtaken — and a reading published on a timer would bump it every
   * couple of seconds, cancelling negotiations that had nothing wrong with
   * them. Telemetry is not slot state, and keeping the two apart is what
   * makes that impossible rather than merely unlikely.
   */
  onStats?(stats: ShareStats | undefined): void;
  /**
   * Fired the first time a share attempt actually learns whether this
   * deployment has TURN — relayed straight from `MediaPeer.offer()`/
   * `answer()`'s `onIceConfig` (`#makePeerEvents` below), which is itself
   * fed by the one `mediaRtcConfig()` call that attempt already makes.
   * Optional and never fetched for on its own: TransferPanel used to run a
   * second `/turn` probe on mount purely to learn this, which is the
   * composition defect this callback replaces — see client/media/ice.ts's
   * `mediaRtcConfig` doc comment for the "no request while idle" contract
   * that second probe broke.
   */
  onTurnAvailable?(available: boolean): void;
}

/**
 * Owns the session's single live-media slot: who holds it, what happens
 * when both peers grab it in the same instant, and how it comes down.
 *
 * `MediaPeer` is deliberately transport-only — it negotiates one
 * `RTCPeerConnection` and reports what happened, but never decides that the
 * *peer* needs to be told, and never sends a control frame of its own (see
 * its class doc comment). That decision is orchestration, and this class is
 * where it lives: every path that ends a stream this session was sending or
 * receiving funnels through `#release()`, which is the one place that
 * stops local tracks, tells the peer via `media-stop`, and publishes the
 * new (idle) slot. Task 4 built `MediaPeer` with exactly this shape of bug
 * once already — tracks stopped in `close()` and nowhere else, so two other
 * termination paths left the camera light on — and the fix there was the
 * same one applied here: one funnel, not one `close()` call per call site.
 *
 * The seven ways a claimed slot returns to idle, and where each is handled:
 *  - `start()` replacing an already-claimed slot with a new capture
 *  - `stop()`, the local user ending their own share
 *  - the browser's own "Stop sharing" chrome ending a screen capture
 *    (wired up in `start()` via `onStreamEnded`, which calls `stop()`'s
 *    same path)
 *  - an inbound `media-stop` from the peer (`onMediaSignal`)
 *  - the peer disconnecting entirely (`onPeerLeft`)
 *  - a real connection failure (`#makePeerEvents`'s `onClosed`)
 *  - glare, where the polite peer abandons its own outstanding offer
 *    (`onMediaSignal`'s offer branch)
 * All seven end up inside `#release()`, directly or through the identical
 * `#release({ silent: true })` glare uses. None calls `peer.close()` on its
 * own — see `#release()`'s doc comment for why that matters.
 *
 * A negotiation attempt can also fail, or be overtaken, before it ever
 * reaches `#slot` at all — `MediaPeer.offer()`/`answer()` rejecting, or a
 * second attempt (a competing `start()`, an inbound offer that wins glare,
 * an explicit `stop()`) claiming or clearing the slot while the first is
 * still awaiting its own `MediaPeer.offer()`/`answer()` to resolve. Both
 * `start()` and `onMediaSignal()`'s offer branch handle this the same way:
 * capture `#generation` (see its doc comment) right before the await, and
 * check it right after. A rejection has no peer to clean up beyond the
 * captured stream itself (handled inline, in the `catch`). Being overtaken
 * does have one — the `MediaPeer` the losing attempt just finished
 * building — and it is closed directly, right there, without going
 * through `#release()`: that peer was never written to `#slot`, so
 * `#release()` (slot-keyed) has no way to ever find it. These are the only
 * places in this file that stop tracks or close a `MediaPeer` outside
 * `#release()`, and both exist for the identical reason — a moment where a
 * real `MediaPeer`/stream exists but `#slot` does not yet, or no longer,
 * point to it.
 *
 * A related but distinct race lives entirely inside `onMediaSignal()`:
 * the `onMediaSignal` subscriber TransferPanel registers on this class
 * discards this method's own promise (`void live.onMediaSignal(signal)`,
 * client/screens/TransferPanel.tsx) rather than awaiting it, so two calls
 * into `onMediaSignal()` (or one into it and one into `start()`) can
 * genuinely interleave. Each of
 * `onMediaSignal()`'s three `await peer.accept(...)` calls captures the
 * peer it's calling into as a local *before* that await, and re-checks
 * `#slot`'s current peer against it afterward — in the routing branch's
 * catch, in the offering -> sending promotion right after it, and in the
 * answer branch's own catch — because a *different*, already-claimed
 * attempt can legitimately replace `#slot` while any of these is still
 * pending. Without the check, a garbage SDP/candidate on one attempt (Task
 * 1's whitelist checks shape and length, never validity, so a peer can
 * trigger this on purpose) would tear down or mislabel whatever unrelated
 * attempt `#slot` now legitimately holds — the same identity guard
 * `#makePeerEvents` already applies to `onRemoteStream`/`onClosed`, for
 * the same reason.
 */
/**
 * Ceiling on `LiveSession#earlyIce` — candidates buffered before the offer
 * they belong to has arrived. A browser's first wave for one offer runs to a
 * handful per media line, so 64 is headroom over any real trickle, not a
 * limit a camera share should ever reach; same reasoning, and the same
 * threat, as `MAX_PENDING_ICE` in client/media/media-peer.ts.
 */
const MAX_EARLY_ICE = 64;

export class LiveSession {
  #slot: Slot = { state: 'idle' };

  /**
   * WebRTC's perfect-negotiation polite/impolite roles, assigned from the
   * `peerId` the session already has rather than anything new on the wire.
   * `a` is impolite (its offer always wins); `b` is polite (it yields).
   * Both peers compute this identically with no round trip, which is what
   * makes glare resolve in one exchange instead of a negotiation about who
   * negotiates.
   */
  readonly #polite: boolean;
  readonly #events: LiveSessionEvents;

  /**
   * Unsubscribes the `onStreamEnded` listener `start()` registered on our
   * own capture. Only ever set while we hold local tracks (offering or
   * sending); cleared unconditionally by `#release()` so a stale listener
   * never outlives the stream it was watching.
   */
  #unsubStreamEnded: (() => void) | undefined;

  /**
   * Bumped on every change to `#slot` — a successful claim, a transition
   * within one (offering -> sending, a remote stream filling in), or
   * `#release()` being invoked at all, even when it finds nothing to
   * release. `start()` and `onMediaSignal()`'s offer branch each build a
   * `MediaPeer` asynchronously (`MediaPeer.offer()`/`answer()`) before
   * there is anywhere in `#slot` to put it; either can be overtaken while
   * it awaits — a competing `start()`, an inbound offer that wins glare,
   * an explicit `stop()` — and both capture `#generation` right before
   * that await and compare it right after, to tell "nothing happened
   * while I was negotiating" apart from "something did".
   *
   * Checking `#slot.state === 'idle'` after the await, instead of a
   * counter, was the first thing tried, and it is not enough: a `stop()`
   * that arrives while `#slot` is *already* idle (nothing yet to release,
   * because the competing attempt hasn't finished either) still has to
   * invalidate the attempt that's still in flight, and "still idle" can't
   * tell "nothing happened" apart from "the thing that was going to claim
   * it just got told to stop". `#release()` bumping this unconditionally —
   * even on its own no-op path — is what makes that distinguishable.
   */
  #generation = 0;
  /** The stats poll, live only while this device is sending. */
  #statsTimer: ReturnType<typeof setInterval> | undefined;
  /** The running byte total the last reading was taken against — see stats.ts. */
  #statsSample: StatsSample | undefined;

  /**
   * Inbound `media-ice` that arrived before this side had a `MediaPeer` to
   * hand it to. An offerer emits its host candidates within a millisecond
   * of `setLocalDescription` — ahead of, or alongside, the `media-offer`
   * they belong to — while an answerer cannot build its `MediaPeer` until
   * `mediaRtcConfig()` has finished fetching `/turn` (client/media/ice.ts),
   * a full network round trip later. Every candidate that lands in that
   * window used to be dropped on the floor here, because `#slot` was still
   * 'idle'; measured against a 600ms `/turn` response, that was the
   * offerer's entire first wave of candidates. What survived was a
   * connection that had to rediscover the offerer peer-reflexively from its
   * own connectivity checks, which works on a loopback pair and is exactly
   * the kind of thing that stops working across a real network.
   *
   * Buffered here rather than in `MediaPeer` (whose own `#pendingIce`
   * covers the *later* window — a peer exists, but has no remote
   * description yet) because in this one there is no `MediaPeer` in
   * existence to buffer anything. Bounded for the same reason
   * `MAX_PENDING_ICE` is, and against the same peer: a session that is
   * never offered anything must not grow this without limit.
   */
  #earlyIce: MediaControl[] = [];

  constructor(peerId: 'a' | 'b', events: LiveSessionEvents) {
    this.#polite = peerId === 'b';
    this.#events = events;
  }

  /**
   * Starts sharing `kind`, replacing whatever this session currently holds.
   *
   * Capture happens before anything about the existing slot changes: if the
   * user denies the permission prompt (or there's no camera, or the browser
   * doesn't support it), an already-running share must be left alone rather
   * than torn down for a replacement that never arrives. `CaptureError` is
   * the only rejection captureCamera()/captureScreen() ever produce (see
   * capture.ts) — anything else re-throws, since swallowing an unexpected
   * error here would hide a real bug behind a UI that just quietly does
   * nothing.
   */
  async start(kind: MediaKind): Promise<void> {
    let stream: MediaStream;
    try {
      stream = kind === 'camera' ? await captureCamera() : await captureScreen();
    } catch (err) {
      if (!(err instanceof CaptureError)) throw err;
      this.#events.onFailure(err.failure);
      return;
    }

    // One slot: a second Share click (or a switch from camera to screen)
    // replaces whatever this session already holds, stopping its tracks
    // and telling the peer before the new offer goes out.
    this.#release();
    // Captured after #release(), which just bumped it: this attempt's
    // ticket is only invalidated by something that happens *after* this
    // point. See #generation's doc comment for what this guards against.
    const myGeneration = this.#generation;

    // Kept local, not assigned to `this.#unsubStreamEnded`, until
    // MediaPeer.offer() below actually succeeds. Assigning it eagerly
    // would let a rejected offer leave a subscription on `this` that
    // `#release()` never runs to clear (the slot never became non-idle),
    // and — more importantly than the leak — would leave the stream this
    // subscription is watching owned by nobody: not `#slot` (still idle),
    // not `#unsubStreamEnded`'s bookkeeping. `unsub` living in a local
    // until success is what keeps that ownership unambiguous.
    const unsub = onStreamEnded(stream, () => this.stop());

    let peer: MediaPeer;
    const peerEvents = this.#makePeerEvents(() => peer);
    try {
      peer = await MediaPeer.offer(stream, kind, peerEvents);
    } catch {
      /*
       * MediaPeer.offer() failing — mediaRtcConfig(), createOffer(), or
       * setLocalDescription() are all reachable here — leaves a real,
       * already-captured MediaStream that nothing else in this class
       * knows about: the slot never left 'idle', so #release() (which is
       * slot-keyed) has nothing to find and would silently no-op on it.
       * Stopping the tracks directly, right here, is the one path in this
       * file that does that instead of going through #release() — because
       * this is the one moment a stream exists that #release() cannot see.
       */
      // Order matches #release(): unsubscribe before stopping tracks. It
      // doesn't matter today — track.stop() doesn't fire 'ended'
      // (capture.ts) — but a mismatched order here is exactly the kind of
      // inconsistency this file has spent three review rounds closing.
      unsub();
      stream.getTracks().forEach((track) => track.stop());
      this.#events.onFailure({ reason: 'connect-failed' });
      return;
    }

    if (this.#generation !== myGeneration) {
      /*
       * Overtaken while MediaPeer.offer() was negotiating: something else
       * — a competing start(), an inbound offer that won glare, an
       * explicit stop() — already claimed or cleared #slot. This is not a
       * failure; it's the identical outcome the synchronous glare-yield
       * branch below reaches for a fully-formed offer, just for one that
       * hadn't finished being built yet, so no onFailure. peer.close()
       * stops stream's tracks for us (MediaPeer's own #reportClosed) —
       * this isn't a second place that stops them by hand, only a second
       * *moment* where they need to be.
       */
      unsub();
      peer.close();
      return;
    }

    this.#unsubStreamEnded = unsub;
    this.#setSlot({ state: 'offering', kind, peer, stream });
    this.#events.onSlotChanged(this.#slot);
    // Not awaited: `countCameras()` is a real async call, and the preview
    // must appear the instant capture succeeds rather than a device
    // enumeration later. The controls fill in a beat afterwards, through a
    // second onSlotChanged.
    // Caught, not merely fired: an unhandled rejection from a
    // fire-and-forget is a process-level event, and nothing here is worth
    // one. The only consequence of a failure is that the camera controls do
    // not appear — the same outcome as hardware that cannot do them.
    void this.#refreshCamera().catch(() => undefined);
    this.#startStats();
    // Screen shares open on a preset rather than on whatever the encoder
    // would have guessed. See share-quality.ts for why 'text' is the
    // default and why these presets steer rather than override.
    if (kind === 'screen') void this.setSharePreset(DEFAULT_SHARE_PRESET);
  }

  /**
   * Chooses what the screen share protects when the network tightens.
   *
   * This does not manage bandwidth and is not trying to: WebRTC's own
   * congestion control already does that, continuously, from measurements
   * this code has no better version of. What it sets is the policy that
   * loop follows — whether to hold resolution or frame rate — plus, for
   * 'data', a ceiling the user has explicitly asked for. See
   * share-quality.ts.
   */
  async setSharePreset(preset: SharePreset): Promise<void> {
    const slot = this.#slot;
    if (slot.state !== 'offering' && slot.state !== 'sending') return;
    if (slot.kind !== 'screen') return;

    try {
      await slot.peer.applyVideoQuality(SHARE_QUALITY[preset]);
    } catch (err) {
      // Worth saying: a preset that silently did not apply leaves a
      // selected-looking button and a stream still behaving the old way.
      this.#events.onFailure({ reason: 'failed', detail: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Re-read rather than reusing `slot`: applyVideoQuality awaits, and the
    // share can have been replaced or stopped in the meantime.
    const current = this.#currentSlot();
    if (current.state !== 'offering' && current.state !== 'sending') return;
    if (current.kind !== 'screen') return;
    this.#setSlot({ ...current, preset });
    this.#events.onSlotChanged(this.#slot);
  }

  /**
   * Points the camera the other way, without renegotiating anything.
   *
   * A new video track replaces the old one inside the existing sender
   * (`MediaPeer.replaceVideoTrack`), so the peer's video never stops — it
   * simply shows a different view on the next frame. Restarting the share
   * instead would flash the receiver's picture away and back, and would
   * have to win a glare race against whatever the peer was doing.
   *
   * A no-op unless this device is currently sharing a camera it has
   * somewhere to flip to, so a caller need not check first.
   */
  async flipCamera(): Promise<void> {
    const slot = this.#slot;
    if (slot.state !== 'offering' && slot.state !== 'sending') return;
    if (slot.kind !== 'camera' || !slot.camera?.canFlip || slot.camera.busy) return;

    // The requested facing, not the reported one, is what flips: hardware
    // that reports no facingMode at all would otherwise never leave
    // 'environment'. Defaulting an unknown current facing to 'user' makes
    // the first flip ask for the rear camera, which is the one people reach
    // for the toggle to get.
    const next: Facing = slot.camera.facing === 'environment' ? 'user' : 'environment';
    this.#updateCamera({ busy: true });
    // Captured after the busy update, which bumped it — this attempt is
    // only invalidated by something that happens after this point. Same
    // ticket discipline as start(); see #generation's doc comment.
    const myGeneration = this.#generation;

    let replacement: MediaStream;
    try {
      replacement = await captureCameraVideo(next);
    } catch (err) {
      if (!(err instanceof CaptureError)) throw err;
      this.#updateCamera({ busy: false });
      this.#events.onFailure(err.failure);
      return;
    }

    const fresh = replacement.getVideoTracks()[0];
    // Overtaken while the camera was opening — a stop(), a competing
    // start(), an inbound offer that won glare. The new track belongs to
    // nobody, so it is stopped here rather than left running with its
    // recording indicator lit.
    if (this.#generation !== myGeneration || !fresh) {
      replacement.getTracks().forEach((track) => track.stop());
      return;
    }

    const previous = slot.stream.getVideoTracks()[0];
    try {
      await slot.peer.replaceVideoTrack(fresh);
    } catch (err) {
      fresh.stop();
      this.#updateCamera({ busy: false });
      this.#events.onFailure({ reason: 'failed', detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Stopped only once the swap has actually landed: stopping it earlier
    // blacks out the outgoing video on some browsers for the width of the
    // replaceTrack call.
    previous?.stop();

    // The ended-listener start() registered was on the track just stopped.
    // Without re-subscribing, a camera revoked or unplugged after a flip
    // would leave this device claiming to share a stream nothing feeds.
    this.#unsubStreamEnded?.();
    this.#unsubStreamEnded = onStreamEnded(slot.stream, () => this.stop());

    await this.#refreshCamera(next);
  }

  /**
   * Turns the camera's lamp on or off.
   *
   * A live constraint on the existing track, not a recapture: the lamp is a
   * setting of the camera that is already open, and reopening it to change
   * one setting would drop the frame the user is pointing it at.
   */
  async setTorch(on: boolean): Promise<void> {
    const slot = this.#slot;
    if (slot.state !== 'offering' && slot.state !== 'sending') return;
    if (!slot.camera?.canTorch) return;
    const track = slot.stream.getVideoTracks()[0];
    if (!track) return;

    try {
      await applyTorch(track, on);
    } catch (err) {
      // Worth saying out loud. A lamp that silently refused to light leaves
      // a button that looks like it worked and a photo nobody can see.
      this.#events.onFailure({ reason: 'failed', detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.#updateCamera({ torchOn: on });
  }

  /** Ends whatever this session is currently sending or receiving. */
  stop(): void {
    this.#release();
  }

  /**
   * The peer disconnected from the session entirely (not a `media-stop` —
   * that has its own handling below). Whatever we were sending or
   * receiving cannot continue either way, so it releases the same as a
   * local `stop()`.
   */
  onPeerLeft(): void {
    this.#release();
  }

  /**
   * Feeds one already-whitelisted `media-*` control frame in. Not a
   * parser: Task 2's Receiver is the only place a peer-supplied media
   * signal is validated (see `MediaControl`'s doc comment in
   * shared/messages.ts) — one trust boundary, not two.
   */
  async onMediaSignal(signal: MediaControl): Promise<void> {
    if (signal.t === 'media-stop') {
      /*
       * The peer is telling us their side of the exchange has ended.
       * Release without echoing media-stop back: MediaPeer never sends
       * this frame itself (see its class doc comment), so the only source
       * of a reply here would be this very handler — echo it and the two
       * peers bounce "I stopped" back and forth forever.
       */
      this.#release({ silent: true });
      return;
    }

    if (signal.t !== 'media-offer') {
      // media-answer / media-ice: meaningful only if we currently hold a
      // peer connection to hand it to — except that a candidate arriving
      // before the offer it belongs to is ordinary trickle ICE, not a
      // stray, so it waits in `#earlyIce` for the peer the offer is about
      // to build. An answer has no such second life: without a peer there
      // is nothing it could ever be applied to.
      if (this.#slot.state === 'idle') {
        if (signal.t === 'media-ice' && this.#earlyIce.length < MAX_EARLY_ICE) this.#earlyIce.push(signal);
        return;
      }
      // Captured before the await, not read back off `this.#slot`
      // afterward: `onMediaSignal`'s own caller discards its promise
      // rather than awaiting it (client/screens/TransferPanel.tsx), so a
      // second, unrelated signal can run its own #release()/claim while
      // this `accept()` is
      // still pending and leave `#slot` pointing at a completely
      // different attempt by the time this one resolves or rejects. Every
      // use of `this.#slot` below is re-checked against this identity —
      // the same guard `#makePeerEvents` already applies to
      // `onRemoteStream`/`onClosed`, for the identical reason.
      const thatPeer = this.#slot.peer;
      try {
        await thatPeer.accept(signal);
      } catch {
        // Reachable only for a `media-answer` in practice: Task 1's
        // whitelist checks shape and length, never SDP validity
        // (shared/media-signal.ts's own doc comment), so a peer can send
        // a syntactically-fine but unusable answer and setRemoteDescription
        // rejects. `media-ice` cannot land here — MediaPeer.accept()
        // swallows an addIceCandidate rejection itself
        // (#addIceCandidateIgnoringFailure in media-peer.ts), because a
        // single stale candidate rejecting is expected and non-fatal (see
        // that method's doc comment), not the negotiation failing.
        //
        // Only release if `thatPeer` is still what #slot holds. Without
        // this check, a slow, doomed answer on *this* attempt could
        // reject after a different, legitimately-claimed attempt has
        // since taken the slot — tearing down a share that was never
        // actually broken, and blaming its peer for it.
        // #currentSlot(), not `this.#slot` directly: TS keeps the
        // narrowed (non-idle) type it inferred from the `if (idle) return`
        // above across this await, which is stale — #release()/#setSlot()
        // can reassign the real field while this await is pending — and a
        // direct re-read would compare against a type TS (wrongly) still
        // thinks excludes 'idle'.
        const current = this.#currentSlot();
        if (current.state !== 'idle' && current.peer === thatPeer) {
          this.#release();
          this.#events.onFailure({ reason: 'connect-failed' });
        }
        return;
      }
      // The offerer learns its offer was accepted right here: MediaPeer
      // has no separate "negotiated" event, and this is the one place
      // that already knows both "we were offering" and "an answer just
      // arrived", so promoting offering -> sending belongs here rather
      // than as a new callback MediaPeer would have to add just for this.
      // Gated on the same identity check as the catch above: without it,
      // a slow answer resolving after #slot moved on to a different,
      // still-'offering' attempt would promote *that* attempt to
      // 'sending' — claiming it negotiated when it never received an
      // answer at all.
      {
        const current = this.#currentSlot();
        if (signal.t === 'media-answer' && current.state === 'offering' && current.peer === thatPeer) {
          // `camera` carried across, not dropped: the two states show the
          // identical preview off the identical stream (LiveSection's
          // `Sharing`), so losing it here would make the camera controls
          // blink out at the exact moment the peer accepted.
          this.#setSlot({
            state: 'sending',
            kind: current.kind,
            peer: current.peer,
            stream: current.stream,
            camera: current.camera,
            preset: current.preset,
          });
          this.#events.onSlotChanged(this.#slot);
        }
      }
      return;
    }

    // signal.t === 'media-offer' from here down.
    if (this.#slot.state === 'offering') {
      /*
       * Glare: both peers claimed the slot in the same instant.
       *
       * The impolite peer ignores the incoming offer outright and lets its
       * own complete — the polite peer is, at this same moment, doing the
       * opposite. Answering here instead would leave both sides receiving
       * and neither sending, which is worse than either peer's outcome on
       * its own: no exchange at all instead of one.
       */
      if (!this.#polite) return;

      /*
       * The polite peer yields: `#release({ silent: true })` stops our
       * local tracks — the part that matters beyond protocol correctness,
       * since we asked for the camera moments ago and are no longer going
       * to use it — without telling the peer. `silent` here isn't "no one
       * needs to know", it's "no one *can* know yet": our offer never
       * reached a MediaPeer on their side (they were mid-offer themselves,
       * not answering), so there is nothing there to tell. Sending
       * media-stop anyway would land in the impolite peer's own
       * `LiveSession`, arrive while its 'offering' slot is this exact
       * exchange, and look indistinguishable from us asking to cancel the
       * offer that is about to win — undoing the very thing glare
       * resolution exists to do cleanly.
       */
      this.#release({ silent: true });
    } else if (this.#slot.state !== 'idle') {
      // Not glare: an exchange we already own (sending or receiving) is
      // being replaced by a fresh offer from the peer. Tell them theirs
      // ended before answering the new one, same as start() does locally.
      this.#release();
    }
    // Captured right before the async part begins — see #generation's doc
    // comment, and start()'s identical use of it for the general shape of
    // the race this guards against.
    const myGeneration = this.#generation;

    let peer: MediaPeer;
    const peerEvents = this.#makePeerEvents(() => peer);
    try {
      peer = await MediaPeer.answer(peerEvents);
    } catch {
      // Nothing was captured on this side (an answerer owns no local
      // tracks until accept() adds recvonly transceivers), so there is no
      // stream to stop here the way start()'s catch has to — only the
      // failure to report.
      this.#events.onFailure({ reason: 'connect-failed' });
      return;
    }

    if (this.#generation !== myGeneration) {
      // Overtaken while MediaPeer.answer() was under construction — see
      // start()'s identical check. An answerer owns no local tracks yet
      // (accept() hasn't run), so close() here is tearing down an
      // RTCPeerConnection nobody will ever use rather than releasing a
      // camera, but it's still real cleanup this #slot can no longer do
      // on our behalf, since it was never written there.
      peer.close();
      return;
    }

    this.#setSlot({ state: 'receiving', kind: signal.offer.kind, peer });
    this.#events.onSlotChanged(this.#slot);
    // Ahead of the offer, deliberately: `MediaPeer.accept()` holds a
    // candidate that has no remote description yet in its own `#pendingIce`
    // and flushes it the moment `accept(signal)` below sets one — so
    // replaying them in arrival order here needs no ordering logic of its
    // own. Cleared whether or not that accept succeeds; these candidates
    // belong to this offer and nothing later.
    const early = this.#earlyIce;
    this.#earlyIce = [];
    for (const ice of early) void peer.accept(ice);
    try {
      await peer.accept(signal);
    } catch {
      // The offer we just tried to answer turned out to be unusable
      // (garbage SDP past Task 1's shape/length whitelist — see the
      // matching catch above). #release() tells the peer we gave up
      // rather than leaving them waiting on an answer that is never
      // coming.
      //
      // Guarded the same way as the routing branch above: `peer` was
      // written to `#slot` just before this await, but `onMediaSignal` is
      // dispatched fire-and-forget per signal, so a different, unrelated
      // signal can still run its own #release()/claim while this
      // `accept()` is pending. Only release if `peer` is still what
      // `#slot` holds — otherwise this rejection would tear down whatever
      // legitimately-claimed attempt has since taken its place.
      if (this.#slot.state !== 'idle' && this.#slot.peer === peer) {
        this.#release();
        this.#events.onFailure({ reason: 'connect-failed' });
      }
    }
  }

  /**
   * Every exit from a claimed slot funnels here — see the class doc
   * comment for the full list of callers this exists to unify. Always in
   * this order:
   *
   * 1. Drop the `onStreamEnded` subscription, if any: once we're the one
   *    tearing the share down, the browser telling us the track ended is
   *    no longer news.
   * 2. `peer.close()`. This is where the privacy-critical work actually
   *    happens — see `MediaPeer#reportClosed`'s doc comment — and this
   *    method exists only to make sure every path reaches it exactly
   *    once, never to duplicate what it already does.
   * 3. Tell the peer, unless `silent`. The two `silent: true` callers
   *    (glare's yield branch, and an inbound `media-stop`) each have their
   *    own doc comment explaining why that specific path has nothing
   *    honest to say — see `onMediaSignal` for both.
   *
   * Steps 1-3 are a no-op when the slot is already idle, which is what
   * makes it safe to call from `#makePeerEvents`'s `onClosed`: a
   * connection this class closed itself (any of the paths above) has
   * already idled the slot by the time `MediaPeer`'s deferred `onClosed`
   * callback runs, so that second call does nothing beyond the
   * `#generation` bump below.
   *
   * That bump happens unconditionally, before the idle check, and is not
   * skipped on the no-op path — see `#generation`'s doc comment for why:
   * a `stop()`/`onPeerLeft()`/inbound `media-stop` arriving while the slot
   * is *already* idle (because a competing claim is still mid-negotiation)
   * still has to invalidate that claim once it finishes, and it has
   * nothing else to observe that would tell it to.
   */
  #release(opts: { silent?: boolean } = {}): void {
    this.#generation++;
    // Before the idle early-return: a timer outlives the slot it was
    // started for otherwise, and would go on polling a closed connection
    // for the life of the page.
    this.#stopStats();
    if (this.#slot.state === 'idle') return;
    this.#unsubStreamEnded?.();
    this.#unsubStreamEnded = undefined;
    this.#slot.peer.close();
    this.#slot = { state: 'idle' };
    if (!opts.silent) this.#events.onSignal({ t: 'media-stop' });
    this.#events.onSlotChanged(this.#slot);
  }

  /** How often to read the outgoing stream's numbers while sending. */
  static readonly STATS_INTERVAL_MS = 2_000;

  /**
   * Begins reporting what the outgoing stream is doing.
   *
   * Reporting only — nothing read here is fed back into the encoder. See
   * share-quality.ts for why this app steers WebRTC's congestion control
   * instead of running a second loop against the same measurements.
   */
  #startStats(): void {
    this.#stopStats();
    this.#statsTimer = setInterval(() => {
      void this.#pollStats().catch(() => undefined);
    }, LiveSession.STATS_INTERVAL_MS);
  }

  #stopStats(): void {
    if (this.#statsTimer === undefined) return;
    clearInterval(this.#statsTimer);
    this.#statsTimer = undefined;
    this.#statsSample = undefined;
    // Cleared explicitly, so a stopped share does not leave its last
    // reading on screen looking live.
    this.#events.onStats?.(undefined);
  }

  async #pollStats(): Promise<void> {
    const slot = this.#currentSlot();
    if (slot.state !== 'offering' && slot.state !== 'sending') return;

    const report = await slot.peer.getStats();
    // The share can end while getStats is in flight; publishing then would
    // put a reading back on screen after #stopStats cleared it.
    if (this.#currentSlot().state === 'idle') return;

    const { stats, sample } = readShareStats(report, this.#statsSample);
    this.#statsSample = sample;
    this.#events.onStats?.(stats);
  }

  /**
   * Rebuilds the camera state from whatever track is live right now, and
   * republishes the slot.
   *
   * Everything here is re-derived rather than carried forward, because a
   * flip changes all of it: a different camera reports a different
   * facingMode, has or has not got a lamp, and — whatever the lamp was
   * doing a moment ago — comes up with it off. `requested` covers the
   * hardware that declines to report a facingMode at all, where the only
   * thing anyone knows about which way it points is which way it was asked
   * to point.
   */
  async #refreshCamera(requested?: Facing): Promise<void> {
    const before = this.#generation;
    const cameras = await countCameras();
    const slot = this.#currentSlot();
    // The share ended, or was replaced, while the device list was being
    // enumerated. Publishing now would resurrect a slot that is gone.
    if (this.#generation !== before) return;
    if (slot.state !== 'offering' && slot.state !== 'sending') return;
    if (slot.kind !== 'camera') return;

    const track = slot.stream.getVideoTracks()[0];
    this.#setSlot({
      ...slot,
      camera: {
        facing: facingOf(track) ?? requested,
        canFlip: cameras > 1,
        canTorch: hasTorch(track),
        torchOn: false,
        busy: false,
      },
    });
    this.#events.onSlotChanged(this.#slot);
  }

  /**
   * Publishes a change to part of the camera state, leaving the rest of the
   * slot as it stands. A new object every time, never a mutation: the UI
   * holds the slot in React state and compares by identity, so a mutated
   * one would change nothing on screen.
   */
  #updateCamera(change: Partial<CameraState>): void {
    const slot = this.#currentSlot();
    if (slot.state !== 'offering' && slot.state !== 'sending') return;
    if (!slot.camera) return;
    this.#setSlot({ ...slot, camera: { ...slot.camera, ...change } });
    this.#events.onSlotChanged(this.#slot);
  }

  /** Every write to `#slot` that represents a real change — a new claim, or
   * a transition/update within one already held — goes through here, so
   * `#generation` always reflects "has anything about the slot changed"
   * without each call site needing to remember to bump it itself. */
  #setSlot(slot: Slot): void {
    this.#slot = slot;
    this.#generation++;
  }

  /**
   * A plain re-read of `#slot` through a method call, used where a caller
   * needs its *current* type rather than whatever TypeScript narrowed it
   * to before an intervening `await`. `#release()`/`#setSlot()` can
   * reassign the field while such an await is pending, but TS has no way
   * to know that from a bare `this.#slot` read — a method call gives it a
   * fresh return type to work from instead.
   */
  #currentSlot(): Slot {
    return this.#slot;
  }

  /**
   * Builds the `MediaPeerEvents` handed to a freshly-created `MediaPeer`,
   * whether offerer or answerer.
   *
   * `getPeer` is a thunk rather than the peer itself: `MediaPeer.offer()`/
   * `answer()` need a complete events object *before* they resolve with
   * the peer they build, so the peer this closure needs doesn't exist yet
   * at the point these callbacks are constructed. By the time any of them
   * can actually fire — a signal to relay, a remote track, a terminal
   * connection state — the `peer` variable the caller's thunk closes over
   * has long since been assigned; `let peer: MediaPeer` followed by
   * `peer = await MediaPeer.offer(...)` is exactly that pattern at each
   * call site.
   */
  #makePeerEvents(getPeer: () => MediaPeer): MediaPeerEvents {
    return {
      onSignal: (signal) => this.#events.onSignal(signal),

      // Fires before `getPeer()` has anything to return — offer()/answer()
      // call this the instant mediaRtcConfig() resolves, still ahead of
      // `new MediaPeer(...)` — but it needs no slot-identity guard the way
      // onRemoteStream/onClosed below do: whether this deployment has TURN
      // is a fact about the deployment, not about which attempt asked, so
      // there is nothing here for a stale/overtaken attempt to get wrong.
      onIceConfig: (config) => this.#events.onTurnAvailable?.(hasTurnServer(config)),

      onRemoteStream: (stream) => {
        // Guards a stale MediaPeer's event landing after this slot has
        // moved on to something else (a replace, a release) — same
        // identity check as onClosed below, and the same reason.
        if (this.#slot.state === 'receiving' && this.#slot.peer === getPeer()) {
          this.#setSlot({ ...this.#slot, stream });
          this.#events.onSlotChanged(this.#slot);
        }
      },

      onClosed: () => {
        /*
         * The only way this fires while the slot is still live is a
         * genuine connection failure — MediaPeer's connectionstatechange
         * handler reporting failed/closed/disconnected (see its class doc
         * comment). Every other reason MediaPeer closes is something this
         * class caused itself via #release(), which already idled the
         * slot *before* MediaPeer's deferred onClosed microtask runs — so
         * the guard below turns those into a no-op instead of a second
         * release, and this branch only ever runs for the failure case.
         */
        if (this.#slot.state === 'idle' || this.#slot.peer !== getPeer()) return;
        this.#release();
        this.#events.onFailure({ reason: 'connect-failed' });
      },
    };
  }
}

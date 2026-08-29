import type { MediaControl } from '../../shared/messages.js';
import type { MediaKind } from '../../shared/media-signal.js';
import { mediaRtcConfig } from './ice.js';
import type { ShareQuality } from './share-quality.js';

/**
 * Ceiling on buffered ICE candidates from a peer that trickles candidates
 * but never completes negotiation — broken, or a hostile peer deliberately
 * withholding an offer/answer while flooding candidates to grow
 * `#pendingIce` without bound for the life of the connection. Same
 * reasoning as `MAX_SDP_CHARS` in shared/media-signal.ts, applied to
 * candidate *count* instead of one string's length: a real trickle for one
 * offer/answer runs to a handful of candidates per media line (a browser
 * rarely gathers more than a few dozen host/srflx/relay candidates total),
 * so 256 is generous headroom above any real session, not a ceiling anyone
 * sharing a camera or screen should ever brush up against.
 */
const MAX_PENDING_ICE = 256;

/**
 * The seam `MediaPeer` is built on, so its negotiation logic is testable
 * without a browser (see tests/unit/media-peer.test.ts) — matching the
 * house pattern in client/transport/webrtc.ts, which is driven the same
 * way through a plain `signal` callback rather than an EventEmitter.
 *
 * `onSignal` is "to seal and send": `MediaPeer` produces the four
 * `media-*` frames (shared/messages.ts) but never seals or transmits one
 * itself — that's Task 5's `LiveSession`, via `Session.sendMediaSignal`.
 * Kept as a plain callback, not a `Session` reference, for the same reason
 * `WebRTCTransport` never imports `Session`: this class has no business
 * knowing how its output reaches the wire.
 */
export interface MediaPeerEvents {
  onSignal(signal: MediaControl): void;
  onRemoteStream(stream: MediaStream): void;
  onClosed(reason: string): void;
  /**
   * Fired once, from `offer()`/`answer()`, with the `RTCConfiguration`
   * `mediaRtcConfig()` just resolved — before it's handed to
   * `new RTCPeerConnection`. Optional and easy to ignore, but it's the
   * only place this config is ever visible outside this file, and it
   * exists so `LiveSession` can tell whether the deployment has TURN
   * without fetching `/turn` a second time (see client/media/ice.ts's
   * `hasTurnServer`, and TransferPanel's `onTurnAvailable` wiring). A
   * second, mount-time probe used to exist for exactly this and violated
   * the "no request while idle" contract `mediaRtcConfig`'s own doc
   * comment describes — this callback is what let that probe go away.
   */
  onIceConfig?(config: RTCConfiguration): void;
}

/**
 * A second, media-only peer connection: one camera or screen stream,
 * carried on tracks, with no data channel. Deliberately not built on
 * `client/transport/webrtc.ts`'s `WebRTCTransport` or
 * `client/worker/peer-host.ts`: those exist to hand an `UpgradeTransport`
 * to the Web Worker that owns the file-transfer path, and media bytes must
 * never cross into that worker (Global Constraints, plan 04) — decoding a
 * remote `MediaStream` only makes sense on the page that can hand it to a
 * `<video>` element. `MediaPeer` is a separate, simpler class that owns
 * exactly one `RTCPeerConnection` and nothing else: no reconnection, no
 * transport-swap logic, no relay fallback. A live-media failure closes this
 * one connection and reports why; it is never routed through
 * `session.error`, which exists for the transfer path this class doesn't
 * touch.
 *
 * One-way by construction (spec plan 04 §3): the offerer's transceivers
 * are explicitly `sendonly` and the answerer's explicitly `recvonly`. A
 * `sendrecv` default — which is what `addTrack`/an unmodified inbound
 * offer would otherwise negotiate — would quietly ask the browser to also
 * negotiate a return stream that nothing in this feature sends and no UI
 * shows, wasting a getUserMedia prompt's worth of confusion the first time
 * an answerer's browser tries to honour it.
 */
export class MediaPeer {
  readonly #pc: RTCPeerConnection;
  readonly #events: MediaPeerEvents;
  /**
   * Set only for an offerer (the stream `offer()` was given); left
   * undefined for an answerer, which never owns local tracks of its own.
   * Held onto for exactly one reason: so `close()` has something to call
   * `stop()` on.
   */
  readonly #localStream: MediaStream | undefined;
  /**
   * An inbound ICE candidate can legally arrive before its offer/answer
   * does — the two travel as separate sealed control frames (Task 2's
   * Receiver), so nothing here guarantees delivery order the way a single
   * SDP blob would. Two ways to cope: rely on the browser's own queue (the
   * WebRTC 1.0 spec has `addIceCandidate` wait for a remote description
   * before applying), or buffer here and flush once one is set.
   *
   * This class buffers itself. Not every browser this app has to support
   * implements the spec's built-in wait (older Safari raised
   * InvalidStateError instead of queueing), so depending on it would make
   * "does an early candidate throw" a fact about the user's browser rather
   * than about this code. Buffering here is also the only way to prove the
   * behaviour in a unit test at all: a fake `RTCPeerConnection` (Node has
   * no real one) does not, and should not, reimplement a browser's queueing
   * semantics just so this file's own logic can be tested against it.
   */
  #pendingIce: RTCIceCandidateInit[] = [];
  /**
   * Guards `onClosed`, whose contract is "exactly once, whichever path
   * gets there first". `close()`, an ICE/connection failure, and an
   * inbound `media-stop` all call `#reportClosed`; only the first call
   * through this flag ever reaches the caller's callback. Mirrors
   * WebRTCTransport's `#closed`/`#reportClose` in client/transport/webrtc.ts
   * — same problem (several independent event sources can each think they
   * are the one delivering the news), same fix.
   */
  #closed = false;

  private constructor(pc: RTCPeerConnection, events: MediaPeerEvents, localStream?: MediaStream) {
    this.#pc = pc;
    this.#events = events;
    this.#localStream = localStream;

    this.#pc.addEventListener('icecandidate', (event) => {
      // A null candidate is the end-of-candidates marker, not a real one —
      // there is nothing to trickle to the peer, matching WebRTCTransport's
      // own icecandidate handler.
      if (!event.candidate) return;
      this.#events.onSignal({
        t: 'media-ice',
        ice: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid ?? undefined,
          sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
          // Lets a receiver that has since moved its remote description on
          // to a newer negotiation (see shared/media-signal.ts's doc
          // comment on this field) recognise a candidate from this one as
          // stale, rather than misapplying it. Per webrtc-pc the browser
          // does this by *rejecting* addIceCandidate for a mismatched
          // ufrag, not by silently ignoring it — see accept()'s media-ice
          // case below for why that rejection is swallowed, not fatal.
          usernameFragment: event.candidate.usernameFragment ?? undefined,
        },
      });
    });

    // Only ever fires on the answerer (a `sendonly` remote transceiver has
    // nothing to send back), but wiring it unconditionally costs nothing
    // and keeps the offer/answer construction paths symmetric.
    this.#pc.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (stream) this.#events.onRemoteStream(stream);
    });

    this.#pc.addEventListener('connectionstatechange', () => {
      const state = this.#pc.connectionState;
      // Matches WebRTCTransport's terminal set exactly: 'failed' is ICE
      // giving up and 'closed' is the connection tearing down through some
      // path other than this class's own close() (e.g. the underlying
      // browser object being GC'd or torn down by the page).
      //
      // 'disconnected' is NOT terminal, here or on the data path. It is the
      // recoverable state — checks have stopped answering, ICE has not given
      // up — and a TURN-relayed stream between two networks passes through
      // it on any burst of loss. Treating it as terminal is what made a real
      // screen share (2026-08-29) "drop on its own after a few seconds": the
      // browser would have healed the blip, and this ended the share instead.
      // A stream has no reconnection logic of its own, which is an argument
      // for letting ICE finish recovering, not for pre-empting it.
      if (state === 'failed' || state === 'closed') {
        this.#reportClosed(`peer connection ${state}`);
      }
    });
  }

  /**
   * Starts the offerer side: builds the connection, adds every track from
   * `stream` as an explicitly `sendonly` transceiver, and emits the
   * resulting `media-offer` (carrying `kind` so the answerer's UI can label
   * what it's about to receive before the first frame decodes).
   *
   * `addTransceiver(track, { direction: 'sendonly' })` is used instead of
   * the more familiar `addTrack` deliberately: `addTrack` lets the browser
   * pick the transceiver's direction, which defaults to `sendrecv` — the
   * exact outcome the class-level doc comment explains this project does
   * not want.
   */
  static async offer(stream: MediaStream, kind: MediaKind, events: MediaPeerEvents): Promise<MediaPeer> {
    const config = await mediaRtcConfig();
    events.onIceConfig?.(config);
    const pc = new RTCPeerConnection(config);
    // Everything from here down can throw — addTransceiver, createOffer,
    // setLocalDescription — and unlike the camera (stopped directly by
    // start()'s own catch in live-session.ts, since a rejected offer()
    // never reaches #slot for #release() to find), nothing else owns
    // `pc`. Left open, it would keep gathering ICE — and can hold a TURN
    // allocation on the server — for a connection nobody will ever use.
    try {
      const peer = new MediaPeer(pc, events, stream);

      for (const track of stream.getTracks()) {
        pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // A real createOffer()/setLocalDescription() always yields a populated
      // sdp string; the `?? ''` only guards the type (RTCSessionDescriptionInit
      // marks it optional) rather than a case this code expects to hit.
      events.onSignal({ t: 'media-offer', offer: { sdp: offer.sdp ?? '', kind } });
      return peer;
    } catch (err) {
      pc.close();
      throw err;
    }
  }

  /**
   * Starts the answerer side. Builds the bare connection and stops there —
   * unlike `offer()`, there is no local stream yet to add tracks from,
   * and no answer to send until the offerer's `media-offer` arrives
   * through `accept()`.
   */
  static async answer(events: MediaPeerEvents): Promise<MediaPeer> {
    const config = await mediaRtcConfig();
    events.onIceConfig?.(config);
    const pc = new RTCPeerConnection(config);
    return new MediaPeer(pc, events);
  }

  /**
   * Feeds one already-validated `media-*` control frame to this
   * connection. Not a parser: Task 2's Receiver (client/transfer/receiver.ts)
   * is the only place a peer-supplied media signal is whitelisted, and
   * `signal` here is trusted exactly as much as `MediaControl`'s own type
   * promises — one trust boundary, not two, so this file has nothing left
   * to validate.
   */
  async accept(signal: MediaControl): Promise<void> {
    switch (signal.t) {
      case 'media-offer': {
        await this.#pc.setRemoteDescription({ type: 'offer', sdp: signal.offer.sdp });
        // Explicit, not relied-upon: JSEP has a newly-created transceiver
        // default to the mirror of what the offer proposed (sendonly here
        // becomes recvonly), but that default lives in browser behaviour
        // this file cannot see or test. Setting it here makes the
        // direction this class's own decision, provable without a real
        // browser, and inert (a no-op) wherever the browser already agrees.
        for (const transceiver of this.#pc.getTransceivers()) transceiver.direction = 'recvonly';
        await this.#flushPendingIce();
        const answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(answer);
        this.#events.onSignal({ t: 'media-answer', answer: { sdp: answer.sdp ?? '' } });
        return;
      }
      case 'media-answer':
        await this.#pc.setRemoteDescription({ type: 'answer', sdp: signal.answer.sdp });
        await this.#flushPendingIce();
        return;
      case 'media-ice': {
        const candidate: RTCIceCandidateInit = {
          candidate: signal.ice.candidate,
          sdpMid: signal.ice.sdpMid,
          sdpMLineIndex: signal.ice.sdpMLineIndex,
          // Handing this through, rather than the parser stripping it, is
          // what lets the browser itself recognise a candidate that
          // belonged to a negotiation attempt we've since moved past —
          // see shared/media-signal.ts's doc comment on MediaIce. Per
          // webrtc-pc the browser does that by *rejecting* addIceCandidate
          // (OperationError) on a mismatched ufrag, not by ignoring it —
          // #addIceCandidateIgnoringFailure below is what makes that
          // rejection the safe, expected outcome it's supposed to be
          // instead of a connection-ending error.
          usernameFragment: signal.ice.usernameFragment,
        };
        // See #pendingIce's doc comment for why this buffers rather than
        // trusting the browser to queue it.
        if (this.#pc.remoteDescription) {
          await this.#addIceCandidateIgnoringFailure(candidate);
        } else if (this.#pendingIce.length < MAX_PENDING_ICE) {
          this.#pendingIce.push(candidate);
        }
        // else: silently dropped — see MAX_PENDING_ICE's doc comment. A
        // peer past this many un-negotiated candidates is not going to be
        // fixed by holding one more.
        return;
      }
      case 'media-stop':
        this.#reportClosed('remote stopped sharing');
        return;
    }
  }

  /**
   * Tears the connection down from this side. All the actual privacy-
   * critical work — stopping local tracks — lives in `#reportClosed`, not
   * here: see that method's doc comment for why every termination path
   * has to go through it rather than each closing the browser object in
   * its own way.
   */
  /**
   * Applies a quality preset to the outgoing video.
   *
   * `degradationPreference` and the encoding caps live on the SENDER, and
   * `contentHint` on the track, so this is the one place that touches both.
   * None of it renegotiates: every field here is a local encoder setting,
   * invisible to the SDP the two sides already agreed.
   *
   * `setParameters` must be handed the object `getParameters` just returned,
   * mutated — the spec requires the transaction id to match, and a
   * hand-built RTCRtpSendParameters is rejected. A sender with no encodings
   * yet (before the first frame on some browsers) is left alone rather than
   * given one, since inventing an encoding entry changes what is negotiated.
   */
  async applyVideoQuality(quality: ShareQuality): Promise<void> {
    const sender = this.#pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    if (sender.track) sender.track.contentHint = quality.contentHint;

    const parameters = sender.getParameters();
    parameters.degradationPreference = quality.degradation;
    const encoding = parameters.encodings?.[0];
    if (encoding) {
      // Assigned unconditionally, `undefined` included: a preset with no
      // ceiling has to REMOVE the ceiling a previous one set, and leaving
      // the old value in place would make "Save data" a one-way door.
      encoding.maxBitrate = quality.maxBitrate;
      encoding.maxFramerate = quality.maxFramerate;
      encoding.scaleResolutionDownBy = quality.scaleResolutionDownBy;
    }
    await sender.setParameters(parameters);
  }

  /** The raw stats report for the caller to derive from — see client/media/stats.ts. */
  async getStats(): Promise<RTCStatsReport> {
    return this.#pc.getStats();
  }

  /**
   * Swaps the outgoing video track for another, with no renegotiation.
   *
   * `RTCRtpSender.replaceTrack` is what makes a camera flip a swap rather
   * than a restart: the transceiver, its SSRC and the negotiated SDP all
   * stay exactly as they are, so the peer's decoder never sees the stream
   * end. Tearing the share down and offering a new one — the obvious
   * alternative — would flash the receiver's video away and back, and
   * would have to survive glare against whatever the peer is doing.
   *
   * `#localStream` is updated with it, because that stream is both what
   * `close()` calls `stop()` on and what the local preview is bound to. The
   * OLD track is deliberately NOT stopped here: the caller owns it, and
   * stopping it before `replaceTrack` resolves can black out the outgoing
   * video on some browsers.
   */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.#pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) throw new Error('This connection has no video track to replace.');
    await sender.replaceTrack(track);

    const stream = this.#localStream;
    if (!stream) return;
    for (const old of stream.getVideoTracks()) stream.removeTrack(old);
    stream.addTrack(track);
  }

  close(): void {
    this.#pc.close();
    this.#reportClosed('closed locally');
  }

  async #flushPendingIce(): Promise<void> {
    const pending = this.#pendingIce;
    this.#pendingIce = [];
    // Each candidate gets its own try/catch, via #addIceCandidateIgnoringFailure
    // — a single stale one rejecting must not stop the loop and drop every
    // good candidate still queued behind it.
    for (const candidate of pending) await this.#addIceCandidateIgnoringFailure(candidate);
  }

  /**
   * `addIceCandidate` rejecting is an ordinary event here, not a
   * connection failure: per webrtc-pc it rejects with `OperationError`
   * when a candidate's `usernameFragment` doesn't match the currently-
   * applied remote description — precisely what happens to a candidate
   * trickled by an abandoned negotiation attempt (see
   * shared/media-signal.ts's doc comment on `MediaIce`, and `LiveSession`'s
   * glare handling, which relies on this being harmless). Letting that
   * propagate out of `accept()` would make a single bad candidate look
   * identical to the negotiation itself failing to whatever's calling this
   * class — tearing down the connection this mechanism exists to protect,
   * over the one kind of failure it's supposed to produce. Both call sites
   * above (an already-negotiated candidate, and each one flushed from
   * `#pendingIce`) route through here rather than each swallowing it
   * themselves.
   *
   * (Worth confirming against a real browser, per the plan's Verification
   * section, in case some implementation silently ignores a mismatched
   * candidate instead of rejecting — swallowing costs nothing under that
   * reading either.)
   */
  async #addIceCandidateIgnoringFailure(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.#pc.addIceCandidate(candidate);
    } catch {
      // Expected and non-fatal — see doc comment above.
    }
  }

  /**
   * The single funnel for every way this connection ends — `close()`, a
   * `connectionstatechange` to failed/closed/disconnected, and an inbound
   * `media-stop` all call this and nothing else. Two jobs, in order, and
   * both belong here rather than in each caller:
   *
   * 1. Stop every local track. The camera or screen-share indicator light
   *    is the user's only signal that sharing has actually ended, and it
   *    must go out however the session ended — a connection that fails,
   *    or a peer that sends `media-stop`, ends the stream just as surely
   *    as a local `close()` does, and reports as much via `onClosed`. If
   *    that reporting isn't paired with actually stopping the tracks, the
   *    light stays on for a session the caller was just told was over:
   *    the exact failure this comment is here to prevent a future path
   *    from reintroducing. `RTCPeerConnection.close()` never does this
   *    itself — it tears down the connection but leaves any track handed
   *    to it running, since the same `MediaStream` might still be in use
   *    elsewhere (a local preview `<video>` element, say) — so it is
   *    always this class's job, never the browser's.
   * 2. Report `onClosed` exactly once. `#closed` guards both jobs behind
   *    one flag, so a second call (an ICE failure arriving just after an
   *    explicit `close()`, say) is a complete no-op rather than a second
   *    round of track-stopping or a second callback. The callback itself
   *    is deferred by a microtask for the same reentrancy reason
   *    WebRTCTransport's `#reportClose` is: a caller closing this peer
   *    from inside its own `onClosed` handler (Task 5's `LiveSession`,
   *    tearing down its own state when told the connection is gone) must
   *    not be re-entered synchronously from within this call chain.
   */
  #reportClosed(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#localStream?.getTracks().forEach((track) => track.stop());
    queueMicrotask(() => this.#events.onClosed(reason));
  }
}

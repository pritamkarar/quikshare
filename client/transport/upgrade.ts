import type { Transport, TransportKind } from './types.js';
import { HIGH_WATER_BYTES } from './types.js';
import { WebRTCTransport, WhenOpenTimeoutError } from './webrtc.js';

/**
 * How long after a swap a frame on the sidelined baseline is read as a
 * straggler rather than as the peer having gone back to the relay.
 *
 * Both peers upgrade within a round trip of each other, so a frame the peer
 * sent down the relay just before its own swap lands here just after ours —
 * routinely, and hardest during exactly the busy transfer an upgrade is most
 * worth having. Falling back on one of those would undo nearly every upgrade
 * that mattered. A genuine divergence cannot happen in this window at all:
 * it needs the upgraded connection to have worked and then broken, which is
 * seconds of network away, so nothing is lost by waiting out the stragglers.
 * The frame itself is delivered either way — only the fallback waits.
 */
const BASELINE_STRAGGLER_MS = 5000;

/**
 * The transport everything above the seam actually holds. It delegates to
 * whichever implementation is live so Sender and Receiver never learn a
 * swap happened.
 *
 * Each underlying transport (relay, memory, WebRTC) has single-slot
 * onMessage/onDrain/onClose callbacks, so this registers exactly one
 * forwarding closure per transport (at construction, and again at each
 * swap) and fans it out to whatever the caller registered on *this*
 * object — callers register once, before any swap, and keep receiving
 * events afterwards regardless of how many swaps happen underneath.
 *
 * Only the currently-live transport SENDS, and a sidelined one can neither
 * end the session nor release backpressure: `swapTo`/`fallBack` overwrite
 * its close and drain callbacks (`#detach`). A stray *close* is the thing
 * that has to be silenced — without it, the baseline relay hiccuping after
 * a successful upgrade would be reported as `onClose` and end an otherwise
 * healthy peer-to-peer session.
 *
 * The baseline keeps being LISTENED to, and that is load-bearing rather
 * than a leak. Each peer swaps on its own `whenOpen` and falls back on its
 * own connection dying, with nothing on the wire to agree on — so the two
 * can disagree about which transport is live, and the disagreement has no
 * bound: a peer whose WebRTC has not yet reported itself dead will sit on
 * it while the peer that has already fallen back sends every frame down
 * the relay. Muting the baseline turned that into a silent black hole (a
 * real session, 2026-08-29: every row on the sender read "Sent", every row
 * on the receiver sat at 0 bytes, and neither side raised an error). A
 * stray message was always safe to forward — it must still pass AEAD with
 * the frame header as AAD and the receiver's strictly-increasing seq
 * check, so an untouched relay can only replay-and-get-rejected or inject
 * garbage that fails authentication, never something that becomes wrong
 * bytes on disk — so there was never anything to buy by dropping it. This
 * also closes the narrower upgrade-direction gap that used to be recorded
 * here and accepted: a legitimate, correctly-sequenced frame still in
 * flight on the old relay when the peer swapped now arrives instead of
 * vanishing.
 *
 * A frame on the sidelined baseline is also evidence: the peer is plainly
 * back on the relay, which is the one thing this side cannot learn any
 * other way. So it triggers `fallBack()` — once the frame is old enough
 * not to be an upgrade straggler (BASELINE_STRAGGLER_MS above) — and the
 * two agree again rather than never. This does hand the relay a way to end a
 * healthy WebRTC session by injecting a frame the peers will then discard
 * as unauthenticated — accepted deliberately, and it buys the relay
 * nothing it did not already have: it can drop the `rtc` signalling that
 * makes an upgrade possible at all, so keeping a session on itself has
 * never been out of its reach. Losing a file silently is the strictly
 * worse outcome of the two.
 */
export class SwitchableTransport implements Transport {
  #live: Transport;
  readonly #baseline: Transport;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #onKindChange: ((kind: TransportKind) => void) | undefined;
  /**
   * Set if the baseline's own close fires while it is sidelined after a
   * successful upgrade. A sidelined baseline is still listened to for
   * messages (see the class doc), but its close is different: if the socket
   * dies while WebRTC is live, and WebRTC later fails too, `fallBack` would
   * otherwise silently re-bind a relay that will never fire another event —
   * `send` on a closed WebSocket just no-ops and `bufferedAmount` reads 0,
   * so `Sender` would report progress for bytes delivered to nobody, with no
   * error at all. This flag lets `fallBack` recognise there is nothing left
   * to fall back to, instead of resuming on a corpse.
   */
  #baselineDied = false;

  constructor(baseline: Transport) {
    this.#baseline = baseline;
    this.#live = baseline;
    this.#bind(baseline);
  }

  get kind(): TransportKind { return this.#live.kind; }
  get bufferedAmount(): number { return this.#live.bufferedAmount; }

  send(frame: Uint8Array): void { this.#live.send(frame); }
  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }
  onKindChange(cb: (kind: TransportKind) => void): void { this.#onKindChange = cb; }
  close(): void { this.#live.close(); if (this.#live !== this.#baseline) this.#baseline.close(); }

  /** Cuts over to a newly-negotiated transport. Callers must ensure no send
   * is mid-flight when this runs — see TransportSwapGate below.
   *
   * Closes whatever it replaces, unless that is the baseline: the baseline
   * is precisely what a later `fallBack` resumes on, so it must stay alive,
   * but a previous upgrade being swapped out has nothing keeping it alive
   * and would otherwise leak its RTCPeerConnection for the life of the
   * page. Matches what `fallBack` already does for the transport it leaves. */
  swapTo(next: Transport): void {
    const previous = this.#live;
    this.#detach(previous);
    if (previous !== this.#baseline) previous.close();
    this.#live = next;
    this.#bind(next);
    this.#onKindChange?.(next.kind);
    this.#releaseDrainIfIdle();
  }

  /**
   * Returns to the relay when the upgraded transport dies mid-session. If
   * the relay itself died while sidelined (see #baselineDied), there is
   * nothing left to fall back to — reports the session closed instead of
   * silently re-binding a transport that will never fire another event.
   *
   * Always closes the transport being left, not only detaches it. The
   * automatic path (this transport reporting its own onClose) doesn't need
   * that — it's already closing itself, and closing an already-closed
   * WebRTCTransport/RelayTransport/RTCPeerConnection is a documented no-op.
   * The manual path (a caller falling back proactively, e.g. Session
   * re-pairing after a peer leaves mid-upgrade) does need it: without this,
   * that transport's underlying RTCPeerConnection/DataChannel is merely
   * unwired, never closed, and leaks for the rest of the page's lifetime.
   */
  fallBack(): void {
    if (this.#live === this.#baseline) return;
    const dying = this.#live;
    this.#detach(dying);
    dying.close();
    this.#live = this.#baseline;
    if (this.#baselineDied) {
      // Announced even though this session is over: the badge is
      // event-driven, so without this the last thing anyone above ever
      // heard was 'webrtc' — and Session's own #reconnect can put a working,
      // fully relayed session back on screen moments later still wearing a
      // "Direct — travelling straight between your devices" badge. A
      // downgrade always announces, whatever happens next.
      this.#onKindChange?.(this.#baseline.kind);
      this.#onClose?.('relay closed while upgraded');
      return;
    }
    this.#bind(this.#baseline);
    this.#onKindChange?.(this.#baseline.kind);
    this.#releaseDrainIfIdle();
  }

  #bind(transport: Transport): void {
    transport.onMessage((frame) => this.#onMessage?.(frame));
    transport.onDrain(() => this.#onDrain?.());
    transport.onClose((reason) => {
      if (transport === this.#baseline) { this.#onClose?.(reason); return; }
      // An upgraded transport dying is a downgrade, not the end of the session.
      this.fallBack();
    });
  }

  /**
   * Severs a transport that is no longer live so it can neither deliver a
   * stray message (redundant, but harmless — see the class doc) nor a stray
   * close event to whatever `#onClose` currently means. The baseline is the
   * one exception: instead of a full no-op, its close is still recorded
   * (never forwarded to the caller while sidelined, but not thrown away
   * either), so `fallBack` can tell a dead relay apart from a healthy one
   * it is resuming.
   *
   * The consequence, spelled out because it will look like a bug the first
   * time anyone sees it in production: while upgraded, the relay dying is
   * *deliberately silent*. `#onClose` is what `Session` reconnects on, so
   * swallowing it means `Session.#reconnect` does not start when the
   * signalling socket drops during a Direct session — it waits until the
   * WebRTC transport dies too, at which point `fallBack` sees
   * `#baselineDied` and reports the close for real. That is intended: the
   * data path is peer-to-peer and entirely healthy, and tearing a working
   * multi-gigabyte transfer down to rebuild a socket it is not using would
   * be strictly worse than carrying on. Forwarding the close instead would
   * also mean announcing a dead session to a user whose file is still
   * moving at full speed.
   *
   * It is worth stating loudly because until this branch it was unreachable
   * code: the upgrade path never ran in production (`RTCPeerConnection` does
   * not exist in a worker, so the upgrade this class exists to perform had
   * literally never happened), and no transport was ever sidelined. The
   * first real report will read as "signalling went dead but the transfer
   * kept going, and nothing reconnected" — which is this branch working as
   * designed, not a regression to debug.
   */
  #detach(transport: Transport): void {
    transport.onDrain(() => undefined);
    if (transport !== this.#baseline) {
      transport.onMessage(() => undefined);
      transport.onClose(() => undefined);
      return;
    }
    // The baseline stays heard while sidelined — see the class doc. The
    // frame is delivered first and the fallback follows it: the frame is
    // the evidence, and it must not be lost to the rearranging it triggers.
    // `fallBack` rebinds the baseline through `#bind`, replacing this
    // closure, so the fallback happens once and everything after it arrives
    // by the ordinary path.
    //
    // Read from the clock rather than armed as a timer: there is nothing to
    // fire when the window closes, only a question to answer if a frame ever
    // arrives, and a timer would have to be cancelled on every path that
    // leaves this transport behind.
    const sidelinedAt = Date.now();
    transport.onMessage((frame) => {
      this.#onMessage?.(frame);
      if (Date.now() - sidelinedAt >= BASELINE_STRAGGLER_MS) this.fallBack();
    });
    transport.onClose(() => { this.#baselineDied = true; });
  }

  /**
   * A send can be parked mid-`Sender.#awaitDrain`, waiting on whatever
   * transport was live when it backed up, via `transport.onDrain(cb)`.
   * Detaching that transport on swap would otherwise strand that waiter
   * forever — the new transport's own backpressure event only fires from
   * *its own* high-to-low transition, which may never happen if it starts
   * out idle (a fresh WebRTC channel usually does). So every swap checks
   * the newly-live transport itself and, if it's already under the
   * high-water mark, fires the drain callback once. Harmless if nobody was
   * actually waiting: Sender's registered callback just resolves an empty
   * waiter list.
   */
  #releaseDrainIfIdle(): void {
    if (this.#live.bufferedAmount < HIGH_WATER_BYTES) this.#onDrain?.();
  }
}

/**
 * Coordinates a negotiated transport swap with in-flight frame sends so
 * that frames from the pre-swap and post-swap transport can never straddle
 * the cutover. Plan 3's Global Constraints require the swap to happen "only
 * at a frame boundary with the send queue idle" — a snapshot of whatever
 * happens to be in flight right now is not enough, because `Sender.sendFiles`
 * is public and unserialized (client/transfer/sender.ts:57-63): a new send
 * can start in the gap between "checked idle" and "swapped".
 *
 * The unit of work is exactly one frame. Whoever produces frames (Task 3's
 * Sender) must wrap everything from "decided to emit this frame" through
 * the matching `transport.send(...)` call in `wrap(...)` — not narrower (a
 * frame could start being built while a swap is already cutting over) and
 * not wider (wrapping a whole file or batch would mean a large transfer
 * never lets the gate go idle, and a new batch starting mid-wait would
 * reproduce the exact snapshot bug this exists to close).
 *
 * Specifically: `wrap()` must cover the header/seal/`transport.send(...)`
 * work for one frame and stop there — it must NOT also cover waiting for
 * that transport to drain its backpressure afterwards. A transport worth
 * upgrading away from is, by definition, sometimes backed up; if draining
 * it were part of the wrapped unit, a send stuck waiting on a congested
 * relay would hold `#inFlight` above zero indefinitely, and `runExclusive`
 * would then wait forever for a swap that is the ONLY thing that could
 * relieve that exact backpressure. The gate would deadlock the upgrade
 * that exists to rescue the session from precisely this situation. The
 * frame boundary that matters is "handed to `transport.send()`", not "the
 * transport finished draining it" — drain-waiting happens after `wrap()`
 * returns, never inside it.
 *
 * Guarantees: while a swap (`runExclusive`) is pending, no new `wrap()`
 * call begins its work, and the swap itself does not run until every
 * `wrap()` call already in progress has finished. So every frame that was
 * mid-flight when the swap began lands before the cutover, and every frame
 * that begins after `wrap()` unblocks observes the new transport.
 *
 * Does NOT guarantee: delivery order at the network layer. A frame sent
 * moments before the swap through a backed-up relay can still arrive after
 * a frame sent moments later through a fresh, empty WebRTC channel — this
 * only orders when sends are *issued*, not when bytes land on the wire.
 * (The receiver's strictly-increasing seq check turns that into a rejected,
 * restartable transfer rather than silent corruption.) It also provides no
 * protection at all for a caller that calls `transport.send()` directly
 * instead of going through `wrap()` — the gate only knows about work routed
 * through it.
 */
export class TransportSwapGate {
  #inFlight = 0;
  #barrier: Promise<void> | undefined;
  #idleWaiters: Array<() => void> = [];

  /** Wraps one frame's worth of send work. */
  async wrap<T>(fn: () => Promise<T> | T): Promise<T> {
    while (this.#barrier) await this.#barrier;
    this.#inFlight++;
    try {
      return await fn();
    } finally {
      this.#inFlight--;
      if (this.#inFlight === 0) {
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  /**
   * Blocks new `wrap()` calls, waits for every in-flight one to finish,
   * runs `perform` (expected to be synchronous, e.g. `switchable.swapTo`),
   * then releases blocked callers. Only one swap may be in progress at a
   * time — this project performs at most one negotiated upgrade per
   * session, so a second concurrent call is a bug, not a scenario to queue.
   */
  async runExclusive(perform: () => void): Promise<void> {
    if (this.#barrier) throw new Error('TransportSwapGate: a swap is already in progress');
    let release!: () => void;
    this.#barrier = new Promise((resolve) => { release = resolve; });
    if (this.#inFlight > 0) {
      await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    }
    try {
      perform();
    } finally {
      this.#barrier = undefined;
      release();
    }
  }
}

/**
 * What `negotiateUpgrade` needs from a candidate transport: the `Transport`
 * seam plus the two negotiation-only methods. Extracted as an interface, and
 * built through a factory below, because the realm that RUNS this negotiation
 * is not always the realm that can BUILD the connection — `RTCPeerConnection`
 * is `[Exposed=Window]`, and `Session` lives in a Web Worker. Naming
 * `WebRTCTransport` directly here is what made the upgrade unreachable in
 * production for the entire life of the project.
 */
export interface UpgradeTransport extends Transport {
  whenOpen(timeoutMs: number): Promise<void>;
  handleSignal(payload: unknown): Promise<void>;
}

/**
 * Builds one attempt's transport. `isOfferer` decides which side creates the
 * data channel; `sendSignal` is how the transport emits its own SDP and ICE.
 */
export type UpgradeTransportFactory =
  (isOfferer: boolean, sendSignal: (msg: unknown) => void) => UpgradeTransport;

/**
 * The default: a real `WebRTCTransport` in this realm. Correct on the page,
 * and impossible in a worker — which is exactly why callers in the worker
 * pass their own.
 */
export const createLocalUpgradeTransport: UpgradeTransportFactory = (isOfferer, sendSignal) =>
  isOfferer ? WebRTCTransport.offer(sendSignal) : WebRTCTransport.answer(sendSignal);

export interface UpgradeOptions {
  switchable: SwitchableTransport;
  isOfferer: boolean;
  sendSignal: (payload: unknown) => void;
  /** Registers a handler for inbound signalling payloads. */
  onSignal: (cb: (payload: unknown) => void) => void;
  /**
   * Shared with whoever produces frames (Task 3's Sender): the same
   * instance must be passed to both, or the gate has no way to know about
   * the sends it is supposed to be coordinating with.
   */
  gate: TransportSwapGate;
  timeoutMs?: number;
  /**
   * Called once per inbound signalling payload that failed validation (see
   * WebRTCTransport.handleSignal) or otherwise threw while being applied.
   * The relay is an active adversary in this project's threat model, so a
   * malformed or spliced signal must not vanish without a trace — even
   * though, per the catch below, it must also never fail the attempt by
   * itself. Defaults to a throttled `console.warn`, not silence: Ruling 3's
   * diagnosability requirement must hold even if a future caller never
   * passes this — an opt-in guarantee is not a guarantee. The relay is
   * this project's active adversary and the server does not rate-limit its
   * `rtc` forwarding path, so the default must degrade gracefully under a
   * flood rather than logging once per malformed frame.
   */
  onSignalRejected?: (error: unknown) => void;
  /**
   * Cancels this attempt if it hasn't swapped yet. A negotiation targets
   * whichever peer is in the room when it starts; if that peer leaves
   * before the connection opens, the attempt is now negotiating with
   * nobody (or, worse, could still swap in just as a replacement peer takes
   * the room). Checked right before the swap and again inside the gate's
   * `perform`, so an abort that lands while `runExclusive` is queued behind
   * other in-flight sends still lands in time. Also closes the attempt's
   * transport the moment it fires, rather than leaving its
   * RTCPeerConnection and ICE gathering alive until `timeoutMs` expires:
   * `peer-joined` is relay-controlled, and this project treats the relay as
   * an active adversary, so an abort has to actually free the connection —
   * not merely disqualify it from swapping in later.
   */
  signal?: AbortSignal;
  /**
   * How to build this attempt's transport. Defaults to a real
   * `WebRTCTransport` in the calling realm. The transfer worker passes a
   * proxy to the page instead — see client/worker/peer-proxy.ts.
   */
  createTransport?: UpgradeTransportFactory;
}

const SIGNAL_REJECTION_WARNING_THROTTLE_MS = 1000;

/**
 * Builds a fresh, per-attempt throttled warner for the `onSignalRejected`
 * default: a flooding relay must not be able to drive `console.warn` at
 * whatever rate the socket allows. Built fresh per `negotiateUpgrade` call
 * (never shared module state) so one session's throttle can't suppress
 * another's, and so the very first rejection in an attempt always logs.
 */
function createDefaultSignalRejectionWarner(): (error: unknown) => void {
  let lastWarnedAt = -Infinity;
  return (error: unknown) => {
    const now = Date.now();
    if (now - lastWarnedAt < SIGNAL_REJECTION_WARNING_THROTTLE_MS) return;
    lastWarnedAt = now;
    console.warn('WebRTC upgrade: rejected an inbound signal', error);
  };
}

export type UpgradeOutcome =
  | { ok: true }
  /**
   * 'timeout': the data channel did not open before timeoutMs.
   * 'failed': any other reason — connection failure, offer negotiation
   * failure, or an explicit close during negotiation. Task 4's transport
   * badge only needs "did we upgrade or not"; this split exists so a
   * timeout (likely no direct path exists) can be told apart from an
   * outright failure while negotiating, for anyone debugging why WebRTC
   * never engages.
   */
  | { ok: false; reason: 'timeout' | 'failed' };

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Attempts a WebRTC upgrade in the background. Resolves either way — a
 * failed upgrade is not an error, it just means the session stays on the
 * relay — but reports which happened and, on failure, a reason, so a
 * silently-never-upgrading production session is diagnosable rather than
 * indistinguishable from "it just didn't happen".
 */
export async function negotiateUpgrade(opts: UpgradeOptions): Promise<UpgradeOutcome> {
  const {
    switchable, isOfferer, sendSignal, onSignal, gate, signal,
    onSignalRejected = createDefaultSignalRejectionWarner(),
    createTransport = createLocalUpgradeTransport,
  } = opts;
  // Declared out here but constructed *inside* the try: building the
  // transport runs real browser code that can throw synchronously — a
  // malformed VITE_STUN_URLS entry (a bare "stun.example.com" with no
  // scheme is a SyntaxError in Chrome and Firefox), or peer-connection
  // exhaustion. Outside the try, that escaped as a rejected promise, which
  // every caller is told cannot happen: Session fires this and forgets it
  // (`void negotiateUpgrade(...)`), so a misconfigured deployment produced
  // an unhandled rejection once per pairing, for as long as it stayed
  // misconfigured. The declaration stays out here so the catch can still
  // close a transport that was built before failing.
  let rtc: UpgradeTransport | undefined;
  try {
    rtc = createTransport(isOfferer, sendSignal);
    const transport = rtc;
    onSignal((payload) => {
      // An upgrade attempt must never crash a working session over a
      // malformed or adversarial signal — but swallowing it with no trace at
      // all is why nobody could tell WebRTC silently never engaged.
      void transport.handleSignal(payload).catch((error: unknown) => onSignalRejected?.(error));
    });
    // Closed the moment the attempt is cancelled, rather than left running
    // until whenOpen settles: an abort means this negotiation is targeting
    // a peer that is already gone, and `peer-joined` is a relay-controlled
    // signal in a threat model where the relay is an active adversary.
    // Waiting out the timeout would let a flood of them hold up to one live
    // RTCPeerConnection (and its ICE gathering) per frame for the whole
    // window — and Chromium throws once its per-page cap is reached.
    // Closing here also settles whenOpen immediately, so the attempt
    // resolves instead of lingering.
    signal?.addEventListener('abort', () => transport.close(), { once: true });
    await transport.whenOpen(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Checked inside perform, not before calling runExclusive: an abort can
    // land while runExclusive is still queued behind other in-flight sends.
    let aborted = false;
    await gate.runExclusive(() => {
      aborted = signal?.aborted ?? false;
      if (!aborted) switchable.swapTo(transport);
    });
    if (aborted) { transport.close(); return { ok: false, reason: 'failed' }; }
    return { ok: true };
  } catch (error) {
    // `?.`: the construction on the first line of the try is itself one of
    // the things that can land here, in which case there is nothing to close.
    rtc?.close();
    return { ok: false, reason: error instanceof WhenOpenTimeoutError ? 'timeout' : 'failed' };
  }
}

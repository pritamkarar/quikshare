import { HIGH_WATER_BYTES } from '../transport/types.js';
import { WhenOpenTimeoutError } from '../transport/webrtc.js';
import type { UpgradeTransport, UpgradeTransportFactory } from '../transport/upgrade.js';
import type { ToWorker } from './messages.js';
import type { PostRequest } from './sink-proxy.js';

/**
 * Unique for the worker's whole lifetime, not per proxy — same reasoning as
 * `nextRequestId` in sink-proxy.ts. A worker can outlive one session, and a
 * connection id that restarted at 1 would let a stale `peer-message` from a
 * retired connection be delivered into a live one's Receiver.
 */
let nextConnectionId = 1;
let nextSignalRequestId = 1;

export interface PeerProxy {
  /** Hand this to `Session` as its upgrade transport factory. */
  createTransport: UpgradeTransportFactory;
  /** Routes one page → worker peer message. Returns true if it was consumed. */
  handle(msg: ToWorker): boolean;
  /** Fails everything in flight and closes every connection this proxy owns. */
  closeAll(reason: string): void;
}

/** One outstanding `peer-send`, until the page confirms it took it. */
interface InFlight { seq: number; bytes: number; }

class ProxyUpgradeTransport implements UpgradeTransport {
  readonly kind = 'webrtc' as const;
  readonly id = nextConnectionId++;

  #post: PostRequest;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #openSettle: { resolve: () => void; reject: (e: Error) => void } | undefined;
  #signalPending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  #closed = false;
  #closeReason: string | undefined;
  #sendSeq = 0;
  /**
   * The page's most recent reading of the real channel buffer, and the seq it
   * was taken at. Everything sent after that seq is still unaccounted for.
   */
  #reportedBytes = 0;
  #reportedSeq = 0;
  /** Sends the page has not yet confirmed. Bounded by frames in flight. */
  readonly #inFlight: InFlight[] = [];

  /**
   * Called exactly once, the first time this connection reaches a terminal
   * state, so the owning proxy can drop it from its map. Not a courtesy: the
   * relay is an active adversary and can synthesise `peer-left`/`peer-joined`
   * to force an unbounded number of upgrade attempts, each of which mints a
   * fresh `ProxyUpgradeTransport`. Without this the map only ever grows, for
   * the whole life of the worker.
   */
  #retire: (id: number) => void;

  constructor(
    post: PostRequest,
    isOfferer: boolean,
    readonly sendSignal: (msg: unknown) => void,
    retire: (id: number) => void,
  ) {
    this.#post = post;
    this.#retire = retire;
    this.#post({ t: 'peer-open', id: this.id, isOfferer });
  }

  /**
   * A deliberate over-estimate.
   *
   * `Transport.bufferedAmount` is synchronous and `Sender.#awaitDrain` reads
   * it once per chunk, but the buffer it describes lives on the page. What
   * this returns is the page's last reading plus every byte sent since the
   * seq that reading covered — so a byte is only ever forgotten once the page
   * has said it took it. Over-estimating parks the sender a little early;
   * under-estimating would overrun a buffer nobody here can see. Only one of
   * those two errors is safe.
   */
  get bufferedAmount(): number {
    let pending = 0;
    for (const entry of this.#inFlight) pending += entry.bytes;
    return this.#reportedBytes + pending;
  }

  send(frame: Uint8Array): void {
    if (this.#closed) return;
    const seq = ++this.#sendSeq;
    this.#inFlight.push({ seq, bytes: frame.length });
    // Copied into a standalone buffer before transferring: the caller's view
    // may be over a larger pooled buffer, and transferring that would detach
    // the whole pool out from under the Sender.
    const copy = frame.slice();
    this.#post({ t: 'peer-send', id: this.id, seq, frame: copy }, [copy.buffer]);
  }

  whenOpen(timeoutMs: number): Promise<void> {
    if (this.#closed) return Promise.reject(new Error(this.#closeReason ?? 'the connection was closed'));
    // The page runs the real timer against the real connection; this only
    // needs somewhere to park until it answers.
    this.#post({ t: 'peer-wait-open', id: this.id, timeoutMs });
    return new Promise((resolve, reject) => { this.#openSettle = { resolve, reject }; });
  }

  handleSignal(payload: unknown): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const requestId = nextSignalRequestId++;
    return new Promise((resolve, reject) => {
      this.#signalPending.set(requestId, { resolve, reject });
      this.#post({ t: 'peer-signal-in', id: this.id, requestId, payload });
    });
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = 'the connection was closed';
    this.#post({ t: 'peer-close', id: this.id });
    this.#failPending(this.#closeReason);
    this.#retire(this.id);
  }

  /** Called by the proxy for messages addressed to this connection. */
  accept(msg: ToWorker): void {
    switch (msg.t) {
      case 'peer-opened':
        if (msg.ok) this.#openSettle?.resolve();
        else this.#openSettle?.reject(msg.reason === 'timeout'
          ? new WhenOpenTimeoutError()
          : new Error('the data channel could not be established'));
        this.#openSettle = undefined;
        return;
      case 'peer-message':
        // Guarded like every other arm. A frame arriving after this
        // connection closed is harmless when the close came from a swap or a
        // fallback (`SwitchableTransport.#detach` no-ops the callback), but
        // after `Session.close()` `#onMessage` still points straight at
        // `Session.#route`: `#switchable.close()` closes the live transport
        // without detaching it. AEAD and the seq check would keep that from
        // becoming wrong bytes, but a closed session has no business routing
        // frames at all, and consistency across the arms is cheaper to keep
        // than to re-derive.
        if (this.#closed) return;
        this.#onMessage?.(msg.frame);
        return;
      case 'peer-drain':
        // Only update the buffered reading if this report is not stale.
        // A stale report (lower acceptedSeq than one already processed) must
        // not clobber the byte count downward, which would under-report.
        if (msg.acceptedSeq >= this.#reportedSeq) {
          this.#reportedBytes = msg.bufferedAmount;
          this.#reportedSeq = msg.acceptedSeq;
          // Everything the page has confirmed taking is now inside
          // `bufferedAmount` above rather than counted twice.
          while (this.#inFlight.length > 0 && this.#inFlight[0]!.seq <= this.#reportedSeq) {
            this.#inFlight.shift();
          }
        }
        // C1: gated, exactly as both real transports gate it —
        // `RelayTransport` only fires `#onDrain` when its polled
        // `bufferedAmount` has fallen below the mark, and `WebRTCTransport`
        // only fires it from `bufferedamountlow`, whose threshold *is*
        // `HIGH_WATER_BYTES`. Firing unconditionally here was a silent
        // disabling of backpressure on the whole proxy path, not a mere
        // extra wakeup.
        //
        // Why it looked harmless: the page reports on *every* `peer-send`,
        // not only on a real drain event, because the worker's
        // `bufferedAmount` is a synchronous getter that is only ever as
        // fresh as its last report. Read as bandwidth, a report per frame is
        // just a few structured clones. But a report was also an
        // unconditional wakeup, and `Sender.#awaitDrain` resolves *every*
        // parked waiter from that callback without re-reading
        // `bufferedAmount` — so the report generated by the very frame that
        // pushed the sender over the mark was what immediately unparked it.
        // Steady state: one extra frame per worker->page round trip, forever,
        // however full the real channel is. An 8 MB file against a
        // never-draining page buffer pushed all 8,392,473 bytes; Chromium
        // closes a data channel once 16 MiB is buffered.
        //
        // Invisible to the microtask-hop integration harness, and that is
        // the whole reason it survived review: with `queueMicrotask` the
        // report is consumed *before* `#awaitDrain` parks, so the park never
        // happens and the unconditional wakeup has nothing to wake. A real
        // `postMessage` is a task, so in production the report always lands
        // *after* the park. See the task-boundary case in
        // tests/integration/peer-proxy-transport.test.ts.
        //
        // Reads `this.bufferedAmount` — the estimate, including everything
        // still in flight — not `msg.bufferedAmount`, because the estimate is
        // what `Sender.#awaitDrain` itself consults; waking on the raw
        // reading could unpark a sender that would immediately re-read a
        // number above the mark.
        //
        // `<=`, NOT `<`, and this boundary is load-bearing. The comparison
        // has to match the semantics of the event that feeds it:
        //
        //   - `RTCDataChannel` fires `bufferedamountlow` on the *edge* from
        //     `> bufferedAmountLowThreshold` to `<= threshold` (WebRTC 1.0
        //     §6.2), and `WebRTCTransport.#attach` sets that threshold to
        //     `HIGH_WATER_BYTES` exactly — deliberately, so that resume
        //     fires at precisely the fill level `#awaitDrain` paused at.
        //   - Data frames are exactly `MAX_FRAME_BYTES` (65536) and
        //     `HIGH_WATER_BYTES` is exactly 16 of them, so the report
        //     carrying that crossing holds exactly 1,048,576 — the threshold
        //     itself, on the nose, not one byte under it.
        //
        // A strict `<` therefore rejects the crossing report. The event is
        // edge-triggered, so it never fires again; the parked sender issues
        // no further sends, so no further per-send reports arrive either.
        // The transfer deadlocks permanently — which is strictly worse than
        // the unbounded buffering this gate was added to fix. Measured: a
        // sender parked at 17 frames, the page buffer drained fully, exactly
        // one post-park report of 1,048,576 arrived, and nothing ever
        // resumed. The inclusive boundary is the whole reason this gate is
        // safe rather than fatal.
        //
        // No lost-wakeup risk beyond that: the page reports on every send as
        // well as on every genuine drain event, so the report covering the
        // last in-flight frame is always evaluated with `#inFlight` empty,
        // and any later real `bufferedamountlow` produces a report of its
        // own.
        if (this.bufferedAmount <= HIGH_WATER_BYTES) this.#onDrain?.();
        return;
      case 'peer-signal-result': {
        const pending = this.#signalPending.get(msg.requestId);
        if (!pending) return;
        this.#signalPending.delete(msg.requestId);
        if (msg.ok) pending.resolve();
        else pending.reject(new Error(msg.message ?? 'the signal could not be applied'));
        return;
      }
      case 'peer-closed':
        if (this.#closed) return;
        this.#closed = true;
        this.#closeReason = msg.reason;
        this.#retire(this.id);
        this.#failPending(msg.reason);
        this.#onClose?.(msg.reason);
        return;
      default:
        return;
    }
  }

  /** Fails the open and every outstanding signal, so nothing is left hanging. */
  #failPending(reason: string): void {
    this.#openSettle?.reject(new Error(reason));
    this.#openSettle = undefined;
    for (const pending of this.#signalPending.values()) pending.reject(new Error(reason));
    this.#signalPending.clear();
  }

  /** Teardown from the owning proxy, without posting a close the page cannot answer. */
  abandon(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#retire(this.id);
    this.#failPending(reason);
  }
}

export function createPeerProxy(post: PostRequest): PeerProxy {
  const connections = new Map<number, ProxyUpgradeTransport>();

  return {
    createTransport: (isOfferer, sendSignal) => {
      // Retired from the map the moment it reaches a terminal state, by any
      // route: `close()`, `abandon()`, or the page reporting `peer-closed`.
      // Deleting during `closeAll`'s own iteration is safe — removing the
      // entry the iterator is currently on is well-defined for a Map — and
      // the `clear()` that follows is then just belt and braces.
      const transport = new ProxyUpgradeTransport(
        post, isOfferer, sendSignal, (id) => { connections.delete(id); },
      );
      connections.set(transport.id, transport);
      return transport;
    },

    handle: (msg) => {
      if (!msg.t.startsWith('peer-')) return false;
      const addressed = msg as Extract<ToWorker, { id: number }>;
      const connection = connections.get(addressed.id);
      // An unknown id is a message for a connection already retired — see
      // `nextConnectionId`. Dropped, never routed to whatever is current.
      if (!connection) return true;
      if (msg.t === 'peer-signal-out') { connection.sendSignal(msg.payload); return true; }
      connection.accept(msg);
      return true;
    },

    closeAll: (reason) => {
      for (const connection of connections.values()) connection.abandon(reason);
      connections.clear();
    },
  };
}

import {
  createLocalUpgradeTransport,
  type UpgradeTransport,
  type UpgradeTransportFactory,
} from '../transport/upgrade.js';
import { WhenOpenTimeoutError } from '../transport/webrtc.js';
import type { FromWorker, ToWorker } from './messages.js';

/**
 * The page's half of the peer proxy, and the mirror of `sink-host.ts`.
 *
 * It exists for one reason: `RTCPeerConnection` is `[Exposed=Window]`, so the
 * realm that owns `Session` — a dedicated Web Worker — cannot construct one.
 * This side owns the connection; the worker keeps the key, the frames and
 * every AES-GCM operation, and never learns that its transport is a proxy.
 */
export interface PeerHost {
  /** Routes one worker → page peer message. Returns true if it was consumed. */
  handle(msg: FromWorker): boolean;
  /** Closes every connection. Called when the session is torn down. */
  closeAll(): void;
}

interface Live {
  transport: UpgradeTransport;
  /** The highest `peer-send` seq handed to the real transport. */
  acceptedSeq: number;
  opened: boolean;
}

export function createPeerHost(opts: {
  post: (msg: ToWorker, transfer?: Transferable[]) => void;
  createTransport?: UpgradeTransportFactory;
}): PeerHost {
  const { post, createTransport = createLocalUpgradeTransport } = opts;
  const live = new Map<number, Live>();

  function report(id: number, entry: Live): void {
    post({
      t: 'peer-drain',
      id,
      acceptedSeq: entry.acceptedSeq,
      bufferedAmount: entry.transport.bufferedAmount,
    });
  }

  /** Starts the real open race. Idempotent: a repeated request is ignored. */
  function waitOpen(id: number, timeoutMs: number): void {
    const entry = live.get(id);
    if (!entry || entry.opened) return;
    entry.opened = true;
    entry.transport.whenOpen(timeoutMs).then(
      () => post({ t: 'peer-opened', id, ok: true }),
      (error: unknown) => post({
        t: 'peer-opened', id, ok: false,
        reason: error instanceof WhenOpenTimeoutError ? 'timeout' : 'failed',
      }),
    );
  }

  function open(id: number, isOfferer: boolean): void {
    // Never two connections for one id: an RTCPeerConnection is expensive and
    // an orphaned one keeps gathering ICE for the life of the page.
    if (live.has(id)) return;

    let transport: UpgradeTransport;
    try {
      // Real browser code that can throw synchronously — a malformed
      // VITE_STUN_URLS entry is a SyntaxError in Chrome and Firefox, and
      // Chromium throws once its per-page peer-connection cap is reached.
      transport = createTransport(isOfferer, (payload) => post({ t: 'peer-signal-out', id, payload }));
    } catch {
      post({ t: 'peer-opened', id, ok: false, reason: 'failed' });
      return;
    }

    const entry: Live = { transport, acceptedSeq: 0, opened: false };
    live.set(id, entry);

    transport.onMessage((frame) => {
      // Copied then transferred: the same pooled-buffer hazard the relay
      // transport guards against on its own send path.
      const copy = frame.slice();
      post({ t: 'peer-message', id, frame: copy }, [copy.buffer]);
    });
    transport.onDrain(() => report(id, entry));
    transport.onClose((reason) => {
      live.delete(id);
      post({ t: 'peer-closed', id, reason });
    });
  }

  return {
    handle: (msg) => {
      switch (msg.t) {
        case 'peer-open':
          open(msg.id, msg.isOfferer);
          return true;
        case 'peer-wait-open':
          waitOpen(msg.id, msg.timeoutMs);
          return true;
        case 'peer-send': {
          const entry = live.get(msg.id);
          if (!entry) return true;
          try {
            entry.transport.send(msg.frame);
          } catch {
            // Wrapped for the same reason `open()` wraps `createTransport`:
            // this is real browser code that throws synchronously.
            // `WebRTCTransport.send` throws above MAX_FRAME_BYTES, and a real
            // `RTCDataChannel.send` throws OperationError once the user
            // agent's send-buffer maximum is exceeded (16 MiB in Chromium),
            // closing the channel as it does so.
            //
            // Unguarded, that throw left the realm entirely: out of
            // `handle()`, out of `peerHost.handle(msg)` in useSession, out of
            // WorkerClient's message listener, which has no try/catch — an
            // uncaught page error. Worse than the error was what it skipped.
            // Neither `entry.acceptedSeq` nor `report()` below ran, so the
            // worker never heard about the frame: its `#inFlight` entry was
            // never pruned, its `bufferedAmount` estimate stayed permanently
            // inflated above the high-water mark, and `Sender` parked
            // forever with nothing to unpark it. A hang, not a failure.
            //
            // So the connection is retired rather than the frame merely
            // dropped. Both throw conditions are terminal in practice — the
            // UA cap has already closed the channel underneath us, and an
            // oversized frame is a protocol bug that the next frame will
            // reproduce — and this transport is the *upgrade*, never the
            // baseline. `peer-closed` is what the proxy turns into
            // `#onClose`, which is what drives `SwitchableTransport.fallBack`
            // back onto the relay with resume intact. Reporting a drain
            // instead would keep the accounting honest but leave a channel
            // nobody can send on; falling back loses nothing but the
            // upgrade.
            live.delete(msg.id);
            try { entry.transport.close(); } catch { /* already dying */ }
            // Posted unconditionally, even though `close()` may have fired
            // `onClose` and posted one already: the proxy ignores a second
            // `peer-closed` (it retires on the first), and a *missing* one is
            // the permanent stall this whole branch exists to avoid.
            post({ t: 'peer-closed', id: msg.id, reason: 'the connection could not accept a frame' });
            return true;
          }
          entry.acceptedSeq = msg.seq;
          // Reported every send, not only on a drain event: the worker's
          // synchronous bufferedAmount is only as fresh as its last report,
          // and Sender consults it once per chunk. The worker gates the
          // *wakeup* that report implies on its own reconstructed
          // bufferedAmount — see the `peer-drain` arm in peer-proxy.ts.
          report(msg.id, entry);
          return true;
        }
        case 'peer-signal-in': {
          const entry = live.get(msg.id);
          if (!entry) return true;
          void entry.transport.handleSignal(msg.payload).then(
            () => post({ t: 'peer-signal-result', id: msg.id, requestId: msg.requestId, ok: true }),
            (error: unknown) => post({
              t: 'peer-signal-result', id: msg.id, requestId: msg.requestId, ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return true;
        }
        case 'peer-close': {
          const entry = live.get(msg.id);
          live.delete(msg.id);
          entry?.transport.close();
          return true;
        }
        default:
          return false;
      }
    },

    closeAll: () => {
      // Closed, not merely dropped: an abandoned RTCPeerConnection keeps
      // gathering ICE for the life of the page.
      for (const entry of live.values()) entry.transport.close();
      live.clear();
    },
  };
}

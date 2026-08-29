import type { FileMeta, MediaControl, SaveCapability } from '../../shared/messages.js';
import type { DeviceInfo } from '../../shared/device.js';
import type { TransportKind } from '../transport/types.js';

export type ToWorker =
  | {
    t: 'init';
    wsUrl: string;
    intent: { t: 'create' } | { t: 'join'; code: string };
    saveCapability: SaveCapability;
    /**
     * The page's escape hatch, forwarded here because `Session` runs inside
     * this worker and a worker's own `location.href` is the worker SCRIPT's
     * URL, not the page's — reading a query string in here would silently
     * never see what the page's address bar actually carries.
     */
    forceTransport?: 'relay';
    /**
     * How this device describes itself, detected on the page for the same
     * reason `saveCapability` is: a worker has no `screen` and no
     * `localStorage`, so neither the display size nor the persistent device
     * id can be read from in here. Its `ip` is left for the Session to fill
     * in from the relay's own signal — a browser cannot see its own address.
     */
    device?: DeviceInfo;
    /**
     * Whether the PAGE can host an RTCPeerConnection. The worker cannot
     * answer this for itself — RTCPeerConnection is [Exposed=Window] — and
     * for the whole life of the project it tried to, which is why the
     * upgrade never ran.
     */
    webrtcAvailable?: boolean;
  }
  | { t: 'send-files'; files: File[] }
  | { t: 'send-text'; content: string }
  /**
   * Stop these files. `direction` is the page's own view of the ids — a
   * fileId alone cannot say which of the two files sharing it is meant, so
   * it travels with every cancel. See Session.cancelFiles.
   */
  | { t: 'cancel-files'; direction: 'send' | 'receive'; fileIds: number[] }
  /** The user pressed confirm on the verification number. See Session.confirmVerification. */
  | { t: 'confirm-verification' }
  /*
   * Tell the peer this device is leaving on purpose. Answered with
   * 'end-session-sent' rather than being fire-and-forget, because the page
   * navigates away on that answer and navigating sooner terminates this
   * worker before the frame is written (see Session.endSession).
   */
  | { t: 'end-session' }
  /**
   * One of the four `media-*` control frames, page → worker, to be sealed
   * and put on the wire. `signal` is minted on the page (Task 5's
   * `LiveSession`, built from a real `RTCPeerConnection` — the worker
   * cannot host one; see the `webrtcAvailable` comment on 'init' above), so
   * it is already a `MediaControl` by construction, and
   * `Session.sendMediaSignal` does not re-parse it. This task wires the
   * transport only; nothing yet posts this message.
   */
  | { t: 'send-media-signal'; signal: MediaControl }
  | { t: 'close' }
  /*
   * Peer RPC, page → worker. The page owns the real connection; these report
   * what it did.
   */
  | { t: 'peer-opened'; id: number; ok: true }
  | { t: 'peer-opened'; id: number; ok: false; reason: 'timeout' | 'failed' }
  | { t: 'peer-message'; id: number; frame: Uint8Array }
  /**
   * The page's buffer drained below the high-water mark. `acceptedSeq` is the
   * highest `peer-send` seq the page has handed to the data channel, and
   * `bufferedAmount` is the channel's own reading at that moment — together
   * they let the worker reconstruct a conservative synchronous view.
   */
  | { t: 'peer-drain'; id: number; acceptedSeq: number; bufferedAmount: number }
  | { t: 'peer-closed'; id: number; reason: string }
  /** SDP or ICE the page's connection produced, for the worker to relay. */
  | { t: 'peer-signal-out'; id: number; payload: unknown }
  /** The result of applying one `peer-signal-in`, correlated by `requestId`. */
  | { t: 'peer-signal-result'; id: number; requestId: number; ok: boolean; message?: string }
  // The page's answer to one sink request, correlated by `id`. `blob` is set
  // only by a 'sink-close' the in-memory tier answered; a Blob is
  // structured-cloneable, so it crosses this boundary intact.
  | { t: 'sink-result'; id: number; ok: true; blob?: Blob }
  | { t: 'sink-result'; id: number; ok: false; message: string };

export type FromWorker =
  /**
   * `device` is the page's own description handed back completed — same
   * fields, plus the address the relay observed. Carried on 'ready' rather
   * than announced separately because it is fully known by the time
   * create()/join() resolve, and a page that had to wait for a second
   * message would render a card with an empty address for one frame.
   */
  | { t: 'ready'; code: string; peerId: 'a' | 'b'; shareUrl: string; device?: DeviceInfo }
  /** This device's address changed — a reconnect landed on a different network. */
  | { t: 'self-device'; info: DeviceInfo }
  /** The peer described itself; already sanitised (shared/device.ts). */
  | { t: 'peer-device'; info: DeviceInfo }
  /**
   * The six digits both devices must be shown to compare, one message per
   * key agreement. Arriving again means the number CHANGED (a different peer
   * took the room's free slot), so the page discards whatever confirmation
   * state it was holding — see useSession.
   */
  | { t: 'verification'; digits: string }
  /** The peer's user confirmed. Both directions must land before sends are allowed. */
  | { t: 'peer-verified' }
  /** The 'end-session' frame is out, or could not be sent. Either way, the page may go. */
  | { t: 'end-session-sent' }
  | { t: 'peer-joined' }
  | { t: 'peer-left'; reason: string }
  /** The session is over, permanently — see Session.SessionEvents.onSessionEnded. */
  | { t: 'session-ended'; reason: 'gave-up' | 'room-gone' | 'peer-ended' }
  /** The live data-path transport changed, so the UI can show it honestly. */
  | { t: 'transport'; kind: TransportKind }
  | { t: 'offer'; files: FileMeta[] }
  | { t: 'outgoing'; files: FileMeta[] }
  | { t: 'send-progress'; fileId: number; bytesMoved: number; totalBytes: number; bytesPerSecond: number }
  | { t: 'receive-progress'; fileId: number; bytesMoved: number; totalBytes: number; bytesPerSecond: number }
  // One file of a send batch fully sent and acknowledged, independent of the
  // rest of the batch — without this, a multi-file send's per-file progress
  // is only ever flushed once the entire batch resolves, and a finished
  // file's row sits visibly short of complete while an unrelated file in the
  // same batch is still transferring.
  | { t: 'send-file-done'; fileId: number }
  /**
   * One file stopped early because it was cancelled, on either side. Carries
   * `direction` for the same reason 'cancel-files' does, and is a message of
   * its own rather than an 'error' because a cancellation is not a failure.
   */
  | { t: 'file-cancelled'; direction: 'send' | 'receive'; fileId: number }
  | { t: 'file-complete'; meta: FileMeta; blob?: Blob }
  | { t: 'text'; content: string }
  /**
   * A note this device sent, reported once `Session.sendText` has resolved —
   * i.e. once it is sealed and on the wire, not when the user pressed Send.
   *
   * The record shows sent and received notes side by side, and a row that
   * appeared on the click would be a claim the app cannot support: a send
   * that rejects (peer left mid-seal, transport died) would leave a "Sent"
   * row behind for a note that never left. File sends already work this way
   * — see the `outgoing` comment in useSession — and notes now match.
   */
  | { t: 'text-sent'; content: string }
  | { t: 'error'; fileId?: number; message: string }
  /**
   * One of the four `media-*` control frames, worker → page — already
   * whitelisted by the Receiver (shared/media-signal.ts) before Session
   * ever raised its `onMediaSignal` event, so the page does not re-parse it
   * either. This task wires the transport only; nothing yet reads this
   * message on the page, and a live-media failure never becomes an 'error'
   * message — see the plan's global constraints.
   */
  | { t: 'media-signal'; signal: MediaControl }
  /*
   * Peer RPC, worker → page. Same shape and the same reason as the sink RPC
   * below: `RTCPeerConnection` is `[Exposed=Window]`, so the connection is
   * built and owned on the page while `Session` — and every AES-GCM
   * operation — stays in this worker. Frames cross as transferable
   * ArrayBuffers, so nothing is copied.
   */
  | { t: 'peer-open'; id: number; isOfferer: boolean }
  /**
   * Separate from `peer-open` on purpose. The proxy builds the connection as
   * soon as it is constructed (so ICE starts gathering at the right moment
   * and with the right role) but only learns the timeout later, when
   * `negotiateUpgrade` calls `whenOpen`. Folding both into one message meant
   * sending `peer-open` twice with a meaningless second `isOfferer`, and a
   * host that mishandled it would build two RTCPeerConnections.
   */
  | { t: 'peer-wait-open'; id: number; timeoutMs: number }
  /**
   * `seq` is a per-connection counter the page echoes back in `peer-drain`
   * and `peer-message`. It is what lets the worker compute a synchronous
   * `bufferedAmount` for a buffer it cannot see — see peer-proxy.ts.
   */
  | { t: 'peer-send'; id: number; seq: number; frame: Uint8Array }
  /** An SDP or ICE payload off the relay, to be applied to the page's connection. */
  | { t: 'peer-signal-in'; id: number; requestId: number; payload: unknown }
  | { t: 'peer-close'; id: number }
  /*
   * Sink RPC, worker → page. Two of the three save tiers cannot be built in a
   * worker realm at all: `showSaveFilePicker` is Window-only and needs a user
   * gesture, and the Service Worker download tier needs a `document` to host
   * its navigating iframe — while `ServiceWorkerRegistration` is not
   * structured-cloneable, so it can never be posted in here either.
   *
   * So the worker keeps the Receiver and every AES-GCM operation, and the page
   * owns the real sink. Plaintext crosses as a transferable ArrayBuffer — a
   * pointer move, not a copy — which keeps the CPU-bound work in the worker
   * and the I/O-bound work where the platform requires it.
   */
  | { t: 'sink-open'; id: number; fileId: number; meta: FileMeta }
  | { t: 'sink-write'; id: number; fileId: number; chunk: Uint8Array }
  | { t: 'sink-close'; id: number; fileId: number }
  | { t: 'sink-abort'; id: number; fileId: number; reason: string };

/** The page's answer to one sink request. */
export type SinkResult = Extract<ToWorker, { t: 'sink-result' }>;

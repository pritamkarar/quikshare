/// <reference lib="webworker" />
import { Session } from '../session.js';
import { createProgressThrottle } from './client.js';
import { createPeerProxy, type PeerProxy } from './peer-proxy.js';
import { createSinkProxy, type SinkProxy } from './sink-proxy.js';
import type { FromWorker, ToWorker } from './messages.js';

declare const self: DedicatedWorkerGlobalScope;

let session: Session | undefined;
/** The page-side sinks this session's Receiver writes through. */
let sinks: SinkProxy | undefined;
/** The page-owned data connections this session negotiates through. */
let peers: PeerProxy | undefined;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => self.postMessage(msg, transfer);

const sendProgress = createProgressThrottle(200, (p) =>
  post({ t: 'send-progress', fileId: p.fileId, bytesMoved: p.bytesMoved, totalBytes: p.totalBytes, bytesPerSecond: p.bytesPerSecond }),
);
const receiveProgress = createProgressThrottle(200, (p) =>
  post({ t: 'receive-progress', fileId: p.fileId, bytesMoved: p.bytesMoved, totalBytes: p.totalBytes, bytesPerSecond: p.bytesPerSecond }),
);

function wire(s: Session): void {
  s.events.onPeerJoined = () => post({ t: 'peer-joined' });
  s.events.onPeerLeft = (reason) => post({ t: 'peer-left', reason });
  s.events.onSessionEnded = (reason) => post({ t: 'session-ended', reason });
  s.events.onTransportChange = (kind) => post({ t: 'transport', kind });
  s.events.onOffer = (files) => post({ t: 'offer', files });
  // Posted the moment a batch's ids are minted (see Sender.onFilesQueued),
  // not once the whole batch finishes sending — a page that learned about
  // these files only when `send-files` below resolves would show every row
  // as freshly started at the exact moment the transfer actually completed.
  s.events.onOutgoing = (files) => post({ t: 'outgoing', files });
  s.events.onText = (content) => post({ t: 'text', content });
  s.events.onPeerDevice = (info) => post({ t: 'peer-device', info });
  s.events.onVerification = (digits) => post({ t: 'verification', digits });
  s.events.onPeerVerified = () => post({ t: 'peer-verified' });
  s.events.onSelfDevice = (info) => post({ t: 'self-device', info });
  s.events.onMediaSignal = (signal) => post({ t: 'media-signal', signal });
  s.events.onError = (e) => post({ t: 'error', fileId: e.fileId, message: e.message });
  s.events.onSendProgress = (p) => sendProgress.report({ fileId: p.fileId, bytesMoved: p.bytesSent, totalBytes: p.totalBytes });
  s.events.onReceiveProgress = (p) => receiveProgress.report({ fileId: p.fileId, bytesMoved: p.bytesReceived, totalBytes: p.totalBytes });
  s.events.onSendFileDone = (fileId) => {
    // Flushed per file, the moment it finishes, rather than waiting for the
    // whole batch: without this, an earlier file's final progress sits
    // buffered until the last file in the batch finishes, and its row looks
    // stuck just short of complete while an unrelated file keeps moving.
    sendProgress.flush(fileId);
    post({ t: 'send-file-done', fileId });
  };
  s.events.onFileCancelled = ({ fileId, direction }) => {
    // Flushed for the same reason a finished file is: the throttle is
    // holding this file's last progress report, and without a flush the
    // cancelled row keeps whatever stale byte count was on screen when the
    // cooldown started. The cancelled side's own throttle only.
    (direction === 'send' ? sendProgress : receiveProgress).flush(fileId);
    post({ t: 'file-cancelled', direction, fileId });
  };
  s.events.onFileComplete = ({ meta, blob }) => {
    // Receive-side completion only (Session wires it exclusively off the
    // Receiver) — flush that file's receive cooldown. Flushing sendProgress
    // here, or flushing every tracked file id instead of just this one,
    // would reset an unrelated file's throttle state mid-transfer.
    receiveProgress.flush(meta.id);
    post({ t: 'file-complete', meta, blob });
  };
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  void (async () => {
    try {
      switch (msg.t) {
        case 'init': {
          // This worker can outlive a single Session — 'close' only clears
          // the `session` reference, not the worker — so a fresh 'init' must
          // not inherit a previous session's pending timers or per-file
          // baselines. File ids restart at 1 per session, and a stale
          // baseline would corrupt the new session's first rate calculation.
          sendProgress.reset();
          receiveProgress.reset();
          // Detected by the page and handed in, because this realm cannot
          // detect it: a dedicated worker has no `showSaveFilePicker` and no
          // document, so a probe run here would always answer 'blob'.
          const { saveCapability, forceTransport, device } = msg;
          // And for the same reason it cannot BUILD two of the three sinks:
          // the File System Access sink needs a picker, the Service Worker
          // sink needs a document to host its iframe — and a
          // ServiceWorkerRegistration is not structured-cloneable, so that
          // tier could never be handed across this boundary anyway.
          //
          // So the sink itself lives on the page and this proxy forwards to
          // it, which keeps the decryption here (a 4 GB transfer is roughly
          // 65,000 AES-GCM operations, and doing those on the main thread
          // starves the UI) and the file I/O where the platform requires it.
          // Plaintext crosses as a transferable buffer, so nothing is copied.
          //
          // A previous session must be closed BEFORE `peers` is retired
          // below, not after — and this worker previously skipped closing it
          // on re-init at all. `Session.close` tears down `#switchable`,
          // which (if this session had upgraded) calls the live
          // ProxyUpgradeTransport's own `close()` and THAT is what posts
          // `peer-close` to the page, releasing its real
          // RTCPeerConnection. `PeerProxy.closeAll` below uses `abandon`,
          // which marks a connection closed WITHOUT posting anything — it
          // exists to fail promises still pending on this side, not to tell
          // the page anything. Retiring `peers` first would flip that same
          // connection's `#closed` flag before `Session.close` ever ran, so
          // `transport.close()`'s own `if (this.#closed) return` would then
          // swallow the `peer-close` post entirely, orphaning a real
          // RTCPeerConnection on the page for the life of that tab.
          session?.close();
          session = undefined;
          sinks?.rejectAll('the session was restarted');
          sinks = createSinkProxy(saveCapability, post);
          peers?.closeAll('the session was restarted');
          peers = createPeerProxy(post);
          const options = {
            saveCapability, createSink: sinks.createSink, forceTransport, device,
            // `available` is the PAGE's answer — this realm has no
            // RTCPeerConnection to ask, which is the bug this whole change
            // fixes. See SessionOptions.webrtc.
            webrtc: { available: msg.webrtcAvailable ?? false, createTransport: peers.createTransport },
          };
          session = msg.intent.t === 'create'
            ? await Session.create(msg.wsUrl, options)
            : await Session.join(msg.wsUrl, msg.intent.code, options);
          wire(session);
          post({
            t: 'ready',
            code: session.code,
            peerId: session.peerId,
            shareUrl: session.shareUrl,
            // Read after wire(), so `onSelfDevice` is already installed for
            // any later change: this getter is the *initial* value only.
            device: session.selfDevice,
          });
          return;
        }
        case 'confirm-verification':
          session?.confirmVerification();
          return;
        // Always answered, even with no session to send from: the page is
        // waiting on this before it navigates, and a silent path here is a
        // button that does nothing.
        case 'end-session':
          await session?.endSession();
          post({ t: 'end-session-sent' });
          return;
        case 'send-files': {
          // The metas the sender mints are announced via onOutgoing above,
          // synchronously and before this resolves, so the UI keys progress
          // by the same ids from the moment the batch starts rather than
          // only once it finishes.
          await session?.sendFiles(msg.files);
          return;
        }
        // Awaited, then reported: `sendText` resolves only once the note is
        // sealed and handed to the transport. A rejection falls through to
        // the catch below and surfaces as an 'error' — with no `text-sent`,
        // so no row claims a note went that did not. A send with no session
        // returns silently — matching send-files and avoiding a false claim
        // that a note went out when the session vanished (e.g. racing close).
        case 'cancel-files':
          // Not awaited into a reply: the page has already struck the rows
          // out, and Session.cancelFiles does the local half before it ever
          // touches the transport, so there is nothing for the page to wait
          // on. Failures surface as the 'error' the catch below posts.
          await session?.cancelFiles(msg.direction, msg.fileIds);
          return;
        case 'send-text':
          if (!session) return;
          await session.sendText(msg.content);
          post({ t: 'text-sent', content: msg.content });
          return;
        /*
         * Caught locally rather than left to the try/catch below: that catch
         * posts `{t:'error'}`, which useSession turns into the session's own
         * error banner and, for a session-wide failure, its error *state* —
         * the exact thing the plan's global constraints forbid a live-media
         * failure from becoming. A signal issued before pairing, or after the
         * peer has gone, is swallowed here; Task 5's `LiveSession` is what
         * will eventually have somewhere of its own to report this kind of
         * failure (`LiveSessionEvents.onFailure`).
         */
        case 'send-media-signal':
          await session?.sendMediaSignal(msg.signal).catch(() => undefined);
          return;
        // The page answering one of this worker's sink requests. Routed before
        // anything else touches it: these never reach the Session.
        case 'sink-result': sinks?.settle(msg); return;
        case 'close': {
          // Belt and braces, not load-bearing: `useSession`'s cleanup posts
          // this and calls `terminate()` on the very next line, so this
          // handler will usually never run at all. What actually makes that
          // safe is that the page runs `host.abortAll` first, releasing every
          // real sink on its own side; this case matters only for a caller
          // that closes a session WITHOUT terminating the worker (a future
          // reuse of one worker across sessions, which 'init' above already
          // anticipates). Deleting it would look harmless and would not be.
          //
          // Closing tears the Receiver down, which aborts every sink still
          // open — those aborts are requests to the page, so they go out
          // before the proxy is retired below.
          session?.close();
          session = undefined;
          // Nothing may be left awaiting an answer from a page that has, in
          // all likelihood, already terminated this worker.
          sinks?.rejectAll('the session was closed');
          sinks = undefined;
          peers?.closeAll('the session was closed');
          peers = undefined;
          // A pending trailing-edge timer from an interrupted transfer must
          // not fire after close.
          sendProgress.reset();
          receiveProgress.reset();
          return;
        }
        // The page answering this worker's peer RPC. Caught here rather than
        // by an explicit case per `peer-*` tag: none of them collide with a
        // case above, so a `default` placed last still receives every one of
        // them intact, and these never reach the Session.
        default:
          if (peers?.handle(msg)) return;
          return;
      }
    } catch (error: unknown) {
      post({ t: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  })();
});

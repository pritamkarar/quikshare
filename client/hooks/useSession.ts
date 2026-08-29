import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkerClient } from '../worker/client.js';
import { createPeerHost } from '../worker/peer-host.js';
import { createSinkHost, type SinkHost } from '../worker/sink-host.js';
import type { FromWorker } from '../worker/messages.js';
import type { FileMeta, MediaControl } from '../../shared/messages.js';
import type { TransportKind } from '../transport/types.js';
import { resolvePageSave } from '../save/select.js';
import {
  chooseSaveDirectory, createDirectorySink, supportsDirectoryPicker,
  type FileSystemDirectoryHandleLike,
} from '../save/fsaccess.js';
import { describeThisDevice } from '../device.js';
import type { DeviceInfo } from '../../shared/device.js';

/**
 * 'gone' is distinct from 'ended': 'ended' is a peer that just left, with the
 * room still open and worth re-showing the QR for — 'gone' is a confirmed,
 * permanent outcome (Session.onSessionEnded) where re-showing the same code
 * cannot help, whichever of the two reasons caused it (see `endedReason`).
 */
export type SessionState = 'connecting' | 'waiting' | 'paired' | 'ended' | 'gone' | 'error';

/** How long `endSession` waits for the worker before letting the page go. */
const END_SESSION_TIMEOUT_MS = 1_500;

export type SessionIntent =
  | { t: 'create' }
  | { t: 'join'; code: string };

export interface TrackedFile {
  meta: FileMeta;
  direction: 'send' | 'receive';
  bytesMoved: number;
  bytesPerSecond: number;
  done: boolean;
  /**
   * Stopped early, by whichever side's user pressed cancel. Distinct from
   * `done`: a cancelled file never transferred whole, so a row must not
   * badge it Sent or Received, and its partial bytes were discarded rather
   * than saved.
   */
  cancelled?: boolean;
  /** Set only for a received file the in-memory tier produced a Blob for. */
  blobUrl?: string;
  /**
   * Arrival order within this session, from the same counter that stamps
   * notes. Not the worker's file id: ids are minted per-kind and restart
   * per session, so they cannot order a file against a note that arrived
   * between two of them. See client/ui/record.ts.
   */
  seq: number;
}

/**
 * A note that crossed, tagged with its direction and the ordinal it arrived
 * on. `seq` comes from the same counter that stamps files, which is the only
 * thing that can order a note against a file: the worker's file ids are
 * minted per-kind, so they cannot.
 */
export interface TrackedNote {
  seq: number;
  direction: 'send' | 'receive';
  content: string;
}

export interface SessionHandle {
  state: SessionState;
  code: string;
  shareUrl: string;
  files: TrackedFile[];
  /**
   * Every note that crossed, in either direction — replacing the
   * received-only `texts` this hook used to expose. A sent note is recorded
   * when the worker confirms it went (`text-sent`), never on the click.
   */
  notes: TrackedNote[];
  error: string | undefined;
  /** Set only alongside state === 'gone' — which of the two terminal outcomes this was. */
  endedReason: 'gave-up' | 'room-gone' | 'peer-ended' | undefined;
  /**
   * Something the user needs to know that is not a failure — the save tier
   * was downgraded, say. Kept apart from `error` so the two cannot overwrite
   * each other, and so a downgrade is not rendered as an alarm.
   */
  notice: string | undefined;
  /**
   * Whether this browser can be handed a whole folder to write into. False
   * everywhere but Chromium desktop — which is precisely where a multi-file
   * batch otherwise runs into "Allow this site to download multiple files?"
   * — so a screen must render the offer conditionally rather than assume it.
   */
  canChooseFolder: boolean;
  /**
   * The folder incoming files are being written into, or undefined while
   * they still go through the browser's downloads. Its bare name, which is
   * all the File System Access API exposes — never a path.
   */
  saveFolder: string | undefined;
  /**
   * Asks for that folder. MUST be called straight from a click: the picker
   * needs transient activation. Once, though — the handle it returns covers
   * every file for the life of the page, which is what makes this an
   * alternative to a browser download per file rather than a dialog per file.
   *
   * Cancelling is not an error and reports nothing. A real failure lands in
   * `error`, because a user who just clicked a button is owed an answer.
   */
  chooseFolder(): void;
  /** The live data-path transport. Task 4's TransferPanel reads this to show it honestly. */
  transportKind: TransportKind;
  /**
   * This device's role in the relay's pairing — `'a'` if it created the
   * session, `'b'` if it joined — undefined only before the first `ready`
   * message. Not new state: `client/session.ts`'s own `peerId` field has
   * always carried this, threaded through `client/worker/messages.ts`'s
   * `ready` message; nothing before Task 8 needed it on the page side.
   * Task 8's `LiveSession` (client/media/live-session.ts) needs a real
   * `'a' | 'b'` at construction time to compute WebRTC perfect-negotiation
   * politeness — defaulting it, rather than waiting for the real value,
   * would flip which device yields on glare for whichever one actually is
   * `'b'`. `TransferPanel` only ever exists once `session.state ===
   * 'paired'` (CreateScreen/SessionScreen's own guards), and this is set in
   * the same `ready` handler that unlocks both `'waiting'` and `'paired'`,
   * so by the time a consumer can render on `peerId`, it is always defined.
   */
  peerId: 'a' | 'b' | undefined;
  /**
   * This device, as the peer is being told about it — including the address
   * the relay observed, which is why it is undefined until the session is
   * connected rather than available synchronously from `describeThisDevice`.
   */
  selfDevice: DeviceInfo | undefined;
  /**
   * The other device, or undefined until it has said. Peer-authored and
   * already sanitised at the Receiver boundary (`parseDeviceInfo`), so every
   * field is safe to render as text — but still a *claim*, not a
   * measurement: nothing here is verified and nothing should be relied on.
   */
  peerDevice: DeviceInfo | undefined;
  /**
   * The six digits derived from the agreed session key, or undefined before
   * a peer has been paired with. Both devices show the same number when the
   * relay stayed out of the way, and different numbers when it did not —
   * which is the only thing standing between this session and a
   * machine-in-the-middle now that the key is agreed over the relay rather
   * than carried in the link. See client/crypto.ts's `deriveSession`.
   */
  verification: string | undefined;
  /** This device's user has confirmed the number. */
  verifiedByMe: boolean;
  /** The other device's user has confirmed it. Nothing sends until both are true. */
  verifiedByPeer: boolean;
  confirmVerification(): void;
  /**
   * Tells the peer this device is leaving on purpose, resolving once the
   * frame is out (or a moment has passed with no answer). Callers navigate
   * away on it — see `Session.endSession` for why the wait is load-bearing
   * rather than politeness.
   */
  endSession(): Promise<void>;
  sendFiles(files: File[]): void;
  /**
   * Stops files that are still moving, on both devices. `direction` is this
   * device's view of the ids — 'send' for files it is sending, 'receive'
   * for files it is receiving — and is required, because the two id spaces
   * are minted independently and overlap.
   *
   * A cancelled incoming file's partial bytes are discarded, never left on
   * disk as a truncated file with a real name.
   */
  cancelFiles(direction: 'send' | 'receive', fileIds: number[]): void;
  sendText(content: string): void;
  /**
   * Hands one of the four `media-*` control frames to the worker to seal
   * and send. Nothing in this codebase calls this yet — it exists so
   * Task 5's `LiveSession` has somewhere to post the signals it mints from
   * a real `RTCPeerConnection`.
   */
  sendMediaSignal(signal: MediaControl): void;
  /**
   * Subscribes to inbound media signalling, already whitelisted by the
   * Receiver before it ever reaches this hook (shared/media-signal.ts).
   * Returns an unsubscribe function.
   *
   * A callback subscription rather than a `files`/`notes`-style piece of
   * state: this hook has exactly one long-lived consumer in mind (Task 5's
   * `LiveSession`), which reacts to every signal as it streams in — an
   * offer, then a run of trickled ICE candidates — rather than rendering a
   * list of them, so there is nothing here worth keeping in React state. A
   * `Set` rather than a single slot because `<StrictMode>` mounts an effect
   * twice in development; a single slot would let the second mount's
   * subscribe silently replace the first's, and the first mount's own
   * cleanup would then unsubscribe the second mount's listener instead of
   * its own.
   */
  onMediaSignal(cb: (signal: MediaControl) => void): () => void;
}

/**
 * Rewrites the one row a worker message is about.
 *
 * A row is identified by BOTH its direction and its id, never the id alone:
 * a fileId is minted by whichever `Sender` produced the file, and every
 * Sender starts its own counter at 1 (client/transfer/sender.ts's
 * `#mintFileId`), so this device's first outgoing file and the peer's first
 * incoming one are both id 1. Matching on the id alone — which every one of
 * these handlers used to do — made each progress frame rewrite the other
 * direction's row too: a finished download would start counting an upload's
 * bytes, and either completion would badge both rows done. It is the same
 * collision `TrackedFile.seq` exists to work around when ordering a file
 * against a note.
 *
 * Kept as one helper rather than four inline predicates so a fifth
 * file-addressed message cannot reintroduce the id-only match by being
 * written in the older style.
 */
function updateFile(
  files: TrackedFile[],
  direction: TrackedFile['direction'],
  fileId: number,
  change: (file: TrackedFile) => TrackedFile,
): TrackedFile[] {
  return files.map((f) => (f.direction === direction && f.meta.id === fileId ? change(f) : f));
}

/** The relay lives behind the same origin, so the page never has to be told where it is. */
function relayUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/**
 * The page's escape hatch for suppressing the WebRTC upgrade — `?forceTransport=relay`.
 * A pure function of the URL string, not read inline, so it can be exercised
 * without a real `location` or a rendered hook: `Session` runs inside a Web
 * Worker, whose own `location.href` is the worker SCRIPT's URL, so this must
 * be read here, on the page, and threaded through the worker's 'init'
 * message instead.
 */
export function forceTransportFromUrl(href: string): 'relay' | undefined {
  return new URL(href).searchParams.get('forceTransport') === 'relay' ? 'relay' : undefined;
}

/**
 * Transport and session failures travel as short protocol tokens, because
 * that is what the layers below switch on: `Sender.abort('peer-left')` makes
 * the in-flight `sendFiles` reject with exactly that string, and the worker's
 * catch reposts it verbatim. This hook is the boundary where a message stops
 * being machine state and becomes something a person reads, so it is where
 * the translation belongs — every reason, not just the one that was noticed.
 */
const REASON_COPY: Record<string, string> = {
  // The four refusals shared/signals.ts defines. RelayTransport.connect
  // rejects with the bare reason, so without these the most likely joiner
  // failure of all — a mistyped or expired code — degraded to "the transfer
  // stopped", which is both wrong and useless: nothing had started yet.
  'not-found': 'No session with that code. It may have expired, or been typed differently. Check the other device and try again.',
  full: 'That session already has two devices connected. Ask the other device to start a new one.',
  'rate-limited': 'Too many attempts from this network in the last minute. Wait a moment and try again.',
  'bad-request': 'The relay would not accept this connection. Reload the page and try again.',
  'peer-left': 'The other device disconnected before the transfer finished.',
  'peer left': 'The other device disconnected before the transfer finished.',
  'socket-closed': 'The connection dropped before the transfer finished.',
  'session closed': 'The session was closed before the transfer finished.',
  'the session was closed': 'The session was closed before the transfer finished.',
  'the session was restarted': 'The session restarted before the transfer finished.',
  'websocket error': 'This device could not reach the relay. Check the connection and try again.',
};

/**
 * A token, not a sentence: lowercase words and hyphens, no punctuation, no
 * capital. Everything the layers below deliberately write for a human — the
 * integrity-check failure, the save tier's advice, `Session.join`'s missing
 * key — fails this test and is passed through untouched, so translating here
 * can never swallow copy that was already fit to show.
 */
const RAW_TOKEN = /^[a-z][a-z0-9-]*(?: [a-z0-9-]+)*$/;

function userFacing(message: string): string {
  const known = REASON_COPY[message];
  if (known) return known;
  // An unrecognised token degrades instead of leaking: a reason added below
  // this layer must not reach the user as jargon merely because nobody
  // remembered to extend the map above.
  return RAW_TOKEN.test(message)
    ? 'The transfer stopped unexpectedly. Ask the other device for a fresh link and try again.'
    : message;
}

/**
 * What a session-level failure does to the phase.
 *
 * 'ended' is terminal: a peer that left has left, and the error that follows
 * it (the same departure, seen a second time as the in-flight send rejecting)
 * must not drag the screen back off the disconnect state and onto a
 * live-looking transfer panel. 'gone' is even more final — a confirmed,
 * permanent outcome — and for the identical reason must not be clobbered by
 * whatever trailing error the same disconnect produces elsewhere. 'paired'
 * is kept for the opposite reason — pairing is a fact, and one failed send
 * is no reason to throw away the queue and the drop zone the user is still
 * looking at.
 *
 * What is left is the reading both screens now share: 'error' means the
 * session never got going, and is never the transfer panel.
 */
function afterSessionError(previous: SessionState): SessionState {
  return previous === 'ended' || previous === 'gone' || previous === 'paired' ? previous : 'error';
}

/**
 * Owns one transfer session: the worker that runs it, the page-side sinks it
 * writes through, and the state a screen renders from.
 *
 * The split matters. Every AES-GCM operation happens in the worker — a 4 GB
 * transfer is roughly 65,000 of them, and on the main thread they starve the
 * UI and slow the transfer. But the sinks stay here, because two of the three
 * save tiers cannot exist in a worker realm at all, so the worker writes
 * through a proxy that this hook answers.
 */
/**
 * `describeThisDevice` is written not to throw — every storage access in it
 * is already guarded — but it is the one thing in the init path that reads
 * host APIs of any kind, and it exists purely to fill in a cosmetic panel.
 * If some future browser makes `navigator.userAgent` or `screen` throw, the
 * session must still start; a missing description costs a card that reads
 * "unknown", which is not worth a failed transfer.
 */
function describeSelfSafely(): DeviceInfo | undefined {
  try {
    return describeThisDevice();
  } catch {
    return undefined;
  }
}

export function useSession(intent: SessionIntent): SessionHandle {
  const [state, setState] = useState<SessionState>('connecting');
  const [code, setCode] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [files, setFiles] = useState<TrackedFile[]>([]);
  const [notes, setNotes] = useState<TrackedNote[]>([]);
  /**
   * One counter for both kinds, in a ref rather than state: it is read and
   * incremented inside the worker message handler, where a stale closure
   * over a state value would hand two items the same ordinal and make their
   * order arbitrary.
   *
   * KNOWN, dev-only, deliberately not changed. All four sites that stamp an
   * ordinal ('offer', 'outgoing', 'text', 'text-sent' below) run
   * `++arrivalSeq.current` *inside* the `setFiles`/`setNotes` updater, which
   * makes the updater impure. `client/main.tsx` mounts under `<StrictMode>`,
   * and StrictMode double-invokes state updaters in development, so a
   * development build burns two ordinals per item and the record's accessible
   * names read "note 2, note 4, note 6". Everything the ordinal is actually
   * for survives: each dispatch is atomic, so the values stay unique and
   * strictly increasing, and the record's newest-first sort (client/ui/record.ts)
   * is unaffected. Production, where StrictMode does not double-invoke, is
   * unaffected entirely. Stamping outside the updater would remove the gap,
   * but it is four touched call sites, in the same commit as a virtualizer
   * fix, to correct a cosmetic dev-only artefact of a number the user never
   * sees as a number — so it is recorded here instead.
   */
  const arrivalSeq = useRef(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [endedReason, setEndedReason] = useState<'gave-up' | 'room-gone' | 'peer-ended' | undefined>(undefined);
  /** Resolves the in-flight `endSession()`, set only while one is waiting. */
  const endSentRef = useRef<(() => void) | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [saveFolder, setSaveFolder] = useState<string | undefined>(undefined);
  /**
   * The picked folder itself. A ref rather than state because the sink
   * factory below is built once, inside the session effect, and has to read
   * whatever the most recent click left here — a state value captured in
   * that closure would stay the one from mount forever, and re-running the
   * effect to refresh it would tear down the live session.
   */
  const saveDir = useRef<FileSystemDirectoryHandleLike | undefined>(undefined);
  const [transportKind, setTransportKind] = useState<TransportKind>('relay');
  const [peerId, setPeerId] = useState<'a' | 'b' | undefined>(undefined);
  const [selfDevice, setSelfDevice] = useState<DeviceInfo | undefined>(undefined);
  const [peerDevice, setPeerDevice] = useState<DeviceInfo | undefined>(undefined);
  const [verification, setVerification] = useState<string | undefined>(undefined);
  const [verifiedByMe, setVerifiedByMe] = useState(false);
  const [verifiedByPeer, setVerifiedByPeer] = useState(false);
  const clientRef = useRef<WorkerClient | undefined>(undefined);
  /** See `SessionHandle.onMediaSignal`'s doc comment for why this is a Set, not a slot. */
  const mediaSignalListeners = useRef(new Set<(signal: MediaControl) => void>());
  // The intent is fixed for the lifetime of a screen: a create screen never
  // becomes a join screen. Held in a ref so the effect below can depend on
  // nothing and still read it, rather than re-running — and tearing down a
  // live session — every time a caller passes a fresh object literal.
  const intentRef = useRef(intent);

  useEffect(() => {
    // The `new URL(..., import.meta.url)` form, written inline, is what lets
    // the bundler find the worker and emit it as its own chunk.
    const worker = new Worker(new URL('../worker/transfer-worker.ts', import.meta.url), { type: 'module' });
    const client = new WorkerClient(worker);
    clientRef.current = client;

    let tornDown = false;
    /** Revoked on teardown; each one otherwise pins a whole received file in memory. */
    const objectUrls: string[] = [];

    // Detected in the realm where the probes are meaningful: a worker has no
    // picker and no document, so a probe run there always answers 'blob'. The
    // tier travels to the worker; the sinks stay on this side.
    const save = resolvePageSave();
    // Built now rather than when that resolves, so there is no window in which
    // a sink request could arrive with nothing on this side to answer it. The
    // factory waits on the tier instead; the receiver already tolerates a
    // factory that takes its time.
    const host: SinkHost = createSinkHost({
      factory: async (meta) => {
        // Read per file rather than captured once: the folder can be picked
        // at any point in a live session, and every file that arrives after
        // that click belongs in it. A directory handle needs no gesture of
        // its own, so this stays a plain call from the receive path.
        const dir = saveDir.current;
        if (dir) return createDirectorySink(meta, dir);
        return (await save).createSink(meta);
      },
      post: (result) => client.post(result),
    });
    const peerHost = createPeerHost({ post: (result, transfer) => client.post(result, transfer) });

    client.on((msg: FromWorker) => {
      // The page's half of the worker's save proxy. These are requests, not
      // events: they are answered here and never reach the UI state below.
      if (host.handle(msg)) return;
      // The page's half of the worker's peer proxy — requests, not events.
      if (peerHost.handle(msg)) return;

      switch (msg.t) {
        case 'ready':
          setCode(msg.code);
          setShareUrl(msg.shareUrl);
          setSelfDevice(msg.device);
          setPeerId(msg.peerId);
          setState(intentRef.current.t === 'create' ? 'waiting' : 'paired');
          return;
        case 'verification':
          // A number arriving is a number that CHANGED — the worker sends one
          // per key agreement, and a reconnect by the same peer re-derives
          // nothing. Both confirmations are dropped with it: whatever the two
          // users compared last time was a different session key.
          setVerification(msg.digits);
          setVerifiedByMe(false);
          setVerifiedByPeer(false);
          return;
        case 'peer-verified': setVerifiedByPeer(true); return;
        case 'end-session-sent': endSentRef.current?.(); return;
        case 'self-device': setSelfDevice(msg.info); return;
        case 'peer-device': setPeerDevice(msg.info); return;
        case 'peer-joined':
          // A peer arriving is a working session, which makes any error from
          // the last one stale: without this the host who watched a peer
          // leave mid-transfer keeps a red "The other device disconnected
          // before the transfer finished." alert on screen through the whole
          // of the next transfer with the replacement peer.
          setError(undefined);
          // Whoever is arriving has not described themselves yet, and the
          // description on screen belongs to the peer that left. Cleared
          // rather than left standing, so the panel says "waiting" for the
          // moment between the two rather than attributing the old device's
          // address and id to the new one. The replacement's own `device`
          // message follows within the same hello exchange.
          setPeerDevice(undefined);
          setState('paired');
          return;
        case 'peer-left': setState('ended'); return;
        case 'session-ended': setEndedReason(msg.reason); setState('gone'); return;
        case 'transport': setTransportKind(msg.kind); return;
        case 'offer':
          setFiles((prev) => [
            ...prev,
            ...msg.files.map((meta) => ({
              meta, seq: ++arrivalSeq.current, direction: 'receive' as const,
              bytesMoved: 0, bytesPerSecond: 0, done: false,
            })),
          ]);
          return;
        case 'outgoing':
          setFiles((prev) => [
            ...prev,
            ...msg.files.map((meta) => ({
              meta, seq: ++arrivalSeq.current, direction: 'send' as const,
              bytesMoved: 0, bytesPerSecond: 0, done: false,
            })),
          ]);
          return;
        case 'send-progress':
          setFiles((prev) => updateFile(prev, 'send', msg.fileId, (f) => (
            { ...f, bytesMoved: msg.bytesMoved, bytesPerSecond: msg.bytesPerSecond }
          )));
          return;
        case 'receive-progress':
          setFiles((prev) => updateFile(prev, 'receive', msg.fileId, (f) => (
            { ...f, bytesMoved: msg.bytesMoved, bytesPerSecond: msg.bytesPerSecond }
          )));
          return;
        case 'send-file-done':
          // The send-side counterpart of 'file-complete': one file of a batch
          // finished independently of the rest, so it is marked done (and its
          // bytes shown as fully moved) the moment it happens rather than
          // whenever the last file in the batch catches up.
          setFiles((prev) => updateFile(prev, 'send', msg.fileId, (f) => (
            { ...f, done: true, bytesMoved: f.meta.size }
          )));
          return;
        case 'file-complete': {
          const blobUrl = msg.blob ? URL.createObjectURL(msg.blob) : undefined;
          if (blobUrl) objectUrls.push(blobUrl);
          setFiles((prev) => updateFile(prev, 'receive', msg.meta.id, (f) => (
            { ...f, done: true, bytesMoved: msg.meta.size, blobUrl }
          )));
          return;
        }
        case 'file-cancelled':
          // Not routed to `error`: the user asked for this. The row stops
          // where it stopped — the byte count is left alone rather than
          // zeroed, because how far it got before being cancelled is the
          // one thing worth still seeing.
          setFiles((prev) => updateFile(prev, msg.direction, msg.fileId, (f) => (
            { ...f, cancelled: true, done: false }
          )));
          return;
        case 'text':
          setNotes((prev) => [...prev, { seq: ++arrivalSeq.current, direction: 'receive', content: msg.content }]);
          return;
        case 'text-sent':
          setNotes((prev) => [...prev, { seq: ++arrivalSeq.current, direction: 'send', content: msg.content }]);
          return;
        case 'error':
          setError(userFacing(msg.message));
          // A per-file failure is not the session failing. Flipping the whole
          // screen to an error state because one file failed its integrity
          // check would throw away a session that is still perfectly usable.
          if (msg.fileId === undefined) setState(afterSessionError);
          return;
        case 'media-signal':
          // Not routed through `error`/`setState` on any path, ever — see
          // this task's global constraints. Nothing subscribes yet; a
          // signal arriving before Task 5's LiveSession exists is simply
          // dropped, the same way an inbound `device` with no panel
          // mounted would be.
          for (const cb of mediaSignalListeners.current) cb(msg.signal);
          return;
      }
    });

    const start = async (): Promise<void> => {
      const { capability, notice } = await save;
      if (tornDown) return;
      // Shown, not swallowed: this is the only warning that the size ceiling
      // just dropped from "whatever fits on disk" to what fits in memory.
      if (notice) setNotice(notice);
      client.post({
        t: 'init',
        wsUrl: relayUrl(),
        intent: intentRef.current,
        saveCapability: capability,
        forceTransport: forceTransportFromUrl(location.href),
        // Detected here, on the page, for the same reason the save tier is:
        // the worker has neither `screen` nor `localStorage`. Wrapped
        // because it touches storage, which *throws* rather than merely
        // returning null wherever site data is blocked — and a device panel
        // must never be the reason a session fails to start.
        device: describeSelfSafely(),
        // Answered here because this is the realm that would actually host
        // the connection. Asking inside the worker — which is what the code
        // used to do — always answers "no": RTCPeerConnection is
        // [Exposed=Window].
        webrtcAvailable: typeof RTCPeerConnection !== 'undefined',
      });
    };

    // `resolvePageSave` is written not to reject, but nothing here can enforce
    // that: if it ever did, `init` would never be posted and the screen would
    // sit on "Starting a session…" forever with nothing to show for it.
    void start().catch((failure: unknown) => {
      if (tornDown) return;
      setError(userFacing(failure instanceof Error ? failure.message : String(failure)));
      setState(afterSessionError);
    });

    return () => {
      tornDown = true;
      // The page owns the sinks, and the worker is terminated on the next
      // line, so it cannot ask for this itself. Without it a
      // FileSystemWritableFileStream is left open and a partial file stays
      // on disk.
      host.abortAll('the session was closed');
      peerHost.closeAll();
      client.post({ t: 'close' });
      client.terminate();
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, []);

  const confirmVerification = useCallback(() => {
    // Set here rather than on a message back from the worker: this is the
    // user's own action on this device, and the worker's own copy
    // (Session.#localVerified) is idempotent, so there is nothing to
    // reconcile. A 'verification' message — a new key, a new number —
    // clears it again.
    setVerifiedByMe(true);
    clientRef.current?.post({ t: 'confirm-verification' });
  }, []);

  const endSession = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        endSentRef.current = undefined;
        resolve();
      };
      // Bounded, because the caller navigates on this and a button whose
      // whole job is to leave must never be the thing that traps someone.
      // Expiring is not a failure: it means the peer will fall back to the
      // rejoin screen it would have shown anyway.
      const timer = setTimeout(settle, END_SESSION_TIMEOUT_MS);
      endSentRef.current = settle;
      client.post({ t: 'end-session' });
    });
  }, []);

  const chooseFolder = useCallback(() => {
    void chooseSaveDirectory().then(
      (dir) => {
        saveDir.current = dir;
        setSaveFolder(dir.name);
        // A downgrade `notice` is deliberately left standing. Files now land
        // in the folder rather than in memory, but the ceiling the peer was
        // told about at `hello` time has not moved, so the sender still
        // refuses what that notice warns about.
      },
      (failure: unknown) => {
        // Closing the picker is a decision, not a failure — reporting it
        // would put a red alert on screen for someone who changed their mind.
        if (failure instanceof DOMException && failure.name === 'AbortError') return;
        setError(userFacing(failure instanceof Error ? failure.message : String(failure)));
      },
    );
  }, []);

  const sendFiles = useCallback((chosen: File[]) => {
    // No optimistic rows: the worker announces the real metas via 'outgoing',
    // and only those ids match the progress messages that follow.
    clientRef.current?.post({ t: 'send-files', files: chosen });
  }, []);

  const cancelFiles = useCallback((direction: 'send' | 'receive', fileIds: number[]) => {
    if (fileIds.length === 0) return;
    clientRef.current?.post({ t: 'cancel-files', direction, fileIds });
  }, []);

  const sendText = useCallback((content: string) => {
    clientRef.current?.post({ t: 'send-text', content });
  }, []);

  const sendMediaSignal = useCallback((signal: MediaControl) => {
    clientRef.current?.post({ t: 'send-media-signal', signal });
  }, []);

  const onMediaSignal = useCallback((cb: (signal: MediaControl) => void) => {
    mediaSignalListeners.current.add(cb);
    return () => { mediaSignalListeners.current.delete(cb); };
  }, []);

  return {
    state, code, shareUrl, files, notes, error, endedReason, notice, transportKind, peerId,
    // A probe of a global, so it cannot change while this page is open and
    // needs no state of its own.
    canChooseFolder: supportsDirectoryPicker(), saveFolder, chooseFolder,
    selfDevice, peerDevice, verification, verifiedByMe, verifiedByPeer, confirmVerification,
    sendFiles, cancelFiles, sendText, sendMediaSignal, onMediaSignal, endSession,
  };
}

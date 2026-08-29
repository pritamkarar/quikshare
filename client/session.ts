import { RelayTransport } from './transport/relay.js';
import { RECONNECT_BUDGET_MS, Reconnector } from './transport/reconnect.js';
import type { Transport, TransportKind } from './transport/types.js';
import { HIGH_WATER_BYTES } from './transport/types.js';
import {
  SwitchableTransport, TransportSwapGate, negotiateUpgrade, type UpgradeTransportFactory,
} from './transport/upgrade.js';
import type { FileMeta, MediaControl, SaveCapability } from '../shared/messages.js';
import { formatIp, type DeviceInfo } from '../shared/device.js';
import { createSinkFactory, detectSaveCapability, type SinkFactory } from './save/select.js';
import {
  deriveSession, exportPublicKey, fromBase64Url, generateKeyPair, generateNoncePrefix,
  importKey, toBase64Url,
} from './crypto.js';
import { FrameType, decodeControl, decodeFrame, encodeControl, encodeFrame } from './protocol.js';
import { Sender } from './transfer/sender.js';
import { Receiver } from './transfer/receiver.js';

export interface SessionEvents {
  onPeerJoined?: () => void;
  onPeerLeft?: (reason: string) => void;
  onOffer?: (files: FileMeta[]) => void;
  /**
   * Fired the moment a batch's file ids are minted, before any of its bytes
   * are sent — see `Sender.onFilesQueued` for why that timing matters.
   */
  onOutgoing?: (files: FileMeta[]) => void;
  onSendProgress?: (p: { fileId: number; bytesSent: number; totalBytes: number }) => void;
  onReceiveProgress?: (p: { fileId: number; bytesReceived: number; totalBytes: number }) => void;
  /** One file of a send batch fully sent and acknowledged with `file-end`. */
  onSendFileDone?: (fileId: number) => void;
  /**
   * One file stopped early because it was cancelled. `direction` is which
   * of this device's two id spaces the fileId belongs to — 'send' for a
   * file this device was sending, 'receive' for one it was receiving —
   * without which a listener cannot tell the two files that share id 1
   * apart.
   */
  onFileCancelled?: (p: { fileId: number; direction: 'send' | 'receive' }) => void;
  onFileComplete?: (r: { meta: FileMeta; blob?: Blob }) => void;
  onText?: (content: string) => void;
  onError?: (e: { fileId?: number; message: string }) => void;
  /** The live data-path transport changed — either a WebRTC upgrade landed, or a downgrade fell back to the relay. */
  onTransportChange?: (kind: TransportKind) => void;
  /**
   * This session is over, permanently — distinct from onPeerLeft, which
   * fires immediately on any disconnect (including a transient one this
   * side is actively trying to reconnect from) and always implies the room
   * might still be usable. This fires only once a Reconnector has actually
   * confirmed there is nothing left to try: 'gave-up' means every retry was
   * exhausted (this device's own connectivity, not necessarily the room,
   * is the problem), 'room-gone' means the relay explicitly said the room
   * itself no longer exists (not-found). Neither case should keep offering
   * the same QR code — 'gave-up' because rescanning it cannot fix a local
   * connectivity failure, 'room-gone' because there is nothing left to
   * scan into.
   */
  /**
   * This session is over for good, and the same code cannot recover it.
   *
   * 'gave-up' is this device's own connectivity and 'room-gone' is the relay
   * saying the room no longer exists — neither is fixed by scanning again.
   * 'peer-ended' is the third: the other device's user chose to end it and
   * said so before leaving (shared/messages.ts's `end-session`).
   */
  onSessionEnded?: (reason: 'gave-up' | 'room-gone' | 'peer-ended') => void;
  /**
   * The peer described its hardware (shared/messages.ts, `device`). Purely
   * informational — nothing in the transfer path reads it — and already
   * sanitised by `parseDeviceInfo` before it gets here, so it is safe to
   * render as text. Fires again on a reconnect, and again for a replacement
   * peer, since both re-run the hello exchange that prompts it.
   */
  onPeerDevice?: (info: DeviceInfo) => void;
  /**
   * This device's own description, *completed* — the caller supplies
   * everything a browser can know about itself, and the relay supplies the
   * one thing it cannot (its address), so the finished object only exists
   * once a connection is up. Fires only on a genuine change after
   * create()/join() resolve: a reconnect that lands on a different network
   * (wifi to cellular, say) changes the address mid-session, and the panel
   * would otherwise keep showing the one from before the drop.
   */
  onSelfDevice?: (info: DeviceInfo) => void;
  /**
   * The six-digit number derived from the agreed key, ready to be shown and
   * compared with the other device (client/crypto.ts's `deriveSession`).
   * Fires once per key agreement: at pairing, and again whenever a
   * *different* peer takes the room's free slot — never on a reconnect by
   * the same peer, which re-derives nothing. Every firing invalidates any
   * confirmation the last one earned: the number changed, so both sides
   * must look again.
   */
  onVerification?: (digits: string) => void;
  /** The peer's user confirmed the number matches. Sends unblock once both sides have. */
  onPeerVerified?: () => void;
  /**
   * One of the four `media-*` control frames arrived from the peer, already
   * whitelisted by the Receiver (`parseMediaOffer`/`parseMediaAnswer`/
   * `parseMediaIce` in shared/media-signal.ts) — see that module's doc
   * comment for why this is the only place a media signal is validated at
   * all. Nothing in this task produces or consumes one; it exists so the
   * worker bridge (client/worker/transfer-worker.ts) and, later, Task 5's
   * `LiveSession` have somewhere to receive it.
   */
  onMediaSignal?: (signal: MediaControl) => void;
}

export interface SessionOptions {
  /**
   * How this device will save incoming files. Defaults to a probe of this
   * browser. Passed explicitly by a caller that resolved it in another realm —
   * the transfer worker has neither a document nor a file picker, so its page
   * detects the tier and hands it in.
   */
  saveCapability?: SaveCapability;
  /**
   * Required by the 'sw-stream' tier and ignored by the others. Registration
   * belongs at app startup, not here: a worker registered at the first
   * transfer is active but not yet controlling the page, and only a
   * controlling worker intercepts the download.
   */
  swRegistration?: ServiceWorkerRegistration;
  /**
   * Where received bytes actually go. Defaults to this realm's own factory for
   * the chosen tier. Passed explicitly by a caller whose realm cannot build
   * the sink it advertises: the transfer worker hands in a proxy that forwards
   * every write to the page, which owns the picker and the document those
   * tiers need. The capability above is still what the hello advertises — this
   * only changes which realm the bytes are written in.
   */
  createSink?: SinkFactory;
  /**
   * Escape hatch: skips the WebRTC upgrade entirely, staying on the relay for
   * the life of the session, even when RTCPeerConnection is available.
   *
   * Read from the page's query string and threaded through here via the
   * worker's 'init' message (see client/hooks/useSession.ts and
   * client/worker/transfer-worker.ts) rather than read directly from
   * `location.href` in this file: `Session` runs inside a Web Worker, and a
   * worker's own `location.href` is the worker SCRIPT's URL, not the page's
   * — reading the query string here would silently never see it.
   */
  forceTransport?: 'relay';
  /**
   * How this session reaches a WebRTC data path, and whether it can at all.
   *
   * Both halves in one option on purpose: `available` without a
   * `createTransport` is a promise this class cannot keep, and the two were
   * previously answered by a single `typeof RTCPeerConnection` check in
   * whatever realm happened to be running — which is the bug this whole
   * change exists to fix. `Session` runs in a Web Worker, where that check is
   * ALWAYS false, so the upgrade never once ran in production and every
   * session was permanently relayed.
   *
   * The page answers `available` (it is the realm that would host the
   * connection) and supplies a factory that proxies to it. Omitted entirely,
   * this session never attempts an upgrade — which is the right default for
   * a caller that has not thought about realms, and is what the Node test
   * environment wants.
   */
  webrtc?: { available: boolean; createTransport: UpgradeTransportFactory };
  /**
   * How this device should describe itself to the peer. Detected by the
   * caller rather than here for the same reason `saveCapability` is: this
   * class runs inside a Web Worker, which has no `screen` and no
   * `localStorage` — so neither the display size nor the persistent device
   * id could be read from in here. See client/device.ts.
   *
   * Its `ip` is expected to be absent: a browser cannot see its own public
   * address, and this session fills that field in from the relay's own
   * `created`/`joined` signal. Omit the option entirely and this session
   * simply never announces a device, which the peer's panel renders as an
   * unknown card.
   */
  device?: DeviceInfo;
}

interface ResolvedSave {
  capability: SaveCapability;
  createSink: SinkFactory;
}

/**
 * What is advertised and what is used, resolved together from one value, so
 * the hello can never promise a tier the sinks do not implement.
 */
function resolveSave(options: SessionOptions): ResolvedSave {
  const capability = options.saveCapability ?? detectSaveCapability();
  return {
    capability,
    createSink: options.createSink ?? createSinkFactory(capability, options.swRegistration),
  };
}

const NONCE_PREFIX_BYTES = 3;
/**
 * Thrown by every send while either end of the pair has yet to confirm the
 * verification number. A sentence rather than a token, so `userFacing` in
 * client/hooks/useSession.ts passes it through to the screen unchanged.
 */
export const UNVERIFIED = 'Confirm the security number on both devices before sending anything.';
/**
 * Reported rather than swallowed: a peer on an incompatible build would
 * otherwise present as an indefinite hang. An untrusted relay can spam this,
 * but it can already do so through the catch in #route, so staying silent here
 * would not shrink that surface.
 */
export const MALFORMED_HELLO = 'The other device sent a handshake this build could not read.';
/**
 * A hello always precedes data on the real protocol path, so anything past
 * this is a relay flooding unauthenticated bytes into an unbounded buffer.
 */
const MAX_DEFERRED_FRAMES = 256;
export const DEFERRED_OVERFLOW = 'The other device sent data before the handshake completed; some of it was dropped.';

/**
 * Both inputs here are always exactly NONCE_PREFIX_BYTES long — this is a
 * plain equality check, not a timing-safe compare, because a nonce prefix
 * is not a secret (it travels in the clear in every hello).
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Joins the two halves of this device's description: what the browser knows
 * about itself, and the address only the relay can see. Returns a new object
 * rather than mutating the caller's, so the page's own copy — which it keeps
 * and renders — is never quietly changed underneath it by the worker.
 */
function withIp(device: DeviceInfo | undefined, ip: string | undefined): DeviceInfo | undefined {
  if (!device) return undefined;
  return ip === undefined ? device : { ...device, ip: formatIp(ip) };
}

export class Session {
  readonly code: string;
  readonly peerId: 'a' | 'b';
  readonly events: SessionEvents = {};

  /**
   * The raw relay connection. Kept separate from the data path on purpose:
   * SDP and ICE travel *through* the relay as out-of-band signalling
   * (sendSignal/onSignal), and room-presence (onPeerJoined/onPeerLeft) is a
   * fact about this connection specifically, not about whichever transport
   * currently carries encrypted frames. Never used for send/onMessage/
   * onDrain/onClose directly — those slots belong to #switchable, which
   * wraps this as its baseline and claims them.
   *
   * NOT readonly: a reconnect (#reconnect/#resumeAfterReconnect) replaces
   * this session's own dead relay socket with a freshly connected one, and
   * room-presence signals from that point on must come through the new
   * socket — the old one is closed and will never fire onPeerJoined/
   * onPeerLeft again.
   */
  #relay!: RelayTransport;
  /**
   * The live encrypted data path: everything Sender and Receiver actually
   * send and receive through goes here, never through #relay directly. Wraps
   * #relay as its baseline and, once negotiateUpgrade succeeds, swaps to a
   * WebRTCTransport — transparently to Sender/Receiver, which hold this same
   * reference for the life of the session and never learn a swap happened.
   *
   * NOT readonly, for the same reason #relay isn't: a reconnect builds a
   * brand new SwitchableTransport around the new relay socket rather than
   * reusing swapTo() on the old one — swapTo()'s "baseline" concept assumes
   * the baseline is still alive to fall back to, which is false here by
   * definition (the whole reason this session is reconnecting is that its
   * relay baseline just died).
   */
  #switchable!: SwitchableTransport;
  /**
   * Shared with negotiateUpgrade (see #startUpgrade): the single instance
   * that coordinates every frame Sender emits with a pending swap, so a swap
   * can only land at a frame boundary. Built once and reused across every
   * reconnect: it coordinates frame sends with a pending *transport swap*,
   * not with which relay socket happens to be live underneath, so nothing
   * about a reconnect requires a fresh one.
   */
  readonly #gate: TransportSwapGate;
  /**
   * The in-flight #startUpgrade attempt's controller, or undefined when no
   * attempt is pending. Two jobs: cancelling a stale negotiation (a
   * re-pairing after a peer leaves starts a new attempt targeting the new
   * peer, and the old one must never be allowed to swap in afterwards — see
   * negotiateUpgrade's `signal` option), and being the "is one already
   * running?" flag #startUpgrade needs, since `peer-joined` is a
   * relay-controlled signal and the relay is an active adversary here.
   */
  #upgradeAttempt: AbortController | undefined;
  readonly #forceTransport: 'relay' | undefined;
  readonly #webrtc: SessionOptions['webrtc'];
  /**
   * This session's ephemeral ECDH pair. Minted once in #init and kept for
   * the life of the session — a reconnecting peer re-sends the same public
   * key and must re-derive the same session key, exactly as it re-sends the
   * same nonce prefix (see #noncePrefix).
   */
  #keyPair: CryptoKeyPair | undefined;
  /** This device's public key, base64url, as every hello carries it. */
  #pub = '';
  /** The peer public key #key was derived from, so a repeat hello re-derives nothing. */
  #derivedFrom: string | undefined;
  /**
   * Set when a hello arrived before #init had finished minting this
   * session's key pair — there is nothing to derive against yet, so #init's
   * tail picks it up. The same field also carries the "send a hello as soon
   * as there is a public key to put in it" case, for a peer that joined
   * while this side was still generating.
   */
  #helloBeforeKeys: { pub: string; samePeer: boolean } | undefined;
  #helloDeferred = false;
  /**
   * Supersedes an in-flight derivation. A hello is relay-controlled, so two
   * can arrive back to back; without this, a slower first derivation could
   * land after a newer one and install the wrong key.
   */
  #deriveSeq = 0;
  #verification: string | undefined;
  #localVerified = false;
  #peerVerified = false;
  /** Advertised in every hello, and the tier #startReceiver builds sinks for. */
  readonly #save: ResolvedSave;
  /**
   * The prefix backing the current Sender. Minted once, in this field
   * initializer, and never regenerated for the life of the session —
   * `#buildSender` rebuilds the Sender itself (on `#unpair`'s deferred
   * discard-or-keep decision in `#route`, and on a reconnect) but always
   * against this same value. That is deliberate, not an oversight: the
   * peer's Receiver for the file this side is sending is a *persistent*
   * object (see Ruling H — it is never torn down just because this session's
   * Sender got rebuilt), and its `remoteNoncePrefix` is fixed at
   * construction with no way to update it later. Regenerating this prefix
   * out from under a receiver that is still expecting the old one would
   * break every subsequent frame's AEAD check on the peer's side, for a
   * receiver we specifically kept alive so a resume could use it.
   *
   * The guarantee that keeps AES-GCM safe was never that a (key, prefix)
   * pair is unique — nothing enforces that, and it cannot be enforced: the
   * prefix is 3 random bytes, and an untrusted relay can force unbounded
   * Sender rebuilds by synthesising peer-left, so a repeat was always
   * reachable even before this field stopped changing. The guarantee is
   * that the seq counter never restarts within a session. `#buildSender`
   * carries it across every rebuild, so even a repeated (or, now, always
   * identical) prefix yields fresh nonces.
   */
  #noncePrefix = generateNoncePrefix();
  readonly #deferred: Uint8Array[] = [];
  /** So a flooding relay is reported once, not once per dropped frame. */
  #deferredOverflowReported = false;
  #forward: ((raw: Uint8Array) => void) | undefined;
  #sender: Sender | undefined;
  #receiver: Receiver | undefined;
  #key: CryptoKey | undefined;
  #remoteNoncePrefix: Uint8Array | undefined;
  #pendingHello: (() => void) | undefined;
  #pendingHelloReject: ((error: Error) => void) | undefined;
  /**
   * Set once this session can never pair again, so a send issued *after* the
   * close fails immediately instead of registering a waiter nothing will ever
   * settle. 'peer-left' deliberately does not set it — the room outlives the
   * departing peer and a replacement can still arrive.
   */
  #closedReason: string | undefined;
  /**
   * Distinguishes "we closed" from "they left". Without it, closing your own
   * tab fires onPeerLeft('socket-closed') and the UI announces that the *other*
   * device disconnected.
   */
  #closedLocally = false;
  /**
   * Held so #reconnect can build a Reconnector: create()/join() only ever
   * had this as a local parameter before Task 6, and a reconnect needs it
   * on the instance to rejoin the same relay origin later.
   */
  readonly #wsUrl: string;
  /** Set while a reconnect attempt is in flight; one per disconnect episode (see #reconnect). */
  #reconnector: Reconnector | undefined;
  /**
   * Every File ever handed to sendFiles, keyed by the fileId Sender minted
   * for it, so an incoming 'resume-from' (Ruling F: untrusted — it is
   * whatever the peer's Sender put in a control frame) can be resolved back
   * to a real File to resume, and so "is this a fileId we actually queued"
   * can be checked before acting on anything else in the message. Entries
   * are removed as their file finishes (successfully or not) — see
   * #buildSender's onFileDone — so this does not grow for the session's
   * lifetime.
   */
  readonly #queuedFiles = new Map<number, File>();
  /**
   * The File[] of whichever sendFiles() call is *currently* inside its
   * Sender.sendFiles(...) call, so the Sender's onFilesQueued callback (which
   * only receives the minted FileMeta[], not the original Files) can pair
   * each meta back up with the File at the same array index. Set and cleared
   * synchronously around that one call — onFilesQueued fires before the
   * first await inside it, so no other sendFiles() call can interleave and
   * observe a stale value in between.
   */
  #pendingSendBatch: File[] | undefined;
  /**
   * fileIds with a resumeFile() call currently in flight. #resyncReceiveState
   * can fire twice for one reconnect episode — once directly from
   * #resumeAfterReconnect, once more when the peer's own reply hello arrives
   * at #route's samePeerReconnected branch — and a hostile peer can just
   * spam resume-from for the same fileId directly (Ruling F amplification).
   * Either way, two concurrent resumeFile() calls for the same file each
   * resend overlapping ranges, which the receiver's completion gate then
   * (correctly, but needlessly) fails as "sent more data than it offered".
   * Guards #handleResumeFrom so only the first of any such pair proceeds —
   * it always covers everything a later, redundant one would, since
   * bytesReceived only ever grows.
   */
  readonly #resumingFiles = new Set<number>();
  /**
   * The nonce prefix of the last peer this session accepted a hello from,
   * kept deliberately past both #unpair (which clears #remoteNoncePrefix to
   * gate sends) and #peerGoneTimer (which drops the Receiver). Those two are
   * what "is this the same peer?" used to be inferred from, and both are
   * gone exactly when the question is hardest: a hello arriving after the
   * timer fired, or after a session that only ever *sent*, had no Receiver
   * to compare against at all and so read as "same peer" by default —
   * letting a replacement inherit the departed peer's queued fileIds. This
   * field answers the question that was actually being asked.
   */
  #lastPeerPrefix: Uint8Array | undefined;
  /**
   * Armed by #unpair, cleared by a fresh hello (#route) or by close(). There
   * is no protocol-level "the peer is never coming back" signal on this
   * side of a peer-left — #reconnect's own giveUp has one (its Reconnector
   * exhausted every retry, or the relay said the room is gone), but the
   * *surviving* peer has nothing but silence to go on. Left unbounded, a
   * peer that genuinely never returns would leave this Receiver's sink(s)
   * — a streaming File System Access handle, a download stuck at zero —
   * open until the user manually ends the session. RECONNECT_BUDGET_MS is
   * the least-bad bound available: at least as long as a full Reconnector
   * retry cycle could plausibly take.
   */
  #peerGoneTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * This device's finished self-description, or undefined if the caller
   * never supplied one. Sent to the peer once per hello exchange — see
   * #announceDevice — and readable by the caller through `selfDevice`.
   */
  #device: DeviceInfo | undefined;

  private constructor(
    relay: RelayTransport, code: string, peerId: 'a' | 'b', save: ResolvedSave,
    forceTransport: 'relay' | undefined, wsUrl: string, device: DeviceInfo | undefined,
    webrtc: SessionOptions['webrtc'],
  ) {
    this.code = code;
    this.#device = device;
    this.peerId = peerId;
    this.#save = save;
    this.#forceTransport = forceTransport;
    this.#webrtc = webrtc;
    this.#wsUrl = wsUrl;
    this.#gate = new TransportSwapGate();

    this.#attachRelay(relay);
    // Built before #init ever calls #buildSender: the Sender must be handed
    // this switchable, never the raw relay, or a later swap would change
    // what the switchable points at while the Sender keeps sending through
    // the relay forever — silently inert, and invisible to a test that only
    // checks transportKind.
    this.#attachSwitchable(relay);
  }

  static async create(wsUrl: string, options: SessionOptions = {}): Promise<Session> {
    const conn = await RelayTransport.connect(wsUrl, { t: 'create' });
    const session = new Session(
      conn.transport, conn.code, conn.peerId, resolveSave(options), options.forceTransport, wsUrl,
      withIp(options.device, conn.ip), options.webrtc,
    );
    await session.#init();
    return session;
  }

  static async join(wsUrl: string, code: string, options: SessionOptions = {}): Promise<Session> {
    const conn = await RelayTransport.connect(wsUrl, { t: 'join', code });
    const session = new Session(
      conn.transport, conn.code, conn.peerId, resolveSave(options), options.forceTransport, wsUrl,
      withIp(options.device, conn.ip), options.webrtc,
    );
    await session.#init();
    // The joiner never receives a peer-joined signal — it *is* the peer that
    // joined — so it greets the host explicitly.
    session.#sendHello();
    session.#startUpgrade();
    return session;
  }

  /**
   * Wires up room-presence for whichever relay socket is currently ours —
   * the original one from create()/join(), or a fresh one from a successful
   * #reconnect. Extracted from the constructor so both call the exact same
   * wiring rather than a hand-copied approximation of it.
   */
  #attachRelay(relay: RelayTransport): void {
    this.#relay = relay;
    relay.onPeerJoined(this.#handlePeerJoined);
    // A room-presence fact, not a transport lifecycle event: it must reach
    // this handler even after an upgrade has detached #relay's onClose slot
    // (see SwitchableTransport's doc comment in client/transport/upgrade.ts).
    relay.onPeerLeft(this.#handlePeerLeft);
  }

  #handlePeerJoined = (): void => {
    this.#sendHello();
    this.events.onPeerJoined?.();
    this.#startUpgrade();
  };

  #handlePeerLeft = (): void => {
    this.#sender?.abort('peer-left');
    this.#failPendingHello('peer-left');
    this.#unpair();
    if (!this.#closedLocally) this.events.onPeerLeft?.('peer-left');
  };

  /**
   * Builds a fresh SwitchableTransport around `relay` as its baseline and
   * wires up everything Session needs from it. A genuine fresh object each
   * time (constructor, or a successful reconnect) rather than reusing
   * swapTo() on an existing one: swapTo()'s whole "baseline" concept assumes
   * the baseline is still alive to fall back to if the newly-swapped-in
   * transport later dies, which is false for a reconnect by definition — the
   * relay we are replacing is the one that just died. Reusing it there would
   * leave a *second* failure silently re-binding a socket that already fired
   * its one and only 'close' event and will never fire another.
   */
  #attachSwitchable(relay: RelayTransport): void {
    // Closed, not just dropped: on a reconnect this replaces a switchable
    // whose baseline socket is dead but whose *upgraded* transport may not
    // be — dropping the reference alone would leak that RTCPeerConnection
    // for the life of the page. A no-op on the constructor's first call.
    this.#switchable?.close();
    this.#switchable = new SwitchableTransport(relay);
    this.#switchable.onKindChange((kind) => {
      this.events.onTransportChange?.(kind);
      // A downgrade is a reconnect without a hello: the connection that was
      // carrying frames a moment ago has gone, and anything that was on it
      // when it went is lost — including, in the worst case, a whole file
      // the peer's Sender has already written and is waiting to hear about.
      // Nothing else fires here (fallBack is deliberately invisible to the
      // Sender, so the transfer carries on over the relay), so without this
      // the lost frames have no path back. Guarded on a peer being present:
      // #unpair falls back too, and there is nobody to tell.
      if (kind === 'relay' && this.#remoteNoncePrefix) void this.#resyncReceiveState();
    });
    // Pushed rather than waited for: onKindChange only ever fires on a
    // *change*, so a brand-new switchable built during a reconnect would
    // otherwise leave whatever the UI last heard standing — a badge still
    // reading 'webrtc' over a session that is now plainly back on the relay.
    // A no-op from the constructor (events are wired after create()/join()
    // resolve) and idempotent for the UI, which only re-renders on a change.
    this.events.onTransportChange?.(this.#switchable.kind);
    // Bound to the switchable, not the raw relay: once a swap lands, incoming
    // frames arrive on whichever transport is live, and #route must not care.
    // A reconnect calls this method again for a brand new SwitchableTransport,
    // which needs this registered on it too, not just on the original one.
    this.#switchable.onMessage((raw) => this.#route(raw));
    // Fires exactly when the *live* data path has genuinely died: a
    // successful upgrade detaches the relay's onClose, and the upgraded
    // transport dying triggers an internal fallback rather than reaching
    // here (see SwitchableTransport). Sender does not register onClose
    // itself: Transport has a single close-callback slot and the Session
    // owns it. Without this the sender's in-flight awaitDrain would stay
    // pending forever on a dead transport.
    this.#switchable.onClose((reason) => {
      this.#sender?.abort(reason);
      this.#failPendingHello(reason);
      if (this.#closedLocally) {
        // ??=: close() already set the more useful 'session closed'.
        this.#closedReason ??= reason;
        return;
      }
      // This session's OWN connection died — try to get it back before
      // treating the session as over. See #reconnect.
      this.#reconnect(reason);
    });
  }

  get transportKind(): TransportKind {
    return this.#switchable.kind;
  }

  /**
   * This device's own description, complete with the address the relay
   * observed. Undefined when the caller supplied no `device` option. Read
   * once by the worker as create()/join() resolve; later changes arrive
   * through `onSelfDevice` instead.
   */
  get selfDevice(): DeviceInfo | undefined {
    return this.#device;
  }

  /**
   * The URL to encode as a QR code — and, now, one a person can read out or
   * type. It carries no key: the code names the room, and the key is agreed
   * between the two devices (see client/crypto.ts's `deriveSession`). What
   * the link no longer has is a `#` and 43 characters of base64 after it.
   */
  get shareUrl(): string {
    const base = typeof location === 'undefined'
      ? 'https://quik.share'
      : `${location.protocol}//${location.host}`;
    return `${base}/s/${this.code}`;
  }

  async sendFiles(files: File[]): Promise<FileMeta[]> {
    await this.#awaitHello();
    this.#requireVerified();
    // See #pendingSendBatch's doc comment: this makes the File[] available to
    // the Sender's onFilesQueued callback, synchronously, for exactly the
    // duration of this call.
    this.#pendingSendBatch = files;
    try {
      return await this.#sender!.sendFiles(files);
    } finally {
      this.#pendingSendBatch = undefined;
    }
  }

  /**
   * Awaits the handshake for the same reason sendFiles does: without it a send
   * issued before the peer arrives is sealed, handed to a transport with no
   * peer, and lost with a resolved promise and no error.
   */
  async sendText(content: string): Promise<void> {
    await this.#awaitHello();
    this.#requireVerified();
    await this.#sender!.sendText(content);
  }

  /**
   * Hands one of the four `media-*` control frames to this session's Sender,
   * once a peer is actually there to receive it — same reasoning as
   * `sendText`: a signal issued before pairing would seal and hand to a
   * transport with no peer on the other end, and vanish with a resolved
   * promise and no error. `msg` is trusted here: it either originated on
   * this device (Task 5's `LiveSession`, built from a real
   * `RTCPeerConnection`) or already passed through the Receiver's whitelist
   * on the way in — this method is plumbing, not a second parse boundary.
   */
  async sendMediaSignal(msg: MediaControl): Promise<void> {
    await this.#awaitHello();
    this.#requireVerified();
    await this.#sender!.sendMediaSignal(msg);
  }

  close(): void {
    this.#closedReason = 'session closed';
    this.#closedLocally = true;
    this.#sender?.abort('session closed');
    this.#failPendingHello('session closed');
    // Dropping the Receiver alone abandons its sinks mid-write. Harmless for
    // the blob sink, but Plan 2's File System Access and Service Worker sinks
    // would leak a file handle and leave a partial file on disk.
    this.#receiver?.abortAll('session closed');
    this.#receiver = undefined;
    this.#forward = undefined;
    this.#clearDeferred();
    // Same for a negotiation still in flight: aborting it closes its
    // RTCPeerConnection now (see negotiateUpgrade's `signal`), where
    // otherwise it would keep gathering ICE after the session is over and
    // then try to swap itself into a switchable that is already closed.
    this.#upgradeAttempt?.abort();
    this.#upgradeAttempt = undefined;
    // A reconnect attempt still pending would otherwise keep trying the
    // relay in the background after the caller has already walked away —
    // stop() is safe to call even if nothing is in flight.
    this.#reconnector?.stop();
    this.#reconnector = undefined;
    // A pending "give up on this peer" timer must not fire after close():
    // the Receiver it would abort is already gone, and #closedLocally
    // (already set above) makes the abort moot anyway, but a live timer
    // outliving the session it belongs to is not a well-behaved teardown.
    clearTimeout(this.#peerGoneTimer);
    this.#queuedFiles.clear();
    // Closes whichever transport(s) are actually in play: just the relay if
    // never upgraded, or both the live WebRTC transport and the baseline
    // relay if it was. Closing only the raw relay here would leave an
    // upgraded RTCPeerConnection/DataChannel open and leaking.
    this.#switchable.close();
  }

  /**
   * Mints this session's ECDH pair. No session key exists yet at this point
   * and cannot: it is derived from the peer's public key, which arrives in
   * their hello. Everything that needs the key — the Sender, the Receiver,
   * the device announcement — is built in #establish instead.
   *
   * #attachSwitchable already registered onMessage, synchronously, in the
   * constructor — before this function's first await — so a hello arriving
   * during the generation below is routed rather than dropped
   * (RelayTransport queues nothing). #route parks it in #helloBeforeKeys,
   * which the tail of this method then picks up; the same tail sends this
   * side's own hello if a peer turned up while there was no public key to
   * put in it.
   */
  async #init(): Promise<void> {
    this.#keyPair = await generateKeyPair();
    this.#pub = await exportPublicKey(this.#keyPair);
    if (this.#helloDeferred) {
      this.#helloDeferred = false;
      this.#sendHello();
    }
    const parked = this.#helloBeforeKeys;
    if (parked) {
      this.#helloBeforeKeys = undefined;
      void this.#establish(parked.pub, parked.samePeer);
    }
  }

  /**
   * Turns the peer's public key into this session's key, and everything that
   * needs one into a live object.
   *
   * Called from #route for every well-formed hello, and from #init's tail
   * for one that beat the key pair into existence. Re-derivation is skipped
   * when the peer's key is unchanged — a reconnecting peer re-sends the same
   * one — so a reconnect keeps the key, the verification number, and the
   * confirmations both users already gave. A *different* key is a different
   * peer: it produces a different number, and both confirmations are
   * withdrawn, because nobody has looked at the new one yet.
   *
   * Failure is reported rather than swallowed: an unusable public key means
   * this session can never carry a byte, and silence would present as a
   * permanent "connecting…".
   */
  async #establish(pub: string, samePeerReconnected: boolean): Promise<void> {
    if (!this.#keyPair) {
      // #init has not finished; its tail replays this.
      this.#helloBeforeKeys = { pub, samePeer: samePeerReconnected };
      return;
    }
    try {
      if (pub !== this.#derivedFrom) {
        const attempt = ++this.#deriveSeq;
        const { rawKey, verification } = await deriveSession(this.#keyPair.privateKey, pub, this.code);
        const key = await importKey(rawKey);
        // A newer hello superseded this one while the maths ran. Installing
        // this key now would replace the newer peer's key with an older
        // peer's, and every frame after it would fail its integrity check.
        if (attempt !== this.#deriveSeq) return;
        this.#key = key;
        this.#derivedFrom = pub;
        this.#verification = verification;
        // The Sender is rebuilt against the new key here rather than left as
        // it was: #route only discards the RECEIVER for a replacement peer,
        // and a Sender still holding the departed peer's key would seal
        // frames the new one cannot open.
        this.#buildSender();
        this.events.onVerification?.(verification);
      }
      this.#startReceiver();
      this.#settlePendingHello();
      // After #startReceiver, not before: the peer is answering with its own
      // device message at the same moment, and this side must have somewhere
      // to route it.
      this.#announceDevice();
      // A reconnect keeps this side's confirmation, but the peer's Receiver
      // was rebuilt and has not heard it — so say it again. Nothing is sent
      // for a first pairing, where nobody has confirmed anything yet.
      if (this.#localVerified) this.#sendVerified();
      // Only for a reconnect: a genuinely new peer's Receiver was just built
      // fresh above and has nothing yet to resume.
      if (samePeerReconnected) void this.#resyncReceiveState();
    } catch (error: unknown) {
      this.events.onError?.({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The user at this device says the number on screen matches the one on the
   * other device. Idempotent, and inert before a key exists — a confirmation
   * of a number that has not been derived yet would be a confirmation of
   * nothing.
   */
  confirmVerification(): void {
    if (this.#localVerified || !this.#verification) return;
    this.#localVerified = true;
    this.#sendVerified();
  }

  /** The number both users compare, or undefined before a key is agreed. */
  get verification(): string | undefined {
    return this.#verification;
  }

  /**
   * Both users have confirmed, for the pairing that is live right now.
   *
   * The prefix is part of the question, not decoration: #unpair clears it the
   * moment a peer leaves, and a confirmation is about the key this session
   * agreed with THAT peer. Leaving this true across a departure would let the
   * first send after a replacement peer's hello go out on the strength of a
   * number the new pair never compared.
   */
  get verified(): boolean {
    return this.#remoteNoncePrefix !== undefined && this.#localVerified && this.#peerVerified;
  }

  #sendVerified(): void {
    // Same treatment as #announceDevice: a failed send here is retried by
    // the next hello exchange, and routing it to onError would put a red
    // alert in front of a user whose session is fine.
    void this.#sender?.sendVerified().catch(() => undefined);
  }

  /**
   * Tells the peer this device is leaving on purpose, and resolves once the
   * frame has been handed to the transport.
   *
   * Awaited by the caller for a reason that is easy to miss: `useSession`'s
   * cleanup posts `close` to the worker and calls `terminate()` on the very
   * next line, so a frame merely *queued* as the screen navigates away is
   * killed with the worker before it is ever written. Resolving here is what
   * lets the page hold the navigation until the bytes are out.
   *
   * Never rejects. Every reason it could — no peer has joined, the socket is
   * already gone, the transport is mid-swap — is a case where the peer
   * cannot be told and the user still has to be allowed to leave. Failing
   * would strand them on a screen they asked to close, which is a worse
   * outcome than the peer falling back to the rejoin screen it would have
   * shown anyway.
   */
  async endSession(): Promise<void> {
    await this.#sender?.sendEndSession().catch(() => undefined);
  }

  #handlePeerEnded = (): void => {
    // Terminal, and deliberately routed through the same event as the other
    // two terminal outcomes: what the screen has to do — stop offering this
    // code — is identical, and only the wording differs.
    this.events.onSessionEnded?.('peer-ended');
  };

  #handlePeerVerified = (): void => {
    if (this.#peerVerified) return;
    this.#peerVerified = true;
    this.events.onPeerVerified?.();
  };

  /**
   * The gate every send passes through. Rejects rather than waits: waiting
   * would hide a dropped file behind a spinner for as long as the other
   * person takes to look at their screen, and the screen already disables
   * the controls this could fire from.
   */
  #requireVerified(): void {
    if (!this.verified) throw new Error(UNVERIFIED);
  }

  /**
   * Tells the peer what this device is, once per completed hello exchange.
   *
   * Called from #route (the ordinary path: a hello arrived and a Sender is
   * already standing) and from the tail of #init (the race where the hello
   * beat the key import). A reconnect and a replacement peer both re-run the
   * hello exchange, so both re-announce for free — which is what the panel
   * needs, since a replacement peer has never seen this description and a
   * reconnect may have changed the address in it.
   *
   * Failures are swallowed deliberately. This is a cosmetic panel: a device
   * card that never fills in is a card that says "unknown", whereas routing
   * the rejection to `onError` would put a red alert about a failed transfer
   * in front of someone whose transfer is fine. Every path that actually
   * matters — the file frames themselves — reports its own failures.
   */
  #announceDevice(): void {
    const device = this.#device;
    if (!device || !this.#sender) return;
    void this.#sender.sendDevice(device).catch(() => undefined);
  }

  /**
   * Re-completes this device's description after a reconnect landed on a
   * different address — a laptop that moved from wifi to cellular mid
   * session is the ordinary case. Compared before firing so an ordinary
   * reconnect on the same network is silent rather than re-rendering the
   * panel for an identical value.
   */
  #applySelfIp(ip: string | undefined): void {
    const updated = withIp(this.#device, ip);
    if (!updated || updated.ip === this.#device?.ip) return;
    this.#device = updated;
    this.events.onSelfDevice?.(updated);
  }

  /**
   * The only place a Sender is constructed. Never regenerates #noncePrefix
   * (see that field's doc comment) — carries both the seq counter (via
   * `initialSeq: previous?.nextSeq ?? 0n`, the one thing that must survive
   * every rebuild for nonces to stay unique) and the fileId counter (via
   * `initialFileId: previous?.nextFileId ?? 1`, required on `Sender` as of
   * fix-round-4: without it a batch sent right after a rebuild could mint a
   * fileId still in flight on the receiver's side, silently replacing that
   * file's `Incoming` entry — see `SenderOptions.initialFileId`'s own doc
   * comment for why that is a silent stall, not a loud failure) forward
   * instead of restarting either. Called for the first build (#init), after
   * a peer-left (#unpair, targeting the current #switchable, which #unpair
   * itself never replaces), and after this session's own reconnect
   * (#resumeAfterReconnect, targeting the freshly rebuilt #switchable).
   */
  #buildSender(): void {
    if (!this.#key) return;
    const previous = this.#sender;
    this.#sender = new Sender({
      transport: this.#switchable,
      key: this.#key,
      peerId: this.peerId,
      noncePrefix: this.#noncePrefix,
      initialSeq: previous?.nextSeq ?? 0n,
      // fix-round-4 (was Minor in round 3, corrected to Critical): the same
      // shape as initialSeq just above, and now required on Sender for the
      // same reason — see SenderOptions.initialFileId's doc comment.
      initialFileId: previous?.nextFileId ?? 1,
      // Optional where the two above are required — see the option's own doc
      // comment — but always passed: an ack landing after a rebuild names a
      // file this device sent, and a Sender that never heard of it leaves
      // the row at 100% until the next resync re-acks it.
      initialAwaitingAck: previous?.awaitingAck,
      gate: this.#gate,
      events: {
        onProgress: (p) => this.events.onSendProgress?.(p),
        onFileDone: (fileId) => {
          // Ruling I: without this, #queuedFiles grows for the whole
          // session — every file ever sent, never freed.
          this.#queuedFiles.delete(fileId);
          this.events.onSendFileDone?.(fileId);
        },
        onFileCancelled: (fileId) => {
          // Freed for the same reason onFileDone frees it: this file will
          // never be sent or resumed again, so holding its File pins the
          // whole thing in memory for the rest of the session.
          this.#queuedFiles.delete(fileId);
          this.events.onFileCancelled?.({ fileId, direction: 'send' });
        },
        onFilesQueued: (metas) => {
          const batch = this.#pendingSendBatch;
          if (batch) {
            for (const [index, meta] of metas.entries()) {
              const file = batch[index];
              if (file) this.#queuedFiles.set(meta.id, file);
            }
          }
          this.events.onOutgoing?.(metas);
        },
      },
    });
  }

  /**
   * A peer left, but the relay cannot tell "gone for good" apart from "about
   * to reconnect" (Ruling H) — every socket close of theirs looks identical
   * from here, whichever caused it. So this does the part that is safe to do
   * either way (this session's own Sender needs to be usable again the
   * moment a fresh hello arrives, from whoever ends up sending it; a
   * negotiation targeting the peer that just left must not swap in later;
   * an upgraded transport negotiated with them is no longer safe to keep
   * sending over) and leaves the Receiver and #remoteNoncePrefix alone.
   *
   * The decision #unpair does NOT make — discard the old Receiver and its
   * accumulated per-file progress, or keep serving it — waits for #route's
   * hello handling, which is the only place that can actually tell a
   * reconnecting peer (same prefix) apart from a replacement one (a fresh,
   * unrelated prefix): #unpair fires on an unauthenticated room-presence
   * signal with no prefix in it at all.
   */
  #unpair(): void {
    // #awaitHello() gates new sends on this: a peer that just left (even one
    // about to reconnect) must not have new sendFiles()/sendText() calls
    // fire into the relay while nobody is actually there to receive them.
    this.#remoteNoncePrefix = undefined;
    this.#clearDeferred();
    // A negotiation still in flight was targeting the peer that just left —
    // if it later opens anyway, it must not be allowed to swap in a
    // connection to nobody (or race a replacement peer's own upgrade).
    this.#upgradeAttempt?.abort();
    // Cleared, not just aborted: #startUpgrade treats a live controller as
    // "an attempt is already running", and a replacement peer arriving must
    // be able to start a fresh one without waiting on the aborted attempt's
    // own promise to settle first.
    this.#upgradeAttempt = undefined;
    // A transport upgrade was negotiated with the peer that just left — it is
    // never safe to keep sending a fresh peer's hello or data over it. Falls
    // back to the always-available relay so the next pairing starts from a
    // known-good baseline instead of a WebRTC connection that may take a
    // while to notice its own peer is actually gone. A no-op if there was
    // never an upgrade to begin with.
    this.#switchable.fallBack();
    this.#buildSender();
    // Fix-round-1, Important: bound how long the preserved Receiver waits
    // for the same peer's hello before concluding it is genuinely gone —
    // see #peerGoneTimer's doc comment. Re-armed (not merely left running)
    // on every peer-left, so a peer that leaves, briefly reconnects, then
    // leaves again gets the full budget again rather than whatever was left
    // of the first timer.
    clearTimeout(this.#peerGoneTimer);
    this.#peerGoneTimer = setTimeout(() => {
      this.#receiver?.abortAll('peer left');
      this.#receiver = undefined;
    }, RECONNECT_BUDGET_MS);
  }

  /**
   * Hello frames arrive before the receiver's own prefix is known, so this
   * session listens for them directly and hands off once paired. Everything
   * else is buffered until the receiver exists, so no frame that overtakes
   * the handshake is lost.
   *
   * The whole body is guarded: these are the only decodes in the client that
   * run on unauthenticated bytes. An untrusted relay can inject a short buffer
   * (decodeFrame throws), non-JSON (decodeControl throws) or a hello whose
   * noncePrefix is not a string (fromBase64Url throws) — and a throw here
   * would escape into the WebSocket listener, leaving #pendingHello unsettled
   * and the session silently wedged forever.
   *
   * WHAT AN INJECTED HELLO CAN DO, recorded rather than fixed. A hello is
   * unauthenticated by necessity: it carries the nonce prefix — and now the
   * ECDH public key — that both sides need before anything can be sealed at
   * all, so it cannot itself be sealed. An untrusted relay can forge one at
   * will, and doing so:
   *
   *   - reads as a replacement peer (random prefix), triggering
   *     `abortAll('peer replaced')` — killing the live Receiver and its sinks;
   *   - replayed verbatim, resets #peerGoneTimer every time, so the
   *     sink-lifetime bound #unpair exists to enforce can be pushed out
   *     indefinitely, and re-triggers #resyncReceiveState each time;
   *   - carrying a public key of the relay's own, agrees a NEW session key
   *     with this device — which is the machine-in-the-middle the key
   *     agreement made possible when it took the key out of the URL.
   *
   * The first two are availability-only: every data and control frame still
   * has to pass AEAD with the frame header as AAD, a strictly increasing
   * per-file sequence number, and (for data) its own byte offset bound into
   * the additional data, so a forged hello produces no wrong bytes on disk
   * and no repeated nonce. It ends or stalls a session the relay could have
   * ended by dropping the connection anyway.
   *
   * The third is the one that matters, and it is why #establish resets both
   * halves of the verification state whenever the peer's public key changes.
   * A relay that swaps in its own key gets a different shared secret with
   * each device, so the two devices derive different six-digit numbers; the
   * gate in #requireVerified holds every send until the two people confirm
   * they are looking at the same number, and a mid-session swap drops both
   * confirmations and puts the gate back up. The number is unforgeable
   * because it is a fingerprint of the key itself — but it is only checked
   * by a person, which is exactly what makes the confirmation a gate rather
   * than a badge.
   */
  #route(raw: Uint8Array): void {
    try {
      const frame = decodeFrame(raw);
      if (frame.type === FrameType.Hello) {
        const msg = decodeControl(frame.payload);
        if (msg.t !== 'hello' || typeof msg.noncePrefix !== 'string' || typeof msg.pub !== 'string') {
          this.events.onError?.({ message: MALFORMED_HELLO });
          return;
        }
        // The two peers' nonce spaces are disjoint only because their ids
        // differ. A peer claiming ours would share it, so refuse at the
        // handshake rather than leaving a confusing integrity failure later.
        if (msg.peerId === this.peerId) {
          this.events.onError?.({ message: MALFORMED_HELLO });
          return;
        }
        const prefix = fromBase64Url(msg.noncePrefix);
        // makeNonce requires exactly 3 bytes; a wrong length would throw later,
        // deep inside a seal, rather than here where we can report it.
        if (prefix.length !== NONCE_PREFIX_BYTES) {
          this.events.onError?.({ message: MALFORMED_HELLO });
          return;
        }

        // A well-formed hello, from whoever sent it, means someone is now in
        // the room — #unpair's "give up and abort the Receiver" timer no
        // longer applies, whether this turns out to be the same peer
        // reconnecting (samePeerReconnected below) or a replacement (whose
        // arrival already discards the old Receiver on its own).
        clearTimeout(this.#peerGoneTimer);

        // Ruling H: #unpair() deliberately left this decision for here,
        // where a prefix is actually available to check. A hello arriving
        // while a Receiver already exists is either the SAME peer
        // reconnecting (its Sender never regenerates its prefix — see
        // #noncePrefix's doc comment — so the prefix is unchanged) or a
        // genuinely different peer taking the room's free slot (a fresh,
        // unrelated one). Only the former can safely keep this Receiver's
        // accumulated per-file progress; the latter must discard it, or the
        // new peer's frames would be checked against someone else's prefix
        // and never authenticate.
        // Keyed on the peer, not on whether a Receiver happens to exist:
        // #peerGoneTimer may already have dropped it, and a session that
        // only ever sent never had one — in both cases a replacement peer
        // used to read as "same peer" purely by absence of evidence. The
        // very first hello of a session has nothing to compare against and
        // is correctly not-the-same; everything it clears is empty anyway.
        const samePeerReconnected = this.#lastPeerPrefix !== undefined
          && bytesEqual(this.#lastPeerPrefix, prefix);
        if (!samePeerReconnected) {
          // `?.`: only the former case has a Receiver to discard. Its
          // accumulated per-file progress cannot be kept for a different
          // peer — the new peer's frames would be checked against someone
          // else's prefix and never authenticate.
          this.#receiver?.abortAll('peer replaced');
          this.#receiver = undefined;
          // The bridge callback the discarded Receiver installed, dropped
          // with it. Left standing, every frame arriving before the
          // replacement's Receiver exists would be handed to a receiver that
          // is holding the departed peer's key — a window that used to be
          // one synchronous step wide and is now as wide as a key agreement.
          // Cleared, they stay in #deferred until the new Receiver attaches,
          // which is what that buffer is for.
          this.#forward = undefined;
          // Ruling I, second half: #queuedFiles is only pruned as files
          // finish, so a batch aborted by the departure leaves its entries
          // behind. They exist so a resume-from can be resolved back to a
          // real File — which is right for the SAME peer reconnecting, and
          // wrong for a replacement: theirs would resolve a fileId they never
          // received a byte of and trigger a full resend that their own
          // Receiver then rejects chunk by chunk, one error each.
          this.#queuedFiles.clear();
        }
        this.#lastPeerPrefix = prefix;

        // A hello carrying a public key this session has not derived against
        // is a hello that changes the session key, and #establish cannot do
        // that until some asynchronous maths finishes. Everything that would
        // be wrong to keep in the meantime is dropped here, synchronously, in
        // the same turn that accepts the hello: the old key (so #awaitHello
        // cannot release a send that would then be sealed for a peer who is
        // gone) and both halves of the verification (so the number nobody has
        // compared yet cannot inherit the confirmation for a number they did).
        if (msg.pub !== this.#derivedFrom) {
          this.#key = undefined;
          this.#localVerified = false;
          this.#peerVerified = false;
        }
        this.#remoteNoncePrefix = prefix;
        // Everything that needs the session key — deriving it from the
        // public key in this hello included — happens there, asynchronously.
        void this.#establish(msg.pub, samePeerReconnected);
        return;
      }
      // Bounded: these are unauthenticated bytes, and a relay that sends data
      // frames but never a hello would otherwise grow this without limit.
      if (this.#deferred.length >= MAX_DEFERRED_FRAMES) {
        if (!this.#deferredOverflowReported) {
          this.#deferredOverflowReported = true;
          this.events.onError?.({ message: DEFERRED_OVERFLOW });
        }
        return;
      }
      this.#deferred.push(raw);
      this.#drainDeferred();
    } catch (error: unknown) {
      this.events.onError?.({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #drainDeferred(): void {
    if (!this.#forward) return;
    while (this.#deferred.length > 0) this.#forward(this.#deferred.shift()!);
    // The backlog cleared, so a later flood is worth reporting again.
    this.#deferredOverflowReported = false;
  }

  #clearDeferred(): void {
    this.#deferred.length = 0;
    this.#deferredOverflowReported = false;
  }

  #startReceiver(): void {
    if (this.#receiver || !this.#key || !this.#remoteNoncePrefix) return;
    // The Receiver wants an onMessage slot of its own, but Transport has just
    // one and the Session holds it. This bridge hands it routed frames.
    const switchable = this.#switchable;
    // kind/bufferedAmount are live getters onto #switchable, not a one-time
    // snapshot: Receiver reads neither today (no branch on transport.kind,
    // no backpressure of its own), but a hardcoded 'relay'/0 here would be
    // actively wrong after an upgrade rather than merely unused, and a live
    // getter costs nothing over a stale literal.
    const bridge: Transport = {
      get kind() { return switchable.kind; },
      get bufferedAmount() { return switchable.bufferedAmount; },
      send: (frame) => switchable.send(frame),
      onMessage: (cb) => { this.#forward = cb; this.#drainDeferred(); },
      onDrain: () => undefined,
      onClose: () => undefined,
      close: () => undefined,
    };
    this.#receiver = new Receiver({
      transport: bridge,
      key: this.#key,
      peerId: this.peerId,
      remoteNoncePrefix: this.#remoteNoncePrefix,
      // The same tier the hello advertised, both the factory and the ceiling
      // the Receiver checks offers against. A failure to build a sink is
      // per-file and reported as such, rather than quietly falling back to
      // memory after telling the peer this device could take any size.
      createSink: this.#save.createSink,
      saveCapability: this.#save.capability,
      events: {
        onOffer: (files) => this.events.onOffer?.(files),
        onProgress: (p) => this.events.onReceiveProgress?.(p),
        onFileComplete: (r) => {
          this.events.onFileComplete?.(r);
          // The other half of `onFileDone`: this device is the only one that
          // knows the file arrived, so it has to say so. Fire-and-forget,
          // and a failure here is not the user's problem — the file is
          // saved. If the ack does not make it, the next resync re-sends it
          // (#resyncReceiveState).
          void this.#sender?.sendFileAck(r.meta.id).catch(() => undefined);
        },
        onFileAck: (fileId) => this.#handleFileAck(fileId),
        onText: (c) => this.events.onText?.(c),
        onError: (e) => this.events.onError?.(e),
        onResumeFrom: (fileId, bytesReceived) => this.#handleResumeFrom(fileId, bytesReceived),
        onFileCancelled: (fileId) => this.events.onFileCancelled?.({ fileId, direction: 'receive' }),
        onCancel: (side, fileIds) => this.#handleCancel(side, fileIds),
        onPeerDevice: (info) => this.events.onPeerDevice?.(info),
        onPeerVerified: this.#handlePeerVerified,
        onPeerEnded: this.#handlePeerEnded,
        onMediaSignal: (signal) => this.events.onMediaSignal?.(signal),
      },
    });
    this.#receiver.start();
  }

  /**
   * Stops files this device is sending, receiving, or both, and tells the
   * peer so its own half stops too.
   *
   * `direction` is this device's view of the ids, and it is required for the
   * same reason the wire frame carries `side`: id 1 routinely names two
   * different files at once, one in each direction.
   *
   * The local half happens first and unconditionally. The user asked for
   * this to stop, so it stops whether or not the frame reaches the peer —
   * a cancel that silently depended on a live transport would be at its
   * least reliable exactly when it is most wanted, on a connection already
   * in trouble. The frame is best-effort on top of that.
   */
  async cancelFiles(direction: 'send' | 'receive', fileIds: readonly number[]): Promise<void> {
    if (fileIds.length === 0) return;
    if (direction === 'send') {
      this.#sender?.cancel(fileIds);
    } else {
      await this.#receiver?.cancelIncoming(fileIds);
    }
    // 'send' here means "files I am sending", which is exactly what the
    // frame calls 'mine'; 'receive' means "files you are sending me",
    // which is 'yours'. See the `cancel` frame in shared/messages.ts.
    await this.#sender?.sendCancel(direction === 'send' ? 'mine' : 'yours', fileIds)
      .catch(() => undefined);
  }

  /**
   * Ruling F: `side` and `fileIds` are untrusted input, exactly like
   * `#handleResumeFrom`'s arguments. The frame arrived AEAD-decrypted, so
   * the relay could not have forged it — but the peer holds the same key,
   * and `decodeControl` is a bare `JSON.parse(...) as ControlMessage` with
   * no runtime validation, so the wire type's annotations guarantee nothing
   * at runtime.
   *
   * Every id is checked against a map this side owns rather than acted on:
   * a `side: 'yours'` cancel can only stop files this device actually
   * queued for sending, and a `side: 'mine'` cancel can only stop files it
   * was actually offered. That bounds the whole message to things already
   * in flight — a peer sending ten thousand junk ids gets ten thousand map
   * misses and nothing else, which is why no separate length cap is needed.
   *
   * An unrecognised-but-well-formed id is ignored in silence, for the same
   * reason `#handleResumeFrom` ignores one: a cancel racing a file that
   * just finished is ordinary, not adversarial.
   */
  #handleCancel(side: unknown, fileIds: unknown): void {
    if (side !== 'mine' && side !== 'yours') return;
    if (!Array.isArray(fileIds)) return;
    const ids = (fileIds as unknown[]).filter((id): id is number => Number.isInteger(id));
    if (ids.length === 0) return;

    if (side === 'yours') {
      // The peer is asking this device to stop sending. Only ids this
      // session actually queued can be stopped, which is the one check only
      // Session can make.
      const mine = ids.filter((id) => this.#queuedFiles.has(id));
      if (mine.length > 0) this.#sender?.cancel(mine);
      return;
    }
    // The peer stopped sending these. `cancelIncoming` ignores an id it has
    // no entry for, so no membership check of its own is needed here.
    void this.#receiver?.cancelIncoming(ids).catch(() => undefined);
  }

  /**
   * Ruling F: fileId/bytesReceived are untrusted input. The payload arrived
   * AEAD-decrypted (so the relay could not have forged it), but the peer
   * holds the same key and decodeControl (protocol.ts) is a bare
   * `JSON.parse(...) as ControlMessage` with no runtime validation — a
   * malicious or buggy peer can put anything at all in this message, and
   * TypeScript's `number` annotation on the wire type does not make it so at
   * runtime. Rejects anything that is not a fileId this side actually
   * queued for sending, or not a finite integer within [0, file.size],
   * without acting on it. Sender.resumeFile enforces the fromByte bound
   * again independently — this is the one check only Session can make,
   * since only Session tracks which fileIds are actually its own.
   */
  #handleResumeFrom(fileId: number, bytesReceived: number): void {
    if (typeof fileId !== 'number' || !Number.isInteger(fileId)) {
      this.events.onError?.({ message: 'The other device sent an invalid resume request and it was ignored.' });
      return;
    }
    const file = this.#queuedFiles.get(fileId);
    // Not an error: an unrecognised-but-well-formed fileId is exactly what a
    // stray or late-arriving resume-from for a file we never sent (or
    // already finished and cleared, see Ruling I) looks like — nothing to
    // act on, and not adversarial merely for arriving late.
    if (!file) return;
    if (typeof bytesReceived !== 'number' || !Number.isInteger(bytesReceived)
      || bytesReceived < 0 || bytesReceived > file.size) {
      this.events.onError?.({
        fileId, message: 'The other device sent an invalid resume offset and it was ignored.',
      });
      return;
    }
    // #resumingFiles guard: #resyncReceiveState can legitimately fire twice
    // for one reconnect episode (see that field's doc comment), and a
    // hostile peer can just spam resume-from for the same fileId directly.
    // Either way, a second one arriving while the first is still resuming
    // this file is ignored outright rather than starting a second,
    // concurrent resumeFile() call that would resend an overlapping range.
    if (this.#resumingFiles.has(fileId)) return;
    this.#resumingFiles.add(fileId);
    const meta: FileMeta = { id: fileId, name: file.name, size: file.size, type: file.type };
    void this.#sender?.resumeFile(file, meta, bytesReceived)
      .catch((error: unknown) => {
        this.events.onError?.({ fileId, message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { this.#resumingFiles.delete(fileId); });
  }

  /**
   * The peer says it has one of our files, whole.
   *
   * Validated because the id arrives as un-checked JSON (`decodeControl`)
   * from a frame a hostile relay cannot forge but a hostile PEER can send
   * freely. Nothing here indexes or trusts it: `confirmDelivered` is a set
   * lookup, so a made-up number finds nothing and reports nothing. A
   * well-formed id for a file we never sent is not an error either — a
   * duplicate ack from a resync is exactly that, and arriving late is not
   * adversarial.
   */
  #handleFileAck(fileId: unknown): void {
    if (typeof fileId !== 'number' || !Number.isInteger(fileId)) {
      this.events.onError?.({ message: 'The other device sent an invalid delivery confirmation and it was ignored.' });
      return;
    }
    this.#sender?.confirmDelivered(fileId);
  }

  /**
   * Tells the peer, over our own (possibly just-rebuilt) Sender, everything
   * this device knows about what it has received: where each in-flight file
   * has got to, and which ones arrived whole.
   *
   * Both halves exist because a transport that dies takes whatever was on it
   * with it, in both directions. A lost chunk leaves the peer's Sender ahead
   * of where this side actually is, which `resume-from` corrects. A lost
   * `file-ack` leaves the peer's row at 100% with nothing left in `#incoming`
   * to produce a resume point for — the file is finished here, so re-sending
   * the acknowledgement is the only thing that can finish it there.
   *
   * Fired from #route whenever a hello confirms the SAME peer is back —
   * covering both directions of a reconnect regardless of whose socket
   * actually dropped: the side that reconnected sends its own hello
   * explicitly (#resumeAfterReconnect, mirroring how a fresh join() already
   * has to), the side that stayed connected replies automatically via its
   * existing onPeerJoined handler, and each side's #route reacts to
   * whichever hello it receives. And from a downgrade, which is the same
   * kind of event without a hello: see #attachSwitchable.
   */
  async #resyncReceiveState(): Promise<void> {
    const receiver = this.#receiver;
    const sender = this.#sender;
    if (!receiver || !sender) return;
    // fix-round-3: resumePoints() is queued behind the receiver's own frame
    // chain (see its doc comment) — a synchronous read here could publish a
    // stale offset while frames from before the disconnect were still
    // queued to land. completedFiles() is read through the same chain, for
    // the same reason.
    for (const point of await receiver.resumePoints()) {
      try {
        await sender.sendResumeFrom(point.fileId, point.bytesReceived);
      } catch (error: unknown) {
        this.events.onError?.({
          fileId: point.fileId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const fileId of await receiver.completedFiles()) {
      // Silently: a re-acknowledgement that cannot go out is not something
      // to put in front of the user. The file is saved here either way, and
      // the next resync sends it again.
      await sender.sendFileAck(fileId).catch(() => undefined);
    }
  }

  /**
   * This session's OWN connection to the relay died — not the peer leaving
   * (that is relay.onPeerLeft, a signal about the OTHER side's socket, and
   * #handlePeerLeft above). Tries to rejoin the same room with the same code
   * before treating the session as over, so a transient network drop does
   * not throw away an in-flight transfer.
   *
   * The UI's "other device disconnected" state fires immediately, win or
   * lose: useSession's existing 'peer-joined' handling already flips it back
   * to 'paired' on its own once #resumeAfterReconnect fires that event, so a
   * reconnect that succeeds quickly looks like a brief flicker rather than a
   * new, bespoke "reconnecting…" state this task has no UI budget to add.
   */
  #reconnect(reason: string): void {
    this.events.onPeerLeft?.(reason);
    // One Reconnector per disconnect episode: #switchable.onClose can only
    // fire again for a NEW live transport once this one has actually landed
    // (reconnected or given up), so a second call here while one is already
    // running would be a bug elsewhere, not a case to double up on.
    if (this.#reconnector) return;

    const reconnector = new Reconnector(this.#wsUrl, this.code);
    this.#reconnector = reconnector;

    reconnector.onReconnected((conn) => {
      this.#reconnector = undefined;
      // close() can land while a reconnect is in flight; the caller already
      // walked away, so the newly-opened socket has nothing to resume.
      if (this.#closedLocally) { conn.transport.close(); return; }
      this.#resumeAfterReconnect(conn.transport, conn.ip);
    });
    const giveUp = (closeReason: string, terminalReason: 'gave-up' | 'room-gone'): void => {
      this.#reconnector = undefined;
      this.#closedReason ??= closeReason;
      this.#sender?.abort(closeReason);
      // Unlike #unpair, this IS the confirmed-gone case: our own Reconnector
      // exhausted every retry (or the relay said the room itself is gone),
      // so there is nothing left to resume for and this Receiver's sink(s)
      // should not stay open indefinitely.
      this.#receiver?.abortAll(closeReason);
      this.#receiver = undefined;
      // Terminal, so the same teardown close() does: a ~92s "give up on this
      // peer" timer must not outlive the session that armed it, and the
      // Files queued for sending are never going to be resumed by anyone.
      clearTimeout(this.#peerGoneTimer);
      this.#queuedFiles.clear();
      // Fix-round-1, Important: onPeerLeft already fired, immediately, when
      // the connection first dropped — offering the same recovery UI
      // (rescan the QR) as a genuine peer departure. Now that a real,
      // confirmed-terminal outcome exists, say so distinctly: neither
      // "gave-up" (our own connectivity, not the room) nor "room-gone" (the
      // room itself) can be fixed by scanning the same code again.
      this.events.onSessionEnded?.(terminalReason);
    };
    reconnector.onGaveUp(() => giveUp(reason, 'gave-up'));
    reconnector.onRoomGone(() => giveUp('room gone', 'room-gone'));
    reconnector.start();
  }

  /**
   * This session's own connection came back. Rebuilds the transport plumbing
   * around the new relay socket and picks the pairing back up exactly where
   * it was: same key, same #noncePrefix (never regenerated — see that
   * field's doc comment), same Receiver with whatever it already has. Only
   * the Sender is rebuilt, because it is the one thing whose `transport`
   * option pinned it to the now-dead #switchable; #buildSender still carries
   * `initialSeq: previous.nextSeq` across that rebuild exactly as it always
   * has, which is what keeps the seq counter — and therefore every nonce —
   * from ever repeating across the reconnect.
   */
  #resumeAfterReconnect(relay: RelayTransport, ip?: string): void {
    // Before the hello below, so the announcement that hello triggers
    // carries the address this session is *now* reachable at rather than the
    // one it had before the drop.
    this.#applySelfIp(ip);
    this.#attachRelay(relay);
    this.#attachSwitchable(relay);
    this.#buildSender();
    this.events.onPeerJoined?.();
    // Mirrors join(): this side just "joined" the room again from the
    // relay's point of view, and the peer's own onPeerJoined only fires for
    // someone ELSE arriving, never for your own successful join.
    this.#sendHello();
    this.#startUpgrade();
    void this.#resyncReceiveState();
  }

  /**
   * Plaintext by necessity: this frame delivers the nonce prefix the peer
   * needs before it can derive any nonce, so it cannot itself be sealed.
   * It carries no user data — peer id, nonce prefix, save capability, buffer
   * size. It goes straight out through the transport rather than through the
   * Sender, whose #sendControl is typed to reject 'hello' for this reason.
   * Its seq of 0n is unused: nothing derives a nonce from an unsealed frame,
   * so it cannot collide with the sender's counter.
   */
  #sendHello(): void {
    // A peer can join while #init is still minting the key pair. A hello
    // with no public key in it is a hello the peer cannot derive against,
    // so it waits for one rather than going out empty.
    if (!this.#pub) {
      this.#helloDeferred = true;
      return;
    }
    this.#switchable.send(encodeFrame(FrameType.Hello, 0, 0n, encodeControl({
      t: 'hello',
      peerId: this.peerId,
      noncePrefix: toBase64Url(this.#noncePrefix),
      pub: this.#pub,
      saveCapability: this.#save.capability,
      maxBufferedBytes: HIGH_WATER_BYTES,
    })));
  }

  /**
   * Fire-and-forgets a background attempt to upgrade the data path to
   * WebRTC. Called once the peer is present: from onPeerJoined (whichever
   * side is already in the room when someone else joins) and, for the
   * joiner itself, right after #sendHello in `join`.
   *
   * Guarded on #webrtc?.available — the page's answer to whether the page
   * (the realm that would actually host the connection) can reach WebRTC,
   * not whether this Session's own realm can — so a caller that never
   * supplied it (Node's test environment, or a browser that lacks WebRTC
   * entirely) simply never attempts one and stays on the relay — see the "no
   * WebRTC available at all" case in tests/integration/upgrade-fallback.
   * test.ts. #forceTransport is the same escape hatch, checked the same way,
   * for a caller that wants to suppress the upgrade even where WebRTC is
   * available.
   *
   * negotiateUpgrade never needs to know about the Sender: Ruling D replaced
   * the brief's whenIdle()/Sender-snapshot design with TransportSwapGate,
   * which Sender and this call share via #gate — see SenderOptions.gate and
   * TransportSwapGate's doc comment in client/transport/upgrade.ts.
   * negotiateUpgrade resolves either way (a failed upgrade just means the
   * session stays on the relay) and never rejects, so this is safe to fire
   * and forget.
   *
   * A no-op while an attempt is already in flight, or once the session is
   * already on WebRTC. Both callers are driven by `peer-joined`, which is a
   * relay-controlled signal in a threat model where the relay is an active
   * adversary — and `WebRTCTransport.offer` constructs a peer connection and
   * starts ICE immediately, so without this an N-frame flood produced N live
   * RTCPeerConnections and N ICE gatherings (until Chromium's per-page cap
   * threw, which negotiateUpgrade's own try now catches rather than turning
   * into an unhandled rejection). The non-adversarial half matters just as
   * much: a genuine duplicate peer-joined after a successful upgrade would
   * otherwise run a second negotiation whose swapTo detaches the first
   * transport. A re-pairing after #unpair is unaffected — #unpair aborts and
   * clears the attempt, so the next peer-joined starts a fresh one.
   */
  #startUpgrade(): void {
    // Asks the PAGE whether a connection is possible, not this realm. The
    // previous `typeof RTCPeerConnection === 'undefined'` check ran here, in
    // a Web Worker, where that class does not exist — so it was always true
    // and this method always returned on its first line. See
    // SessionOptions.webrtc.
    if (!this.#webrtc?.available || this.#forceTransport === 'relay') return;
    if (this.#upgradeAttempt || this.#switchable.kind === 'webrtc') return;
    const controller = new AbortController();
    this.#upgradeAttempt = controller;
    void negotiateUpgrade({
      switchable: this.#switchable,
      // The room creator offers; the joiner answers. A fixed role avoids glare.
      isOfferer: this.peerId === 'a',
      // Signalling travels through the relay, but out of band from the
      // encrypted data path — sent and received on #relay directly, never
      // through #switchable.
      sendSignal: (payload) => this.#relay.sendSignal({ t: 'rtc', payload }),
      onSignal: (cb) => this.#relay.onSignal((signal) => {
        if (signal.t === 'rtc') cb(signal.payload);
      }),
      createTransport: this.#webrtc.createTransport,
      gate: this.#gate,
      signal: controller.signal,
    // Guarded on identity: #unpair may already have cleared this and a
    // newer attempt taken its place by the time this one settles.
    }).finally(() => {
      if (this.#upgradeAttempt === controller) this.#upgradeAttempt = undefined;
    });
  }

  /**
   * Waiters chain rather than overwrite: two sends racing the handshake would
   * otherwise leave the first one pending forever. The rejection chain exists
   * so a send issued before the peer ever arrives fails with a reason the UI
   * can show, instead of hanging for the life of the page.
   */
  #awaitHello(): Promise<void> {
    if (this.#closedReason) return Promise.reject(new Error(this.#closedReason));
    // The key is part of the handshake now, not something #init already had:
    // a prefix without one means the hello landed but the derivation is
    // still running, and the Sender it would use does not exist yet.
    if (this.#remoteNoncePrefix && this.#key) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const priorResolve = this.#pendingHello;
      const priorReject = this.#pendingHelloReject;
      this.#pendingHello = () => { priorResolve?.(); resolve(); };
      this.#pendingHelloReject = (error) => { priorReject?.(error); reject(error); };
    });
  }

  #settlePendingHello(): void {
    const resolve = this.#pendingHello;
    this.#pendingHello = undefined;
    this.#pendingHelloReject = undefined;
    resolve?.();
  }

  #failPendingHello(reason: string): void {
    const reject = this.#pendingHelloReject;
    this.#pendingHello = undefined;
    this.#pendingHelloReject = undefined;
    reject?.(new Error(reason));
  }
}

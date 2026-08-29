import type { Transport } from './types.js';
import { HIGH_WATER_BYTES, MAX_FRAME_BYTES } from './types.js';

/*
 * More than one operator, deliberately, and not just more than one hostname.
 * A STUN URL is resolved by DNS before a single packet is sent, and a failed
 * lookup is not a slow candidate — it is *no* server-reflexive candidate at
 * all. Captured on a real session (2026-08-28): the file-transfer connection
 * gathered `152.58.177.87 typ srflx` and paired with the peer's own srflx,
 * while the live-media connection thirty seconds later finished gathering in
 * 186ms with host candidates only and two `701 STUN host lookup received
 * error`s. The two devices were on different LANs (192.168.31.x and
 * 192.168.0.x), so those host candidates could never pair with anything, and
 * the media connection failed with nothing to fall back on.
 *
 * One name behind one operator's DNS was the single point of failure there.
 * Cloudflare's endpoint is the one that matters most in this list: a
 * different operator on a different domain, so a resolver failing on
 * `l.google.com` says nothing about it. All three sit in one RTCIceServer
 * entry rather than three, which keeps `iceServers.length` meaning "the
 * build-time STUN list" for `hasTurnServer` (client/media/ice.ts).
 */
const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export function defaultRtcConfig(): RTCConfiguration {
  const configured = (import.meta.env.VITE_STUN_URLS as string | undefined ?? '')
    .split(',').map((u) => u.trim()).filter(Boolean);
  // No TURN here, deliberately: this is the DATA path, and a multi-gigabyte
  // file transfer must never land on an operator's metered TURN relay when
  // the WebSocket relay already exists as a fallback (spec §4 D2). The MEDIA
  // path has a different cost profile — a live camera/screen stream is
  // comparatively small and time-bounded — so it builds its own
  // configuration, TURN included, in client/media/ice.ts rather than reusing
  // this function.
  // An explicitly empty VITE_STUN_URLS falls back to the default rather than
  // configuring zero STUN servers: some browsers reject that outright, and
  // others accept it while silently forcing every session to relay-only.
  const urls = configured.length > 0 ? configured : DEFAULT_STUN;
  return { iceServers: [{ urls }] };
}

type SignalMessage =
  | { kind: 'sdp'; description: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

function isSdpType(value: unknown): value is 'offer' | 'answer' {
  return value === 'offer' || value === 'answer';
}

/**
 * Whitelists an inbound signalling payload into a fresh SignalMessage, or
 * undefined if it doesn't match the expected shape. SDP and ICE candidates
 * travel through the relay, which this project's threat model treats as an
 * active adversary that can reorder, drop, duplicate, or splice frames — so
 * this constructs a fresh object from known-good fields rather than casting
 * the one it was handed, matching the house pattern in
 * shared/signals.ts's parseClientSignal/parseServerSignal. Only 'offer' and
 * 'answer' are accepted for an sdp type: this transport never produces or
 * expects 'pranswer' or 'rollback', so anything else is treated the same as
 * a malformed message rather than passed on to setRemoteDescription.
 */
function parseSignal(msg: unknown): SignalMessage | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const value = msg as Record<string, unknown>;

  if (value.kind === 'ice') {
    if (typeof value.candidate !== 'object' || value.candidate === null) return undefined;
    const candidate = value.candidate as Record<string, unknown>;
    if (typeof candidate.candidate !== 'string') return undefined;
    return {
      kind: 'ice',
      candidate: {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid : undefined,
        sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : undefined,
      },
    };
  }

  if (value.kind === 'sdp') {
    if (typeof value.description !== 'object' || value.description === null) return undefined;
    const description = value.description as Record<string, unknown>;
    if (!isSdpType(description.type) || typeof description.sdp !== 'string') return undefined;
    return { kind: 'sdp', description: { type: description.type, sdp: description.sdp } };
  }

  return undefined;
}

/**
 * Distinguishes "the data channel never opened in time" from every other
 * way `whenOpen` can reject (peer connection failure, explicit close,
 * offer negotiation failure). A dedicated type, not a message string:
 * callers that need to classify the reason (negotiateUpgrade's timeout vs.
 * failed outcome) should never depend on another module's error wording.
 */
export class WhenOpenTimeoutError extends Error {
  constructor() {
    super('data channel did not open in time');
    this.name = 'WhenOpenTimeoutError';
  }
}

export class WebRTCTransport implements Transport {
  readonly kind = 'webrtc' as const;

  readonly #pc: RTCPeerConnection;
  readonly #signal: (msg: SignalMessage) => void;
  #channel: RTCDataChannel | undefined;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #closed = false;
  #openResolve: (() => void) | undefined;
  #openReject: ((error: Error) => void) | undefined;

  private constructor(signal: (msg: SignalMessage) => void, config: RTCConfiguration) {
    this.#signal = signal;
    this.#pc = new RTCPeerConnection(config);

    this.#pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.#signal({ kind: 'ice', candidate: event.candidate.toJSON() });
    });

    this.#pc.addEventListener('connectionstatechange', () => {
      const state = this.#pc.connectionState;
      // 'disconnected' is deliberately NOT in this set. It means ICE has
      // stopped hearing back on the selected pair *for now* — a wifi roam, a
      // NAT rebinding, a burst of loss — and the browser recovers from it on
      // its own, or moves on to 'failed' by itself once consent freshness
      // runs out. It used to be treated as terminal here, and that cost a
      // real session (2026-08-29): two computers on different networks,
      // connected Direct, where a blip during a screen share permanently
      // downgraded a data path that was about to recover. A downgrade is not
      // free — see SwitchableTransport in ./upgrade.ts for what a peer that
      // downgrades alone does to one that has not — so it must be spent on
      // ICE actually giving up, which is what 'failed' means.
      if (state === 'failed' || state === 'closed') {
        this.#reportClose(`peer connection ${state}`);
      }
    });
  }

  static offer(signal: (msg: unknown) => void, config: RTCConfiguration = defaultRtcConfig()): WebRTCTransport {
    const transport = new WebRTCTransport(signal as (msg: SignalMessage) => void, config);
    // Ordered and reliable: SCTP then guarantees the same delivery semantics
    // the WebSocket relay provides, so nothing above the seam changes.
    transport.#attach(transport.#pc.createDataChannel('files', { ordered: true }));
    transport.#pc.createOffer()
      .then(async (offer) => {
        await transport.#pc.setLocalDescription(offer);
        transport.#signal({ kind: 'sdp', description: offer });
      })
      // A negotiation failure here would otherwise be a silently swallowed
      // rejection, leaving the caller with nothing but whenOpen's timeout to
      // learn something went wrong.
      .catch((error: unknown) => transport.#reportClose(`offer failed: ${String(error)}`));
    return transport;
  }

  static answer(signal: (msg: unknown) => void, config: RTCConfiguration = defaultRtcConfig()): WebRTCTransport {
    const transport = new WebRTCTransport(signal as (msg: SignalMessage) => void, config);
    transport.#pc.addEventListener('datachannel', (event) => transport.#attach(event.channel));
    return transport;
  }

  async handleSignal(msg: unknown): Promise<void> {
    const signal = parseSignal(msg);
    if (!signal) throw new Error('malformed or unrecognised signal message');
    if (signal.kind === 'ice') {
      await this.#pc.addIceCandidate(signal.candidate);
      return;
    }
    await this.#pc.setRemoteDescription(signal.description);
    if (signal.description.type !== 'offer') return;
    const answer = await this.#pc.createAnswer();
    await this.#pc.setLocalDescription(answer);
    this.#signal({ kind: 'sdp', description: answer });
  }

  /**
   * Resolves once the data channel opens (immediately if already open),
   * rejects if it fails to open before timeoutMs. Single-waiter: a second
   * concurrent call overwrites the first's resolve/reject, so an earlier
   * pending caller then only settles via its own timeout rather than an
   * early open/close signal. Task 3's usage is one call per transport
   * instance; revisit if that ever needs multiple concurrent callers.
   */
  whenOpen(timeoutMs: number): Promise<void> {
    if (this.#channel?.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new WhenOpenTimeoutError()), timeoutMs);
      this.#openResolve = () => { clearTimeout(timer); resolve(); };
      this.#openReject = (error) => { clearTimeout(timer); reject(error); };
    });
  }

  get bufferedAmount(): number { return this.#channel?.bufferedAmount ?? 0; }

  send(frame: Uint8Array): void {
    // Plan 3's Global Constraints: a single DataChannel message must never
    // exceed MAX_FRAME_BYTES — the actual boundary that matters, asserted
    // here rather than assumed from how CHUNK_SIZE happens to be derived.
    // The derivation itself is checked behaviorally in
    // tests/unit/sender.test.ts ("sends exactly one chunk for a file the
    // size of one chunk"): a CHUNK_SIZE-sized file produces exactly one
    // MAX_FRAME_BYTES frame.
    if (frame.byteLength > MAX_FRAME_BYTES) {
      throw new Error(`frame of ${frame.byteLength} bytes exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`);
    }
    if (this.#channel?.readyState !== 'open') return;
    // Copy into a standalone ArrayBuffer, matching RelayTransport.send: a
    // view over a larger pooled buffer would otherwise send the whole pool.
    this.#channel.send(frame.slice().buffer);
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }

  close(): void {
    // Not every browser reliably fires connectionstatechange (or the
    // channel's own 'close' event) synchronously on a locally initiated
    // close, so whenOpen must not depend on either: #reportClose rejects a
    // pending wait directly, uniformly with every other teardown path.
    this.#reportClose('transport closed');
    this.#channel?.close();
    this.#pc.close();
  }

  #attach(channel: RTCDataChannel): void {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    // Unlike WebSocket, a DataChannel signals drain natively — no polling.
    // Threshold is the shared HIGH_WATER_BYTES, not a private second number:
    // resume fires at exactly the fill level Sender's #awaitDrain paused at,
    // the same pause/resume point RelayTransport already uses. See
    // client/transport/types.ts for why a second, lower threshold here would
    // reintroduce the drift that constant exists to prevent.
    channel.bufferedAmountLowThreshold = HIGH_WATER_BYTES;
    channel.addEventListener('bufferedamountlow', () => this.#onDrain?.());
    channel.addEventListener('open', () => {
      this.#openResolve?.();
      this.#openResolve = undefined;
      this.#openReject = undefined;
    });
    channel.addEventListener('close', () => this.#reportClose('data channel closed'));
    channel.addEventListener('message', (event: MessageEvent) => {
      this.#onMessage?.(new Uint8Array(event.data as ArrayBuffer));
    });
  }

  /**
   * Funnels every close cause through one call: the channel's own 'close'
   * event, a failed/closed connectionstatechange, a failed offer
   * negotiation, and a caller-invoked close() all land here.
   *
   * #openReject fires synchronously and unconditionally on every call —
   * rejecting an already-settled promise is a harmless no-op, and a pending
   * whenOpen() must not be left to hang until its own timeout just because a
   * different cause (e.g. the channel closing before it ever opened) is
   * the one that actually fired.
   *
   * #onClose is deduped to exactly one call AND deferred by a microtask:
   * close() must never synchronously re-enter caller code from inside its
   * own call chain (e.g. a Session.close() that calls transport.close()
   * while already inside its own onClose handler). RelayTransport never
   * has this hazard, since its onClose only ever fires from the
   * WebSocket's own async 'close' event; deferring here gives
   * WebRTCTransport the same "never synchronous" shape without requiring
   * every future caller to guard against reentrancy itself.
   */
  #reportClose(reason: string): void {
    this.#openReject?.(new Error(reason));
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.#onClose?.(reason));
  }
}

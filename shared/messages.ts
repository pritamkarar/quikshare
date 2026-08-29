import type { DeviceInfo } from './device.js';
import type { MediaAnswer, MediaIce, MediaOffer } from './media-signal.js';

export type SaveCapability = 'fs-access' | 'sw-stream' | 'blob';

export interface FileMeta {
  id: number;
  name: string;
  size: number;
  type: string;
}

/**
 * The longest note the textarea will accept, and the one number the UI is
 * allowed to know about frame sizing. A text snippet travels as ONE
 * unchunked control frame, so its ceiling is what a single frame can carry:
 * MAX_FRAME_BYTES (65536) minus the 13-byte header and the 16-byte GCM tag
 * = 65507 bytes of JSON, of which `{"t":"text","content":""}` costs 25.
 *
 * 10,000 *characters* rather than ~65,000 because the unit the textarea can
 * enforce is UTF-16 code units, and JSON.stringify + UTF-8 can expand one of
 * those to six bytes (a raw control character becomes `\u0000`). At six
 * bytes each, 10,000 still fits with room to spare, so a note the textarea
 * accepted can never be one `Sender.sendText` then refuses — whatever the
 * user pasted, and whichever transport is live at the time. `Sender` still
 * checks the real byte bound itself: this constant is the UI's stop, not the
 * guarantee.
 */
export const MAX_TEXT_CHARS = 10_000;

export type ControlMessage =
  /**
   * `pub` is this device's ephemeral P-256 public key (raw, base64url). The
   * two halves of the key agreement that replaced the URL fragment travel
   * here, in the one frame that is already unsealed by necessity — see
   * `deriveSession` in client/crypto.ts. It is public by definition: the
   * relay learns nothing from reading it, and what it could do by *swapping*
   * it is what the six-digit verification gate exists to catch.
   */
  | {
    t: 'hello'; peerId: 'a' | 'b'; noncePrefix: string; pub: string;
    saveCapability: SaveCapability; maxBufferedBytes: number;
  }
  | { t: 'offer-batch'; batchId: string; files: readonly FileMeta[] }
  | { t: 'accept'; batchId: string }
  | { t: 'reject'; batchId: string; reason: string }
  | { t: 'file-end'; fileId: number }
  /**
   * "I have this file, whole." Sent by the receiving side once `file-end`
   * has passed its length check and the sink has closed without error — the
   * only moment either device knows the file actually arrived.
   *
   * It exists because the sending side cannot tell. `transport.send()`
   * hands a frame to a socket or a data channel and returns; both drop a
   * frame silently when their channel is not open, and a WebRTC channel
   * whose network path has died keeps `readyState: 'open'` for as long as
   * ICE takes to give up, accepting every byte into a buffer nothing will
   * drain. Before this frame existed, "Sent" meant "written locally", and a
   * real session (2026-08-29) lost a whole batch to the difference: every
   * row on the sender read Sent, every row on the receiver sat at 0 bytes,
   * and neither side raised an error.
   *
   * `fileId` is the SENDER's id, echoed back — the same namespace
   * `resume-from` uses, and unambiguous for the same reason: an ack you
   * receive is always about a file you sent.
   *
   * Re-sent for every completed file whenever the two sides resync (see
   * Session's `#resyncReceiveState`), so an ack lost with the transport
   * that carried it does not strand a row at 100% forever.
   */
  | { t: 'file-ack'; fileId: number }
  /**
   * Stop these files. Sent by whichever side's user pressed cancel, and the
   * only frame either side can originate about a transfer already underway.
   *
   * `side` says whose ids these are, from the point of view of the device
   * that SENT this frame:
   *
   *   'mine'  — "I was sending you these and I have stopped." The recipient
   *             aborts the sinks it had open for them.
   *   'yours' — "you are sending me these; stop." The recipient's own Sender
   *             drops them from its loop.
   *
   * The field is not optional and cannot be inferred. A fileId is minted by
   * whichever Sender produced the file, and every Sender starts its counter
   * at 1, so id 1 routinely names two different files at once — one in each
   * direction. Without `side` a recipient holding both would have no way to
   * know which of the two to stop, and would guess wrong half the time.
   *
   * `fileIds` is a list rather than one id so cancelling a whole batch is
   * one frame instead of N. Everything in it is attacker-controlled — see
   * Session's `#handleCancel`, which is the only sanctioned way to act on it.
   */
  | { t: 'cancel'; side: 'mine' | 'yours'; fileIds: readonly number[] }
  | { t: 'text'; content: string }
  /**
   * What kind of machine is on the other end — rendered by the peer's device
   * panel and nothing else.
   *
   * A sealed control frame rather than a field on `hello`, for two separate
   * reasons. The hello travels in the clear by necessity (it carries the
   * nonce prefix that makes sealing possible at all), so putting a device
   * fingerprint and an IP address in it would hand the relay, in plaintext,
   * exactly the pairing that the rest of this design goes to some length to
   * deny it. And the address itself is not known when the hello is built on
   * the joiner's path — it arrives with the relay's own `joined` signal —
   * so a hello field would have been empty half the time.
   *
   * Purely informational: nothing in the transfer path reads it, so a peer
   * that never sends one is a peer whose card says "unknown", not a peer
   * that cannot transfer. Everything in it is attacker-controlled — see
   * `parseDeviceInfo` in shared/device.ts, which is the only sanctioned way
   * to turn this payload into a `DeviceInfo`.
   */
  | { t: 'device'; info: DeviceInfo }
  /**
   * "The person at this device has confirmed the verification number
   * matches." Sealed, so only the holder of the derived key can say it — a
   * relay that swapped the public keys holds a different key on each side
   * and cannot forge this into either session.
   *
   * Both directions are required before either side will send anything (see
   * `Session.#requireVerified`), which is what keeps a receiver from ever
   * having to decide whether the bytes arriving at it were vouched for: no
   * peer sends until it knows this device's user has looked.
   */
  | { t: 'verified' }
  /*
   * The leaving device chose to end this, rather than merely vanishing.
   *
   * Nothing below this layer can tell the two apart: a closed tab, a dead
   * network and a deliberate "End session" all reach the peer as the same
   * dropped socket, and the relay keeps the room alive either way (it is
   * deleted only once every peer has gone — server/rooms.ts). That default
   * is right for an accident, since the peer can scan back into the same
   * room, and wrong for a decision, since there is nothing to scan back
   * into. Only the device whose user clicked knows which happened, so it
   * says so before it goes.
   *
   * Best effort by nature: a crash cannot send it, which is exactly the case
   * where its absence is the correct answer.
   */
  | { t: 'end-session' }
  | { t: 'switch-transport'; to: 'webrtc' }
  | { t: 'switch-ack' }
  | { t: 'resume-from'; fileId: number; bytesReceived: number }
  /*
   * Live media negotiation, sealed like every other control frame.
   *
   * Sealed rather than sent as plaintext `{t:'rtc'}` relay signals — which
   * is how the DATA connection negotiates — for a reason that only applies
   * to media: nobody can press Share before the session is paired, so the
   * encrypted channel always exists first. Sending media SDP through it
   * costs nothing and denies the relay the media candidates entirely. The
   * data channel has no such luxury; it is what is being bootstrapped.
   *
   * Everything in these is attacker-controlled — see shared/media-signal.ts,
   * which is the only sanctioned way to turn one of these payloads into
   * something handed to a peer connection.
   */
  | { t: 'media-offer'; offer: MediaOffer }
  | { t: 'media-answer'; answer: MediaAnswer }
  | { t: 'media-ice'; ice: MediaIce }
  | { t: 'media-stop' };

/**
 * The narrowed view of `ControlMessage` that everything downstream of
 * `parseMediaOffer`/`parseMediaAnswer`/`parseMediaIce` actually passes
 * around, so a media handler's signature says "one of the four media
 * frames" instead of "any control message, trust me". Lives here rather
 * than in shared/media-signal.ts because it selects from `ControlMessage`,
 * and later tasks pass it across the worker boundary alongside every other
 * type this module exports.
 */
export type MediaControl = Extract<ControlMessage, { t: `media-${string}` }>;

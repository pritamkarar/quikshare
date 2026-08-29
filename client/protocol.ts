import type { ControlMessage } from '../shared/messages.js';

export const HEADER_BYTES = 13;

/**
 * `Hello` is additive: `Control` and `Data` keep their committed values, so
 * the on-wire layout is unchanged. It exists because the handshake frame
 * cannot be sealed — it *carries* the nonce prefix the peer needs before it
 * can derive any nonce — so it needs a type the receiver can recognise
 * without first trying to decrypt it.
 */
export const FrameType = { Control: 0, Data: 1, Hello: 2 } as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameType;
  fileId: number;
  seq: bigint;
  /**
   * The frame's own first HEADER_BYTES, copied. For a control frame, handed
   * to `open` as additional data exactly as-is, rather than rebuilt from the
   * parsed fields above: reconstructing it would only prove the parse is
   * self-consistent, whereas replaying the exact bytes proves they are the
   * ones the sender authenticated. For a data frame, this header is only the
   * *base* of the additional data, not the whole of it — see
   * client/transfer/data-aad.ts, which extends it with the chunk's own byte
   * offset before either side calls `seal`/`open`.
   */
  header: Uint8Array;
  payload: Uint8Array;
}

/**
 * The 13-byte header, used both on the wire and as (all or the base of) the
 * AES-GCM additional data — a control frame's AAD is this header alone; a
 * data frame's AAD is this header plus its chunk's own byte offset, appended
 * by client/transfer/data-aad.ts, never by this function. Extracted so both
 * sides derive identical header bytes: the relay is an active adversary, and
 * a header that is merely transmitted rather than authenticated lets it
 * rearrange genuine chunks into a file the sender never sent.
 */
export function encodeHeader(type: FrameType, fileId: number, seq: bigint): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint8(0, type);
  view.setUint32(1, fileId, false);
  view.setBigUint64(5, seq, false);
  return header;
}

export function encodeFrame(type: FrameType, fileId: number, seq: bigint, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out.set(encodeHeader(type, fileId, seq), 0);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < HEADER_BYTES) throw new Error(`frame too short: ${buf.length} bytes`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    type: view.getUint8(0) as FrameType,
    fileId: view.getUint32(1, false),
    seq: view.getBigUint64(5, false),
    // slice() copies, so the frame does not alias a reused network buffer.
    header: buf.slice(0, HEADER_BYTES),
    payload: buf.slice(HEADER_BYTES),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeControl(msg: ControlMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

export function decodeControl(payload: Uint8Array): ControlMessage {
  return JSON.parse(decoder.decode(payload)) as ControlMessage;
}

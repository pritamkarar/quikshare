// client/transport/types.ts
export type TransportKind = 'relay' | 'webrtc';

/**
 * Shared backpressure threshold: the point at which a transport is
 * considered backed up and a sender should pause. Defined once here so
 * RelayTransport's drain polling and Sender's wait threshold can never
 * silently disagree.
 */
export const HIGH_WATER_BYTES = 1024 * 1024;

/**
 * The largest single message a WebRTC DataChannel is guaranteed to carry.
 * Lives here, not in the transfer layer, for the same reason
 * HIGH_WATER_BYTES does: it describes a constraint of the wire itself, a
 * value more than one layer must agree on, not transfer logic.
 * client/transfer/sender.ts derives CHUNK_SIZE from this (header +
 * ciphertext + GCM tag must land on exactly this many bytes) and
 * re-exports it so its own callers don't also need to import from here.
 */
export const MAX_FRAME_BYTES = 65536;

export interface Transport {
  readonly kind: TransportKind;
  readonly bufferedAmount: number;
  send(frame: Uint8Array): void;
  onMessage(cb: (frame: Uint8Array) => void): void;
  onDrain(cb: () => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

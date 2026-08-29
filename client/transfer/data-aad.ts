/**
 * Additional authenticated data for a DATA frame: the frame's own header, as
 * before, plus the byte offset this chunk's plaintext starts at within its
 * file. Binds contiguity into the ciphertext itself instead of inferring it
 * from seq order (fix-round-2 for Ruling H) — a chunk that lands at the
 * wrong offset simply cannot open, regardless of what its seq claims, what
 * a replayed control frame reset, or how many times the file has already
 * been resumed. Sender and Receiver both call this one function so the two
 * sides can never independently drift on the byte encoding.
 *
 * Control frames do not get this: they have no byte offset of their own
 * (see receiver.ts's `#lastControlSeq` for their own, separate replay
 * protection instead).
 */
export function dataAad(header: Uint8Array, offset: number): Uint8Array {
  const aad = new Uint8Array(header.length + 8);
  aad.set(header, 0);
  new DataView(aad.buffer).setBigUint64(header.length, BigInt(offset), false);
  return aad;
}

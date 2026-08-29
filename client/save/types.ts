export interface SaveSink {
  /**
   * Takes ownership of `chunk`: the caller must not read it again once this
   * has been called. The transfer worker's proxy sink moves the chunk's buffer
   * to the page rather than copying it, which detaches it here.
   *
   * Resolves only when the bytes have actually been accepted — that is what
   * carries the sink's backpressure back to the receive loop.
   */
  write(chunk: Uint8Array): Promise<void>;
  /** Finalizes the file. Returns a Blob only for the in-memory sink. */
  close(): Promise<Blob | undefined>;
  abort(reason: string): Promise<void>;
  /** Throws if `totalBytes` exceeds what this sink can hold. */
  assertWithinCap(totalBytes: number): void;
}

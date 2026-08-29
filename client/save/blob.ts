import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from './types.js';

export const BLOB_SINK_MAX_BYTES = 512 * 1024 * 1024;

/**
 * One wording for one condition. The Receiver checks this ceiling at offer
 * time, before any sink exists, and the sink checks it again for itself — the
 * two must not drift into two different sentences for the same refusal.
 */
export function tooLargeForMemory(totalBytes: number): string {
  return `File too large for this browser: ${totalBytes} bytes exceeds the ${BLOB_SINK_MAX_BYTES}-byte in-memory limit.`;
}

export function createBlobSink(meta: FileMeta): SaveSink {
  let chunks: Uint8Array[] | undefined = [];

  return {
    assertWithinCap(totalBytes: number): void {
      if (totalBytes > BLOB_SINK_MAX_BYTES) throw new Error(tooLargeForMemory(totalBytes));
    },
    async write(chunk: Uint8Array): Promise<void> {
      chunks?.push(chunk);
    },
    async close(): Promise<Blob | undefined> {
      if (!chunks) return undefined;
      const blob = new Blob(chunks as BlobPart[], { type: meta.type || 'application/octet-stream' });
      chunks = undefined;
      return blob;
    },
    async abort(): Promise<void> {
      chunks = undefined;
    },
  };
}

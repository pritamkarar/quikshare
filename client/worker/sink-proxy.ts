import type { FileMeta, SaveCapability } from '../../shared/messages.js';
import type { SaveSink } from '../save/types.js';
import { capacityRejection, type SinkFactory } from '../save/select.js';
import type { FromWorker, SinkResult } from './messages.js';

/** How the worker gets a request to the page, with an optional transfer list. */
export type PostRequest = (msg: FromWorker, transfer?: Transferable[]) => void;

export interface SinkProxy {
  /**
   * Hand this to `Session` as its sink factory. Every sink it builds lives on
   * the page; what it returns here is a proxy that forwards across the worker
   * boundary.
   */
  createSink: SinkFactory;
  /** Settles the request one `sink-result` answers. Unknown ids are ignored. */
  settle(result: SinkResult): void;
  /**
   * Fails every request still in flight. Called when the session this proxy
   * served is torn down, so nothing is left awaiting an answer that the page
   * will never send.
   */
  rejectAll(reason: string): void;
}

interface Pending {
  resolve(blob: Blob | undefined): void;
  reject(error: Error): void;
}

/**
 * Unique for the worker's whole lifetime, not per proxy. A session can be
 * retired and a new one built in the same worker, and the worker routes every
 * `sink-result` to whichever proxy is current — so a request id that restarted
 * at 1 would let a stale answer settle the new session's request that happens
 * to share it. For a `sink-write` that is a write acked before its bytes
 * reached the page: backpressure gone, and a chunk counted as landed that
 * never was.
 */
let nextRequestId = 1;

/**
 * The worker's half of the sink proxy: a `SaveSink` whose `write`, `close` and
 * `abort` are request/response round trips to the page, correlated by id.
 *
 * Two properties this must never lose:
 *
 *  - **Every write is individually acked.** `write` resolves only once the
 *    page's real `write` has resolved. Without that the receiver's `await`
 *    returns before bytes reach disk, backpressure disappears, the receive
 *    loop outruns the sink, and the memory the disk-backed tiers exist to
 *    bound comes straight back.
 *  - **A rejected request rejects the proxy method.** Disk full, permission
 *    revoked, a cancelled download: the rejection has to reach the receiver so
 *    its per-file failure path runs, rather than a file that silently stops.
 */
export function createSinkProxy(capability: SaveCapability, post: PostRequest): SinkProxy {
  const pending = new Map<number, Pending>();

  const request = (
    build: (id: number) => { msg: FromWorker; transfer?: Transferable[] },
  ): Promise<Blob | undefined> => new Promise<Blob | undefined>((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    const { msg, transfer } = build(id);
    try {
      post(msg, transfer);
    } catch (error: unknown) {
      // A post that throws (an un-cloneable payload, a dead port) would
      // otherwise leave this promise pending for the life of the worker.
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const proxyFor = (fileId: number): SaveSink => ({
    /**
     * Deliberately synchronous, and deliberately answered here rather than on
     * the page: `describeCapability` gives the tier's ceiling with no sink
     * instance, which is exactly what it is for. A round trip would mean
     * widening `SaveSink` to an async `assertWithinCap` for no gain.
     */
    assertWithinCap(totalBytes: number): void {
      const rejection = capacityRejection(capability, totalBytes);
      if (rejection !== undefined) throw new Error(rejection);
    },
    async write(chunk: Uint8Array): Promise<void> {
      await request((id) => ({
        msg: { t: 'sink-write', id, fileId, chunk },
        // The plaintext moves rather than copies. Its buffer is minted by
        // `open()` per chunk and owned by nobody else — but a view over a
        // SharedArrayBuffer cannot be transferred at all, so the list is
        // built from what is actually transferable.
        transfer: chunk.buffer instanceof ArrayBuffer ? [chunk.buffer] : [],
      }));
    },
    close(): Promise<Blob | undefined> {
      return request((id) => ({ msg: { t: 'sink-close', id, fileId } }));
    },
    async abort(reason: string): Promise<void> {
      await request((id) => ({ msg: { t: 'sink-abort', id, fileId, reason } }));
    },
  });

  return {
    async createSink(meta: FileMeta): Promise<SaveSink> {
      // Awaited: the page's factory can take arbitrarily long (a Save-As
      // dialog waits on the user) and can fail (they cancel it). Either way
      // the receiver sees it as this file's sink failing to build.
      await request((id) => ({ msg: { t: 'sink-open', id, fileId: meta.id, meta } }));
      return proxyFor(meta.id);
    },

    settle(result: SinkResult): void {
      const entry = pending.get(result.id);
      // A duplicate or late answer has nothing left to settle.
      if (!entry) return;
      pending.delete(result.id);
      if (result.ok) entry.resolve(result.blob);
      else entry.reject(new Error(result.message));
    },

    rejectAll(reason: string): void {
      const waiting = [...pending.values()];
      pending.clear();
      for (const entry of waiting) entry.reject(new Error(reason));
    },
  };
}

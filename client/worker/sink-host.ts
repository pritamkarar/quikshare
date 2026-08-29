import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from '../save/types.js';
import type { SinkFactory } from '../save/select.js';
import type { FromWorker, SinkResult } from './messages.js';

export interface SinkHostOptions {
  /** Built on the page for the negotiated tier, where the probes actually work. */
  factory: SinkFactory;
  /** How an answer gets back to the worker. */
  post: (result: SinkResult) => void;
}

export interface SinkHost {
  /**
   * Handles one message from the worker. Returns true if it was a sink
   * request and has been answered (or will be, asynchronously), so the caller
   * knows not to route it anywhere else.
   */
  handle(msg: FromWorker): boolean;
  /**
   * Aborts every sink still open and refuses any further ones. Called when the
   * session closes or the worker is terminated: the worker cannot ask for this
   * itself, because it dies at the same moment — and a dropped
   * `FileSystemWritableFileStream` leaves a partial file on disk.
   */
  abortAll(reason: string): void;
}

/**
 * The page's half of the sink proxy. It owns the real `SaveSink` for every
 * file in flight, because two of the three save tiers cannot exist in a worker
 * realm at all — `showSaveFilePicker` is Window-only, and the Service Worker
 * download tier needs a document to host its iframe.
 *
 * Every request is answered exactly once, including the ones that fail: an
 * unanswered request leaves the worker's proxy awaiting forever, which would
 * stall the receive loop with no error anywhere.
 */
export function createSinkHost({ factory, post }: SinkHostOptions): SinkHost {
  const sinks = new Map<number, SaveSink>();
  let closedReason: string | undefined;

  const answer = (id: number, run: () => Promise<Blob | undefined>): void => {
    void run().then(
      (blob) => post({ t: 'sink-result', id, ok: true, blob }),
      (error: unknown) => post({
        t: 'sink-result',
        id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const sinkFor = (fileId: number): SaveSink => {
    const sink = sinks.get(fileId);
    if (!sink) throw new Error(`There is no sink open on this page for file ${fileId}.`);
    return sink;
  };

  const openSink = async (fileId: number, meta: FileMeta): Promise<undefined> => {
    if (closedReason) throw new Error(`This session was closed: ${closedReason}`);
    if (sinks.has(fileId)) throw new Error(`A sink is already open on this page for file ${fileId}.`);

    // May take arbitrarily long: a Save-As dialog waits on the user, and the
    // streaming tier waits for the browser to start the download.
    const sink = await factory(meta);

    if (closedReason) {
      // Built into a session that no longer exists. It holds a real file
      // handle or a real stalled download, so it is released here rather than
      // dropped — and the worker still hears why its file cannot proceed.
      void sink.abort(closedReason).catch(() => undefined);
      throw new Error(`This session was closed: ${closedReason}`);
    }
    sinks.set(fileId, sink);
    return undefined;
  };

  return {
    handle(msg: FromWorker): boolean {
      switch (msg.t) {
        case 'sink-open':
          answer(msg.id, () => openSink(msg.fileId, msg.meta));
          return true;

        case 'sink-write':
          // The answer is posted only after this resolves, which is what
          // carries the sink's backpressure back across the boundary.
          answer(msg.id, async () => {
            await sinkFor(msg.fileId).write(msg.chunk);
            return undefined;
          });
          return true;

        case 'sink-close':
          answer(msg.id, async () => {
            const sink = sinkFor(msg.fileId);
            // Forgotten before the await: a close that throws has still
            // finished with this sink, and leaving the entry behind would keep
            // a dead handle in the map until teardown.
            sinks.delete(msg.fileId);
            return await sink.close();
          });
          return true;

        case 'sink-abort':
          answer(msg.id, async () => {
            const sink = sinks.get(msg.fileId);
            sinks.delete(msg.fileId);
            // Idempotent on purpose: a file can fail before it ever had a
            // chunk to build a sink on, and aborting nothing is not an error.
            await sink?.abort(msg.reason);
            return undefined;
          });
          return true;

        default:
          return false;
      }
    },

    abortAll(reason: string): void {
      closedReason = reason;
      const stillOpen = [...sinks.values()];
      sinks.clear();
      // Fire-and-forget: teardown is synchronous, and a sink that cannot even
      // abort has nothing further to report.
      for (const sink of stillOpen) void sink.abort(reason).catch(() => undefined);
    },
  };
}

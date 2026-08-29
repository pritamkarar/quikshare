import type { FromWorker, ToWorker } from './messages.js';

export interface ProgressReport {
  fileId: number;
  bytesMoved: number;
  totalBytes: number;
}

export interface ThrottledProgress extends ProgressReport {
  bytesPerSecond: number;
}

interface Tracked {
  pending: ProgressReport | undefined;
  lastEmitAt: number;
  lastEmitBytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Collapses thousands of per-chunk reports into a few emissions per second.
 * Without this the UI re-renders per 64 KB chunk and starves the transfer.
 *
 * Leading + trailing edge, per file id: a report emits immediately only when
 * real time since that file's *last emission* has already reached
 * `intervalMs` (gated on elapsed time, not merely on "no timer currently
 * running" — a report landing the instant a trailing emission fires is still
 * within the interval and must not be treated as a fresh leading edge, or a
 * sustained stream double-emits at every boundary). Anything inside that
 * window only updates `pending`, and the cooldown timer — scheduled for the
 * *remainder* of the interval, not a fresh one — flushes it as one trailing
 * emission carrying the latest value.
 */
export function createProgressThrottle(
  intervalMs: number,
  emit: (p: ThrottledProgress) => void,
): { report(p: ProgressReport): void; flush(fileId: number): void; reset(): void } {
  const tracked = new Map<number, Tracked>();

  const emitNow = (entry: Tracked, p: ProgressReport): void => {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - entry.lastEmitAt);
    const bytesPerSecond = ((p.bytesMoved - entry.lastEmitBytes) * 1000) / elapsedMs;
    entry.lastEmitAt = now;
    entry.lastEmitBytes = p.bytesMoved;
    entry.pending = undefined;
    emit({ ...p, bytesPerSecond: Math.max(0, bytesPerSecond) });
  };

  const getEntry = (fileId: number): Tracked => {
    let entry = tracked.get(fileId);
    if (!entry) {
      // lastEmitAt 0 makes the first-ever report for a file id a leading edge:
      // elapsed since the epoch is always >= intervalMs.
      entry = { pending: undefined, lastEmitAt: 0, lastEmitBytes: 0, timer: undefined };
      tracked.set(fileId, entry);
    }
    return entry;
  };

  return {
    report(p: ProgressReport): void {
      const entry = getEntry(p.fileId);
      const now = Date.now();
      const sinceLast = now - entry.lastEmitAt;

      if (entry.timer === undefined && sinceLast >= intervalMs) {
        emitNow(entry, p);
        return;
      }

      entry.pending = p;
      if (entry.timer !== undefined) return;

      // Wait out the remainder of the interval, not a fresh one — otherwise a
      // report landing just after a trailing emit starts its own cycle and
      // the boundary double-emits.
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (entry.pending) emitNow(entry, entry.pending);
      }, Math.max(0, intervalMs - sinceLast));
    },
    /** Scoped to one file id: finishing file A must not disturb file B's cooldown. */
    flush(fileId: number): void {
      const entry = tracked.get(fileId);
      if (!entry) return;
      if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
      if (entry.pending) emitNow(entry, entry.pending);
    },
    /**
     * Drops all per-file state, including cancelling any live cooldown
     * timers. Called at session boundaries: this worker outlives a single
     * Session (init/close can recur), and a pending timer from an
     * interrupted transfer must not fire into a later session, nor may a
     * stale lastEmitAt/lastEmitBytes baseline survive to corrupt the first
     * rate computed for a reused file id (ids restart at 1 per session).
     */
    reset(): void {
      for (const entry of tracked.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
      }
      tracked.clear();
    },
  };
}

export class WorkerClient {
  readonly #worker: Worker;
  #onMessage: ((msg: FromWorker) => void) | undefined;

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      this.#onMessage?.(event.data);
    });
  }

  post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.#worker.postMessage(msg, transfer);
  }

  on(cb: (msg: FromWorker) => void): void { this.#onMessage = cb; }

  terminate(): void { this.#worker.terminate(); }
}

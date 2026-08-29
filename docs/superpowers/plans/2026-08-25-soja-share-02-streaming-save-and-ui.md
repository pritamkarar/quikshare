# soja-share Plan 2 — Streaming Save and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Plan 1's dev harness with the real interface, move transfer work off the main thread, and lift the file size ceiling by writing received bytes straight to disk.

**Architecture:** `Sender` and `Receiver` move into a Web Worker that owns the `Transport` and throttles progress to a few messages per second. The receiver picks a `SaveSink` implementation at startup from three tiers — File System Access, Service Worker stream, in-memory blob — behind the interface Plan 1 defined. The UI is React with hand-rolled Tailwind primitives, built against every MUST in `AGENTS.md`.

**Tech Stack:** React 19, Vite 6, Tailwind 4, `qrcode`, `@zxing/browser`, `@tanstack/react-virtual`, Vitest + `@testing-library/react` + `jsdom`, `axe-core`.

**Spec:** `docs/superpowers/specs/2026-08-25-soja-share-design.md`
**Prerequisite:** Plan 1 complete (`docs/superpowers/plans/2026-08-25-soja-share-01-core-relay-transfer.md`).

## Global Constraints

Everything in Plan 1's Global Constraints still applies, plus:

- `AGENTS.md` is binding. Every MUST in it applies to every component built here. The ones with teeth in this plan are listed per task.
- Progress must never trigger a React state update per chunk. The worker throttles to at most one progress message per 200 ms per file.
- Never animate layout properties. Progress uses `transform: scaleX()`.
- All numeric readouts use `font-variant-numeric: tabular-nums`.
- All units use a non-breaking space between number and unit (`10 MB`).
- Status is never conveyed by color alone — always icon plus text.
- Hit targets ≥ 44 px on touch, ≥ 24 px otherwise.
- Every interactive element is reachable and operable by keyboard, with a visible `:focus-visible` ring.
- The URL fragment carrying the key MUST survive every client-side navigation.

---

### Task 1: Move transfer into a Web Worker

**Files:**
- Create: `client/worker/transfer-worker.ts`
- Create: `client/worker/messages.ts`
- Create: `client/worker/client.ts`
- Modify: `client/session.ts` — delegate to the worker client
- Test: `tests/unit/worker-messages.test.ts`
- Test: `tests/unit/progress-throttle.test.ts`

**Interfaces:**
- Consumes: `Session`, `Sender`, `Receiver` from Plan 1.
- Produces:
  - `client/worker/messages.ts` exports `ToWorker` and `FromWorker` union types.
  - `class WorkerClient` with `constructor(worker: Worker)`, `post(msg: ToWorker, transfer?: Transferable[]): void`, `on(cb: (msg: FromWorker) => void): void`.
  - `createProgressThrottle(intervalMs, emit)` returning `{ report(p): void; flush(): void }`.

- [ ] **Step 1: Write `client/worker/messages.ts` (pure types)**

```ts
// client/worker/messages.ts
import type { FileMeta, SaveCapability } from '../../shared/messages.js';

export type ToWorker =
  | { t: 'init'; wsUrl: string; intent: { t: 'create' } | { t: 'join'; code: string; keyFragment: string }; saveCapability: SaveCapability }
  | { t: 'send-files'; files: File[] }
  | { t: 'send-text'; content: string }
  | { t: 'close' };

export type FromWorker =
  | { t: 'ready'; code: string; peerId: 'a' | 'b'; shareUrl: string }
  | { t: 'peer-joined' }
  | { t: 'peer-left'; reason: string }
  | { t: 'offer'; files: FileMeta[] }
  | { t: 'outgoing'; files: FileMeta[] }
  | { t: 'send-progress'; fileId: number; bytesMoved: number; totalBytes: number; bytesPerSecond: number }
  | { t: 'receive-progress'; fileId: number; bytesMoved: number; totalBytes: number; bytesPerSecond: number }
  | { t: 'file-complete'; meta: FileMeta; blob?: Blob }
  | { t: 'text'; content: string }
  | { t: 'error'; fileId?: number; message: string };
```

- [ ] **Step 2: Write the failing throttle test**

```ts
// tests/unit/progress-throttle.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressThrottle } from '../../client/worker/client.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createProgressThrottle', () => {
  it('emits the first report immediately', () => {
    const emit = vi.fn();
    createProgressThrottle(200, emit).report({ fileId: 1, bytesMoved: 10, totalBytes: 100 });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst into one emission per interval', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    for (let i = 0; i < 1000; i++) throttle.report({ fileId: 1, bytesMoved: i, totalBytes: 1000 });
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('emits the latest value, not a stale one', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 100 });
    throttle.report({ fileId: 1, bytesMoved: 50, totalBytes: 100 });
    vi.advanceTimersByTime(200);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ bytesMoved: 50 }));
  });

  it('throttles each file independently', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 10 });
    throttle.report({ fileId: 2, bytesMoved: 1, totalBytes: 10 });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('computes a transfer rate from elapsed time', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 0, totalBytes: 1000 });
    vi.advanceTimersByTime(1000);
    throttle.report({ fileId: 1, bytesMoved: 500, totalBytes: 1000 });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ bytesPerSecond: expect.any(Number) }));
    const last = emit.mock.calls.at(-1)![0] as { bytesPerSecond: number };
    expect(last.bytesPerSecond).toBeGreaterThan(0);
  });

  it('flush emits any pending value straight away', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 10 });
    throttle.report({ fileId: 1, bytesMoved: 9, totalBytes: 10 });
    throttle.flush();
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ bytesMoved: 9 }));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/unit/progress-throttle.test.ts`
Expected: FAIL — cannot resolve `../../client/worker/client.js`.

- [ ] **Step 4: Implement the throttle in `client/worker/client.ts`**

```ts
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
 */
export function createProgressThrottle(
  intervalMs: number,
  emit: (p: ThrottledProgress) => void,
): { report(p: ProgressReport): void; flush(): void } {
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

  return {
    report(p: ProgressReport): void {
      let entry = tracked.get(p.fileId);
      if (!entry) {
        entry = { pending: undefined, lastEmitAt: Date.now(), lastEmitBytes: 0, timer: undefined };
        tracked.set(p.fileId, entry);
        emitNow(entry, p);
        return;
      }
      entry.pending = p;
      if (entry.timer !== undefined) return;
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (entry.pending) emitNow(entry, entry.pending);
      }, intervalMs);
    },
    flush(): void {
      for (const entry of tracked.values()) {
        if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
        if (entry.pending) emitNow(entry, entry.pending);
      }
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
```

- [ ] **Step 5: Run the throttle test**

Run: `npx vitest run tests/unit/progress-throttle.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Implement `client/worker/transfer-worker.ts`**

```ts
/// <reference lib="webworker" />
import { Session } from '../session.js';
import { createProgressThrottle } from './client.js';
import type { FromWorker, ToWorker } from './messages.js';

declare const self: DedicatedWorkerGlobalScope;

let session: Session | undefined;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => self.postMessage(msg, transfer);

const sendProgress = createProgressThrottle(200, (p) =>
  post({ t: 'send-progress', fileId: p.fileId, bytesMoved: p.bytesMoved, totalBytes: p.totalBytes, bytesPerSecond: p.bytesPerSecond }),
);
const receiveProgress = createProgressThrottle(200, (p) =>
  post({ t: 'receive-progress', fileId: p.fileId, bytesMoved: p.bytesMoved, totalBytes: p.totalBytes, bytesPerSecond: p.bytesPerSecond }),
);

function wire(s: Session): void {
  s.events.onPeerJoined = () => post({ t: 'peer-joined' });
  s.events.onPeerLeft = (reason) => post({ t: 'peer-left', reason });
  s.events.onOffer = (files) => post({ t: 'offer', files });
  s.events.onText = (content) => post({ t: 'text', content });
  s.events.onError = (e) => post({ t: 'error', fileId: e.fileId, message: e.message });
  s.events.onSendProgress = (p) => sendProgress.report({ fileId: p.fileId, bytesMoved: p.bytesSent, totalBytes: p.totalBytes });
  s.events.onReceiveProgress = (p) => receiveProgress.report({ fileId: p.fileId, bytesMoved: p.bytesReceived, totalBytes: p.totalBytes });
  s.events.onFileComplete = ({ meta, blob }) => {
    sendProgress.flush();
    receiveProgress.flush();
    post({ t: 'file-complete', meta, blob });
  };
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  void (async () => {
    try {
      switch (msg.t) {
        case 'init': {
          session = msg.intent.t === 'create'
            ? await Session.create(msg.wsUrl)
            : await Session.join(msg.wsUrl, msg.intent.code, msg.intent.keyFragment);
          wire(session);
          post({ t: 'ready', code: session.code, peerId: session.peerId, shareUrl: session.shareUrl });
          return;
        }
        case 'send-files': {
          // Post the metas the sender actually minted so the UI keys progress
          // by the same ids; inventing placeholder ids never matches.
          const metas = await session?.sendFiles(msg.files);
          if (metas) post({ t: 'outgoing', files: metas });
          return;
        }
        case 'send-text': session?.sendText(msg.content); return;
        case 'close': session?.close(); session = undefined; return;
      }
    } catch (error: unknown) {
      post({ t: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  })();
});
```

Note: `Session.shareUrl` reads `location` for the origin. In a worker `self.location` exists and points at the worker script URL, whose origin matches the page — so the existing implementation works unchanged.

- [ ] **Step 7: Write the message-shape test**

```ts
// tests/unit/worker-messages.test.ts
import { describe, expect, it, vi } from 'vitest';
import { WorkerClient } from '../../client/worker/client.js';
import type { FromWorker } from '../../client/worker/messages.js';

class FakeWorker implements Pick<Worker, 'addEventListener' | 'postMessage' | 'terminate'> {
  listener: ((event: MessageEvent) => void) | undefined;
  readonly posted: unknown[] = [];
  addEventListener(_type: string, cb: EventListenerOrEventListenerObject): void {
    this.listener = cb as (event: MessageEvent) => void;
  }
  postMessage(msg: unknown): void { this.posted.push(msg); }
  terminate(): void { /* no-op */ }
  emit(data: FromWorker): void { this.listener?.({ data } as MessageEvent); }
}

describe('WorkerClient', () => {
  it('forwards posts to the worker', () => {
    const fake = new FakeWorker();
    new WorkerClient(fake as unknown as Worker).post({ t: 'close' });
    expect(fake.posted).toEqual([{ t: 'close' }]);
  });

  it('delivers worker messages to the handler', () => {
    const fake = new FakeWorker();
    const client = new WorkerClient(fake as unknown as Worker);
    const seen = vi.fn();
    client.on(seen);
    fake.emit({ t: 'peer-joined' });
    expect(seen).toHaveBeenCalledWith({ t: 'peer-joined' });
  });
});
```

- [ ] **Step 8: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add client/worker tests/unit/worker-messages.test.ts tests/unit/progress-throttle.test.ts
git commit -m "feat(client): run transfers in a web worker with throttled progress"
```

---

### Task 2: File System Access save sink

**Files:**
- Create: `client/save/fsaccess.ts`
- Test: `tests/unit/save-fsaccess.test.ts`

**Interfaces:**
- Consumes: `SaveSink` from `client/save/types.ts`.
- Produces: `supportsFileSystemAccess(): boolean`, `createFileSystemSink(meta: FileMeta): Promise<SaveSink>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/save-fsaccess.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileSystemSink, supportsFileSystemAccess } from '../../client/save/fsaccess.js';

const meta = { id: 1, name: 'a.bin', size: 3, type: 'application/octet-stream' };

function installPicker(): { writes: Uint8Array[]; closed: boolean; picker: ReturnType<typeof vi.fn> } {
  const state = { writes: [] as Uint8Array[], closed: false };
  const writable = {
    write: vi.fn(async (chunk: Uint8Array) => { state.writes.push(chunk); }),
    close: vi.fn(async () => { state.closed = true; }),
    abort: vi.fn(async () => { state.closed = true; }),
  };
  const picker = vi.fn(async () => ({ createWritable: async () => writable }));
  Reflect.set(globalThis, 'showSaveFilePicker', picker);
  return { ...state, picker, get writes() { return state.writes; }, get closed() { return state.closed; } } as never;
}

afterEach(() => { Reflect.deleteProperty(globalThis, 'showSaveFilePicker'); });

describe('file system access sink', () => {
  it('reports unsupported when the picker is absent', () => {
    expect(supportsFileSystemAccess()).toBe(false);
  });

  it('reports supported when the picker exists', () => {
    installPicker();
    expect(supportsFileSystemAccess()).toBe(true);
  });

  it('suggests the incoming filename', async () => {
    const harness = installPicker();
    await createFileSystemSink(meta);
    expect(harness.picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'a.bin' }));
  });

  it('streams chunks to the writable and closes it', async () => {
    const harness = installPicker();
    const sink = await createFileSystemSink(meta);
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    expect(await sink.close()).toBeUndefined();
    expect(harness.writes.map((c) => [...c])).toEqual([[1, 2], [3]]);
    expect(harness.closed).toBe(true);
  });

  it('has no practical size cap', async () => {
    installPicker();
    const sink = await createFileSystemSink(meta);
    expect(() => sink.assertWithinCap(50 * 1024 ** 3)).not.toThrow();
  });

  it('aborts the writable so a partial file is discarded', async () => {
    const harness = installPicker();
    const sink = await createFileSystemSink(meta);
    await sink.write(new Uint8Array([1]));
    await sink.abort('integrity failure');
    expect(harness.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/save-fsaccess.test.ts`
Expected: FAIL — cannot resolve `../../client/save/fsaccess.js`.

- [ ] **Step 3: Implement `client/save/fsaccess.ts`**

```ts
import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from './types.js';

interface FileSystemWritableLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableLike>;
}

type SaveFilePicker = (opts: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandleLike>;

function picker(): SaveFilePicker | undefined {
  return Reflect.get(globalThis, 'showSaveFilePicker') as SaveFilePicker | undefined;
}

export function supportsFileSystemAccess(): boolean {
  return typeof picker() === 'function';
}

/**
 * Writes chunks straight to disk, so file size is bounded by the disk rather
 * than by tab memory. The picker must be called from a user gesture, so the
 * receiver requests this sink when the user accepts the incoming batch.
 */
export async function createFileSystemSink(meta: FileMeta): Promise<SaveSink> {
  const show = picker();
  if (!show) throw new Error('File System Access API is not available in this browser.');

  const handle = await show({ suggestedName: meta.name });
  const writable = await handle.createWritable();

  return {
    assertWithinCap(): void { /* disk-bound, no ceiling to enforce */ },
    async write(chunk: Uint8Array): Promise<void> { await writable.write(chunk); },
    async close(): Promise<Blob | undefined> { await writable.close(); return undefined; },
    async abort(reason: string): Promise<void> { await writable.abort(reason); },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/save-fsaccess.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/save/fsaccess.ts tests/unit/save-fsaccess.test.ts
git commit -m "feat(client): add File System Access save sink"
```

---

### Task 3: Service Worker streaming download

**Files:**
- Create: `client/sw.ts`
- Create: `client/save/swstream.ts`
- Test: `tests/unit/save-swstream.test.ts`

**Interfaces:**
- Consumes: `SaveSink`.
- Produces: `supportsServiceWorkerStream(): boolean`, `createServiceWorkerSink(meta: FileMeta, registration: ServiceWorkerRegistration): Promise<SaveSink>`.

**How this works.** The page opens a `MessageChannel` to the service worker and registers a virtual download URL (`/__download/<token>`). The worker holds a `ReadableStream` for that token and answers a `fetch` for the URL with a `Response` whose body is that stream and whose `Content-Disposition` forces a download. The page then navigates a hidden iframe to the URL, which hands the stream to the browser's own download machinery — bytes go to disk as they arrive, never accumulating in tab memory.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/save-swstream.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildDownloadHeaders, createStreamRegistry } from '../../client/save/swstream.js';

describe('download headers', () => {
  it('forces a download with the original filename', () => {
    const headers = buildDownloadHeaders({ id: 1, name: 'report.pdf', size: 10, type: 'application/pdf' });
    expect(headers.get('Content-Disposition')).toContain('attachment');
    expect(headers.get('Content-Disposition')).toContain('report.pdf');
  });

  it('percent-encodes non-ASCII filenames per RFC 5987', () => {
    const headers = buildDownloadHeaders({ id: 1, name: 'résumé.pdf', size: 10, type: 'application/pdf' });
    expect(headers.get('Content-Disposition')).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it('sets Content-Length so the browser can show a progress bar', () => {
    const headers = buildDownloadHeaders({ id: 1, name: 'a.bin', size: 4096, type: '' });
    expect(headers.get('Content-Length')).toBe('4096');
  });

  it('falls back to a generic content type', () => {
    const headers = buildDownloadHeaders({ id: 1, name: 'a.bin', size: 1, type: '' });
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });
});

describe('stream registry', () => {
  it('hands the registered stream to a matching request', async () => {
    const registry = createStreamRegistry();
    const { writable } = registry.register('token-1');
    const writer = writable.getWriter();
    void writer.write(new Uint8Array([1, 2, 3])).then(() => writer.close());

    const stream = registry.take('token-1');
    expect(stream).toBeDefined();
    const reader = stream!.getReader();
    expect([...(await reader.read()).value!]).toEqual([1, 2, 3]);
  });

  it('returns undefined for an unknown token', () => {
    expect(createStreamRegistry().take('nope')).toBeUndefined();
  });

  it('consumes a token exactly once', () => {
    const registry = createStreamRegistry();
    registry.register('t');
    expect(registry.take('t')).toBeDefined();
    expect(registry.take('t')).toBeUndefined();
  });

  it('generates unique tokens', () => {
    const registry = createStreamRegistry();
    const tokens = new Set(Array.from({ length: 200 }, () => registry.newToken()));
    expect(tokens.size).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/save-swstream.test.ts`
Expected: FAIL — cannot resolve `../../client/save/swstream.js`.

- [ ] **Step 3: Implement `client/save/swstream.ts`**

```ts
import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from './types.js';

export const DOWNLOAD_PATH_PREFIX = '/__download/';

export function buildDownloadHeaders(meta: FileMeta): Headers {
  // RFC 5987: an ASCII fallback plus a percent-encoded UTF-8 form, so
  // non-Latin filenames survive.
  const asciiFallback = meta.name.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '');
  const encoded = encodeURIComponent(meta.name);

  return new Headers({
    'Content-Type': meta.type || 'application/octet-stream',
    'Content-Length': String(meta.size),
    'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
  });
}

export interface StreamRegistry {
  newToken(): string;
  register(token: string): { writable: WritableStream<Uint8Array> };
  take(token: string): ReadableStream<Uint8Array> | undefined;
}

export function createStreamRegistry(): StreamRegistry {
  const pending = new Map<string, ReadableStream<Uint8Array>>();

  return {
    newToken(): string {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    register(token: string): { writable: WritableStream<Uint8Array> } {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      pending.set(token, readable);
      return { writable };
    },
    take(token: string): ReadableStream<Uint8Array> | undefined {
      const stream = pending.get(token);
      pending.delete(token);
      return stream;
    },
  };
}

export function supportsServiceWorkerStream(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof TransformStream === 'function';
}

/**
 * Streams to disk through the browser's own download machinery. Bytes are
 * handed to the service worker as they arrive and never accumulate in the tab.
 */
export async function createServiceWorkerSink(
  meta: FileMeta,
  registration: ServiceWorkerRegistration,
): Promise<SaveSink> {
  const worker = registration.active;
  if (!worker) throw new Error('The download helper is not ready yet. Reload the page and try again.');

  const token = createStreamRegistry().newToken();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  worker.postMessage({ t: 'register-download', token, meta, stream: readable }, [readable as unknown as Transferable]);

  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = `${DOWNLOAD_PATH_PREFIX}${token}`;
  document.body.append(iframe);

  return {
    assertWithinCap(): void { /* disk-bound, no ceiling to enforce */ },
    async write(chunk: Uint8Array): Promise<void> { await writer.write(chunk); },
    async close(): Promise<Blob | undefined> {
      await writer.close();
      setTimeout(() => iframe.remove(), 5_000);
      return undefined;
    },
    async abort(reason: string): Promise<void> {
      await writer.abort(reason);
      iframe.remove();
    },
  };
}
```

- [ ] **Step 4: Implement `client/sw.ts`**

```ts
/// <reference lib="webworker" />
import { DOWNLOAD_PATH_PREFIX, buildDownloadHeaders } from './save/swstream.js';
import type { FileMeta } from '../shared/messages.js';

declare const self: ServiceWorkerGlobalScope;

interface PendingDownload {
  meta: FileMeta;
  stream: ReadableStream<Uint8Array>;
}

const pending = new Map<string, PendingDownload>();

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { t?: string; token?: string; meta?: FileMeta; stream?: ReadableStream<Uint8Array> };
  if (data?.t !== 'register-download' || !data.token || !data.meta || !data.stream) return;
  pending.set(data.token, { meta: data.meta, stream: data.stream });
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(DOWNLOAD_PATH_PREFIX)) return;

  const token = url.pathname.slice(DOWNLOAD_PATH_PREFIX.length);
  const entry = pending.get(token);
  if (!entry) {
    event.respondWith(new Response('This download has expired.', { status: 404 }));
    return;
  }
  pending.delete(token);
  event.respondWith(new Response(entry.stream, { headers: buildDownloadHeaders(entry.meta) }));
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/unit/save-swstream.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Manual browser verification (this path cannot be unit-tested end to end)**

Serve over HTTPS or `localhost`, register the service worker, and receive a file larger than available RAM would allow (2 GB is a good check on a phone).
Expected: the browser's own download indicator appears and memory use stays flat.

- [ ] **Step 7: Commit**

```bash
git add client/sw.ts client/save/swstream.ts tests/unit/save-swstream.test.ts
git commit -m "feat(client): stream downloads to disk through a service worker"
```

---

### Task 4: Save capability negotiation

**Files:**
- Create: `client/save/select.ts`
- Modify: `client/transfer/receiver.ts` — use the selected sink factory
- Modify: `client/session.ts` — advertise the real capability in `hello`
- Test: `tests/unit/save-select.test.ts`

**Interfaces:**
- Consumes: all three sinks.
- Produces: `detectSaveCapability(): SaveCapability`, `createSinkFactory(capability: SaveCapability, registration?: ServiceWorkerRegistration): (meta: FileMeta) => SaveSink | Promise<SaveSink>`, `describeCapability(c: SaveCapability): { label: string; limitBytes: number | undefined }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/save-select.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeCapability, detectSaveCapability } from '../../client/save/select.js';
import { BLOB_SINK_MAX_BYTES } from '../../client/save/blob.js';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
  Reflect.deleteProperty(globalThis, 'navigator');
});

describe('detectSaveCapability', () => {
  it('prefers File System Access when available', () => {
    Reflect.set(globalThis, 'showSaveFilePicker', vi.fn());
    expect(detectSaveCapability()).toBe('fs-access');
  });

  it('falls back to the service worker stream', () => {
    Reflect.set(globalThis, 'navigator', { serviceWorker: {} });
    expect(detectSaveCapability()).toBe('sw-stream');
  });

  it('falls back to an in-memory blob as a last resort', () => {
    Reflect.set(globalThis, 'navigator', {});
    expect(detectSaveCapability()).toBe('blob');
  });
});

describe('describeCapability', () => {
  it('reports no limit for disk-backed tiers', () => {
    expect(describeCapability('fs-access').limitBytes).toBeUndefined();
    expect(describeCapability('sw-stream').limitBytes).toBeUndefined();
  });

  it('reports the memory ceiling for the blob tier', () => {
    expect(describeCapability('blob').limitBytes).toBe(BLOB_SINK_MAX_BYTES);
  });

  it('gives every tier a human label', () => {
    for (const c of ['fs-access', 'sw-stream', 'blob'] as const) {
      expect(describeCapability(c).label.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/save-select.test.ts`
Expected: FAIL — cannot resolve `../../client/save/select.js`.

- [ ] **Step 3: Implement `client/save/select.ts`**

```ts
import type { FileMeta, SaveCapability } from '../../shared/messages.js';
import type { SaveSink } from './types.js';
import { BLOB_SINK_MAX_BYTES, createBlobSink } from './blob.js';
import { createFileSystemSink, supportsFileSystemAccess } from './fsaccess.js';
import { createServiceWorkerSink, supportsServiceWorkerStream } from './swstream.js';

export function detectSaveCapability(): SaveCapability {
  if (supportsFileSystemAccess()) return 'fs-access';
  if (supportsServiceWorkerStream()) return 'sw-stream';
  return 'blob';
}

export function describeCapability(capability: SaveCapability): { label: string; limitBytes: number | undefined } {
  switch (capability) {
    case 'fs-access': return { label: 'Saved straight to disk', limitBytes: undefined };
    case 'sw-stream': return { label: 'Streamed to your downloads', limitBytes: undefined };
    case 'blob': return { label: 'Held in memory', limitBytes: BLOB_SINK_MAX_BYTES };
  }
}

export function createSinkFactory(
  capability: SaveCapability,
  registration?: ServiceWorkerRegistration,
): (meta: FileMeta) => SaveSink | Promise<SaveSink> {
  switch (capability) {
    case 'fs-access': return (meta) => createFileSystemSink(meta);
    case 'sw-stream': return (meta) => {
      if (!registration) throw new Error('The download helper is not registered.');
      return createServiceWorkerSink(meta, registration);
    };
    case 'blob': return (meta) => createBlobSink(meta);
  }
}
```

- [ ] **Step 4: Widen `ReceiverOptions.createSink` to allow async sinks**

In `client/transfer/receiver.ts`, change the option type:

```ts
  createSink?: (meta: FileMeta) => SaveSink | Promise<SaveSink>;
```

and in `#handleControl`, make the `offer-batch` case await sink creation. Replace the `case 'offer-batch'` body with:

```ts
      case 'offer-batch': {
        const factory = this.#opts.createSink ?? ((meta: FileMeta) => createBlobSink(meta));
        for (const meta of msg.files) {
          try {
            const sink = await factory(meta);
            sink.assertWithinCap(meta.size);
            this.#incoming.set(meta.id, { meta, sink, bytesReceived: 0, failed: false });
          } catch (error: unknown) {
            this.#opts.events.onError({
              fileId: meta.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.#opts.events.onOffer(msg.files);
        return;
      }
```

Make `#handleControl` `async` and `await` it from `#handle`. The `#chain` promise in `start()` already serializes handling, so control frames still land in order ahead of the data frames that depend on them.

- [ ] **Step 5: Advertise the real capability in `client/session.ts`**

In `#sendHello`, replace the hard-coded `saveCapability: 'blob'` with a value passed into the session. Add a `saveCapability` field set from a new constructor argument, defaulted by `detectSaveCapability()` in `create` and `join`, and pass `createSinkFactory(...)` into the `Receiver` options in `#startReceiver`.

- [ ] **Step 6: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS. Plan 1's receiver tests still pass because the default factory is unchanged.

- [ ] **Step 7: Commit**

```bash
git add client/save/select.ts client/transfer/receiver.ts client/session.ts tests/unit/save-select.test.ts
git commit -m "feat(client): negotiate and select the best available save tier"
```

---

### Task 5: Design tokens and theming

**Files:**
- Create: `client/styles/tokens.css`
- Create: `client/styles/app.css`
- Modify: `vite.config.ts` — add React and Tailwind plugins
- Modify: `package.json` — add UI dependencies
- Test: `tests/unit/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties consumed by every component in Tasks 6–11.

**Guideline MUSTs in play:** `color-scheme` on `<html>`; `<meta name="theme-color">` matching the background; contrast increases on hover, active, and focus; borders and shadows tinted toward the background hue; `prefers-reduced-motion` honored.

- [ ] **Step 1: Add dependencies**

```bash
npm install react react-dom qrcode @zxing/browser @tanstack/react-virtual
npm install -D @types/react @types/react-dom @types/qrcode @vitejs/plugin-react tailwindcss @tailwindcss/vite jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom axe-core
```

- [ ] **Step 2: Write the failing token test**

```ts
// tests/unit/tokens.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../client/styles/tokens.css', import.meta.url), 'utf8');

const TOKENS = [
  '--color-bg', '--color-surface', '--color-surface-2', '--color-border',
  '--color-text', '--color-text-muted', '--color-accent', '--color-accent-fg',
  '--color-success', '--color-warning', '--color-danger',
];

describe('design tokens', () => {
  it('defines every token on bare :root so light mode never depends on a media query', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    for (const token of TOKENS) expect(root).toContain(token);
  });

  it('redefines tokens for system dark mode, guarded against an explicit light choice', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it('redefines tokens for an explicit dark choice so a toggle wins both ways', () => {
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it('sets color-scheme so native form controls and scrollbars match', () => {
    expect(css).toContain('color-scheme:');
  });

  it('honors prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('never animates a layout property', () => {
    expect(css).not.toMatch(/transition:[^;]*\b(width|height|top|left|right|bottom|margin|padding)\b/);
  });

  it('never uses transition: all', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/unit/tokens.test.ts`
Expected: FAIL — `client/styles/tokens.css` does not exist.

- [ ] **Step 4: Implement `client/styles/tokens.css`**

The product is a precise instrument used for thirty seconds at a time. The palette is near-neutral with a single accent reserved for live state, so a status change is the only thing on screen competing for attention.

```css
:root {
  color-scheme: light;

  --color-bg: #fbfbfc;
  --color-surface: #ffffff;
  --color-surface-2: #f3f4f6;
  --color-border: rgb(10 11 13 / 12%);
  --color-text: #0a0b0d;
  --color-text-muted: #565b66;
  --color-accent: #1f5cff;
  --color-accent-fg: #ffffff;
  --color-success: #0f7a43;
  --color-warning: #8a5a00;
  --color-danger: #b02a1f;

  --shadow-ambient: 0 1px 2px rgb(10 11 13 / 6%);
  --shadow-direct: 0 8px 24px -8px rgb(10 11 13 / 18%);

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;

  --duration-fast: 120ms;
  --duration-base: 200ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

/* System dark, unless the viewer explicitly chose light. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;

    --color-bg: #0a0b0d;
    --color-surface: #131519;
    --color-surface-2: #1c1f26;
    --color-border: rgb(255 255 255 / 12%);
    --color-text: #f2f3f5;
    --color-text-muted: #98a0ad;
    --color-accent: #6d9bff;
    --color-accent-fg: #06101f;
    --color-success: #3ecf8e;
    --color-warning: #e0a83a;
    --color-danger: #ff6b5e;

    --shadow-ambient: 0 1px 2px rgb(0 0 0 / 40%);
    --shadow-direct: 0 8px 24px -8px rgb(0 0 0 / 60%);
  }
}

/* Explicit dark choice wins in both directions. */
:root[data-theme="dark"] {
  color-scheme: dark;

  --color-bg: #0a0b0d;
  --color-surface: #131519;
  --color-surface-2: #1c1f26;
  --color-border: rgb(255 255 255 / 12%);
  --color-text: #f2f3f5;
  --color-text-muted: #98a0ad;
  --color-accent: #6d9bff;
  --color-accent-fg: #06101f;
  --color-success: #3ecf8e;
  --color-warning: #e0a83a;
  --color-danger: #ff6b5e;

  --shadow-ambient: 0 1px 2px rgb(0 0 0 / 40%);
  --shadow-direct: 0 8px 24px -8px rgb(0 0 0 / 60%);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Contrast note: verify each pairing with APCA rather than WCAG 2. Body text against `--color-bg` targets Lc ≥ 90; muted text and large type target Lc ≥ 60. Adjust `--color-text-muted` if it falls short in either theme.

- [ ] **Step 5: Implement `client/styles/app.css`**

```css
@import "tailwindcss";
@import "./tokens.css";

@theme inline {
  --color-bg: var(--color-bg);
  --color-surface: var(--color-surface);
  --color-surface-2: var(--color-surface-2);
  --color-border: var(--color-border);
  --color-text: var(--color-text);
  --color-text-muted: var(--color-text-muted);
  --color-accent: var(--color-accent);
  --color-accent-fg: var(--color-accent-fg);
  --color-success: var(--color-success);
  --color-warning: var(--color-warning);
  --color-danger: var(--color-danger);
}

html {
  /* Prevents iOS from silently enlarging text in landscape. */
  -webkit-text-size-adjust: 100%;
}

body {
  background-color: var(--color-bg);
  color: var(--color-text);
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  /* Kills the 300ms double-tap zoom delay without disabling pinch zoom. */
  touch-action: manipulation;
  -webkit-tap-highlight-color: rgb(31 92 255 / 18%);
  min-height: 100dvh;
  padding:
    env(safe-area-inset-top) env(safe-area-inset-right)
    env(safe-area-inset-bottom) env(safe-area-inset-left);
}

:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.numeric {
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

- [ ] **Step 6: Update `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } } },
});
```

- [ ] **Step 7: Add a jsdom test project to `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
    environmentMatchGlobs: [
      ['tests/ui/**', 'jsdom'],
      ['**', 'node'],
    ],
    setupFiles: ['tests/ui/setup.ts'],
  },
});
```

And `tests/ui/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 8: Run the token test**

Run: `npx vitest run tests/unit/tokens.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 9: Commit**

```bash
git add client/styles vite.config.ts vitest.config.ts tests/ui/setup.ts tests/unit/tokens.test.ts package.json package-lock.json
git commit -m "feat(ui): add theme-aware design tokens and Tailwind setup"
```

---

### Task 6: UI primitives

**Files:**
- Create: `client/ui/Button.tsx`
- Create: `client/ui/Badge.tsx`
- Create: `client/ui/ProgressBar.tsx`
- Create: `client/ui/CodeInput.tsx`
- Create: `client/ui/format.ts`
- Test: `tests/ui/primitives.test.tsx`
- Test: `tests/unit/format.test.ts`

**Interfaces:**
- Consumes: design tokens.
- Produces:
  - `formatBytes(n: number): string` — value and unit joined by a non-breaking space.
  - `formatRate(bytesPerSecond: number): string`
  - `<Button variant="primary" | "ghost" | "danger" loading?>`
  - `<Badge tone="neutral" | "live" | "relayed" icon label>`
  - `<ProgressBar value max label>`
  - `<CodeInput value onChange onSubmit>`

**Guideline MUSTs in play:** loading buttons keep their label and show a spinner; icon-only buttons carry an `aria-label`; status is never color-only; progress animates `transform` only; the code input is ≥ 16 px, paste-friendly, spellcheck-off, and autocapitalized.

- [ ] **Step 1: Write the failing format test**

```ts
// tests/unit/format.test.ts
import { describe, expect, it } from 'vitest';
import { formatBytes, formatRate } from '../../client/ui/format.js';

const NBSP = ' ';

describe('formatBytes', () => {
  it('joins value and unit with a non-breaking space', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe(`10${NBSP}MB`);
  });

  it('shows bytes below one kilobyte', () => {
    expect(formatBytes(512)).toBe(`512${NBSP}B`);
  });

  it('handles zero', () => {
    expect(formatBytes(0)).toBe(`0${NBSP}B`);
  });

  it('keeps one decimal place for partial units', () => {
    expect(formatBytes(1536)).toBe(`1.5${NBSP}KB`);
  });

  it('scales to gigabytes', () => {
    expect(formatBytes(3 * 1024 ** 3)).toBe(`3${NBSP}GB`);
  });
});

describe('formatRate', () => {
  it('appends a per-second suffix', () => {
    expect(formatRate(2.4 * 1024 * 1024)).toBe(`2.4${NBSP}MB/s`);
  });

  it('reports a stalled transfer plainly', () => {
    expect(formatRate(0)).toBe('—');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/format.test.ts`
Expected: FAIL — cannot resolve `../../client/ui/format.js`.

- [ ] **Step 3: Implement `client/ui/format.ts`**

```ts
const NBSP = ' ';
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}${NBSP}B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  // One decimal only when it carries information.
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${NBSP}${UNITS[unitIndex]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}
```

- [ ] **Step 4: Write the failing primitives test**

```tsx
// tests/ui/primitives.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../client/ui/Button.js';
import { Badge } from '../../client/ui/Badge.js';
import { ProgressBar } from '../../client/ui/ProgressBar.js';
import { CodeInput } from '../../client/ui/CodeInput.js';

describe('Button', () => {
  it('keeps its label while loading', () => {
    render(<Button loading>Send</Button>);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('marks itself busy for assistive tech while loading', () => {
    render(<Button loading>Send</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('fires on click', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
  });

  it('is reachable and activatable by keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Badge', () => {
  it('conveys status with text, not color alone', () => {
    render(<Badge tone="relayed" icon="↔" label="Relayed" />);
    expect(screen.getByText('Relayed')).toBeInTheDocument();
  });

  it('hides the decorative icon from assistive tech', () => {
    render(<Badge tone="live" icon="●" label="Direct" />);
    expect(screen.getByText('●')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('ProgressBar', () => {
  it('exposes progressbar semantics', () => {
    render(<ProgressBar value={50} max={100} label="Sending a.bin" />);
    const bar = screen.getByRole('progressbar', { name: /sending a\.bin/i });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('animates transform rather than width', () => {
    const { container } = render(<ProgressBar value={25} max={100} label="x" />);
    const fill = container.querySelector('[data-progress-fill]');
    expect(fill).toHaveStyle({ transform: 'scaleX(0.25)' });
  });

  it('clamps a value beyond the maximum', () => {
    render(<ProgressBar value={500} max={100} label="x" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('CodeInput', () => {
  it('normalizes a pasted, dashed, lowercase code', async () => {
    const onChange = vi.fn();
    render(<CodeInput value="" onChange={onChange} onSubmit={vi.fn()} />);
    await userEvent.type(screen.getByRole('textbox'), 'k7m-3qp');
    expect(onChange).toHaveBeenLastCalledWith('K7M3QP');
  });

  it('disables spellcheck and autocorrect for a code', () => {
    render(<CodeInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('autocapitalize', 'characters');
  });

  it('submits on Enter once the code is complete', async () => {
    const onSubmit = vi.fn();
    render(<CodeInput value="K7M3QP" onChange={vi.fn()} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('K7M3QP');
  });

  it('does not submit an incomplete code', async () => {
    const onSubmit = vi.fn();
    render(<CodeInput value="K7M" onChange={vi.fn()} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run tests/ui/primitives.test.tsx`
Expected: FAIL — the component modules do not exist.

- [ ] **Step 6: Implement the primitives**

`client/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:brightness-110 active:brightness-95',
  ghost: 'bg-[var(--color-surface-2)] text-[var(--color-text)] hover:bg-[var(--color-surface)] active:brightness-95',
  danger: 'bg-[var(--color-danger)] text-white hover:brightness-110 active:brightness-95',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'primary', loading = false, children, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      // min-h-11 is 44px: the touch target floor.
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 text-base font-medium transition-[filter,background-color] duration-[var(--duration-fast)] disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {/* The label stays put while loading, so the button never changes width. */}
      {children}
    </button>
  );
}
```

`client/ui/Badge.tsx`:

```tsx
type Tone = 'neutral' | 'live' | 'relayed';

const TONES: Record<Tone, string> = {
  neutral: 'text-[var(--color-text-muted)] border-[var(--color-border)]',
  live: 'text-[var(--color-success)] border-[color-mix(in_oklab,var(--color-success)_40%,transparent)]',
  relayed: 'text-[var(--color-warning)] border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)]',
};

export function Badge({ tone, icon, label }: { tone: Tone; icon: string; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm ${TONES[tone]}`}>
      {/* Icon is decorative: the label carries the meaning, so status is never color-only. */}
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </span>
  );
}
```

`client/ui/ProgressBar.tsx`:

```tsx
export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const clamped = Math.max(0, Math.min(value, max));
  const ratio = max > 0 ? clamped / max : 0;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
    >
      <div
        data-progress-fill
        // scaleX runs on the compositor; animating width would force layout.
        style={{ transform: `scaleX(${ratio})` }}
        className="h-full w-full origin-left bg-[var(--color-accent)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)]"
      />
    </div>
  );
}
```

`client/ui/CodeInput.tsx`:

```tsx
import { normalizeCode } from '../../server/codes.js';

export function CodeInput({
  value, onChange, onSubmit,
}: { value: string; onChange: (v: string) => void; onSubmit: (code: string) => void }) {
  const complete = normalizeCode(value) !== '';

  return (
    <input
      type="text"
      inputMode="text"
      autoCapitalize="characters"
      autoComplete="off"
      spellCheck={false}
      aria-label="Session code"
      placeholder="K7M3QP"
      value={value}
      maxLength={9}
      onChange={(event) => {
        // Accept messy input and normalize; never block typing.
        const raw = event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
        onChange(normalizeCode(raw) || raw);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        const code = normalizeCode(value);
        if (code) onSubmit(code);
      }}
      // text-base is 16px, which stops iOS zooming on focus.
      className="mono min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-base uppercase tracking-[0.3em]"
    />
  );
}

export { normalizeCode };
```

Note: `CodeInput` imports `normalizeCode` from `server/codes.ts`. That module is dependency-free and runs identically in a browser, so sharing it keeps one definition of what a valid code is. If the import path across the `server/` boundary reads badly, move `codes.ts` to `shared/` in this task and update the two server imports.

- [ ] **Step 7: Run the primitives test**

Run: `npx vitest run tests/ui/primitives.test.tsx tests/unit/format.test.ts`
Expected: PASS — 19 tests.

- [ ] **Step 8: Commit**

```bash
git add client/ui tests/ui/primitives.test.tsx tests/unit/format.test.ts
git commit -m "feat(ui): add accessible button, badge, progress and code input primitives"
```

---

### Task 7: App shell and fragment-preserving routing

**Files:**
- Create: `client/index.html`
- Create: `client/main.tsx`
- Create: `client/App.tsx`
- Create: `client/routing.ts`
- Delete: `client/dev.html`, `client/dev.ts`
- Test: `tests/unit/routing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseRoute(url: URL): Route` where `Route` is `{ t: 'home' } | { t: 'session'; code: string; keyFragment: string } | { t: 'invalid'; reason: 'bad-code' | 'missing-key' }`.

**Guideline MUSTs in play:** URL reflects state; `<title>` matches context; a skip-to-content link exists; hierarchical headings.

- [ ] **Step 1: Write the failing routing test**

```ts
// tests/unit/routing.test.ts
import { describe, expect, it } from 'vitest';
import { parseRoute } from '../../client/routing.js';

const KEY = 'a'.repeat(43);

describe('parseRoute', () => {
  it('treats the root as home', () => {
    expect(parseRoute(new URL('https://x.dev/'))).toEqual({ t: 'home' });
  });

  it('parses a session URL with its key fragment', () => {
    expect(parseRoute(new URL(`https://x.dev/s/K7M3QP#${KEY}`)))
      .toEqual({ t: 'session', code: 'K7M3QP', keyFragment: KEY });
  });

  it('normalizes a lowercase code in the path', () => {
    const route = parseRoute(new URL(`https://x.dev/s/k7m3qp#${KEY}`));
    expect(route).toMatchObject({ t: 'session', code: 'K7M3QP' });
  });

  it('reports a missing key rather than silently joining', () => {
    expect(parseRoute(new URL('https://x.dev/s/K7M3QP')))
      .toEqual({ t: 'invalid', reason: 'missing-key' });
  });

  it('rejects a malformed code', () => {
    expect(parseRoute(new URL(`https://x.dev/s/TOOLONG9#${KEY}`)))
      .toEqual({ t: 'invalid', reason: 'bad-code' });
  });

  it('rejects a truncated key', () => {
    expect(parseRoute(new URL('https://x.dev/s/K7M3QP#short')))
      .toEqual({ t: 'invalid', reason: 'missing-key' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/routing.test.ts`
Expected: FAIL — cannot resolve `../../client/routing.js`.

- [ ] **Step 3: Implement `client/routing.ts`**

```ts
import { normalizeCode } from '../server/codes.js';

export const KEY_FRAGMENT_LENGTH = 43;

export type Route =
  | { t: 'home' }
  | { t: 'session'; code: string; keyFragment: string }
  | { t: 'invalid'; reason: 'bad-code' | 'missing-key' };

export function parseRoute(url: URL): Route {
  const match = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return { t: 'home' };

  const code = normalizeCode(decodeURIComponent(match[1]!));
  if (!code) return { t: 'invalid', reason: 'bad-code' };

  const keyFragment = url.hash.slice(1);
  if (keyFragment.length !== KEY_FRAGMENT_LENGTH) return { t: 'invalid', reason: 'missing-key' };

  return { t: 'session', code, keyFragment };
}

/**
 * Navigates without losing the fragment. The key lives there, so any
 * history call that drops it silently breaks decryption for the peer.
 */
export function navigateTo(path: string, keyFragment?: string): void {
  const target = keyFragment ? `${path}#${keyFragment}` : path;
  history.pushState(null, '', target);
  dispatchEvent(new PopStateEvent('popstate'));
}
```

- [ ] **Step 4: Run the routing test**

Run: `npx vitest run tests/unit/routing.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Create `client/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <!-- Zoom is never disabled: no user-scalable=no, no maximum-scale. -->
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfbfc" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0b0d" />
    <meta name="description" content="Send files between two devices with a link or a QR code. Nothing is stored." />
    <title>soja-share</title>
  </head>
  <body>
    <a href="#main" class="sr-only focus:not-sr-only">Skip to content</a>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `client/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/app.css';

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 7: Create `client/App.tsx` as a route switch**

```tsx
import { useEffect, useState } from 'react';
import { parseRoute, type Route } from './routing.js';
import { CreateScreen } from './screens/CreateScreen.js';
import { SessionScreen } from './screens/SessionScreen.js';
import { InvalidScreen } from './screens/InvalidScreen.js';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(new URL(location.href)));

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(new URL(location.href)));
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-4">
      {route.t === 'home' && <CreateScreen />}
      {route.t === 'session' && <SessionScreen code={route.code} keyFragment={route.keyFragment} />}
      {route.t === 'invalid' && <InvalidScreen reason={route.reason} />}
    </main>
  );
}
```

Screens land in Tasks 8–10. Create empty placeholder modules now so the app compiles, and fill them in as each task runs.

- [ ] **Step 8: Delete the Plan 1 harness**

```bash
git rm client/dev.html client/dev.ts
```

Update `server/index.ts` to send `index.html` rather than `dev.html` for `/s/:code`.

- [ ] **Step 9: Commit**

```bash
git add client/index.html client/main.tsx client/App.tsx client/routing.ts server/index.ts tests/unit/routing.test.ts
git commit -m "feat(ui): add app shell with fragment-preserving routing"
```

---

### Task 8: Create screen with client-side QR

**Files:**
- Create: `client/screens/CreateScreen.tsx`
- Create: `client/ui/QRPanel.tsx`
- Create: `client/hooks/useSession.ts`
- Test: `tests/ui/create-screen.test.tsx`

**Interfaces:**
- Consumes: `WorkerClient`, `formatBytes`, primitives.
- Produces: `useSession(intent)` returning `{ state, code, shareUrl, peerPresent, files, send, sendText, error }`.

**Guideline MUSTs in play:** the QR is rendered in-browser (never fetched); the copy button confirms; the code is `translate="no"`; empty and waiting states are designed; `<title>` reflects context.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/ui/create-screen.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QRPanel } from '../../client/ui/QRPanel.js';

vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => undefined) },
  toCanvas: vi.fn(async () => undefined),
}));

describe('QRPanel', () => {
  it('renders the code as readable text alongside the QR', async () => {
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByText(/K7M-3QP/)).toBeInTheDocument());
  });

  it('marks the code as untranslatable so it cannot be garbled', async () => {
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByText(/K7M-3QP/)).toHaveAttribute('translate', 'no'));
  });

  it('gives the QR canvas an accessible description', async () => {
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByLabelText(/scan/i)).toBeInTheDocument());
  });

  it('never sends the URL anywhere to build the QR', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<QRPanel shareUrl="https://x.dev/s/K7M3QP#key" code="K7M3QP" />);
    await waitFor(() => expect(screen.getByText(/K7M-3QP/)).toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/create-screen.test.tsx`
Expected: FAIL — cannot resolve `../../client/ui/QRPanel.js`.

- [ ] **Step 3: Implement `client/ui/QRPanel.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

/** Groups the code as XXX-XXX so it can be read aloud without mistakes. */
function groupCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function QRPanel({ shareUrl, code }: { shareUrl: string; code: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    // Rendered locally. The URL fragment holds the key, so asking a server
    // to draw this would hand over the very secret the fragment protects.
    void QRCode.toCanvas(canvasRef.current, shareUrl, {
      width: 288,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
  }, [shareUrl]);

  return (
    <div className="flex flex-col items-center gap-4">
      {/* A bright card on a dark canvas: cameras lock on faster. */}
      <div className="rounded-[var(--radius-lg)] bg-white p-4 shadow-[var(--shadow-ambient),var(--shadow-direct)]">
        <canvas ref={canvasRef} aria-label="Scan this QR code with the other device" role="img" />
      </div>
      <p
        translate="no"
        className="mono text-3xl tracking-[0.35em] text-[var(--color-text)]"
      >
        {groupCode(code)}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Implement `client/hooks/useSession.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkerClient } from '../worker/client.js';
import type { FromWorker } from '../worker/messages.js';
import type { FileMeta } from '../../shared/messages.js';
import { detectSaveCapability } from '../save/select.js';

export type SessionState = 'connecting' | 'waiting' | 'paired' | 'ended' | 'error';

export interface TrackedFile {
  meta: FileMeta;
  direction: 'send' | 'receive';
  bytesMoved: number;
  bytesPerSecond: number;
  done: boolean;
  blobUrl?: string;
}

export interface SessionHandle {
  state: SessionState;
  code: string;
  shareUrl: string;
  files: TrackedFile[];
  texts: string[];
  error: string | undefined;
  sendFiles(files: File[]): void;
  sendText(content: string): void;
}

export function useSession(intent: { t: 'create' } | { t: 'join'; code: string; keyFragment: string }): SessionHandle {
  const [state, setState] = useState<SessionState>('connecting');
  const [code, setCode] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [files, setFiles] = useState<TrackedFile[]>([]);
  const [texts, setTexts] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const clientRef = useRef<WorkerClient | undefined>(undefined);

  useEffect(() => {
    const worker = new Worker(new URL('../worker/transfer-worker.ts', import.meta.url), { type: 'module' });
    const client = new WorkerClient(worker);
    clientRef.current = client;

    client.on((msg: FromWorker) => {
      switch (msg.t) {
        case 'ready':
          setCode(msg.code);
          setShareUrl(msg.shareUrl);
          setState(intent.t === 'create' ? 'waiting' : 'paired');
          return;
        case 'peer-joined': setState('paired'); return;
        case 'peer-left': setState('ended'); return;
        case 'offer':
          setFiles((prev) => [
            ...prev,
            ...msg.files.map((meta) => ({ meta, direction: 'receive' as const, bytesMoved: 0, bytesPerSecond: 0, done: false })),
          ]);
          return;
        case 'outgoing':
          setFiles((prev) => [
            ...prev,
            ...msg.files.map((meta) => ({ meta, direction: 'send' as const, bytesMoved: 0, bytesPerSecond: 0, done: false })),
          ]);
          return;
        case 'send-progress':
        case 'receive-progress':
          setFiles((prev) => prev.map((f) =>
            f.meta.id === msg.fileId ? { ...f, bytesMoved: msg.bytesMoved, bytesPerSecond: msg.bytesPerSecond } : f,
          ));
          return;
        case 'file-complete':
          setFiles((prev) => prev.map((f) =>
            f.meta.id === msg.meta.id
              ? { ...f, done: true, bytesMoved: msg.meta.size, blobUrl: msg.blob ? URL.createObjectURL(msg.blob) : undefined }
              : f,
          ));
          return;
        case 'text': setTexts((prev) => [...prev, msg.content]); return;
        case 'error': setError(msg.message); setState('error'); return;
      }
    });

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    client.post({ t: 'init', wsUrl, intent, saveCapability: detectSaveCapability() });

    return () => { client.post({ t: 'close' }); client.terminate(); };
    // The intent is fixed for the lifetime of a screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendFiles = useCallback((chosen: File[]) => {
    // No optimistic rows: the worker announces the real metas via 'outgoing',
    // and only those ids match the progress messages that follow.
    clientRef.current?.post({ t: 'send-files', files: chosen });
  }, []);

  const sendText = useCallback((content: string) => {
    clientRef.current?.post({ t: 'send-text', content });
  }, []);

  return { state, code, shareUrl, files, texts, error, sendFiles, sendText };
}
```

- [ ] **Step 5: Implement `client/screens/CreateScreen.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useSession } from '../hooks/useSession.js';
import { QRPanel } from '../ui/QRPanel.js';
import { Button } from '../ui/Button.js';
import { TransferPanel } from './TransferPanel.js';

export function CreateScreen() {
  const session = useSession({ t: 'create' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = session.code ? `${session.code} · soja-share` : 'soja-share';
  }, [session.code]);

  if (session.state === 'connecting') {
    return <p className="text-[var(--color-text-muted)]">Starting a session…</p>;
  }

  if (session.state === 'paired') return <TransferPanel session={session} />;

  return (
    <section className="flex flex-col items-center gap-6 py-8">
      <h1 className="text-2xl font-semibold">Scan to connect</h1>
      <QRPanel shareUrl={session.shareUrl} code={session.code} />
      <p className="max-w-sm text-center text-[var(--color-text-muted)]">
        Open the camera on the other device, or type the code at this address. Files move directly between
        the two devices and are never stored.
      </p>
      <Button
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(session.shareUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? 'Link copied' : 'Copy link'}
      </Button>
      <p aria-live="polite" className="sr-only">{copied ? 'Link copied to clipboard' : ''}</p>
      <p className="text-sm text-[var(--color-text-muted)]">Waiting for the other device…</p>
    </section>
  );
}
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/ui/create-screen.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add client/screens/CreateScreen.tsx client/ui/QRPanel.tsx client/hooks/useSession.ts tests/ui/create-screen.test.tsx
git commit -m "feat(ui): add create screen with locally rendered QR code"
```

---

### Task 9: Join screen with camera scan and manual entry

**Files:**
- Create: `client/screens/JoinScreen.tsx`
- Create: `client/screens/InvalidScreen.tsx`
- Create: `client/hooks/useQRScanner.ts`
- Test: `tests/ui/join-screen.test.tsx`

**Interfaces:**
- Consumes: `CodeInput`, `parseRoute`, `navigateTo`.
- Produces: `useQRScanner({ onResult })` returning `{ videoRef, status: 'idle' | 'scanning' | 'denied' | 'unsupported', start(): void }`.

**Guideline MUSTs in play:** camera denial is never a dead end — manual entry is always present and focused; the error explains the next step; the scanner has a keyboard-reachable alternative.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/ui/join-screen.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JoinScreen } from '../../client/screens/JoinScreen.js';
import { InvalidScreen } from '../../client/screens/InvalidScreen.js';

vi.mock('../../client/hooks/useQRScanner.js', () => ({
  useQRScanner: () => ({ videoRef: { current: null }, status: 'unsupported', start: vi.fn() }),
}));

describe('JoinScreen', () => {
  it('always offers manual code entry', () => {
    render(<JoinScreen onJoin={vi.fn()} />);
    expect(screen.getByLabelText(/session code/i)).toBeInTheDocument();
  });

  it('submits a typed code', async () => {
    const onJoin = vi.fn();
    render(<JoinScreen onJoin={onJoin} />);
    await userEvent.type(screen.getByLabelText(/session code/i), 'K7M3QP{Enter}');
    expect(onJoin).toHaveBeenCalledWith('K7M3QP');
  });

  it('explains that the camera is unavailable instead of failing silently', () => {
    render(<JoinScreen onJoin={vi.fn()} />);
    expect(screen.getByText(/camera/i)).toBeInTheDocument();
  });
});

describe('InvalidScreen', () => {
  it('explains a missing key and offers a way forward', () => {
    render(<InvalidScreen reason="missing-key" />);
    expect(screen.getByText(/key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start a new session/i })).toBeInTheDocument();
  });

  it('explains a bad code and offers a way forward', () => {
    render(<InvalidScreen reason="bad-code" />);
    expect(screen.getByRole('button', { name: /start a new session/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/join-screen.test.tsx`
Expected: FAIL — the screen modules do not exist.

- [ ] **Step 3: Implement `client/hooks/useQRScanner.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';

export type ScannerStatus = 'idle' | 'scanning' | 'denied' | 'unsupported';

export function useQRScanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<ScannerStatus>('idle');
  const controlsRef = useRef<{ stop: () => void } | undefined>(undefined);

  const start = useCallback(() => {
    // getUserMedia requires a secure context; on plain http it is simply absent.
    if (!navigator.mediaDevices?.getUserMedia || !videoRef.current) {
      setStatus('unsupported');
      return;
    }
    setStatus('scanning');
    const reader = new BrowserQRCodeReader();
    void reader
      .decodeFromVideoDevice(undefined, videoRef.current, (result) => {
        if (result) onResult(result.getText());
      })
      .then((controls) => { controlsRef.current = controls; })
      .catch(() => setStatus('denied'));
  }, [onResult]);

  useEffect(() => () => controlsRef.current?.stop(), []);

  return { videoRef, status, start };
}
```

- [ ] **Step 4: Implement `client/screens/JoinScreen.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { CodeInput } from '../ui/CodeInput.js';
import { Button } from '../ui/Button.js';
import { useQRScanner } from '../hooks/useQRScanner.js';
import { parseRoute } from '../routing.js';

export function JoinScreen({ onJoin }: { onJoin: (code: string, keyFragment?: string) => void }) {
  const [value, setValue] = useState('');
  const scanner = useQRScanner({
    onResult: (text) => {
      try {
        const route = parseRoute(new URL(text));
        if (route.t === 'session') onJoin(route.code, route.keyFragment);
      } catch { /* not a URL; ignore and keep scanning */ }
    },
  });

  useEffect(() => { document.title = 'Join a session · soja-share'; }, []);

  return (
    <section className="flex flex-col gap-6 py-8">
      <h1 className="text-2xl font-semibold">Join a session</h1>

      {scanner.status === 'scanning' ? (
        <video ref={scanner.videoRef} className="w-full rounded-[var(--radius-lg)]" muted playsInline />
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
          <p className="text-[var(--color-text-muted)]">
            {scanner.status === 'denied'
              ? 'Camera access was declined. Type the code below instead.'
              : scanner.status === 'unsupported'
                ? 'The camera is unavailable here — this page needs HTTPS. Type the code below instead.'
                : 'Scan the QR code on the other device, or type its code below.'}
          </p>
          {scanner.status === 'idle' && (
            <Button className="mt-4" onClick={scanner.start}>Use the camera</Button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <label htmlFor="code" className="text-sm text-[var(--color-text-muted)]">Session code</label>
        <CodeInput value={value} onChange={setValue} onSubmit={(code) => onJoin(code)} />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Implement `client/screens/InvalidScreen.tsx`**

```tsx
import { Button } from '../ui/Button.js';
import { navigateTo } from '../routing.js';

const COPY: Record<'bad-code' | 'missing-key' | 'expired', { heading: string; body: string }> = {
  'bad-code': {
    heading: 'That code does not look right',
    body: 'Session codes are six characters. Check the other device and try again.',
  },
  'missing-key': {
    heading: 'This link is missing its key',
    body: 'The part after the # carries the decryption key and never reaches our server. Ask for the full link, or scan the QR code instead.',
  },
  expired: {
    heading: 'This session has ended',
    body: 'Sessions live only while both devices have the page open. Nothing was stored.',
  },
};

export function InvalidScreen({ reason }: { reason: 'bad-code' | 'missing-key' | 'expired' }) {
  const copy = COPY[reason];
  return (
    <section className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">{copy.heading}</h1>
      <p className="max-w-sm text-[var(--color-text-muted)]">{copy.body}</p>
      {/* No dead ends: every error screen offers the next step. */}
      <Button onClick={() => navigateTo('/')}>Start a new session</Button>
    </section>
  );
}
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/ui/join-screen.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 7: Commit**

```bash
git add client/screens client/hooks/useQRScanner.ts tests/ui/join-screen.test.tsx
git commit -m "feat(ui): add join screen with camera scanning and manual fallback"
```

---

### Task 10: Session screen — drop zone, queue, text snippets

**Files:**
- Create: `client/screens/SessionScreen.tsx`
- Create: `client/screens/TransferPanel.tsx`
- Create: `client/ui/DropZone.tsx`
- Create: `client/ui/FileQueue.tsx`
- Create: `client/ui/TextSnippet.tsx`
- Test: `tests/ui/transfer-panel.test.tsx`

**Interfaces:**
- Consumes: `useSession`, primitives, `formatBytes`, `formatRate`.
- Produces: the paired-session UI.

**Guideline MUSTs in play:** drag is never the only path; the queue virtualizes past 50 rows; flex children carry `min-w-0` so long filenames truncate; numbers are tabular; completion is announced politely; text areas submit on ⌘/Ctrl+Enter; empty state is designed.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/ui/transfer-panel.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DropZone } from '../../client/ui/DropZone.js';
import { FileQueue } from '../../client/ui/FileQueue.js';
import { TextSnippet } from '../../client/ui/TextSnippet.js';
import type { TrackedFile } from '../../client/hooks/useSession.js';

const tracked = (over: Partial<TrackedFile> = {}): TrackedFile => ({
  meta: { id: 1, name: 'report.pdf', size: 2048, type: 'application/pdf' },
  direction: 'send', bytesMoved: 1024, bytesPerSecond: 512, done: false, ...over,
});

describe('DropZone', () => {
  it('offers a click-to-browse path, not only drag and drop', () => {
    render(<DropZone onFiles={vi.fn()} />);
    expect(screen.getByRole('button', { name: /choose files/i })).toBeInTheDocument();
  });

  it('is operable by keyboard', async () => {
    render(<DropZone onFiles={vi.fn()} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /choose files/i })).toHaveFocus();
  });

  it('accepts dropped files', () => {
    const onFiles = vi.fn();
    const { container } = render(<DropZone onFiles={onFiles} />);
    const zone = container.querySelector('[data-dropzone]')!;
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const event = new Event('drop', { bubbles: true }) as Event & { dataTransfer: unknown };
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file], items: [] } });
    zone.dispatchEvent(event);
    expect(onFiles).toHaveBeenCalled();
  });
});

describe('FileQueue', () => {
  it('shows sizes with a non-breaking space', () => {
    render(<FileQueue files={[tracked()]} />);
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
  });

  it('renders numbers with tabular figures so they do not jitter', () => {
    const { container } = render(<FileQueue files={[tracked()]} />);
    expect(container.querySelector('.numeric')).toBeInTheDocument();
  });

  it('announces completion politely', () => {
    render(<FileQueue files={[tracked({ done: true })]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/report\.pdf/i);
  });

  it('designs an empty state rather than rendering nothing', () => {
    render(<FileQueue files={[]} />);
    expect(screen.getByText(/nothing sent yet/i)).toBeInTheDocument();
  });

  it('truncates a very long filename instead of overflowing', () => {
    const long = 'a'.repeat(300) + '.pdf';
    const { container } = render(<FileQueue files={[tracked({ meta: { id: 1, name: long, size: 10, type: '' } })]} />);
    expect(container.querySelector('.truncate')).toBeInTheDocument();
    expect(container.querySelector('.min-w-0')).toBeInTheDocument();
  });
});

describe('TextSnippet', () => {
  it('submits on Ctrl+Enter, not on plain Enter', async () => {
    const onSend = vi.fn();
    render(<TextSnippet onSend={onSend} received={[]} />);
    const box = screen.getByRole('textbox', { name: /text to send/i });
    await userEvent.type(box, 'hello{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, '{Control>}{Enter}{/Control}');
    expect(onSend).toHaveBeenCalledWith('hello\n');
  });

  it('offers a copy action for received text', () => {
    render(<TextSnippet onSend={vi.fn()} received={['a secret']} />);
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/transfer-panel.test.tsx`
Expected: FAIL — the component modules do not exist.

- [ ] **Step 3: Implement `client/ui/DropZone.tsx`**

```tsx
import { useRef, useState } from 'react';
import { Button } from './Button.js';

export function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      data-dropzone
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length > 0) onFiles(files);
      }}
      className={`flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-dashed p-8 text-center transition-colors duration-[var(--duration-fast)] ${
        over ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)]' : 'border-[var(--color-border)]'
      }`}
    >
      <p className="text-[var(--color-text-muted)]">Drop files or a folder here</p>
      {/* Drag is an enhancement. The button is the guaranteed path. */}
      <Button onClick={() => inputRef.current?.click()}>Choose files</Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        // webkitdirectory is set imperatively below so the same input serves both.
        className="sr-only"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length > 0) onFiles(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Implement `client/ui/FileQueue.tsx`**

```tsx
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ProgressBar } from './ProgressBar.js';
import { formatBytes, formatRate } from './format.js';
import type { TrackedFile } from '../hooks/useSession.js';

const VIRTUALIZE_ABOVE = 50;
const ROW_HEIGHT = 68;

function Row({ file }: { file: TrackedFile }) {
  return (
    <div className="flex items-center gap-3 py-2">
      {/* min-w-0 is what actually lets the filename truncate inside a flex row. */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{file.meta.name}</p>
        <p className="numeric text-xs text-[var(--color-text-muted)]">
          {formatBytes(file.bytesMoved)} of {formatBytes(file.meta.size)}
          {!file.done && ` · ${formatRate(file.bytesPerSecond)}`}
        </p>
        <div className="mt-1.5">
          <ProgressBar
            value={file.bytesMoved}
            max={file.meta.size}
            label={`${file.direction === 'send' ? 'Sending' : 'Receiving'} ${file.meta.name}`}
          />
        </div>
      </div>
      {file.done && file.blobUrl && (
        <a href={file.blobUrl} download={file.meta.name} className="text-sm text-[var(--color-accent)]">
          Save
        </a>
      )}
    </div>
  );
}

export function FileQueue({ files }: { files: TrackedFile[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const completed = files.filter((f) => f.done).map((f) => f.meta.name);

  if (files.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]">Nothing sent yet. Drop a file to begin.</p>;
  }

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {completed.length > 0 ? `${completed.at(-1)} finished` : ''}
      </p>

      {files.length <= VIRTUALIZE_ABOVE ? (
        <div>{files.map((f) => <Row key={f.meta.id} file={f} />)}</div>
      ) : (
        // A folder drop can be thousands of rows; rendering them all melts the tab.
        <div ref={parentRef} className="max-h-96 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
              >
                <Row file={files[item.index]!} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Implement `client/ui/TextSnippet.tsx`**

```tsx
import { useState } from 'react';
import { Button } from './Button.js';

export function TextSnippet({ onSend, received }: { onSend: (content: string) => void; received: string[] }) {
  const [draft, setDraft] = useState('');

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-[var(--color-text-muted)]">Send text</h2>
      <textarea
        aria-label="Text to send"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Plain Enter inserts a newline; the modifier submits, per the guidelines.
          if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          if (draft.trim()) { onSend(draft); setDraft(''); }
        }}
        rows={3}
        placeholder="Paste a link or a note…"
        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-base"
      />
      <p className="text-xs text-[var(--color-text-muted)]">Press ⌘/Ctrl + Enter to send</p>

      {received.map((text, i) => (
        <div key={i} className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3">
          <p className="min-w-0 flex-1 break-words text-sm">{text}</p>
          <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(text)}>Copy</Button>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 6: Implement `TransferPanel.tsx` and `SessionScreen.tsx`**

```tsx
// client/screens/TransferPanel.tsx
import { Badge } from '../ui/Badge.js';
import { DropZone } from '../ui/DropZone.js';
import { FileQueue } from '../ui/FileQueue.js';
import { TextSnippet } from '../ui/TextSnippet.js';
import type { SessionHandle } from '../hooks/useSession.js';

export function TransferPanel({ session }: { session: SessionHandle }) {
  return (
    <section className="flex flex-col gap-6 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Connected</h1>
        <Badge tone="relayed" icon="↔" label="Relayed" />
      </header>
      <DropZone onFiles={session.sendFiles} />
      <FileQueue files={session.files} />
      <TextSnippet onSend={session.sendText} received={session.texts} />
      {session.error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">{session.error}</p>
      )}
    </section>
  );
}
```

```tsx
// client/screens/SessionScreen.tsx
import { useSession } from '../hooks/useSession.js';
import { TransferPanel } from './TransferPanel.js';
import { InvalidScreen } from './InvalidScreen.js';

export function SessionScreen({ code, keyFragment }: { code: string; keyFragment: string }) {
  const session = useSession({ t: 'join', code, keyFragment });

  if (session.state === 'connecting') {
    return <p className="text-[var(--color-text-muted)]">Connecting…</p>;
  }
  if (session.state === 'ended') return <InvalidScreen reason="expired" />;
  return <TransferPanel session={session} />;
}
```

The transport badge is hard-coded to `Relayed` here because Plan 2 has only one transport. Plan 3 makes it reflect the live transport.

- [ ] **Step 7: Run the test**

Run: `npx vitest run tests/ui/transfer-panel.test.tsx`
Expected: PASS — 10 tests.

- [ ] **Step 8: Commit**

```bash
git add client/screens client/ui tests/ui/transfer-panel.test.tsx
git commit -m "feat(ui): add session screen with drop zone, file queue and text snippets"
```

---

### Task 11: In-flight guards and live title

**Files:**
- Create: `client/hooks/useTransferGuards.ts`
- Modify: `client/screens/TransferPanel.tsx` — use the hook
- Test: `tests/ui/transfer-guards.test.tsx`

**Interfaces:**
- Consumes: `TrackedFile[]`.
- Produces: `useTransferGuards(files: TrackedFile[]): void` — installs a `beforeunload` handler while any transfer is in flight and mirrors aggregate progress into `document.title`.

**Guideline MUSTs in play:** warn before navigation loses work; `<title>` matches current context.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/ui/transfer-guards.test.tsx
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTransferGuards } from '../../client/hooks/useTransferGuards.js';
import type { TrackedFile } from '../../client/hooks/useSession.js';

const tracked = (over: Partial<TrackedFile> = {}): TrackedFile => ({
  meta: { id: 1, name: 'a.bin', size: 100, type: '' },
  direction: 'send', bytesMoved: 40, bytesPerSecond: 10, done: false, ...over,
});

function fireBeforeUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  dispatchEvent(event);
  return event.defaultPrevented;
}

describe('useTransferGuards', () => {
  it('blocks navigation while a transfer is in flight', () => {
    renderHook(() => useTransferGuards([tracked()]));
    expect(fireBeforeUnload()).toBe(true);
  });

  it('allows navigation once everything is done', () => {
    renderHook(() => useTransferGuards([tracked({ done: true })]));
    expect(fireBeforeUnload()).toBe(false);
  });

  it('allows navigation when nothing is queued', () => {
    renderHook(() => useTransferGuards([]));
    expect(fireBeforeUnload()).toBe(false);
  });

  it('shows aggregate progress in the document title', () => {
    renderHook(() => useTransferGuards([tracked()]));
    expect(document.title).toMatch(/40%/);
  });

  it('restores the plain title when idle', () => {
    renderHook(() => useTransferGuards([tracked({ done: true })]));
    expect(document.title).not.toMatch(/%/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/transfer-guards.test.tsx`
Expected: FAIL — cannot resolve the hook module.

- [ ] **Step 3: Implement `client/hooks/useTransferGuards.ts`**

```ts
import { useEffect } from 'react';
import type { TrackedFile } from './useSession.js';

const BASE_TITLE = 'soja-share';

export function useTransferGuards(files: TrackedFile[]): void {
  const active = files.filter((f) => !f.done);
  const moved = active.reduce((sum, f) => sum + f.bytesMoved, 0);
  const total = active.reduce((sum, f) => sum + f.meta.size, 0);
  const percent = total > 0 ? Math.floor((moved / total) * 100) : 0;
  const inFlight = active.length > 0;

  useEffect(() => {
    // There is no server-side copy: closing the tab destroys the transfer.
    if (!inFlight) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    addEventListener('beforeunload', onBeforeUnload);
    return () => removeEventListener('beforeunload', onBeforeUnload);
  }, [inFlight]);

  useEffect(() => {
    // A backgrounded tab still shows progress in its title.
    document.title = inFlight ? `${percent}% · ${BASE_TITLE}` : BASE_TITLE;
    return () => { document.title = BASE_TITLE; };
  }, [inFlight, percent]);
}
```

- [ ] **Step 4: Use it in `TransferPanel`**

Add `useTransferGuards(session.files);` as the first line of the component body.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/ui/transfer-guards.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add client/hooks/useTransferGuards.ts client/screens/TransferPanel.tsx tests/ui/transfer-guards.test.tsx
git commit -m "feat(ui): guard navigation and mirror progress into the document title"
```

---

### Task 12: Accessibility audit

**Files:**
- Create: `tests/ui/a11y.test.tsx`
- Modify: whichever components the audit finds at fault

**Interfaces:**
- Consumes: every screen.
- Produces: an automated axe pass plus a recorded keyboard walkthrough.

- [ ] **Step 1: Write the axe test**

```tsx
// tests/ui/a11y.test.tsx
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { InvalidScreen } from '../../client/screens/InvalidScreen.js';
import { JoinScreen } from '../../client/screens/JoinScreen.js';
import { FileQueue } from '../../client/ui/FileQueue.js';
import { TextSnippet } from '../../client/ui/TextSnippet.js';

vi.mock('../../client/hooks/useQRScanner.js', () => ({
  useQRScanner: () => ({ videoRef: { current: null }, status: 'unsupported', start: vi.fn() }),
}));

async function violations(node: HTMLElement): Promise<axe.Result[]> {
  const results = await axe.run(node, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom cannot compute contrast
  });
  return results.violations;
}

describe('accessibility', () => {
  it('join screen has no axe violations', async () => {
    const { container } = render(<JoinScreen onJoin={vi.fn()} />);
    expect(await violations(container)).toEqual([]);
  });

  it('invalid screen has no axe violations', async () => {
    const { container } = render(<InvalidScreen reason="expired" />);
    expect(await violations(container)).toEqual([]);
  });

  it('file queue has no axe violations', async () => {
    const { container } = render(
      <FileQueue files={[{
        meta: { id: 1, name: 'a.bin', size: 10, type: '' },
        direction: 'receive', bytesMoved: 5, bytesPerSecond: 1, done: false,
      }]} />,
    );
    expect(await violations(container)).toEqual([]);
  });

  it('text snippet has no axe violations', async () => {
    const { container } = render(<TextSnippet onSend={vi.fn()} received={['x']} />);
    expect(await violations(container)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and fix what it finds**

Run: `npx vitest run tests/ui/a11y.test.tsx`
Expected: initially FAIL on real violations. Fix the components rather than relaxing the rules. The likely findings are a missing `<label>` association on the code input, a `<video>` without a title, and heading levels that skip.

- [ ] **Step 3: Manual keyboard walkthrough**

With the dev server running, complete a full transfer using only the keyboard: Tab to **Choose files**, select a file with Enter, Tab through the queue, Tab to the text box, send with ⌘/Ctrl+Enter, Tab to **Copy**. Confirm at every stop that the focus ring is visible and never covered by sticky UI.
Record the result in the commit message.

- [ ] **Step 4: Manual contrast check**

Check `--color-text`, `--color-text-muted`, `--color-accent`, and every status color against their backgrounds with an APCA tool, in both themes. Body text targets Lc ≥ 90; muted and large text target Lc ≥ 60. Adjust tokens until they pass, then re-run the token test.

- [ ] **Step 5: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/ui/a11y.test.tsx client
git commit -m "test(ui): add axe audit and fix the accessibility issues it found"
```

---

## Plan 2 done when

- `npm test` is green and `npm run typecheck` is clean.
- A multi-gigabyte file transfers on a File System Access browser and on a Service Worker browser without memory growth.
- The full flow is completable with the keyboard alone, and axe reports no violations.
- The UI reads correctly in light and dark, in system mode and with an explicit choice.

## Deliberately deferred

- **WebRTC and the transport badge's real state (spec §6).** The badge is hard-coded to `Relayed` until Plan 3.
- **Reconnect and resume (spec §10).** A dropped socket still ends the session.
- **Playwright end-to-end coverage (spec §13).** Plan 3 adds two-context browser tests.

Plan 3 adds the peer-to-peer transport, resilience, and the browser end-to-end suite.

import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from './types.js';

/** Virtual path the service worker answers; nothing on the server serves it. */
export const DOWNLOAD_PATH_PREFIX = '/__download/';

/**
 * `encodeURIComponent` leaves these alone, but RFC 8187 does not list them as
 * attr-chars — and `'` is what delimits the `UTF-8''` prefix, so a filename
 * containing one would truncate the value for a strict parser.
 */
const NOT_ATTR_CHAR = /['()*]/g;

export function buildDownloadHeaders(meta: FileMeta): Headers {
  // RFC 5987/8187: an ASCII fallback plus a percent-encoded UTF-8 form, so
  // non-Latin filenames survive. The fallback lives inside a quoted string, so
  // a quote or a backslash is dropped rather than transliterated — either one
  // would end or escape past the closing quote.
  const asciiFallback = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(meta.name).replace(
    NOT_ATTR_CHAR,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return new Headers({
    'Content-Type': meta.type || 'application/octet-stream',
    // Known up front, and without it the browser can only show an
    // indeterminate progress bar for the download.
    'Content-Length': String(meta.size),
    'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
  });
}

/** Unguessable, and safe to drop straight into a URL path. */
export function newDownloadToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PendingDownload {
  meta: FileMeta;
  stream: ReadableStream<Uint8Array>;
  /**
   * The page's half of the start handshake. The worker posts on it once the
   * download is actually being served; the page waits for that before it
   * writes, because bytes written into a stream nobody is reading never
   * settle. Optional because a page and a worker can be different builds
   * mid-update: a page that sends no port is still worth serving, and it is
   * the page's own timeout that covers a worker too old to answer.
   */
  port?: MessagePort;
}

export interface StreamRegistry {
  register(token: string, download: PendingDownload): void;
  /** Returns the download and forgets the token, so it is consumable once. */
  take(token: string): PendingDownload | undefined;
}

/**
 * The downloads the service worker is holding open, keyed by token. Take-once
 * because a `ReadableStream` can only be read once: a replayed request must
 * get a clean 404 rather than a stream someone else already drained.
 */
export function createStreamRegistry(): StreamRegistry {
  const pending = new Map<string, PendingDownload>();

  return {
    register(token: string, download: PendingDownload): void {
      pending.set(token, download);
    },
    take(token: string): PendingDownload | undefined {
      const download = pending.get(token);
      pending.delete(token);
      return download;
    },
  };
}

/**
 * Whether this browser can hand a stream to another realm. Safari 15.0–16.3
 * has `serviceWorker` and `TransformStream` but not transferable streams, so
 * `postMessage` throws DataCloneError — and feature-detecting the two
 * constructors alone reports that browser as supported. That would be a loud
 * throw in isolation; the damage is that the capability handshake advertises
 * this predicate to the *peer*, so the sender commits to an offer this
 * receiver can never save. Synchronous, and both ports are dropped
 * immediately, so nothing observes the probe.
 */
function canTransferStreams(): boolean {
  try {
    const stream = new ReadableStream();
    const channel = new MessageChannel();
    channel.port1.postMessage(stream, [stream]);
    channel.port1.close();
    channel.port2.close();
    return true;
  } catch {
    return false;
  }
}

export function supportsServiceWorkerStream(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof TransformStream === 'function'
    // The download is adopted by navigating a hidden iframe, so this tier
    // needs a document. Without this check the predicate reports supported
    // inside a worker, where `createServiceWorkerSink` cannot run at all.
    && typeof document !== 'undefined'
    && canTransferStreams();
}

/** Where the build emits the worker. Origin root, so its scope covers every page. */
const SERVICE_WORKER_URL = '/sw.js';

/**
 * Registers the download helper. Call it at startup rather than at the first
 * transfer: a freshly registered worker is active but not yet *controlling*
 * this page, and only a controlling worker intercepts the download fetch.
 *
 * The rejection is the caller's to handle and must be shown. Swallowed, a
 * failed registration is indistinguishable from a browser that never had the
 * tier, and the app downgrades to the in-memory blob sink with no explanation.
 */
export async function registerDownloadWorker(): Promise<ServiceWorkerRegistration> {
  if (!supportsServiceWorkerStream()) {
    throw new Error('This browser cannot stream downloads through a service worker.');
  }
  // Under `vite dev` /sw.js is served straight from source as an ES module —
  // it still carries its `import` of this file — and a classic registration
  // rejects on it. The built worker is a self-contained classic script (see
  // the second build entry in vite.config.ts), which Firefox needs because it
  // has no module service workers at all.
  const type: WorkerType = import.meta.env.DEV ? 'module' : 'classic';
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { type });
}

/**
 * How long to wait for the freshly registered worker to take control of this
 * page. `clients.claim()` in the worker's activate handler makes this quick,
 * but it is still a round trip through activation, so it is not instant.
 */
export const DOWNLOAD_CONTROL_TIMEOUT_MS = 5_000;

/**
 * Whether the download helper is actually *controlling* this page, waiting a
 * bounded time for it to take control if it does not yet.
 *
 * Registration resolves as soon as the worker is installed, which is strictly
 * earlier than control: on the first load after registering, the worker is
 * active but this page is still uncontrolled, and only a controlling worker
 * intercepts the download fetch. Advertising 'sw-stream' in that window tells
 * the peer this device has no size ceiling, and then every file fails on
 * `createServiceWorkerSink`'s controller check — which is exactly the lie the
 * capability handshake exists to prevent.
 */
export async function awaitDownloadWorkerControl(
  timeoutMs = DOWNLOAD_CONTROL_TIMEOUT_MS,
): Promise<boolean> {
  const container = navigator.serviceWorker;
  if (container.controller) return true;
  // Resolves once this page has an active registration — necessary for
  // control, but not sufficient, so the controller is re-checked after it.
  await container.ready;
  if (container.controller) return true;

  return new Promise<boolean>((resolve) => {
    const settle = (controlled: boolean): void => {
      clearTimeout(timer);
      container.removeEventListener('controllerchange', onChange);
      resolve(controlled);
    };
    const onChange = (): void => settle(Boolean(container.controller));
    const timer = setTimeout(() => settle(false), timeoutMs);
    container.addEventListener('controllerchange', onChange);
  });
}

/**
 * How long to wait for the worker to report that it is serving the download.
 * Generous: this covers a worker that has to be started from scratch, not a
 * round trip. What matters is that it is bounded at all.
 *
 * It is also a smaller instance of the ceiling described on
 * `createServiceWorkerSink` below: `Receiver.#openSink` awaits this handshake
 * before the first byte can be written, while frames for that file keep
 * arriving and queueing behind it. The bound on what that costs is this
 * timeout times the wire rate.
 */
export const DOWNLOAD_START_TIMEOUT_MS = 10_000;

/**
 * Resolves when the worker reports the download is being served, and rejects
 * if it never does.
 *
 * The worker's `fetch` handler can miss a token three ways: nothing orders the
 * `postMessage` task against a network-originated `fetch`, the worker can be
 * terminated between the two and lose its in-memory registry, and a replayed
 * request finds the token already consumed. Each ends in a 404 delivered into
 * a *hidden* iframe, which nobody sees. Without this wait the page then writes
 * into a stream with no reader: `TransformStream`'s readable side defaults to
 * a highWaterMark of 0, so the first `write()` returns a promise that never
 * settles and the transfer stalls silently — no error, no progress, and no
 * cleanup either, since `close()` never runs.
 */
function downloadStarted(port: MessagePort, timeoutMs: number, meta: FileMeta): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.close();
      reject(new Error(
        `The browser never started the download for "${meta.name}". `
        + 'The download helper did not respond; reload the page and try again.',
      ));
    }, timeoutMs);
    // A port buffers until it is started, and setting `onmessage` starts it,
    // so an acknowledgement that beats this line is still delivered.
    port.onmessage = (event: MessageEvent): void => {
      if ((event.data as { t?: string } | null)?.t !== 'download-started') return;
      clearTimeout(timer);
      port.close();
      resolve();
    };
  });
}

/**
 * Streams to disk through the browser's own download machinery. Bytes are
 * handed to the service worker as they arrive and never accumulate in the tab,
 * which is what makes multi-gigabyte transfers possible on the browsers
 * without the File System Access API.
 *
 * `write` resolves only as the download consumes the stream, so awaiting it
 * bounds what this sink itself holds. It does NOT bound the receiver, and
 * earlier wording here implied that it did. There is no receiver→sender flow
 * control anywhere in the stack: the relay forwards every frame without
 * checking `bufferedAmount` and never pauses the sending socket, and a
 * browser `WebSocket` cannot stop delivery. So when the disk is slower than
 * the wire, the deficit accumulates upstream of this sink as pending closures
 * in `Receiver`'s `#chain`, each pinning a ≤64 KB frame. Receiver memory is
 * bounded only while network ≤ disk.
 *
 * The real fix is a receiver-side credit control frame — a protocol change,
 * so it belongs with Plan 3's resilience/WebRTC work, where flow control
 * differs anyway.
 */
export async function createServiceWorkerSink(
  meta: FileMeta,
  registration: ServiceWorkerRegistration,
): Promise<SaveSink> {
  if (!registration.active) {
    throw new Error('The download helper is not ready yet. Reload the page and try again.');
  }
  // Registered is not the same as in control. A fetch is only intercepted once
  // the worker controls this page, and on the first load after registration it
  // is active but not yet controlling — exactly when a first transfer happens.
  // Without this guard the iframe below would go to the network and 404, and
  // the download would fail silently mid-transfer.
  if (!navigator.serviceWorker.controller) {
    throw new Error('The download helper is not controlling this page yet. Reload and try again.');
  }
  // The controller, not `registration.active`: during an update the two can be
  // different workers, and only the controller answers this page's fetches.
  const worker = navigator.serviceWorker.controller;

  const token = newDownloadToken();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // The reply channel for the start handshake below. Transferred with the
  // stream, so the worker can answer on the exact download it was handed.
  const channel = new MessageChannel();
  worker.postMessage(
    { t: 'register-download', token, meta, stream: readable, port: channel.port2 },
    [readable, channel.port2],
  );

  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = `${DOWNLOAD_PATH_PREFIX}${token}`;
  document.body.append(iframe);

  try {
    await downloadStarted(channel.port1, DOWNLOAD_START_TIMEOUT_MS, meta);
  } catch (error: unknown) {
    // Errored rather than abandoned: the writable half would otherwise sit
    // half-open, and the iframe would linger for the life of the page.
    await writer.abort(error instanceof Error ? error.message : String(error)).catch(() => undefined);
    iframe.remove();
    throw error;
  }

  /**
   * Held so `abort` can cancel the grace period below rather than leaving a
   * detached-in-5s iframe pinned to the document with nothing able to reclaim
   * it earlier.
   */
  let removalTimer: ReturnType<typeof setTimeout> | undefined;
  const removeIframe = (): void => {
    clearTimeout(removalTimer);
    removalTimer = undefined;
    iframe.remove();
  };

  return {
    // Disk-backed: capacity is bounded by free disk space, not tab memory,
    // so there is no ceiling for this sink to enforce.
    assertWithinCap(): void {},
    async write(chunk: Uint8Array): Promise<void> {
      await writer.write(chunk);
    },
    async close(): Promise<Blob | undefined> {
      await writer.close();
      // The browser needs the iframe to survive long enough to adopt the
      // download; removing it immediately can cancel it. The handle is kept
      // so an abort arriving inside this window takes the iframe out now
      // instead of leaving it attached until the timer fires.
      removalTimer = setTimeout(removeIframe, 5_000);
      return undefined;
    },
    async abort(reason: string): Promise<void> {
      await writer.abort(reason);
      removeIframe();
    },
  };
}

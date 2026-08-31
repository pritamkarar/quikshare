import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileMeta } from '../../shared/messages.js';
import {
  DOWNLOAD_PATH_PREFIX,
  DOWNLOAD_TOKEN_WAIT_MS,
  buildDownloadHeaders,
  createServiceWorkerSink,
  createStreamRegistry,
  newDownloadToken,
  registerDownloadWorker,
  supportsServiceWorkerStream,
} from '../../client/save/swstream.js';

const meta: FileMeta = { id: 1, name: 'report.pdf', size: 10, type: 'application/pdf' };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Reads a stream to completion so a test can assert on what the worker would receive. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const bytes: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes.push(...value);
  }
}

describe('download headers', () => {
  it('forces a download with the original filename', () => {
    const headers = buildDownloadHeaders(meta);
    expect(headers.get('Content-Disposition')).toContain('attachment');
    expect(headers.get('Content-Disposition')).toContain('report.pdf');
  });

  it('percent-encodes non-ASCII filenames per RFC 5987', () => {
    const headers = buildDownloadHeaders({ ...meta, name: 'résumé.pdf' });
    expect(headers.get('Content-Disposition')).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it('keeps quotes and backslashes out of the ASCII fallback they would break', () => {
    const headers = buildDownloadHeaders({ ...meta, name: 'mé"mo\\.pdf' });
    expect(headers.get('Content-Disposition')).toBe(
      `attachment; filename="m_mo.pdf"; filename*=UTF-8''m%C3%A9%22mo%5C.pdf`,
    );
  });

  it('forbids caching, since a token URL serves exactly one consumed stream', () => {
    expect(buildDownloadHeaders(meta).get('Cache-Control')).toBe('no-store');
  });

  it("percent-encodes an apostrophe, which delimits the UTF-8'' prefix", () => {
    const headers = buildDownloadHeaders({ ...meta, name: "don't (final).pdf" });
    expect(headers.get('Content-Disposition')).toContain("filename*=UTF-8''don%27t%20%28final%29.pdf");
  });

  it('sets Content-Length so the browser can show a progress bar', () => {
    expect(buildDownloadHeaders({ ...meta, name: 'a.bin', size: 4096, type: '' }).get('Content-Length')).toBe('4096');
  });

  it('falls back to a generic content type', () => {
    expect(buildDownloadHeaders({ ...meta, name: 'a.bin', size: 1, type: '' }).get('Content-Type')).toBe(
      'application/octet-stream',
    );
  });
});

describe('download tokens', () => {
  it('generates unique tokens', () => {
    expect(new Set(Array.from({ length: 200 }, () => newDownloadToken())).size).toBe(200);
  });

  it('generates tokens that are safe in a URL path', () => {
    expect(newDownloadToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('stream registry', () => {
  it('hands the registered stream to a matching request', async () => {
    const registry = createStreamRegistry();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    registry.register('token-1', { meta, stream: readable });
    const writer = writable.getWriter();
    void writer.write(new Uint8Array([1, 2, 3])).then(() => writer.close());

    const entry = await registry.take('token-1');
    expect(entry?.meta).toEqual(meta);
    expect(await drain(entry!.stream)).toEqual([1, 2, 3]);
  });

  it('returns undefined for an unknown token', async () => {
    expect(await createStreamRegistry().take('nope')).toBeUndefined();
  });

  it('consumes a token exactly once', async () => {
    const registry = createStreamRegistry();
    registry.register('t', { meta, stream: new TransformStream<Uint8Array, Uint8Array>().readable });
    expect(await registry.take('t')).toBeDefined();
    expect(await registry.take('t')).toBeUndefined();
  });

  /*
   * The lost-transfer race, at the seam where it happens. The page posts its
   * token and then navigates the download iframe, and nothing orders those
   * two: the fetch can reach the worker first. Answering "unknown" there
   * costs the file — the page never gets its acknowledgement, because the
   * port travelled with the token that was missed — so the request waits.
   */
  it('hands over a token that only registers after the request is already waiting', async () => {
    const registry = createStreamRegistry();
    const stream = new TransformStream<Uint8Array, Uint8Array>().readable;

    const taken = registry.take('late', 1_000);
    // Registered a turn later, exactly as the postMessage would land.
    await Promise.resolve();
    registry.register('late', { meta, stream });

    expect((await taken)?.stream).toBe(stream);
  });

  it('still consumes a late token exactly once', async () => {
    const registry = createStreamRegistry();
    const taken = registry.take('late', 1_000);
    registry.register('late', { meta, stream: new TransformStream<Uint8Array, Uint8Array>().readable });

    expect(await taken).toBeDefined();
    // Nothing was left in the map on the way past the waiting request.
    expect(await registry.take('late')).toBeUndefined();
  });

  it('gives up on a token that never arrives, rather than holding the request open', async () => {
    const registry = createStreamRegistry();
    expect(await createStreamRegistry().take('never', 10)).toBeUndefined();
    // And the give-up does not poison the token for a later, valid request.
    registry.register('later', { meta, stream: new TransformStream<Uint8Array, Uint8Array>().readable });
    expect(await registry.take('later', 10)).toBeDefined();
  });

  it('answers a second request for the same token once the first has given up', async () => {
    const registry = createStreamRegistry();
    const stream = new TransformStream<Uint8Array, Uint8Array>().readable;

    // A replayed download URL: the first waiter times out, and the second
    // must still be answerable rather than stranded by the first's cleanup.
    expect(await registry.take('dup', 10)).toBeUndefined();
    const second = registry.take('dup', 1_000);
    registry.register('dup', { meta, stream });

    expect((await second)?.stream).toBe(stream);
  });
});

describe('service worker support', () => {
  /** Everything the tier needs, so each test below can remove exactly one piece. */
  function installSupportedBrowser(): void {
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('document', { createElement: () => ({}), body: { append: () => undefined } });
  }

  it('reports unsupported when the browser has no service worker', () => {
    installSupportedBrowser();
    vi.stubGlobal('navigator', {});
    expect(supportsServiceWorkerStream()).toBe(false);
  });

  it('reports supported when the browser has one', () => {
    installSupportedBrowser();
    expect(supportsServiceWorkerStream()).toBe(true);
  });

  it('reports unsupported without TransformStream, which the download body is built from', () => {
    installSupportedBrowser();
    vi.stubGlobal('TransformStream', undefined);
    expect(supportsServiceWorkerStream()).toBe(false);
  });

  it('reports unsupported without a document to host the download iframe', () => {
    installSupportedBrowser();
    vi.stubGlobal('document', undefined);
    expect(supportsServiceWorkerStream()).toBe(false);
  });

  /**
   * Safari 15.0–16.3 has both `serviceWorker` and `TransformStream` and cannot
   * *transfer* a stream: `postMessage` throws DataCloneError. Reporting that
   * browser as supported is worse than a throw at sink creation, because the
   * capability handshake advertises this predicate to the peer — the sender
   * then commits to a multi-gigabyte offer this receiver can never save.
   */
  it('reports unsupported when a stream cannot be transferred', () => {
    installSupportedBrowser();
    vi.stubGlobal('MessageChannel', class {
      port1 = {
        postMessage: (): never => { throw new DOMException('could not be cloned', 'DataCloneError'); },
        close: (): void => undefined,
      };
      port2 = { close: (): void => undefined };
    });
    expect(supportsServiceWorkerStream()).toBe(false);
  });
});

interface FakeIframe {
  hidden: boolean;
  src: string;
  remove: ReturnType<typeof vi.fn>;
}

interface FakeController {
  postMessage: ReturnType<typeof vi.fn>;
}

/**
 * Stands in for the page: a service worker container in a given state of
 * readiness, plus enough of `document` to hold the hidden iframe.
 */
function installPage(controller: FakeController | null): {
  iframes: FakeIframe[];
  appended: ReturnType<typeof vi.fn>;
} {
  const iframes: FakeIframe[] = [];
  const appended = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: { controller } });
  vi.stubGlobal('document', {
    createElement: (): FakeIframe => {
      const iframe = { hidden: false, src: '', remove: vi.fn() };
      iframes.push(iframe);
      return iframe;
    },
    body: { append: appended },
  });
  return { iframes, appended };
}

/** The message the page posts to the worker to hand over one download. */
interface RegisterMessage {
  t: string;
  token: string;
  meta: FileMeta;
  stream: ReadableStream<Uint8Array>;
  port: MessagePort;
}

/**
 * A worker that behaves: it acknowledges the download the moment it is
 * registered, the way the real fetch handler does when it starts serving.
 */
function fakeController(): FakeController {
  return {
    postMessage: vi.fn((message: RegisterMessage) => {
      message.port.postMessage({ t: 'download-started', token: message.token });
    }),
  };
}

/**
 * A worker that never answers. Three real cases look like this: no ordering
 * guarantee between the `postMessage` task and a network-originated `fetch`,
 * a worker terminated between the two, and a request replayed after `take()`
 * consumed the token. The worker's 404 goes into a *hidden* iframe, so the
 * page is never told.
 */
function silentController(): FakeController {
  return { postMessage: vi.fn() };
}

/** A worker whose acknowledgement the test releases by hand. */
function deferredController(): FakeController & { ack(): void } {
  let ack = (): void => undefined;
  return {
    postMessage: vi.fn((message: RegisterMessage) => {
      ack = (): void => message.port.postMessage({ t: 'download-started', token: message.token });
    }),
    ack: () => ack(),
  };
}

const activeRegistration = { active: {} } as unknown as ServiceWorkerRegistration;

/** The stream the page handed to the worker, as captured from `postMessage`. */
function transferredStream(controller: FakeController): ReadableStream<Uint8Array> {
  const [message] = controller.postMessage.mock.calls[0] as [{ stream: ReadableStream<Uint8Array> }];
  return message.stream;
}

describe('service worker sink', () => {
  it('refuses when the worker is not controlling the page yet', async () => {
    installPage(null);
    await expect(createServiceWorkerSink(meta, activeRegistration)).rejects.toThrow(/not controlling this page/);
  });

  it('refuses when the registration has no active worker', async () => {
    installPage(fakeController());
    const registration = { active: null } as unknown as ServiceWorkerRegistration;
    await expect(createServiceWorkerSink(meta, registration)).rejects.toThrow(/not ready/);
  });

  it('hands the stream to the controller and points a hidden iframe at the token URL', async () => {
    const controller = fakeController();
    const { iframes, appended } = installPage(controller);
    await createServiceWorkerSink(meta, activeRegistration);

    const [message, transfer] = controller.postMessage.mock.calls[0] as [RegisterMessage, Transferable[]];
    expect(message.t).toBe('register-download');
    expect(message.meta).toEqual(meta);
    // Identity, not deep equality: both of these are transferred objects, and
    // what matters is that these exact ones were handed over.
    expect(transfer).toHaveLength(2);
    expect(transfer[0]).toBe(message.stream);
    expect(transfer[1]).toBe(message.port);
    expect(iframes[0]?.hidden).toBe(true);
    expect(iframes[0]?.src).toBe(`${DOWNLOAD_PATH_PREFIX}${message.token}`);
    expect(appended).toHaveBeenCalledWith(iframes[0]);
  });

  it('streams chunks through to the worker and closes the stream', async () => {
    const controller = fakeController();
    installPage(controller);
    const sink = await createServiceWorkerSink(meta, activeRegistration);
    const received = drain(transferredStream(controller));

    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    expect(await sink.close()).toBeUndefined();
    expect(await received).toEqual([1, 2, 3]);
  });

  it('has no practical size cap', async () => {
    installPage(fakeController());
    const sink = await createServiceWorkerSink(meta, activeRegistration);
    expect(() => sink.assertWithinCap(50 * 1024 ** 3)).not.toThrow();
  });

  it('errors the download and drops the iframe on abort', async () => {
    const controller = fakeController();
    const { iframes } = installPage(controller);
    const sink = await createServiceWorkerSink(meta, activeRegistration);
    const received = drain(transferredStream(controller));

    await sink.abort('integrity failure');
    await expect(received).rejects.toBe('integrity failure');
    expect(iframes[0]?.remove).toHaveBeenCalled();
  });

  it('keeps the iframe alive long enough for the browser to adopt the download', async () => {
    vi.useFakeTimers();
    try {
      const controller = fakeController();
      const { iframes } = installPage(controller);
      const sink = await createServiceWorkerSink(meta, activeRegistration);
      const received = drain(transferredStream(controller));

      await sink.close();
      // Removing it immediately can cancel a download the browser has not yet
      // taken over, so the sink defers the cleanup rather than skipping it.
      expect(iframes[0]?.remove).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(iframes[0]?.remove).toHaveBeenCalled();
      expect(await received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the worker to acknowledge the download before handing back a sink', async () => {
    const controller = deferredController();
    installPage(controller);

    let settled = false;
    const pending = createServiceWorkerSink(meta, activeRegistration).then((sink) => {
      settled = true;
      return sink;
    });
    // Until the worker is actually serving the token, nothing reads the stream:
    // a chunk written now would queue against a zero highWaterMark and never
    // settle. The sink must not exist yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    controller.ack();
    expect(await (await pending).close()).toBeUndefined();
  });

  it('rejects instead of stalling when the download never starts', async () => {
    vi.useFakeTimers();
    try {
      const controller = silentController();
      const { iframes } = installPage(controller);
      // Caught into a value: the rejection is asserted on after the clock is
      // advanced, and a floating rejected promise in between would be reported
      // as an unhandled error even though this test is what settles it.
      const pending = createServiceWorkerSink(meta, activeRegistration).catch((error: unknown) => error);
      // Both outcomes are caught into values up front: these settle while the
      // clock is being advanced below, and a rejection handled only afterwards
      // is reported as an unhandled error even though this test settles it.
      const received = drain(transferredStream(controller)).then(() => 'drained', (reason: unknown) => reason);

      // Far past any sane wait. Without a bounded wait the transfer hangs here
      // forever: no error, no message, and no iframe cleanup either.
      await vi.advanceTimersByTimeAsync(60_000);

      // The caller gets a real error to downgrade on, the half-open download is
      // errored rather than left queued, and the hidden iframe does not leak.
      const outcome = await pending;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/report\.pdf/);
      expect(await received).toMatch(/report\.pdf/);
      expect(iframes[0]?.remove).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

const ORIGIN = 'https://share.example';

interface FakeScope {
  handlers: Map<string, (event: unknown) => void>;
  location: { origin: string };
  /**
   * `active` is the worker already serving pages, exactly as the real
   * registration reports it: null on a first install, the outgoing worker on
   * an update. Mutable, because it is the one thing that distinguishes the
   * two takeover cases below.
   */
  registration: { active: object | null };
  skipWaiting: ReturnType<typeof vi.fn>;
  clients: { claim: ReturnType<typeof vi.fn> };
  addEventListener(type: string, handler: (event: unknown) => void): void;
}

function fakeScope(): FakeScope {
  const handlers = new Map<string, (event: unknown) => void>();
  return {
    handlers,
    location: { origin: ORIGIN },
    registration: { active: null },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    addEventListener(type, handler): void {
      handlers.set(type, handler);
    },
  };
}

describe('service worker', () => {
  const scope = fakeScope();

  beforeAll(async () => {
    // The worker registers its listeners on `self` at import time, so the fake
    // global scope has to be in place before the module is evaluated.
    vi.stubGlobal('self', scope);
    await import('../../client/sw.js');
  });

  beforeEach(() => {
    vi.stubGlobal('self', scope);
  });

  function dispatch(type: string, event: unknown): void {
    const handler = scope.handlers.get(type);
    if (!handler) throw new Error(`the worker registered no ${type} handler`);
    handler(event);
  }

  function fetchEvent(path: string, origin = ORIGIN): { respondWith: ReturnType<typeof vi.fn> } {
    const event = { request: { url: `${origin}${path}` }, respondWith: vi.fn() };
    dispatch('fetch', event);
    return event;
  }

  /*
   * A promise now, not a Response: the handler waits for a token that has not
   * been registered yet (createStreamRegistry's own comment says why), so it
   * can only answer asynchronously.
   */
  async function response(event: { respondWith: ReturnType<typeof vi.fn> }): Promise<Response> {
    return await (event.respondWith.mock.calls[0]?.[0] as Promise<Response>);
  }

  it('skips waiting and claims open pages so the first transfer is intercepted', () => {
    scope.registration.active = null;
    scope.skipWaiting.mockClear();
    dispatch('install', {});
    const waitUntil = vi.fn();
    dispatch('activate', { waitUntil });
    expect(scope.skipWaiting).toHaveBeenCalled();
    expect(scope.clients.claim).toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalled();
  });

  /*
   * The regression behind "the download helper did not respond", seen in
   * production on the first transfer after a deploy.
   *
   * A page registers its download token by posting it to the worker that
   * currently controls it, and that registry lives in *that worker instance's*
   * memory. An updating worker that skips waiting claims those live pages, so
   * the download iframe's fetch is answered by the new worker — whose registry
   * is empty. It 404s into a hidden iframe nobody sees, the page is never
   * acknowledged, and the file fails on the receiving side.
   *
   * An update must therefore let the pages holding those tokens close first.
   */
  it('does not seize pages from a worker that is already serving them', () => {
    scope.registration.active = {};
    scope.skipWaiting.mockClear();
    dispatch('install', {});
    expect(scope.skipWaiting).not.toHaveBeenCalled();
    scope.registration.active = null;
  });

  it('leaves requests outside the download path to the network', () => {
    expect(fetchEvent('/s/ABC123').respondWith).not.toHaveBeenCalled();
  });

  it('leaves another origin alone even on the download path', () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>().readable;
    dispatch('message', { data: { t: 'register-download', token: 'tok-c', meta, stream } });
    expect(fetchEvent(`${DOWNLOAD_PATH_PREFIX}tok-c`, 'https://elsewhere.example').respondWith)
      .not.toHaveBeenCalled();
  });

  it('answers a registered token with the stream and its download headers', async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    dispatch('message', { data: { t: 'register-download', token: 'tok-a', meta, stream: readable } });
    const writer = writable.getWriter();
    void writer.write(new Uint8Array([7, 8])).then(() => writer.close());

    const served = await response(fetchEvent(`${DOWNLOAD_PATH_PREFIX}tok-a`));
    expect(served.status).toBe(200);
    expect(served.headers.get('Content-Disposition')).toContain('report.pdf');
    expect(served.headers.get('Content-Length')).toBe('10');
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([7, 8]);
  });

  it('serves a token exactly once so a replayed request cannot re-read it', async () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>().readable;
    dispatch('message', { data: { t: 'register-download', token: 'tok-b', meta, stream } });
    expect((await response(fetchEvent(`${DOWNLOAD_PATH_PREFIX}tok-b`))).status).toBe(200);
    // The replay waits out DOWNLOAD_TOKEN_WAIT_MS before it 404s, which is
    // the deliberate cost of covering the race below. Faked rather than
    // waited: five real seconds in a unit suite for a timeout is not worth
    // the wall clock, and the timer is the whole behaviour being asserted.
    vi.useFakeTimers();
    const replay = response(fetchEvent(`${DOWNLOAD_PATH_PREFIX}tok-b`));
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TOKEN_WAIT_MS);
    vi.useRealTimers();
    expect((await replay).status).toBe(404);
  });

  it('404s a token it never held, once it has waited for one', async () => {
    vi.useFakeTimers();
    const answered = response(fetchEvent(`${DOWNLOAD_PATH_PREFIX}nope`));
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TOKEN_WAIT_MS);
    vi.useRealTimers();
    expect((await answered).status).toBe(404);
  });

  /*
   * The lost transfer this wait exists for, at the seam it actually happens
   * on: the download iframe's fetch reaches the worker BEFORE the page's
   * `register-download` message does. Answered immediately, that is a 404
   * into a hidden iframe, no acknowledgement, and a file the receiver fails
   * with "the download helper did not respond" ten seconds later.
   */
  it('holds a download request open for a token that has not been registered yet', async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    void writer.write(new Uint8Array([4, 2])).then(() => writer.close());

    // Fetch first. Message second — the order nothing in the platform
    // prevents, and the one that used to lose the file.
    const answered = response(fetchEvent(`${DOWNLOAD_PATH_PREFIX}tok-race`));
    dispatch('message', { data: { t: 'register-download', token: 'tok-race', meta, stream: readable } });

    const served = await answered;
    expect(served.status).toBe(200);
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([4, 2]);
  });

  it('acknowledges the page only once it is actually serving the download', async () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>().readable;
    const channel = new MessageChannel();
    let acked: unknown;
    const served = new Promise<void>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent): void => {
        acked = event.data;
        resolve();
      };
    });

    dispatch('message', { data: { t: 'register-download', token: 'tok-ack', meta, stream, port: channel.port2 } });
    // Registering is not serving. The page's whole reason for waiting is that
    // a registered token can still be missed — a terminated worker, a fetch
    // that raced ahead of this message — so the acknowledgement has to come
    // from the fetch handler, not from here.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acked).toBeUndefined();

    expect((await response(fetchEvent(`${DOWNLOAD_PATH_PREFIX}tok-ack`))).status).toBe(200);
    await served;
    expect(acked).toEqual({ t: 'download-started', token: 'tok-ack' });
    channel.port1.close();
    channel.port2.close();
  });
});

describe('download worker registration', () => {
  function installBrowser(register: ReturnType<typeof vi.fn>): void {
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    vi.stubGlobal('document', { createElement: () => ({}), body: { append: () => undefined } });
  }

  it('registers the worker at the origin root so it controls every page', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    installBrowser(register);

    expect(await registerDownloadWorker()).toBe(registration);
    // Vitest runs in Vite's dev mode, where /sw.js is served as an ES module
    // (its imports are left unbundled), so classic registration would fail.
    expect(register).toHaveBeenCalledWith('/sw.js', { type: 'module' });
  });

  it('surfaces a failed registration instead of letting it read as an unavailable tier', async () => {
    const register = vi.fn(async () => { throw new Error('the script has an unsupported MIME type'); });
    installBrowser(register);
    await expect(registerDownloadWorker()).rejects.toThrow(/unsupported MIME type/);
  });

  it('refuses when this browser cannot stream through a worker at all', async () => {
    const register = vi.fn(async () => ({} as ServiceWorkerRegistration));
    installBrowser(register);
    vi.stubGlobal('navigator', {});
    await expect(registerDownloadWorker()).rejects.toThrow(/cannot stream downloads/);
    expect(register).not.toHaveBeenCalled();
  });
});

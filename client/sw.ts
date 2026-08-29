/// <reference lib="webworker" />
import type { FileMeta } from '../shared/messages.js';
import { DOWNLOAD_PATH_PREFIX, buildDownloadHeaders, createStreamRegistry } from './save/swstream.js';
import { SHARE_LANDING_PATH, SHARE_MISSED_PATH, SHARE_TARGET_PATH, stashShare } from './share/inbox.js';

declare const self: ServiceWorkerGlobalScope;

const pending = createStreamRegistry();

self.addEventListener('install', () => {
  /*
   * Immediate takeover on a FIRST install only.
   *
   * `clients.claim()` below is what makes a first visit work at all: the page
   * that registered this worker is otherwise uncontrolled until its next
   * load, and an uncontrolled page's fetches are never intercepted. Getting
   * there needs this worker to activate, and on a first install nothing is in
   * its way.
   *
   * On an *update* the same move is actively harmful. A page registers its
   * download token by posting it to the worker currently controlling it, and
   * `pending` above lives in that worker instance's memory. Skipping the wait
   * claims those live pages, so the download iframe's fetch is answered by
   * this worker — whose registry is empty. The result is a 404 into a hidden
   * iframe, no acknowledgement, and a file that fails on the receiving side
   * with "the download helper did not respond". Seen in production on the
   * first transfer after a deploy, against a PC that had the page open.
   *
   * So an update waits for the pages holding those tokens to go away. The
   * cost is that a new worker version only takes effect once every tab of the
   * app is closed — a trade worth making against breaking a transfer that is
   * already in flight, for sessions measured in seconds.
   */
  if (!self.registration.active) void self.skipWaiting();
});
// Claim pages that are already open: a page that registered this worker is
// otherwise uncontrolled until its next load, and an uncontrolled page's
// fetches are never intercepted. The page checks that this took effect before
// it starts a download.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as {
    t?: string; token?: string; meta?: FileMeta; stream?: ReadableStream<Uint8Array>; port?: MessagePort;
  };
  if (data?.t !== 'register-download' || !data.token || !data.meta || !data.stream) return;
  // Registering is deliberately NOT acknowledged: what the page has to know is
  // that the download is being *served*, and a registered token can still be
  // missed — this worker can be terminated before the fetch arrives, or the
  // fetch can have raced ahead of this message and already 404'd.
  pending.register(data.token, { meta: data.meta, stream: data.stream, port: data.port });
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  // The worker sees every request a page in its scope makes, cross-origin ones
  // included. A third-party URL that happens to share one of these paths is
  // not ours to answer.
  if (url.origin !== self.location.origin) return;

  /*
   * The OS share sheet's POST.
   *
   * This has to be answered here and cannot be answered by the server: the
   * shared files ride in the request body, and the navigation that follows
   * discards it. A worker in scope is the only thing that can read that body
   * before it is gone — which is also why a missing worker is not a degraded
   * share but no share at all (see server/index.ts's own POST handler, and
   * the startup registration in client/main.tsx).
   *
   * It answers with a redirect rather than a page, so the app is reached by
   * an ordinary GET navigation and this URL never becomes a history entry the
   * back button can replay into a second, empty share.
   */
  if (event.request.method === 'POST' && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith((async () => {
      try {
        await stashShare(caches, await event.request.formData());
        return Response.redirect(SHARE_LANDING_PATH, 303);
      } catch {
        // Land somewhere with a way forward regardless. An error page in an
        // installed window has no address bar to escape from, which is the
        // dead end AGENTS.md rules out.
        return Response.redirect(SHARE_MISSED_PATH, 303);
      }
    })());
    return;
  }

  if (!url.pathname.startsWith(DOWNLOAD_PATH_PREFIX)) return;

  // Taking the token consumes it, so a reloaded or replayed download URL gets
  // the 404 rather than a stream that has already been read.
  const token = url.pathname.slice(DOWNLOAD_PATH_PREFIX.length);
  const download = pending.take(token);
  if (!download) {
    // Into a hidden iframe, where nobody will see it. The page learns of this
    // by never being acknowledged: a 404 has no port to answer on, because
    // whatever lost the token lost the port with it.
    event.respondWith(new Response('This download has expired.', { status: 404 }));
    return;
  }
  event.respondWith(new Response(download.stream, { headers: buildDownloadHeaders(download.meta) }));
  // Only now: the response is what consumes the stream, so this is the moment
  // the page's writes can actually drain. The page waits for this before it
  // writes anything, since a write with no reader never settles.
  download.port?.postMessage({ t: 'download-started', token });
});

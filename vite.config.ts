import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Case-insensitive: normalizeCode on the server uppercases, so a hand-retyped
// lowercase share link must still reach the page rather than 404.
const SHARE_PATH = /^\/s\/[0-9A-Za-z]{6}(?:[?#]|$)/;

/**
 * Must match `DOWNLOAD_PATH_PREFIX` in client/save/swstream.ts — copied
 * rather than imported so loading this config pulls in no client module.
 * The dev-server middleware below is exercised against the client's own
 * constant in tests/integration/spa-fallback.test.ts, so drift shows up
 * there rather than as a silent second app booting in a hidden iframe.
 */
const DOWNLOAD_PATH_PREFIX = '/__download/';

const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SERVICE_WORKER_ENTRY = fileURLToPath(new URL('./client/sw.ts', import.meta.url));

/**
 * Builds the service worker as a bundle of its own, emitted unhashed at the
 * origin root next to the app.
 *
 * It has to be a second build rather than a second `rollupOptions.input`:
 *
 *  - A worker's scope is decided by the path it is *served* from, so it must
 *    land at /sw.js, not in the hashed assets directory. (An entry alone can
 *    do that much.)
 *  - Rollup hoists any module two entries both reach into a shared chunk. The
 *    page-side sink and the worker share `client/save/swstream.ts`, so as one
 *    build they would emit an `sw.js` that starts with an `import` — and a
 *    classic service worker cannot import. Registering it as a module worker
 *    is not an option either: Firefox, one of the two browsers this whole tier
 *    exists for, has no module service workers. A single-entry build inlines
 *    everything the worker needs and can emit no import at all.
 */
function serviceWorkerBuild(): Plugin {
  return {
    name: 'quik-share-service-worker',
    apply: 'build',
    // After the app bundle is written: the app build empties the directory,
    // and this one must not be wiped by it.
    async closeBundle() {
      await build({
        // No config file, so this build does not recurse into this plugin.
        configFile: false,
        root: PROJECT_ROOT,
        build: {
          outDir: 'dist/client',
          emptyOutDir: false,
          rollupOptions: {
            input: SERVICE_WORKER_ENTRY,
            output: { entryFileNames: 'sw.js' },
          },
        },
      });
    },
  };
}

/** Minimal shape of what the middleware below needs from a request/response. */
export interface DevRoutingRequest { url?: string | undefined }
export interface DevRoutingResponse { statusCode: number; end(): void }

/**
 * The two dev-server routing rules production gets from server/index.ts.
 *
 * Exported (and given plain req/res types) so it can be tested directly:
 * spinning up a real dev server to check two string comparisons is not worth
 * it, but leaving either rule untested is how the download hole below
 * survived in the first place.
 */
export function devRoutingMiddleware(
  req: DevRoutingRequest, res: DevRoutingResponse, next: () => void,
): void {
  // Vite's SPA fallback answers any `Accept: text/html` navigation with
  // index.html, and a download iframe navigation is exactly that — so without
  // this the hidden iframe boots a SECOND full App in development, silently
  // allocating a room and opening another WebSocket. Only the service worker
  // can serve this path; if it did not intercept, 404 is the honest answer.
  if (req.url?.startsWith(DOWNLOAD_PATH_PREFIX)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  // A share URL is a client-side route. Vite's dev server would 404 it, which
  // makes the app's own share link unopenable in development. Production gets
  // the same page from the /s/:code route in server/index.ts.
  if (req.url && SHARE_PATH.test(req.url)) req.url = '/index.html';
  next();
}

function devRouting(): Plugin {
  return {
    name: 'quik-share-dev-routing',
    configureServer(server) {
      // Installed here rather than from a returned function, so it runs
      // BEFORE Vite's own html/SPA-fallback middlewares — which is the whole
      // point for both rules above.
      server.middlewares.use(devRoutingMiddleware);
    },
  };
}

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./client/index.html', import.meta.url)) },
  },
  server: {
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
  plugins: [
    react(),
    tailwindcss(),
    devRouting(),
    serviceWorkerBuild(),
  ],
});

# Web Share Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone share files or a link from any app on their phone straight into Quik Share, which opens with those files staged and sends them the moment both devices confirm the verification number.

**Architecture:** The manifest declares a `POST` share target at `/share-target`. The existing service worker — already registered, already holding a `fetch` handler for streamed downloads — grows one more branch: it reads the multipart body, stashes the files in a Cache, and answers `303 → /new?shared=1`. `CreateScreen` claims the stash on mount, holds it while the QR code is up, and hands it to `TransferPanel`, which sends it once `verifiedByMe && verifiedByPeer`. All the logic lives in a testable module (`client/share/inbox.ts`); `client/sw.ts` stays a thin listener shell, exactly as it already is for downloads.

**Tech Stack:** TypeScript, React 19, Vite 6, Fastify 5, Vitest, Playwright.

**Spec:** this document, [§Spec](#spec).

## Global Constraints

- Node ≥ 22. **The default `node` on this machine is v18 and the suite will not run on it** — every command below must be run with `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"` first.
- No new runtime dependencies. Cache API, `FormData`, and `Response.redirect` are platform features.
- `client/sw.ts` must remain a **classic** script with no `import` surviving into the bundle — it is built as its own single-entry Rollup build for exactly this reason (`vite.config.ts`, `serviceWorkerBuild`). Firefox has no module service workers.
- The service worker must **not** start caching the app shell. The download registry's `skipWaiting` policy (update waits for every tab to close) makes a stale shell a real hazard; the share inbox is a one-entry, take-and-delete Cache, not a shell cache.
- Nothing sends before `session.verifiedByMe && session.verifiedByPeer`. A share target is not an exception to the verification gate.
- The server must not import client modules. Shared path constants are **copied** into `server/index.ts` with a drift test, matching how `DOWNLOAD_PATH_PREFIX` is already handled (`server/index.ts:18-23`, `tests/integration/spa-fallback.test.ts`).
- Text limit: notes are capped at `MAX_TEXT_CHARS` (10 000) from `shared/messages.ts`.

## Spec

**Behaviour**

1. With the app installed, Quik Share appears in the OS share sheet for files of any type, and for links/text.
2. Choosing it launches the app at `/new` — a fresh session, QR code up — with a line naming what is waiting: *"2 files ready — they'll send once you've both confirmed the number."*
3. When the second device joins and both users confirm the six digits, the staged files send automatically, and a staged note (title/text/url folded into one) sends as a note.
4. Shared payload is claimed exactly once. A reload of the landing URL does not re-send, and a peer disconnecting and rejoining does not re-send.
5. If no service worker was there to intercept the POST, the app still lands on a working screen and says the share did not come through, rather than showing a 404 in a window with no address bar.

**Non-goals (deliberate)**

- `launch_handler: navigate-existing`. It would navigate an *existing* window to the share target, tearing down a live session mid-transfer. Sharing twice opening two windows (two rooms) is the safer default.
- `file_handlers` ("Open with → Quik Share"). Separate manifest feature, separate plan.
- Offline/app-shell caching. Unchanged from the PWA work: two devices through a relay have nothing to do offline.

**Known residue:** a share the user never claims (they kill the app at the QR screen) leaves one Cache entry until the next share overwrites it or the next claim deletes it. Documented in `client/share/inbox.ts`, not defended against — the files are the user's own, in their own browser's storage.

## File Structure

| File | Responsibility |
|---|---|
| `client/share/inbox.ts` *(create)* | Every share-target constant, and the stash/take logic, with no listeners and no globals reached implicitly. The unit-testable half. |
| `client/sw.ts` *(modify)* | One new `fetch` branch delegating to `inbox.ts`. Stays a listener shell. |
| `client/main.tsx` *(modify)* | Register the worker at startup, so an installed app launched straight into a share has one. |
| `client/screens/CreateScreen.tsx` *(modify)* | Claim the stash, strip the flag, show what is waiting, hand it down. |
| `client/screens/TransferPanel.tsx` *(modify)* | Send the staged payload once, after mutual verification. |
| `client/public/manifest.webmanifest` *(modify)* | Declare the share target. |
| `server/index.ts` *(modify)* | `POST /share-target` fallback for when no worker intercepted. |
| `tests/unit/share-inbox.test.ts` *(create)* | Stash/take round-trip, note folding, cleanup. |
| `tests/unit/manifest.test.ts` *(modify)* | The manifest's declared target must match the constants the worker answers on. |
| `tests/ui/share-target.test.tsx` *(create)* | CreateScreen claiming; TransferPanel sending once, and only when verified. |
| `tests/integration/spa-fallback.test.ts` *(modify)* | The server's copied constant must not drift from the client's. |
| `tests/e2e/share-target.spec.ts` *(create)* | A real multipart POST through a real worker, then a real transfer to a real second device. |

---

### Task 1: The share inbox module

**Files:**
- Create: `client/share/inbox.ts`
- Test: `tests/unit/share-inbox.test.ts`

**Interfaces:**
- Consumes: `MAX_TEXT_CHARS` from `shared/messages.ts`.
- Produces:
  - `SHARE_TARGET_PATH: '/share-target'`
  - `SHARE_LANDING_PATH: '/new?shared=1'`
  - `SHARE_MISSED_PATH: '/new?shared=missed'`
  - `SHARE_FLAG: 'shared'`
  - `SHARE_CACHE: 'quik-share-inbox'`
  - `interface SharedPayload { files: File[]; note: string | undefined }`
  - `foldNote(form: FormData): string | undefined`
  - `stashShare(storage: CacheStorage, form: FormData): Promise<void>`
  - `takeShare(storage: CacheStorage): Promise<SharedPayload | undefined>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/share-inbox.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from '../../shared/messages.js';
import {
  SHARE_CACHE,
  foldNote,
  stashShare,
  takeShare,
} from '../../client/share/inbox.js';

/**
 * A Cache/CacheStorage good enough for these tests and no more.
 *
 * Node has no `caches`, and the real one is not worth reaching for: what
 * these tests are about is the shape of what gets written and that taking it
 * removes it, neither of which needs a browser.
 */
function fakeStorage(): CacheStorage & { names(): string[] } {
  const caches = new Map<string, Map<string, Response>>();
  const open = async (name: string): Promise<Cache> => {
    const entries = caches.get(name) ?? new Map<string, Response>();
    caches.set(name, entries);
    return {
      put: async (request: RequestInfo | URL, response: Response) => {
        entries.set(String(request), response);
      },
      match: async (request: RequestInfo | URL) => entries.get(String(request)),
    } as unknown as Cache;
  };
  return {
    open,
    delete: async (name: string) => caches.delete(name),
    names: () => [...caches.keys()],
  } as unknown as CacheStorage & { names(): string[] };
}

function shareForm(files: File[], fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

describe('foldNote', () => {
  it('folds title, text and url into one note', () => {
    expect(foldNote(shareForm([], { title: 'Docs', text: 'read this', url: 'https://e.example' })))
      .toBe('Docs\nread this\nhttps://e.example');
  });

  it('says nothing when the share carried no text at all', () => {
    expect(foldNote(shareForm([]))).toBeUndefined();
    expect(foldNote(shareForm([], { title: '  ', text: '' }))).toBeUndefined();
  });

  it('does not repeat a value the share sent under two names', () => {
    // Chrome commonly sends the same URL as both `text` and `url`; a note
    // that says it twice is noise on the other device.
    expect(foldNote(shareForm([], { text: 'https://e.example', url: 'https://e.example' })))
      .toBe('https://e.example');
  });

  it('truncates to the note limit the transfer path enforces', () => {
    const note = foldNote(shareForm([], { text: 'x'.repeat(MAX_TEXT_CHARS + 500) }));
    expect(note).toHaveLength(MAX_TEXT_CHARS);
  });
});

describe('the share inbox', () => {
  it('round-trips files with their names and types intact', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([
      new File(['hello'], 'note.txt', { type: 'text/plain' }),
      new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }),
    ]));

    const payload = await takeShare(storage);

    expect(payload?.files.map((f) => [f.name, f.type, f.size]))
      .toEqual([['note.txt', 'text/plain', 5], ['shot.png', 'image/png', 3]]);
    expect(await payload?.files[0]!.text()).toBe('hello');
  });

  it('carries the note alongside the files', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([], { url: 'https://e.example' }));
    expect((await takeShare(storage))?.note).toBe('https://e.example');
  });

  it('leaves nothing behind once the page has taken it', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([new File(['x'], 'a.txt', { type: 'text/plain' })]));

    await takeShare(storage);

    // The shared copy exists on this device only to be handed to the page.
    expect(storage.names()).not.toContain(SHARE_CACHE);
    expect(await takeShare(storage)).toBeUndefined();
  });

  it('reports nothing when no share was ever stashed', async () => {
    expect(await takeShare(fakeStorage())).toBeUndefined();
  });

  it('does not leave an unclaimed share behind when a second one arrives', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([
      new File(['1'], 'first.txt', { type: 'text/plain' }),
      new File(['2'], 'second.txt', { type: 'text/plain' }),
    ]));
    await stashShare(storage, shareForm([new File(['3'], 'third.txt', { type: 'text/plain' })]));

    const payload = await takeShare(storage);

    // Not "third, plus whatever the first share left at the same keys".
    expect(payload?.files.map((f) => f.name)).toEqual(['third.txt']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/share-inbox.test.ts
```

Expected: FAIL — `Failed to resolve import "../../client/share/inbox.js"`.

- [ ] **Step 3: Write the implementation**

Create `client/share/inbox.ts`:

```ts
import { MAX_TEXT_CHARS } from '../../shared/messages.js';

/**
 * The path the manifest's share target posts to, and the only POST
 * client/sw.ts answers.
 *
 * It must be inside the worker's scope ('/') and it must not be a real
 * route: the whole point is that no request ever reaches the network, so
 * the server's own handler for it (server/index.ts) exists purely to
 * apologise when the worker was not there.
 */
export const SHARE_TARGET_PATH = '/share-target';

/** Where the worker sends the browser once a share is safely stashed. */
export const SHARE_LANDING_PATH = '/new?shared=1';

/** Where it sends the browser when the share could not be stashed at all. */
export const SHARE_MISSED_PATH = '/new?shared=missed';

/** The query parameter CreateScreen reads to learn a stash is waiting. */
export const SHARE_FLAG = 'shared';

/**
 * The one Cache this app owns. It holds at most one unclaimed share, and
 * `takeShare` deletes it outright rather than emptying it.
 *
 * Deliberately not an app-shell cache. The worker does not `skipWaiting` on
 * an update (see client/sw.ts), so a cached shell would keep serving an
 * index.html pointing at hashed assets a deploy had already deleted.
 */
export const SHARE_CACHE = 'quik-share-inbox';

/**
 * The index is written last and read first, so it can never name a body that
 * was not written. A partial stash therefore reads as no stash at all.
 */
const INDEX_URL = '/__share/index';
const bodyUrl = (position: number): string => `/__share/${position}`;

/** What the OS handed this app, once it is back in the page's hands. */
export interface SharedPayload {
  files: File[];
  /** title, text and url folded into one note, or undefined if it carried none. */
  note: string | undefined;
}

interface ShareIndex {
  note?: string;
  files: { name: string; type: string }[];
}

/**
 * The share's text fields as a single note.
 *
 * A shared link arrives spread across up to three fields whose split means
 * nothing to the person receiving it, and which browsers populate
 * inconsistently — Chrome routinely sends the same URL as both `text` and
 * `url`. One de-duplicated note is what the other device can actually use.
 */
export function foldNote(form: FormData): string | undefined {
  const parts = ['title', 'text', 'url']
    .map((key) => form.get(key))
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (parts.length === 0) return undefined;
  // Capped where the transfer path caps it, rather than letting the send
  // fail later on a note the user never typed.
  return [...new Set(parts)].join('\n').slice(0, MAX_TEXT_CHARS);
}

/**
 * Puts a share where the page can pick it up after the redirect.
 *
 * A Cache rather than the worker's own memory: the worker can be terminated
 * between answering this POST and the page that follows it asking for the
 * payload, and a share that vanishes is a photo the user watched disappear.
 * (The download registry accepts that same risk — but it is recoverable
 * there, because the file it loses is still on the sending device.)
 */
export async function stashShare(storage: CacheStorage, form: FormData): Promise<void> {
  // Deleted, not overwritten: an earlier share nobody claimed must not leave
  // bodies behind at keys this one does not happen to reuse.
  await storage.delete(SHARE_CACHE);
  const cache = await storage.open(SHARE_CACHE);

  const files = form.getAll('files').filter((value): value is File => value instanceof File);
  const index: ShareIndex = { files: files.map((file) => ({ name: file.name, type: file.type })) };
  const note = foldNote(form);
  if (note !== undefined) index.note = note;

  await Promise.all(files.map((file, position) => cache.put(bodyUrl(position), new Response(file))));
  // Last, always. See INDEX_URL.
  await cache.put(INDEX_URL, new Response(JSON.stringify(index)));
}

/**
 * Hands the stashed share to the page and clears it.
 *
 * Taking is destructive by design: the copy in the Cache exists only to
 * survive the redirect, and leaving it in storage the user cannot see is
 * exactly the residue this app promises not to leave.
 */
export async function takeShare(storage: CacheStorage): Promise<SharedPayload | undefined> {
  const cache = await storage.open(SHARE_CACHE);
  const indexResponse = await cache.match(INDEX_URL);
  if (indexResponse === undefined) return undefined;
  const index = await indexResponse.json() as ShareIndex;

  const files: File[] = [];
  for (const [position, entry] of index.files.entries()) {
    const body = await cache.match(bodyUrl(position));
    // Unreachable given the write order above, but a browser is free to
    // evict part of a cache. Losing one file of five beats losing all five.
    if (body === undefined) continue;
    files.push(new File([await body.blob()], entry.name, { type: entry.type }));
  }

  await storage.delete(SHARE_CACHE);
  return { files, note: index.note };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/share-inbox.test.ts && npm run typecheck
```

Expected: PASS (11 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add client/share/inbox.ts tests/unit/share-inbox.test.ts
git commit -m "feat(share): hold a shared payload across the redirect that delivers it"
```

---

### Task 2: The worker answers the share, and the manifest asks for it

**Files:**
- Modify: `client/sw.ts:52-73` (the `fetch` listener)
- Modify: `client/public/manifest.webmanifest`
- Test: `tests/unit/manifest.test.ts`

**Interfaces:**
- Consumes: `SHARE_TARGET_PATH`, `SHARE_LANDING_PATH`, `SHARE_MISSED_PATH`, `stashShare` from Task 1.
- Produces: a `share_target` member in the manifest whose `action`, `method`, `enctype` and file param name are what the worker answers on.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/manifest.test.ts` — extend the `Manifest` interface and add a new `describe` block at the end of the file:

```ts
// Add to the Manifest interface:
//   share_target: {
//     action: string;
//     method: string;
//     enctype: string;
//     params: { title: string; text: string; url: string; files: { name: string; accept: string[] }[] };
//   };
```

```ts
import { SHARE_TARGET_PATH } from '../../client/share/inbox.js';

describe('the share target', () => {
  it('posts to the path the service worker actually answers', () => {
    // The manifest and client/sw.ts are edited in different files by
    // different people; a mismatch here is a share that silently reaches the
    // network with its files already gone.
    expect(manifest.share_target.action).toBe(SHARE_TARGET_PATH);
  });

  it('is posted as multipart, which is the only way files can ride along', () => {
    // A GET share target cannot carry files at all, and a POST that is not
    // multipart/form-data drops them — for a file-sending app that is the
    // whole feature, quietly missing.
    expect(manifest.share_target.method).toBe('POST');
    expect(manifest.share_target.enctype).toBe('multipart/form-data');
  });

  it('names its file field what the worker reads, and accepts any type', () => {
    const [files] = manifest.share_target.params.files;
    expect(files?.name).toBe('files');
    expect(files?.accept).toContain('*/*');
  });

  it('keeps its target inside the worker scope that has to intercept it', () => {
    // Outside scope, no worker sees the POST however well it is declared.
    expect(manifest.share_target.action.startsWith(manifest.scope)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/manifest.test.ts
```

Expected: FAIL — `Cannot read properties of undefined (reading 'action')`.

- [ ] **Step 3: Add the manifest member**

In `client/public/manifest.webmanifest`, add after `"icons"` (before `"shortcuts"`):

```json
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [{ "name": "files", "accept": ["*/*"] }]
    }
  },
```

- [ ] **Step 4: Add the worker branch**

In `client/sw.ts`, add the import at the top, beside the existing one:

```ts
import { SHARE_LANDING_PATH, SHARE_MISSED_PATH, SHARE_TARGET_PATH, stashShare } from './share/inbox.js';
```

Then replace the opening of the `fetch` listener. **Before:**

```ts
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  // The worker sees every request a page in its scope makes, cross-origin ones
  // included. A third-party URL that happens to share this path is not ours to
  // answer with a pending download.
  if (url.origin !== self.location.origin || !url.pathname.startsWith(DOWNLOAD_PATH_PREFIX)) return;
```

**After:**

```ts
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
   * before it is gone — which is also why a missing worker is not a
   * degraded share but no share at all (see server/index.ts's own POST
   * handler, and the startup registration in client/main.tsx).
   *
   * It answers with a redirect rather than a page, so the app is reached by
   * a normal GET navigation and this URL never becomes a history entry the
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
```

- [ ] **Step 5: Run tests to verify they pass, and that the worker still builds as a classic script**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/manifest.test.ts tests/unit/save-swstream.test.ts
npm run typecheck
npm run build
grep -c "^import" dist/client/sw.js
```

Expected: tests PASS, typecheck clean, build succeeds, and the `grep` prints `0` — the worker bundle must contain no `import`, or Firefox cannot register it at all.

- [ ] **Step 6: Commit**

```bash
git add client/sw.ts client/public/manifest.webmanifest tests/unit/manifest.test.ts
git commit -m "feat(share): take the share sheet's files in the worker, before the navigation drops them"
```

---

### Task 3: A worker on every launch, and an honest answer when there is none

**Files:**
- Modify: `client/main.tsx`
- Modify: `server/index.ts:13-23` (constants) and the production block at `:225-232`
- Test: `tests/integration/spa-fallback.test.ts`

**Interfaces:**
- Consumes: `registerDownloadWorker` from `client/save/swstream.ts`; `SHARE_TARGET_PATH`, `SHARE_MISSED_PATH` from Task 1.
- Produces: nothing new for later tasks.

**Why this task exists:** `resolvePageSave` (`client/hooks/useSession.ts:396`) is the only thing that registers the worker today, and it runs when a *session starts*. Someone who installs the app from the landing page and then shares a photo into it has no worker, so the POST reaches the network with its body already spent.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/spa-fallback.test.ts`. This doubles as the drift check for the two constants `server/index.ts` copies: it drives the route with the *client's* `SHARE_TARGET_PATH` and compares the redirect against the *client's* `SHARE_MISSED_PATH`, so either copy going stale fails here rather than in production.

```ts
import { SHARE_MISSED_PATH, SHARE_TARGET_PATH } from '../../client/share/inbox.js';

describe('the share target with no worker to intercept it', () => {
  it('redirects to a screen that can explain itself, not a 404', async () => {
    // A POST that reaches the server means no worker was controlling: the
    // files are already gone. What must not also be gone is the way out —
    // an installed window has no address bar to recover a 404 from.
    const response = await app.inject({
      method: 'POST',
      url: SHARE_TARGET_PATH,
      headers: { accept: 'text/html' },
      payload: '',
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(SHARE_MISSED_PATH);
  });
});
```

Follow the file's existing shape: each test does `app = await buildServer()` itself, under the `NODE_ENV=production` stubbing the file already sets up at the top (`tests/integration/spa-fallback.test.ts:10-27`). Do not add a second helper.

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/integration/spa-fallback.test.ts
```

Expected: FAIL — received 404, expected 303.

- [ ] **Step 3: Add the server fallback**

In `server/index.ts`, beside the existing `DOWNLOAD_PATH_PREFIX` constant (`:23`), add:

```ts
/**
 * The manifest's share target, and where to send a share that missed it.
 * Both must match `client/share/inbox.ts` — copies rather than imports so
 * the server build stays free of client modules, exactly as
 * DOWNLOAD_PATH_PREFIX above; tests/integration/spa-fallback.test.ts imports
 * the client's constants and asserts these two agree.
 */
const SHARE_TARGET_PATH = '/share-target';
const SHARE_MISSED_PATH = '/new?shared=missed';
```

Inside the `NODE_ENV === 'production'` block, beside `app.get('/s/:code', ...)`:

```ts
// Only ever reached when no service worker was controlling — the worker
// answers this POST from client/sw.ts and nothing gets this far. The body
// is deliberately not read: the files are unrecoverable by now (the worker
// is the only thing that could have read them in time), so this exists to
// land the user on a screen that says so rather than on a 404 in a window
// with no address bar.
app.post(SHARE_TARGET_PATH, (_request, reply) => reply.redirect(SHARE_MISSED_PATH, 303));
```

- [ ] **Step 4: Register the worker at startup**

In `client/main.tsx`, add the import and the call before `createRoot`:

```tsx
import { registerDownloadWorker } from './save/swstream.js';

/*
 * Registered on every load, not only when a session starts.
 *
 * client/save/select.ts registers this same worker as part of resolving the
 * save tier, which happens when a session starts (client/hooks/useSession.ts).
 * That is too late for one launch in particular: an installed app opened
 * straight from the OS share sheet POSTs its files at the app before any
 * session exists, and a POST no worker intercepts reaches the server with
 * its body already spent. The files cannot be recovered from there.
 *
 * The name says "download" because that is what the worker was built for;
 * it is one worker at /sw.js serving both jobs.
 *
 * Failure is swallowed *here* and nowhere else: on a browser without the
 * tier this rejects on every load, and the save tier registers again when a
 * session starts — reporting the failure there, which is the screen where
 * it means something a user can act on.
 */
void registerDownloadWorker().catch(() => {});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/integration/spa-fallback.test.ts tests/unit/smoke.test.ts
npm run typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add client/main.tsx server/index.ts tests/integration/spa-fallback.test.ts
git commit -m "feat(share): have a worker ready on every launch, and answer honestly when there is not"
```

---

### Task 4: The screens — claim it, show it, send it once

**Files:**
- Modify: `client/screens/CreateScreen.tsx`
- Modify: `client/screens/TransferPanel.tsx:20-40` (props) and its effect block
- Test: `tests/ui/share-target.test.tsx`

**Interfaces:**
- Consumes: `SHARE_FLAG`, `SharedPayload`, `takeShare` from Task 1.
- Produces:
  - `TransferPanelProps` gains `pending?: SharedPayload` and `onPendingSent?: () => void`.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/share-target.test.tsx`. Copy the `LiveSession` mock and the `SessionHandle` stub factory from `tests/ui/transfer-panel.test.tsx` verbatim — TransferPanel builds a real `LiveSession`, which jsdom cannot host, and every TransferPanel suite in this repo mocks it the same way.

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TransferPanel } from '../../client/screens/TransferPanel.js';
import type { SharedPayload } from '../../client/share/inbox.js';

// … LiveSession mock and `stubSession(overrides)` factory, copied from
// tests/ui/transfer-panel.test.tsx …

const payload = (): SharedPayload => ({
  files: [new File(['x'], 'holiday.jpg', { type: 'image/jpeg' })],
  note: 'https://e.example',
});

describe('a share waiting on the verification gate', () => {
  it('does not send before both users have confirmed the number', () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: false });
    render(<TransferPanel session={session} pending={payload()} />);

    // The share sheet is not an exception to the gate: a payload staged by
    // the OS is still a send that must wait for both people.
    expect(session.sendFiles).not.toHaveBeenCalled();
    expect(session.sendText).not.toHaveBeenCalled();
  });

  it('sends the files and the note once both have', async () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    render(<TransferPanel session={session} pending={payload()} />);

    await waitFor(() => expect(session.sendFiles).toHaveBeenCalledTimes(1));
    expect(session.sendFiles.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['holiday.jpg']);
    expect(session.sendText).toHaveBeenCalledWith('https://e.example');
  });

  it('sends it once, however often the panel re-renders', async () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    const pending = payload();
    const { rerender } = render(<TransferPanel session={session} pending={pending} />);

    await waitFor(() => expect(session.sendFiles).toHaveBeenCalledTimes(1));
    rerender(<TransferPanel session={session} pending={pending} />);
    rerender(<TransferPanel session={session} pending={pending} />);

    expect(session.sendFiles).toHaveBeenCalledTimes(1);
  });

  it('tells its owner the payload is spent, so a remount cannot resend it', async () => {
    // The ref that makes the above true dies with the component, and this
    // panel is unmounted and rebuilt whenever a peer leaves and rejoins.
    const onPendingSent = vi.fn();
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    render(<TransferPanel session={session} pending={payload()} onPendingSent={onPendingSent} />);

    await waitFor(() => expect(onPendingSent).toHaveBeenCalledTimes(1));
  });

  it('sends nothing at all when there was no share', async () => {
    const session = stubSession({ verifiedByMe: true, verifiedByPeer: true });
    render(<TransferPanel session={session} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: /share/i })).toBeInTheDocument());
    expect(session.sendFiles).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/share-target.test.tsx
```

Expected: FAIL — `sendFiles` never called; `pending` is not a prop.

- [ ] **Step 3: Send the payload from TransferPanel**

In `client/screens/TransferPanel.tsx`, extend the props:

```tsx
export interface TransferPanelProps {
  session: SessionHandle;
  /**
   * What the OS share sheet handed this app, staged by CreateScreen and
   * waiting on the verification gate. Undefined for every session that was
   * started by hand, which is nearly all of them.
   */
  pending?: SharedPayload;
  /**
   * Told once `pending` has been sent, so the owner can drop it. Necessary
   * because the once-only guard below is a ref: it dies with this component,
   * and this component is torn down and rebuilt every time a peer leaves and
   * rejoins the same session.
   */
  onPendingSent?: () => void;
}
```

Change the signature to `export function TransferPanel({ session, pending, onPendingSent }: TransferPanelProps)` and add this effect after the `verified` constant:

```tsx
  /**
   * Sends a shared payload the moment the gate opens, and exactly once.
   *
   * Auto-sending is the right default here and only here: choosing Quik
   * Share in the OS share sheet *is* the instruction to send these files,
   * and the six-digit comparison both users have just made is what decides
   * it is safe to honour it. Nothing about the share sheet weakens that
   * gate — it only removes the second, redundant "now pick the files" step.
   */
  const pendingSent = useRef(false);
  useEffect(() => {
    if (!verified || pending === undefined || pendingSent.current) return;
    pendingSent.current = true;
    if (pending.files.length > 0) session.sendFiles(pending.files);
    if (pending.note !== undefined) session.sendText(pending.note);
    onPendingSent?.();
  }, [verified, pending, session.sendFiles, session.sendText, onPendingSent]);
```

Add `SharedPayload` to the type imports:

```tsx
import type { SharedPayload } from '../share/inbox.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/share-target.test.tsx
```

Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for claiming the share**

Add to `tests/ui/share-target.test.tsx`. `CreateScreen` calls `useSession`, which the existing `tests/ui/create-screen.test.tsx` already mocks — copy that mock, and the `qrcode` mock alongside it.

```tsx
import { CreateScreen } from '../../client/screens/CreateScreen.js';
import { takeShare } from '../../client/share/inbox.js';

vi.mock('../../client/share/inbox.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../client/share/inbox.js')>(),
  takeShare: vi.fn(),
}));

describe('landing from the share sheet', () => {
  it('claims the stash and says what is waiting', async () => {
    history.replaceState(null, '', '/new?shared=1');
    vi.mocked(takeShare).mockResolvedValue({
      files: [new File(['a'], 'one.jpg', { type: 'image/jpeg' }), new File(['b'], 'two.jpg', { type: 'image/jpeg' })],
      note: undefined,
    });

    render(<CreateScreen />);

    expect(await screen.findByText(/2 files ready/i)).toBeInTheDocument();
    // The flag has done its whole job by being read once; a reload of this
    // URL must not read as a second share.
    expect(location.search).toBe('');
  });

  it('counts a shared link as something waiting too', async () => {
    history.replaceState(null, '', '/new?shared=1');
    vi.mocked(takeShare).mockResolvedValue({ files: [], note: 'https://e.example' });

    render(<CreateScreen />);

    expect(await screen.findByText(/1 link ready/i)).toBeInTheDocument();
  });

  it('says so when the share never reached the app', async () => {
    history.replaceState(null, '', '/new?shared=missed');

    render(<CreateScreen />);

    // The files are unrecoverable by this point; the only useful thing left
    // to do is tell the user, so they can share again.
    expect(await screen.findByText(/did not come through/i)).toBeInTheDocument();
    expect(takeShare).not.toHaveBeenCalled();
  });

  it('claims nothing on an ordinary visit', () => {
    history.replaceState(null, '', '/new');
    render(<CreateScreen />);
    expect(takeShare).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/share-target.test.tsx -t 'landing from the share sheet'
```

Expected: FAIL — "2 files ready" never appears.

- [ ] **Step 7: Claim the share in CreateScreen**

In `client/screens/CreateScreen.tsx`, add the imports:

```tsx
import { SHARE_FLAG, takeShare, type SharedPayload } from '../share/inbox.js';
```

Add this helper above the component:

```tsx
/** What is waiting, in the words the user would use for it. */
function waitingLine(pending: SharedPayload): string {
  const parts: string[] = [];
  if (pending.files.length > 0) {
    parts.push(`${pending.files.length} file${pending.files.length === 1 ? '' : 's'}`);
  }
  if (pending.note !== undefined) parts.push('1 link');
  return `${parts.join(' and ')} ready — they'll send once you've both confirmed the number.`;
}
```

Add the state and the claiming effect inside the component, after `const session = useSession({ t: 'create' });`:

```tsx
  const [pending, setPending] = useState<SharedPayload | undefined>(undefined);
  const [shareMissed, setShareMissed] = useState(false);

  /**
   * Picks up whatever the OS share sheet left for this launch.
   *
   * Runs once, on mount, keyed off a query flag the service worker's
   * redirect put there (client/share/inbox.ts). The flag is stripped
   * immediately: it has done its entire job by being read, and leaving it
   * would make a reload look like a second share of files that are already
   * gone from the cache.
   */
  useEffect(() => {
    const flag = new URL(location.href).searchParams.get(SHARE_FLAG);
    if (flag === null) return;
    history.replaceState(null, '', '/new');

    if (flag === 'missed') { setShareMissed(true); return; }
    // Undefined on an insecure origin, where the worker could not have run
    // either — so there is nothing to claim and the same message applies.
    const storage = globalThis.caches as CacheStorage | undefined;
    if (storage === undefined) { setShareMissed(true); return; }
    void takeShare(storage).then(
      (payload) => { payload === undefined ? setShareMissed(true) : setPending(payload); },
      () => setShareMissed(true),
    );
  }, []);
```

Pass it down — change the paired branch:

```tsx
  if (session.state === 'paired') {
    return (
      <TransferPanel
        session={session}
        pending={pending}
        // Dropped here rather than inside the panel: the panel's own guard
        // is a ref that dies with it, and it is rebuilt whenever a peer
        // leaves and rejoins.
        onPendingSent={() => setPending(undefined)}
      />
    );
  }
```

And render the two messages, directly under the `<h1>`:

```tsx
      {pending !== undefined && (
        <p className="neo-inset max-w-md rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3 text-center text-sm">
          {waitingLine(pending)}
        </p>
      )}
      {shareMissed && (
        <p role="alert" className="max-w-md text-center text-sm text-[var(--color-danger)]">
          That share did not come through — the app had not finished starting up. Open it once, then try
          sharing again.
        </p>
      )}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/share-target.test.tsx tests/ui/create-screen.test.tsx tests/ui/transfer-panel.test.tsx
npm run typecheck
```

Expected: PASS across all three files, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add client/screens/CreateScreen.tsx client/screens/TransferPanel.tsx tests/ui/share-target.test.tsx
git commit -m "feat(share): stage what the share sheet sent, and send it when the number is confirmed"
```

---

### Task 5: The whole path, through a real worker to a real second device

**Files:**
- Create: `tests/e2e/share-target.spec.ts`

**Interfaces:**
- Consumes: `pair`-style helpers from `tests/e2e/helpers.ts` (`confirmVerification`, `makeFixture`).
- Produces: nothing.

**Why a real POST works here:** the manifest's share target is a plain multipart form POST to a path inside the worker's scope. Submitting exactly that form from the page is byte-for-byte what Chrome's share sheet does — everything downstream (the worker branch, the stash, the 303, the claim, the gate, the transfer) is the real code path. Only the OS launch is simulated.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/share-target.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { confirmVerification } from './helpers.js';

test('a file shared from the OS sends itself once both devices confirm the number', async ({ browser }) => {
  const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  // The worker has to be controlling before it can intercept anything —
  // registration alone is not enough (client/save/swstream.ts).
  await host.goto('/new');
  await host.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  }, undefined, { timeout: 20_000 });

  // Exactly the form the manifest declares, submitted as a real navigation.
  await host.evaluate(() => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/share-target';
    form.enctype = 'multipart/form-data';
    const files = document.createElement('input');
    files.type = 'file';
    files.name = 'files';
    files.id = 'shared-files';
    form.append(files);
    const url = document.createElement('input');
    url.name = 'url';
    url.value = 'https://example.invalid/holiday';
    form.append(url);
    document.body.append(form);
  });
  await host.setInputFiles('#shared-files', {
    name: 'holiday.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('sent from the share sheet'),
  });
  await Promise.all([
    host.waitForURL(/\/new$/),
    host.evaluate(() => (document.querySelector('form') as HTMLFormElement).submit()),
  ]);

  // Staged, named, and explicitly not sent yet.
  await expect(host.getByText(/1 file and 1 link ready/i)).toBeVisible();

  await host.getByRole('button', { name: /copy link/i }).click();
  const shareUrl = await host.evaluate(() => navigator.clipboard.readText());
  await guest.goto(shareUrl.replace(/^https?:\/\/[^/]+/, ''));

  await expect(host.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });
  await expect(guest.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });

  await confirmVerification(host, guest);

  // Nobody chose a file on either screen: confirming the number is the only
  // thing that happened, and the share sent itself.
  await expect(guest.getByText('holiday.txt')).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByText('https://example.invalid/holiday')).toBeVisible();

  await hostContext.close();
  await guestContext.close();
});
```

- [ ] **Step 2: Run it to verify it fails on a build without the feature**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
git stash && npm run build && npx playwright test tests/e2e/share-target.spec.ts; git stash pop
```

Expected: FAIL — the POST 404s, or "1 file and 1 link ready" never appears.

- [ ] **Step 3: Run it against the real implementation**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run build && npx playwright test tests/e2e/share-target.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Run everything**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npx vitest run && npx playwright test
```

Expected: unit suite fully green; e2e green except the two pre-existing failures in `tests/e2e/accessibility.spec.ts` (`:64` sticky-overlap, `:190` tap-target floor), which fail on a clean checkout of `master` too and are not this plan's to fix.

- [ ] **Step 5: Document it**

Add to `README.md`, under the feature list: a line that installing the app adds Quik Share to the OS share sheet, and that shared files send after the usual verification step.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/share-target.spec.ts README.md
git commit -m "test(share): drive a share sheet post through a worker to a second device"
```

---

## Self-Review

**Spec coverage:** §1 Task 2 (manifest) + Task 3 (worker present at launch). §2 Task 4 (claim, waiting line). §3 Task 4 (auto-send after gate). §4 Task 4 (`pendingSent` ref + `onPendingSent`, flag stripped via `replaceState`). §5 Task 3 (server 303) + Task 4 (`shareMissed` message). Non-goals: recorded, no tasks — correct.

**Placeholders:** the two mock blocks in Task 4 Step 1 say "copy from `tests/ui/transfer-panel.test.tsx`" rather than restating ~60 lines of `FakeLiveSession`. That is a pointer to real existing code at a named path, not a TODO.

**Type consistency:** `SharedPayload { files, note }` is produced by `takeShare` (Task 1), consumed by `CreateScreen` (Task 4 Step 7) and `TransferPanel` (Task 4 Step 3). `SHARE_TARGET_PATH` / `SHARE_MISSED_PATH` are defined in Task 1, imported by the worker (Task 2) and copied-with-a-drift-test into the server (Task 3). `stashShare(storage, form)` and `takeShare(storage)` take `CacheStorage` at every call site.

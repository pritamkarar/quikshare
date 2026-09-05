import { MAX_TEXT_CHARS } from '../../shared/messages.js';

/**
 * The path the manifest's share target posts to, and the only POST
 * client/sw.ts answers.
 *
 * It must be inside the worker's scope ('/') and it must not be a real
 * route: the whole point is that no request ever reaches the network, so the
 * server's own handler for it (server/index.ts) exists purely to apologise
 * when the worker was not there.
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
  // Capped where the transfer path caps it, rather than letting the send fail
  // later on a note the user never typed.
  return [...new Set(parts)].join('\n').slice(0, MAX_TEXT_CHARS);
}

/**
 * Puts a share where the page can pick it up after the redirect.
 *
 * A Cache rather than the worker's own memory: the worker can be terminated
 * between answering this POST and the page that follows it asking for the
 * payload, and a share that vanishes is a photo the user watched disappear.
 * (The download registry in client/save/swstream.ts accepts that same risk,
 * but it is recoverable there — the file it loses is still sitting on the
 * sending device.)
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
    // Unreachable given the write order above, but a browser is free to evict
    // part of a cache. Losing one file of five beats losing all five.
    if (body === undefined) continue;
    files.push(new File([await body.blob()], entry.name, { type: entry.type }));
  }

  await storage.delete(SHARE_CACHE);
  return { files, note: index.note };
}

/**
 * The same handoff for files chosen on the landing page, without the Cache.
 *
 * Nothing survives here but a tab: dropping on '/' and creating on '/new'
 * are two renders of one document, so the Files can simply be held in
 * memory — no copy, which matters for the multi-gigabyte drop the product
 * promises to take. One slot, not a queue, for the same reason
 * routing.ts's guard is one slot: exactly one session is about to be
 * created, and a reload loses the drop the way it loses any unsent send.
 */
let local: SharedPayload | undefined;

export function stashLocal(payload: SharedPayload): void {
  local = payload;
}

/** Hands over the held payload and clears the slot, mirroring `takeShare`. */
export function takeLocal(): SharedPayload | undefined {
  const payload = local;
  local = undefined;
  return payload;
}

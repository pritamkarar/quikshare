import type { FileMeta, SaveCapability } from '../../shared/messages.js';
import type { SaveSink } from './types.js';
import { BLOB_SINK_MAX_BYTES, createBlobSink, tooLargeForMemory } from './blob.js';
import { createFileSystemSink, supportsFileSystemAccess } from './fsaccess.js';
import {
  awaitDownloadWorkerControl, createServiceWorkerSink, registerDownloadWorker, supportsServiceWorkerStream,
} from './swstream.js';

/** Builds the sink one incoming file is written into. May be async. */
export type SinkFactory = (meta: FileMeta) => SaveSink | Promise<SaveSink>;

/**
 * The best tier this browser can actually use, most capable first. Resolved
 * once at receiver startup and advertised to the peer in the `hello` frame,
 * so the *sender* can warn about a file that will not survive before a
 * multi-gigabyte transfer begins rather than at the moment it dies.
 *
 * Each probe has to be honest about the whole tier, not just the constructor
 * it is named after: what is advertised here is what the other device plans
 * around.
 *
 * 'sw-stream' is checked before 'fs-access' even though a native Save-As
 * dialog looks like the more capable tier. It is not usable here:
 * `showSaveFilePicker` requires transient user activation, but this app has
 * no accept step — offers are auto-accepted — so `Receiver.#openSink` always
 * builds sinks from inside a message handler, which has none, and the call
 * would simply throw. Adding an accept click would fix that but break
 * multi-file batches instead: each picker call consumes the activation, so
 * an N-file batch would need N separate clicks. 'sw-stream' needs no gesture,
 * streams to disk through the browser's own downloader just as well, and
 * works in every browser that reaches this line (including Chrome, which was
 * the only reason to prefer 'fs-access'). 'fs-access' stays as the fallback
 * for a browser where the service worker cannot be registered or cannot
 * claim the page, so it stays live rather than becoming dead code.
 */
export function detectSaveCapability(): SaveCapability {
  if (supportsServiceWorkerStream()) return 'sw-stream';
  if (supportsFileSystemAccess()) return 'fs-access';
  return 'blob';
}

/** What to tell the user about where their files will land, and what will not fit. */
export function describeCapability(
  capability: SaveCapability,
): { label: string; limitBytes: number | undefined } {
  switch (capability) {
    // Disk-backed: bounded by free disk space, which this side cannot know and
    // must not pretend to.
    case 'fs-access': return { label: 'Saved straight to disk', limitBytes: undefined };
    case 'sw-stream': return { label: 'Streamed to your downloads', limitBytes: undefined };
    case 'blob': return { label: 'Held in memory', limitBytes: BLOB_SINK_MAX_BYTES };
  }
}

/**
 * Why a file of this size cannot be saved by this tier at all, or undefined if
 * it can. Answered from the tier alone, with no sink built: the Receiver needs
 * this at offer time, where building one sink per offered file would mean a
 * Save-As dialog or a browser download per file before a single byte arrives.
 * The sink's own `assertWithinCap` still runs when it is finally built, as the
 * second line of defence.
 *
 * 'blob' is the only tier with a ceiling — the other two are bounded by free
 * disk space, which this side cannot know — so the memory wording is the right
 * one for every rejection this can currently produce.
 */
export function capacityRejection(capability: SaveCapability, totalBytes: number): string | undefined {
  const { limitBytes } = describeCapability(capability);
  if (limitBytes === undefined || totalBytes <= limitBytes) return undefined;
  return tooLargeForMemory(totalBytes);
}

/**
 * The sink factory for a chosen tier. Every failure is per-file and thrown, so
 * the receiver reports it against the file it belongs to instead of silently
 * writing somewhere else: a tier that cannot build its sink must never fall
 * back to memory behind the user's back, having already told the peer it
 * could take a file of any size.
 */
export function createSinkFactory(
  capability: SaveCapability,
  registration?: ServiceWorkerRegistration,
): SinkFactory {
  switch (capability) {
    case 'fs-access': return (meta) => createFileSystemSink(meta);
    case 'sw-stream': return (meta) => {
      // Registration happens once at startup, not here: a worker registered at
      // the first transfer is active but not yet controlling the page, and only
      // a controlling worker intercepts the download.
      if (!registration) throw new Error('The download helper is not registered.');
      return createServiceWorkerSink(meta, registration);
    };
    case 'blob': return (meta) => createBlobSink(meta);
  }
}

export interface PageSave {
  /** What the hello advertises, and the ceiling the Receiver checks offers against. */
  capability: SaveCapability;
  createSink: SinkFactory;
  /** Why the tier this browser reported could not be prepared, if it could not. */
  notice?: string;
}

/**
 * The tier this page will actually save with, including the one piece of setup
 * a tier needs: the streaming tier's service worker has to be registered
 * before a transfer starts, because a worker registered at the first transfer
 * is active but not yet *controlling* the page, and only a controlling worker
 * intercepts the download.
 *
 * A failed registration downgrades to the in-memory tier — but only here,
 * strictly before anything is advertised, so the hello still describes what
 * this device can really do. The reason is returned rather than swallowed: a
 * silent downgrade is indistinguishable from a browser that never had the
 * tier, and the user is owed the explanation for a much lower size ceiling.
 *
 * Page-side by necessity. A worker realm has neither the picker nor the
 * document these tiers need, which is why the transfer worker is handed the
 * capability from here and writes through a proxy back to this realm.
 */
export async function resolvePageSave(): Promise<PageSave> {
  const capability = detectSaveCapability();
  if (capability !== 'sw-stream') return { capability, createSink: createSinkFactory(capability) };

  try {
    const registration = await registerDownloadWorker();
    // Registered is not controlling. The download is adopted by navigating a
    // hidden iframe, and an uncontrolled page's fetch goes to the network and
    // 404s — so until the helper controls this page, this tier can save
    // nothing, and advertising it would promise the peer a ceiling this device
    // does not have.
    if (!(await awaitDownloadWorkerControl())) return memoryFallback(NOT_CONTROLLING);
    return { capability, createSink: createSinkFactory(capability, registration) };
  } catch (error: unknown) {
    return memoryFallback(error instanceof Error ? error.message : String(error));
  }
}

const NOT_CONTROLLING = 'the download helper has not taken control of this page yet, and reloading usually fixes it';

/** One wording for one outcome, however the streaming tier failed to prepare. */
function memoryFallback(reason: string): PageSave {
  return {
    capability: 'blob',
    createSink: createSinkFactory('blob'),
    notice: `Streaming downloads are unavailable, so files will be held in memory instead: ${reason}.`,
  };
}

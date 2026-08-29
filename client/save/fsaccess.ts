import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from './types.js';

/**
 * Minimal shape this module needs from a `FileSystemWritableFileStream`.
 * Kept separate from lib.dom's own (much larger) `WritableStream`-derived
 * interface so a plain test double satisfies it without also implementing
 * the rest of the streams API.
 */
interface FileSystemWritableLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableLike>;
}

/**
 * Minimal shape this module needs from a `FileSystemDirectoryHandle` — the
 * folder the user picked once, reused for every file of the session.
 */
export interface FileSystemDirectoryHandleLike {
  /** What to call the folder on screen. Not a path: the API never exposes one. */
  readonly name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemFileHandleLike>;
}

type SaveFilePicker = (opts: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandleLike>;

type DirectoryPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandleLike>;

/**
 * `showSaveFilePicker` is not part of TypeScript's DOM lib (it isn't a
 * cross-browser standard), so it is looked up dynamically rather than
 * referenced as a typed global.
 */
function picker(): SaveFilePicker | undefined {
  return Reflect.get(globalThis, 'showSaveFilePicker') as SaveFilePicker | undefined;
}

/** Looked up dynamically for the same reason `showSaveFilePicker` is. */
function directoryPicker(): DirectoryPicker | undefined {
  return Reflect.get(globalThis, 'showDirectoryPicker') as DirectoryPicker | undefined;
}

export function supportsFileSystemAccess(): boolean {
  return typeof picker() === 'function';
}

/**
 * Whether this browser can hand over a whole folder. Chromium desktop only,
 * which is exactly the set of browsers that interrupt a multi-file batch with
 * "Allow this site to download multiple files?" — so where this is false, the
 * streaming tier is already the best available answer and nothing is lost.
 */
export function supportsDirectoryPicker(): boolean {
  return typeof directoryPicker() === 'function';
}

/**
 * Asks for the folder every incoming file will be written into. MUST be called
 * from a user gesture — but unlike `showSaveFilePicker`, only ONCE: the handle
 * it returns keeps its write permission for the life of the page, so an N-file
 * batch costs one click rather than N. That is the whole reason this tier can
 * exist where the per-file picker could not (see `select.ts`'s
 * `detectSaveCapability`).
 *
 * Rejects with an `AbortError` `DOMException` when the user closes the picker.
 * That is a decision, not a failure, and the caller must not report it as one.
 */
export async function chooseSaveDirectory(): Promise<FileSystemDirectoryHandleLike> {
  const show = directoryPicker();
  if (!show) throw new Error('This browser cannot pick a download folder.');
  // Asked for at pick time so the grant covers writing: prompting again per
  // file is the per-file interruption this tier exists to remove.
  return show({ mode: 'readwrite' });
}

/** Characters no major platform accepts in a filename, plus the control range. */
const UNSAFE_IN_NAME = /[\u0000-\u001f<>:"/\\|?*]/g;

/**
 * A peer-authored filename reduced to one a directory handle will accept.
 *
 * This is a trust boundary, and a new one: the other two tiers show the name
 * to the user (`showSaveFilePicker`) or hand it to the browser's own
 * downloader, which sanitises it. Writing into a directory handle does
 * neither — `getFileHandle(name, { create: true })` creates whatever it is
 * given, with no confirmation — so a name is checked here instead.
 *
 * The separators matter most: `..` and `/` are how a name would try to escape
 * the folder the user chose. The spec makes browsers reject those, but a
 * rejection means the file fails; replacing them means it lands, visibly
 * renamed, which is the better outcome for the overwhelmingly more common
 * cause — a peer on another OS.
 */
export function safeFileName(name: string): string {
  // Trailing dots and spaces are legal on POSIX and silently stripped by
  // Windows, which turns "a. " into "a" behind the caller's back. Stripping
  // them here also collapses "." and ".." to the empty string, which is what
  // makes the fallback below cover the traversal names too.
  const cleaned = name.replace(UNSAFE_IN_NAME, '_').replace(/[. ]+$/, '');
  return cleaned === '' ? 'file' : cleaned;
}

/** How many "name (n)" variants to try before giving up on a colliding name. */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * The first name in `dir` that nothing is using — `name` itself if it is free.
 *
 * Without this a second file of the same name would silently replace the
 * first: data loss the streaming tier never had, because the browser's own
 * downloader does this same disambiguation. Serial by construction, so no two
 * files can pick the same candidate — the Receiver opens one sink at a time
 * on its frame chain, and `getFileHandle(..., { create: true })` below
 * creates the file before the next lookup runs.
 */
async function freeName(dir: FileSystemDirectoryHandleLike, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  // `dot > 0`, not `>= 0`: a dotfile's leading dot starts the name, it does
  // not introduce an extension, so ".env" must number as ".env (1)".
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${extension}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      // NotFoundError — nothing holds this name. Any other rejection (a
      // directory sits there, the permission was revoked) surfaces from the
      // `create` call instead, where it is reported against one file.
      return candidate;
    }
  }
  throw new Error(`There are already ${MAX_NAME_ATTEMPTS} files named like "${name}" in that folder.`);
}

/**
 * The `SaveSink` half both File System Access tiers share: capacity is
 * bounded by free disk space, not tab memory, so there is no ceiling to
 * enforce and every call is a straight pass-through.
 */
function writableSink(writable: FileSystemWritableLike): SaveSink {
  return {
    assertWithinCap(): void {},
    async write(chunk: Uint8Array): Promise<void> {
      await writable.write(chunk);
    },
    async close(): Promise<Blob | undefined> {
      await writable.close();
      return undefined;
    },
    async abort(reason: string): Promise<void> {
      await writable.abort(reason);
    },
  };
}

/**
 * Writes chunks straight to disk via the File System Access API, so file
 * size is bounded by the disk rather than by tab memory. Must be called
 * from within a user gesture (`showSaveFilePicker` throws otherwise) —
 * callers are responsible for only invoking this in response to the user
 * accepting an incoming batch, not eagerly.
 */
export async function createFileSystemSink(meta: FileMeta): Promise<SaveSink> {
  const show = picker();
  if (!show) throw new Error('File System Access API is not available in this browser.');

  const handle = await show({ suggestedName: meta.name });
  return writableSink(await handle.createWritable());
}

/**
 * Writes one file into the folder the user already picked. Needs no gesture
 * of its own — the directory handle carries the grant — which is what lets an
 * auto-accepted batch land every file with no click and no browser download
 * per file, and so never trips the multiple-downloads prompt.
 */
export async function createDirectorySink(
  meta: FileMeta,
  dir: FileSystemDirectoryHandleLike,
): Promise<SaveSink> {
  const name = await freeName(dir, safeFileName(meta.name));
  const handle = await dir.getFileHandle(name, { create: true });
  return writableSink(await handle.createWritable());
}

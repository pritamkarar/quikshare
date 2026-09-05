import { useRef, useState } from 'react';
import { Button } from './Button.js';
import { IconFolder, IconUpload } from './icons.js';

export interface DropZoneProps {
  onFiles: (files: File[]) => void;
  /** The one line of copy in the well. Defaults to the paired-session wording. */
  hint?: string;
}

/** Calls `readEntries` until it hands back nothing: Chrome caps each batch at 100. */
async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

/**
 * Flattens one dropped entry — a file or a whole directory tree — into `out`.
 *
 * ponytail: the tree is flattened to basenames. The transfer protocol carries
 * `file.name` only (client/transfer/sender.ts), so a nested folder arrives as
 * a flat list; carrying paths means a FileMeta change on both ends.
 *
 * An entry the browser refuses to read is skipped rather than sinking the
 * whole drop: losing one file of a folder beats losing the folder.
 */
async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  try {
    if (entry.isFile) {
      out.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, out);
    }
  } catch {
    // See above.
  }
}

/**
 * Drag-and-drop is never the only path to choosing files (AGENTS.md: every
 * gesture needs a tap/click and keyboard alternative) — the "Choose files"
 * and "Choose folder" buttons open the same native picker, are real
 * `<button>`s so they are reachable by Tab, and work identically whether or
 * not the browser ever fires a single drag event.
 */
export function DropZone({ onFiles, hint = 'Drop files or a folder here, paste them, or choose them below' }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // Counts nested dragenter/dragleave pairs fired as the pointer crosses
  // child elements, so the "over" highlight does not flicker off while the
  // pointer is still inside the zone, just over one of its children.
  const depth = useRef(0);

  function handleFiles(files: FileList | File[] | null): void {
    const list = [...(files ?? [])];
    if (list.length > 0) onFiles(list);
  }

  /**
   * One hidden input serves both buttons: the e2e suites locate it as the
   * page's only `input[type="file"]`, and a second one would break that.
   * The attribute is set per click rather than per input, so each button
   * decides the picker's mode for itself and nothing needs resetting on
   * cancel. Set as an attribute, not a property, because jsdom has no
   * `webkitdirectory` property to reflect one.
   */
  function open(directory: boolean): void {
    const input = inputRef.current;
    if (!input) return;
    input.toggleAttribute('webkitdirectory', directory);
    input.click();
  }

  function handleDrop(transfer: DataTransfer | null): void {
    if (!transfer) return;
    // Everything below must be read synchronously: the drag data store is
    // emptied the moment this handler returns, so an entry or a File not
    // taken now is gone by the time a Promise resolves.
    const files: File[] = [];
    const dirs: FileSystemEntry[] = [];
    for (const item of [...(transfer.items ?? [])]) {
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry?.isDirectory) dirs.push(entry);
      else {
        const file = item.getAsFile?.();
        if (file) files.push(file);
      }
    }
    // Nothing folder-shaped, or a browser (or a test) with no entry API at
    // all: hand over `dataTransfer.files` the way this always has, and
    // synchronously, so a plain drop still sends in the same tick.
    if (dirs.length === 0) { handleFiles(transfer.items?.length ? files : transfer.files); return; }
    void (async () => {
      for (const dir of dirs) await walk(dir, files);
      handleFiles(files);
    })();
  }

  return (
    <div
      data-dropzone
      onDragEnter={(event) => {
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        // Required for `onDrop` to fire at all — a dragover with no
        // preventDefault tells the browser this element is not a drop target.
        event.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        handleDrop(event.dataTransfer ?? null);
      }}
      // A well, not a card: dropping something INTO a recess is the shape
      // the gesture already implies, and it distinguishes the zone from the
      // raised buttons sharing the column with it. The dashed rim uses
      // --color-border-strong rather than --color-border, which is a rim
      // LIGHT in the light theme (near-white) and would be invisible here.
      className={`neo-inset flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed bg-[var(--color-surface-2)] p-8 text-center transition-colors duration-[var(--duration-fast)] sm:p-10 ${
        over ? 'border-[var(--color-accent)]' : 'border-[var(--color-border-strong)]'
      }`}
    >
      {/* Decorative: the text below says the same thing. The tint follows the
          drag state so the whole zone, not just its border, responds. */}
      <span
        className={`neo inline-flex size-14 items-center justify-center rounded-full text-2xl transition-colors duration-[var(--duration-fast)] ${
          over
            ? 'bg-[color-mix(in_oklab,var(--color-accent)_20%,transparent)] text-[var(--color-accent)]'
            : 'bg-[var(--color-surface)] text-[var(--color-text-muted)]'
        }`}
      >
        <IconUpload />
      </span>
      <p className="text-[var(--color-text-muted)]">{hint}</p>
      {/* The guaranteed path: real buttons, focusable by Tab, that open the
          browser's own picker — drag is purely an enhancement on top. */}
      <div className="flex flex-wrap justify-center gap-3">
        <Button icon={<IconUpload />} onClick={() => open(false)}>Choose files</Button>
        <Button variant="ghost" icon={<IconFolder />} onClick={() => open(true)}>Choose folder</Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          handleFiles(event.target.files);
          // Cleared so choosing the exact same file again still fires onChange.
          event.target.value = '';
        }}
      />
    </div>
  );
}

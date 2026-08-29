import { useRef, useState } from 'react';
import { Button } from './Button.js';
import { IconUpload } from './icons.js';

export interface DropZoneProps {
  onFiles: (files: File[]) => void;
}

/**
 * Drag-and-drop is never the only path to choosing files (AGENTS.md: every
 * gesture needs a tap/click and keyboard alternative) — the "Choose files"
 * button opens the same native picker, is a real `<button>` so it is
 * reachable by Tab, and works identically whether or not the browser ever
 * fires a single drag event.
 */
export function DropZone({ onFiles }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // Counts nested dragenter/dragleave pairs fired as the pointer crosses
  // child elements, so the "over" highlight does not flicker off while the
  // pointer is still inside the zone, just over one of its children.
  const depth = useRef(0);

  function handleFiles(files: FileList | null): void {
    const list = [...(files ?? [])];
    if (list.length > 0) onFiles(list);
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
        handleFiles(event.dataTransfer?.files ?? null);
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
      <p className="text-[var(--color-text-muted)]">Drop files here, paste them, or choose them below</p>
      {/* The guaranteed path: a real button, focusable by Tab, that opens the
          browser's own file picker — drag is purely an enhancement on top. */}
      <Button icon={<IconUpload />} onClick={() => inputRef.current?.click()}>Choose files</Button>
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

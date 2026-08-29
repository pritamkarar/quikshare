import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TrackedFile, TrackedNote } from '../hooks/useSession.js';
import { applyFilter, buildRecord, RECORD_FILTERS, type RecordFilter, type RecordItem } from './record.js';
import { parseFilter, setFilterParam } from '../routing.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';
import { formatBytes, formatRate } from './format.js';
import {
  IconArrowDownLeft, IconArrowUpRight, IconCheck, IconClose, IconCopy, IconDownload, IconInbox, IconList,
  type IconProps,
} from './icons.js';

/**
 * A glyph per filter chip, keyed by the filter itself so a new `RecordFilter`
 * is a type error here rather than a chip that silently renders no icon.
 * Decorative in every case — the chip keeps its visible word, and selection is
 * carried by `aria-pressed`, never by the picture.
 */
const FILTER_ICONS: Record<RecordFilter, ComponentType<IconProps>> = {
  all: IconList,
  sent: IconArrowUpRight,
  received: IconArrowDownLeft,
};

/** AGENTS.md: virtualize past this many items. A folder drop reaches it easily. */
const VIRTUALIZE_ABOVE = 50;
/**
 * Two fixed heights, chosen by kind rather than measured.
 *
 * `useVirtualizer` can measure elements dynamically, but it does not have to
 * here: a row's height is a pure function of its kind, and `estimateSize`
 * receives the index. Deterministic sizing avoids a measurement pass and the
 * layout thrash that comes with it. Notes are clamped to three lines
 * (`line-clamp-3`) so this stays honest for a long note — the full text is
 * still reachable through Copy.
 *
 * Both constants are exported so the virtualization test can compute an
 * expected total size from the same numbers the component actually uses,
 * rather than a second, driftable copy of 64/92 living in the test file.
 *
 * Neither row may grow past its constant. That is why the copy-failure
 * alert and the copy-success announcement live at the card level (below)
 * instead of inside `NoteRow`: a per-row alert would push a note row past
 * `NOTE_ROW_HEIGHT`, and the `<li>` sets `height: row.size` with no
 * clipping, so the overflow would visually overlap the row underneath it
 * in the virtualized path.
 *
 * Both numbers are px *at a 16px root font size*, and neither row is sized in
 * px — see `ROOT_PX_AT_DERIVATION` and `rootFontPx` below for why they are
 * scaled rather than used raw.
 */
export const FILE_ROW_HEIGHT = 64;
export const NOTE_ROW_HEIGHT = 92;

/**
 * The root font size the two constants above were derived at.
 *
 * Every dimension that actually decides a row's height is expressed in rem,
 * not px: `text-sm`/`text-xs` carry rem line heights, and `py-2`, `gap-1.5`,
 * `mt-1.5`, `h-1.5` and `min-h-11` are all multiples of Tailwind's
 * `--spacing: .25rem`. At the browser default of 16px the arithmetic lands
 * exactly — a file row in flight is 20 + 16 + 6 + 6 + 16 = 64 — which is
 * precisely what makes the raw constants look like px numbers when they are
 * really rem totals that have already been multiplied by 16.
 *
 * A user who raises their browser's default text size — the standard
 * accessibility setting, and a different thing from zoom, which scales px
 * along with everything else and is therefore harmless here — moves that
 * multiplier. At a 20px root the same file row measures 80 against a declared
 * 64 and a note 95 against 92; the `<li>`s are absolutely positioned from
 * these estimates with no clipping, so every row past the virtualization
 * threshold overlaps the one beneath it. The people most likely to hit that
 * are exactly the people who raised their font size, which makes it an
 * accessibility failure rather than a curiosity.
 *
 * Hence the scaling below. The alternative — `useVirtualizer`'s dynamic
 * `measureElement` — would be self-correcting at any root size, but it costs
 * a measurement pass and a layout read per row on a list that exists
 * precisely because it can hold thousands of rows, to recover a number this
 * component can compute in one multiplication. Rejected on that basis, not
 * because it would not work.
 */
const ROOT_PX_AT_DERIVATION = 16;

/**
 * The document's current root font size in px, or 16 if it cannot be read.
 *
 * Called on every render rather than memoised, deliberately. A user can
 * change their browser's text-size setting with this tab open, and there is
 * no event that reliably reports it: no `resize` fires, and `matchMedia` has
 * nothing to match on. A value captured once at mount would therefore be
 * wrong for the rest of the session — which for this component means the
 * whole transfer. Reading it during render instead means the very next render
 * repairs the layout, and this component re-renders on essentially every
 * worker event (each progress tick, each new row, each filter click), so in
 * practice the stale window is one tick of an active transfer and nothing at
 * all once one starts. An idle session left mid-change stays misaligned until
 * something re-renders it; that is the residual, and it is judged smaller
 * than the cost of the alternatives (a polling timer, or a `ResizeObserver`
 * on a probe element mounted purely to detect font-size changes).
 *
 * The cost of reading it is one style read on the root element per render,
 * which the browser answers from already-computed style; that is the cheap
 * end of the trade against the per-row measurement pass rejected above.
 */
function rootFontPx(): number {
  const parsed = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ROOT_PX_AT_DERIVATION;
}

/** How long a "Copied" confirmation stays up before reverting to "Copy". Lifted from TextSnippet. */
const COPIED_MS = 2000;

/**
 * How long "Cancel all" stays armed, waiting for the second click that
 * actually stops everything, before it goes back to being a safe button.
 *
 * AGENTS.md asks for a destructive action to be confirmed or undoable, and
 * stopping a whole batch is destructive with nothing to undo: the partial
 * bytes are discarded on purpose. Two clicks rather than a modal, matching
 * the confirm-in-place shape the copy button beside it already uses. A
 * single row's own cancel stays one click — it names the one file it stops
 * in its own label, and re-sending one file costs a drag and a drop.
 */
const CONFIRM_MS = 4000;

/**
/**
 * Which way a row went, as a glyph rather than a word.
 *
 * The record is a mixed log of both directions, and until this existed the
 * only thing separating an incoming row from an outgoing one was the wording
 * of a badge at the far right — which a cancelled file does not get, and a
 * note never had at all. A leading mark makes the direction the first thing
 * read on every row, at the left edge where the eye already is.
 *
 * The well is the same one DevicePanel draws its device glyph in: recessed,
 * page-coloured, no tint. Colour is deliberately not the carrier here — the
 * accent is spent on the primary action and the semantic palette on transport
 * state (client/styles/tokens.css), and two more tinted chips per row would
 * put four competing colours in a list whose job is to be scannable.
 */
function Direction({ direction }: { direction: 'send' | 'receive' }) {
  const outgoing = direction === 'send';
  return (
    <span className="neo-inset-sm inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
      {outgoing ? <IconArrowUpRight aria-hidden="true" /> : <IconArrowDownLeft aria-hidden="true" />}
      {/* "Outgoing"/"Incoming", not "Sent"/"Received": those two words are
          the completion badge's, and a row that is still moving — or was
          cancelled — must not have a screen reader hear them. */}
      <span className="sr-only">{outgoing ? 'Outgoing' : 'Incoming'}</span>
    </span>
  );
}

/**
 * The file row: progress bar, transfer rate, size formatting, completion
 * state and the `aria-label`led save link. Lifted from `FileQueue.tsx`'s
 * `Row` verbatim (only the wrapping element and its className changed, to
 * fit the record's own layout rather than FileQueue's divide-y list).
 */
function FileRow({ file, onCancel }: {
  file: TrackedFile;
  /** Undefined where a record is rendered with no way to act on it. */
  onCancel?: (direction: TrackedFile['direction'], fileIds: number[]) => void;
}) {
  // `done` is set only by an explicit completion event from useSession
  // ('file-complete' on receive, 'send-file-done' on send) — never derived
  // from bytesMoved reaching the total. A file that fails after every byte
  // has arrived (e.g. the sink's close() rejects) never gets that event, so
  // it is never shown complete just because the number looks like 100%.
  const complete = file.done;
  const cancelled = file.cancelled === true;
  // Still moving, so still worth a progress bar, a transfer rate, and a way
  // to stop it. A file that has been offered but has not started a byte yet
  // counts: stopping it before it begins is the cheapest cancel there is.
  const moving = !complete && !cancelled;
  const verb = file.direction === 'send' ? 'Sending' : 'Receiving';

  return (
    <div data-file-row className="flex items-center gap-3 py-2">
      <Direction direction={file.direction} />
      {/*
        A received image, shown rather than described. Conditional on
        `blobUrl` and not on the media type alone: that field is set only for
        the in-memory save tier (see TrackedFile), because on the sw-stream
        and FS-Access tiers the bytes go straight to a sink and never exist in
        this page to point an <img> at.

        40px, and declared in the attributes rather than only in the class:
        the row's other content is 20 + 16 = 36px inside `py-2`, so a 40px
        thumbnail makes the row 56px against the FILE_ROW_HEIGHT of 64 the
        virtualizer positions from — under it, with room to spare, and the
        attributes hold that shape while the blob is still decoding instead of
        letting the row reflow under a list that assumes fixed heights.

        alt="" because it is decorative here in the strict sense: the filename
        is already this row's visible text one element over, and an alt
        repeating it would make a screen reader read the same file twice.
      */}
      {complete && file.blobUrl && file.meta.type.startsWith('image/') && (
        <img
          data-thumb
          src={file.blobUrl}
          alt=""
          width={40}
          height={40}
          className="neo-inset-sm h-10 w-10 shrink-0 rounded-[var(--radius-sm)] object-cover"
        />
      )}
      {/* min-w-0 is what actually lets the filename truncate inside a flex
          row — without it the row grows to fit the name instead. */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={file.meta.name}>{file.meta.name}</p>
        <p className="mono numeric text-xs text-[var(--color-text-muted)]">
          {/* A finished file reads its size once. "2.3 MB of 2.3 MB" is a
              progress readout on something with no progress left, and it sat
              under every completed row for the whole session. A moving or
              cancelled one keeps both numbers, where the pair is the point:
              how far it has got, and how far it has to go. */}
          {complete
            ? formatBytes(file.meta.size)
            : `${formatBytes(file.bytesMoved)} of ${formatBytes(file.meta.size)}`}
          {/* Only once there is a rate to report. A file that has been
              offered but has not moved a byte has no meaningful one, and
              `formatRate` answers that case with a placeholder dash — which
              read as a broken value sitting where a number belongs, on every
              row of a queued batch at once. */}
          {moving && file.bytesPerSecond > 0 && ` · ${formatRate(file.bytesPerSecond)}`}
        </p>
        {moving && (
          <ProgressBar
            className="mt-1.5"
            value={file.bytesMoved}
            max={file.meta.size}
            label={`${verb} ${file.meta.name}`}
          />
        )}
      </div>
      {/* The byte count above is deliberately left at wherever it stopped
          rather than zeroed: how far a cancelled transfer got is the one
          thing still worth reading off the row. */}
      {cancelled && (
        <Badge className="shrink-0" tone="neutral" icon={<IconClose />} label="Cancelled" />
      )}
      {moving && onCancel && (
        // Named per row for the same reason the Save link is: several
        // in-flight rows would otherwise all be "Cancel" to a screen reader,
        // with nothing to tell them apart. min-h-11/min-w-11 puts the icon
        // over the 44px mobile floor, since it has no text label of its own
        // to grow the target.
        <button
          type="button"
          aria-label={`Cancel ${verb.toLowerCase()} ${file.meta.name}`}
          onClick={() => onCancel(file.direction, [file.meta.id])}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-danger)] focus-visible:text-[var(--color-danger)]"
        >
          <IconClose aria-hidden="true" />
        </button>
      )}
      {complete && (
        <Badge
          className="shrink-0"
          tone="live"
          icon={<IconCheck />}
          label={file.direction === 'send' ? 'Sent' : 'Received'}
        />
      )}
      {complete && file.blobUrl && (
        // Every completed row's link would otherwise share the identical
        // accessible name "Save" — a screen reader user downloading several
        // files would hear "Save, Save, Save…" with nothing to tell them
        // apart. The visible label stays short; the file name (already
        // truncated for display above) goes into aria-label instead, same
        // pattern as TextSnippet's "Copy received text N" buttons.
        <a
          href={file.blobUrl}
          download={file.meta.name}
          aria-label={`Save ${file.meta.name}`}
          // The one link in this app that gets tapped repeatedly on a phone,
          // once per finished file. inline-flex + min-h-11 puts it over the
          // 44px mobile floor; see JoinLink.
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-2 text-sm text-[var(--color-accent)]"
        >
          {/* Decorative, like every other icon beside a label: the anchor
              already has an accessible name (the aria-label above), and the
              glyph must not add a second reading of it. This is an <a>, not a
              Button, so it wires the icon in by hand rather than through
              Button's `icon` prop — same contract, different element. */}
          <IconDownload aria-hidden="true" className="text-base" />
          {/* The underline moved off the anchor and onto the word. A
              text-decoration is painted by the element that declares it,
              across every inline descendant — `no-underline` on the icon
              cannot lift it, so an underlined anchor drew a line straight
              through the glyph. Underlining the label instead keeps the link
              visibly a link (never colour alone) and leaves the icon clean. */}
          <span className="underline underline-offset-4">Save</span>
        </a>
      )}
    </div>
  );
}

/**
 * The note row: content clamped to three lines and the Copy button, styled
 * from `TextSnippet.tsx`'s received-note row. The click handler itself —
 * the insecure-origin fallback, the `COPIED_MS` timer, the `role="alert"`
 * failure message — now lives one level up, in `TransferRecord`, and is
 * passed in as `onCopy` plus the `copied` flag for this row's own seq. See
 * the note on `NOTE_ROW_HEIGHT` above for why: a per-row failure message has
 * variable height (a 3-line note plus a 2-line alert exceeds the fixed row
 * height and overlaps the next row in the virtualized path), and only one
 * copy can be in flight or failed at a time anyway, so one card-level region
 * is both correct and simpler than fixing the height per row.
 */
function NoteRow({ note, copied, onCopy }: {
  note: TrackedNote;
  copied: boolean;
  onCopy: (seq: number, content: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-start gap-3">
        <Direction direction={note.direction} />
        {/* Clamped to three lines so the fixed NOTE_ROW_HEIGHT stays honest
            for a long note — the full text remains reachable through Copy. */}
        <p className="line-clamp-3 min-w-0 flex-1 break-words text-sm">{note.content}</p>
        <Button
          variant="ghost"
          className="shrink-0"
          // TextSnippet distinguished its Copy buttons with a position in the
          // received-only array ("Copy received text N"); here the notes are
          // interleaved with files rather than sitting in one array, so `seq`
          // — the ordinal already unique per item across the whole record —
          // plays that same disambiguating role instead. Without it, several
          // sent notes would share one accessible name and a screen reader
          // user copying the second one would hear the same "Copy sent note"
          // as the first, with nothing to tell them apart.
          aria-label={`Copy ${note.direction === 'send' ? 'sent' : 'received'} note ${note.seq}`}
          icon={copied ? <IconCheck /> : <IconCopy />}
          onClick={() => onCopy(note.seq, note.content)}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

/** Dispatches on `item.kind` to the file row or the note row above. */
function RecordRow({ item, copiedSeq, onCopy, onCancel }: {
  item: RecordItem;
  copiedSeq: number | undefined;
  onCopy: (seq: number, content: string) => void;
  onCancel?: (direction: TrackedFile['direction'], fileIds: number[]) => void;
}) {
  return item.kind === 'file'
    ? <FileRow file={item.file} onCancel={onCancel} />
    : <NoteRow note={item} copied={copiedSeq === item.seq} onCopy={onCopy} />;
}

/**
 * A dashed-border row with an icon, not a bare sentence — so the panel
 * reads as a designed empty state rather than as though it failed to
 * render. Lifted from `FileQueue.tsx`'s own empty state and reused for
 * both of this component's two "nothings" (see `nothingAtAll` below); only
 * the message differs between them.
 */
function EmptyState({ message }: { message: string }) {
  return (
    // Not dashed, where it used to be. A dashed rule is the page's drop-target
    // affordance (DropZone, in the column beside this one), and wearing it here
    // offered a second place to drop a file that has never accepted one — two
    // dashed rectangles side by side, one of them lying.
    <div className="neo-inset flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-5">
      <span className="neo inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-lg text-[var(--color-text-muted)]">
        <IconInbox />
      </span>
      <p className="text-sm text-pretty text-[var(--color-text-muted)]">{message}</p>
    </div>
  );
}

/**
 * The message for "this filter matches nothing" — written as an exhaustive
 * switch rather than `filter === 'sent' ? 'sent' : 'received'`. `filter`'s
 * static type is the full `RecordFilter` union, and this function is only
 * ever called once `nothingAtAll` is false and `items.length === 0` — which
 * for `filter === 'all'` cannot actually happen, since 'all' returns every
 * item and would make `nothingAtAll` true instead. That makes the 'all' arm
 * dead in practice, but a binary ternary would silently read it as
 * 'received' if the invariant above were ever wrong; the exhaustive switch
 * makes the dead case visible instead of guessing.
 */
function emptyFilterMessage(filter: RecordFilter): string {
  switch (filter) {
    case 'sent': return 'Nothing sent yet.';
    case 'received': return 'Nothing received yet.';
    case 'all': return 'Nothing yet.';
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

export interface TransferRecordProps {
  files: TrackedFile[];
  notes: TrackedNote[];
  /**
   * Stops files that are still moving. Optional so a record can be rendered
   * purely as a display — every existing test that mounts this component
   * without one keeps working, and the row simply shows no cancel control.
   */
  onCancel?: (direction: TrackedFile['direction'], fileIds: number[]) => void;
}

export function TransferRecord({ files, notes, onCancel }: TransferRecordProps) {
  /**
   * Seeded from the URL so a shared or reloaded link opens on the filter it
   * names, then owned by React. `parseFilter` is called in the initialiser
   * rather than on every render: after mount this component is the authority
   * and writes back through `setFilterParam`.
   */
  const [filter, setFilter] = useState<RecordFilter>(() => parseFilter(new URL(location.href)));

  const items = useMemo(() => applyFilter(buildRecord(files, notes), filter), [files, notes, filter]);

  function choose(next: RecordFilter): void {
    setFilter(next);
    setFilterParam(next);
  }

  const scrollRef = useRef<HTMLDivElement>(null);

  // Once per render, not once per index: `estimateSize` is called for every
  // item on every measurement pass, and the root font size cannot change
  // between two calls within a single render.
  const rowScale = rootFontPx() / ROOT_PX_AT_DERIVATION;

  /**
   * The virtualizer's own item identity, so that its measurement cache
   * invalidates when the rows change shape.
   *
   * `virtual-core` memoises `getMeasurements` on
   * `[getMeasurementOptions(), itemSizeCacheVersion]`, and
   * `getMeasurementOptions` depends on `count`, `paddingStart`,
   * `scrollMargin`, `getItemKey`, `enabled`, `lanes`, `laneAssignmentMode`
   * and `gap` — *not* on `estimateSize`, which the memo never sees
   * (@tanstack/virtual-core/dist/esm/index.js:542-576). Left unset,
   * `getItemKey` defaults to a module-level function whose identity never
   * changes, so a list with an unchanged `count` reuses the previous pass's
   * `start`/`size` values however different the items are.
   *
   * That is reachable: switch between two filters that both exceed the
   * virtualization threshold and happen to hold equal counts of different
   * kinds — 51 sent files and 51 received notes — and every note is laid out
   * in a file-sized box, overlapping the row beneath it. Adding items always
   * changes `count`, which is why the ordinary paths never show it and why
   * `estimateSize` returning the right answer is not enough: nothing asks it
   * again.
   *
   * `seq` is the arrival ordinal `useSession` stamps on every file and note.
   * It is unique and stable for the life of the session, which is exactly
   * what a virtualizer key wants, and it is already this list's React key.
   * `rowScale` is in the dependency list for the same reason: a root font
   * size change alters every estimate without touching `items`, and the memo
   * has no other way to hear about it.
   */
  const getItemKey = useCallback(
    (index: number) => items[index]!.seq,
    [items, rowScale],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]!.kind === 'note' ? NOTE_ROW_HEIGHT : FILE_ROW_HEIGHT) * rowScale,
    getItemKey,
    overscan: 6,
  });
  const virtualize = items.length > VIRTUALIZE_ABOVE;

  // Only the most recently completed file, so a screen reader hears one
  // announcement per completion rather than one per progress tick — same
  // rule FileQueue's own live region followed. Notes have no comparable
  // "still in flight" state (a sent note is recorded only once the worker
  // confirms it went), so there is nothing analogous to fold in for them.
  //
  // KNOWN LIMITATION, deliberately not fixed here. `files` is in *arrival*
  // order, so this is the last file to have arrived among those that are
  // done — not the last one to have finished. When files complete out of
  // order (a large file queued first finishing after a small one queued
  // second) two things go wrong: the region names the wrong file at the
  // moment the small one completes, and when the large one finally finishes
  // this string does not change at all, so its completion is never announced.
  // Carried verbatim from FileQueue, so it is not a regression — but fixing
  // it needs state that does not exist: either a completion-order stamp
  // written where `done` is set (client/hooks/useSession.ts), or announcing
  // straight off the 'file-complete'/'send-file-done' events instead of
  // deriving from the array. Both are changes to the hook's data model, not
  // to this component, which is why this is recorded rather than patched.
  const lastCompleted = useMemo(() => {
    const done = files.filter((f) => f.done);
    return done.length > 0 ? done[done.length - 1]!.meta.name : '';
  }, [files]);

  /**
   * Copy state for whichever note was clicked most recently, lifted out of
   * `NoteRow` and up to here. `copiedSeq` picks out which row's button
   * reads "Copied"; `copyFailed` drives the one card-level failure alert.
   * Both the insecure-origin fallback and the `COPIED_MS` timer are
   * unchanged from `TextSnippet.tsx` — only their storage moved.
   */
  const [copiedSeq, setCopiedSeq] = useState<number | undefined>(undefined);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** "Cancel all" has been clicked once and is waiting for the confirming second. */
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => () => clearTimeout(armTimer.current), []);

  function handleCopy(seq: number, content: string): void {
    // Undefined on an insecure origin — which a LAN address served over
    // plain http is. Reading through it would throw inside the click
    // handler, same as CreateScreen's own copy-link handler.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setCopiedSeq(undefined);
      setCopyFailed(true);
      return;
    }
    void clipboard.writeText(content).then(
      () => {
        setCopyFailed(false);
        clearTimeout(copyTimer.current);
        setCopiedSeq(seq);
        copyTimer.current = setTimeout(() => setCopiedSeq(undefined), COPIED_MS);
      },
      // Denied permission, an unfocused document, or a restrictive
      // permission policy — all realistic on mobile and in embedded
      // contexts. Silence would look exactly like a successful copy and
      // lose the text — which may be the very secret this session existed
      // to move.
      () => {
        setCopiedSeq(undefined);
        setCopyFailed(true);
      },
    );
  }

  /**
   * Two different nothings. An empty session and a filter that happens to
   * match nothing look identical on screen and mean opposite things — one
   * says "get started", the other says "your filter is hiding things".
   * AGENTS.md asks for empty states to be designed; these are two of them.
   */
  const nothingAtAll = files.length === 0 && notes.length === 0;

  /**
   * Everything still moving, in BOTH directions and regardless of the
   * filter above: the filter hides rows, it does not change what a button
   * labelled "Cancel all" means, and stopping only the visible half would
   * leave transfers running that the user believes they just stopped.
   */
  const inFlight = files.filter((f) => !f.done && f.cancelled !== true);

  function cancelEverything(): void {
    // One call per direction, never one merged list: the two id spaces are
    // minted independently and overlap, so a fileId means nothing without
    // the direction it belongs to.
    for (const direction of ['send', 'receive'] as const) {
      const ids = inFlight.filter((f) => f.direction === direction).map((f) => f.meta.id);
      if (ids.length > 0) onCancel?.(direction, ids);
    }
    setArmed(false);
  }

  return (
    <div className="neo rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Filter transfers" className="flex gap-2">
        {RECORD_FILTERS.map((option) => {
          const Glyph = FILTER_ICONS[option];
          return (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => choose(option)}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-sm capitalize transition-[box-shadow,color] duration-[var(--duration-fast)] ${
              filter === option
                ? 'neo-inset bg-[var(--color-surface-2)] font-semibold text-[var(--color-text)]'
                : 'neo-press bg-[var(--color-surface)] text-[var(--color-text-muted)]'
            }`}
          >
            {/* Decorative: the word beside it is the accessible name, and
                `aria-pressed` — not the glyph — is what says which is on. */}
            <Glyph aria-hidden="true" className="text-base" />
            {option}
          </button>
          );
        })}
      </div>

      {/* Only with something to stop, and only where the record was given a
          way to stop it. A single in-flight file already has its own cancel
          on its row, so a second control for the same one file would be two
          buttons doing one thing. */}
      {inFlight.length > 1 && onCancel && (
        <button
          type="button"
          onClick={() => {
            if (armed) { cancelEverything(); return; }
            setArmed(true);
            clearTimeout(armTimer.current);
            armTimer.current = setTimeout(() => setArmed(false), CONFIRM_MS);
          }}
          // The accessible name changes with the label on purpose, unlike
          // the Copy button beside it: here the change IS the state, and a
          // pinned name would leave a screen reader user pressing "confirm"
          // with no idea they had armed anything.
          className={`ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors duration-[var(--duration-fast)] ${
            armed
              ? 'neo-inset bg-[var(--color-surface-2)] font-semibold text-[var(--color-danger)]'
              : 'neo-press bg-[var(--color-surface)] text-[var(--color-text-muted)]'
          }`}
        >
          <IconClose aria-hidden="true" className="text-base" />
          {armed ? `Stop all ${inFlight.length}?` : 'Cancel all'}
        </button>
      )}
      </div>

      {/* Present before it has anything to say, so a change is announced
          rather than the region's arrival. Per-row progress is deliberately
          not announced — reciting every percent would be unusable; folding
          the most recently completed file's name in here is what replaces
          FileQueue's own "<name> finished" announcement, since the item
          count alone never changes on completion. */}
      <p role="status" aria-live="polite" className="sr-only">
        {nothingAtAll ? '' : lastCompleted ? `${lastCompleted} finished. ${items.length} items.` : `${items.length} items`}
      </p>

      {/* A second, independent status region for Copy: NoteRow's button
          keeps a pinned aria-label ("Copy sent note 4") specifically so its
          visible "Copy" → "Copied" swap does not change its accessible
          name — which means that swap is otherwise inaudible, same as
          TextSnippet's original rationale. Kept separate from the region
          above so a copy and a completion never race to overwrite each
          other's announcement in the same live region.

          KNOWN LIMITATION, deliberately not fixed here: a second copy made
          within COPIED_MS of the first announces nothing. `copiedSeq`
          changes, but this text does not — it is already 'Copied to
          clipboard' — and a live region announces changes, not writes.
          Inherited from TextSnippet, where the same held. Making it audible
          means making the text differ per copy (the note's seq, or a
          counter), which is more words in the ear on every single copy to
          serve the case of copying twice inside two seconds; that trade was
          judged the wrong way round, so this is recorded rather than
          changed. */}
      <p role="status" aria-live="polite" className="sr-only">
        {copiedSeq !== undefined ? 'Copied to clipboard' : ''}
      </p>
      {copyFailed && (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          This browser would not let the page copy that. Select the text above and copy it by hand.
        </p>
      )}

      {nothingAtAll ? (
        <EmptyState message="Nothing yet. Drop a file or paste a note to start." />
      ) : items.length === 0 ? (
        <EmptyState message={emptyFilterMessage(filter)} />
      ) : (
        // Scrolls inside its own card rather than growing the page, so a
        // forty-file session does not push Devices off the bottom.
        // overscrollBehavior: 'contain' stops that scroll from chaining to
        // the page once this list hits its own top or bottom — the same
        // guard FileQueue's virtualized branch uses on mobile.
        <div ref={scrollRef} className="max-h-[22rem] overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {virtualize ? (
            // role="list" on a <ul> looks redundant, and in most browsers it
            // is. WebKit drops a list's implicit semantics when its
            // `list-style` is `none` — which Tailwind's preflight applies to
            // every <ul> in the app — so in Safari/VoiceOver this stops being
            // announced as a list at all, taking the item count with it. The
            // explicit role puts it back, and changes nothing anywhere else.
            // Both branches carry it; only which one renders differs.
            <ul role="list" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((row) => (
                <li
                  key={items[row.index]!.seq}
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    height: row.size, transform: `translateY(${row.start}px)`,
                  }}
                >
                  <RecordRow item={items[row.index]!} copiedSeq={copiedSeq} onCopy={handleCopy} onCancel={onCancel} />
                </li>
              ))}
            </ul>
          ) : (
            // role="list" for the same Safari reason as the branch above.
            // --color-border-strong, not --color-border: the latter is a rim
            // LIGHT in the soft-UI palette (near-white in the light theme),
            // which made every row separator invisible and left the list
            // reading as unstyled text inside a styled card. Row heights are
            // fixed contracts (FILE_ROW_HEIGHT / NOTE_ROW_HEIGHT) so the
            // separator stays a 1px line rather than becoming per-row padding.
            <ul role="list" className="divide-y divide-[var(--color-border-strong)]">
              {items.map((item) => (
                <li key={item.seq}>
                  <RecordRow item={item} copiedSeq={copiedSeq} onCopy={handleCopy} onCancel={onCancel} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

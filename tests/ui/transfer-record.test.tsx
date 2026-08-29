// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FILE_ROW_HEIGHT, NOTE_ROW_HEIGHT, TransferRecord } from '../../client/ui/TransferRecord.js';
import type { TrackedFile } from '../../client/hooks/useSession.js';
import type { TrackedNote } from '../../client/hooks/useSession.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });

const FILES: TrackedFile[] = [
  { seq: 1, meta: { id: 1, name: 'sent.pdf', size: 2048, type: '' }, direction: 'send', bytesMoved: 1024, bytesPerSecond: 512, done: false },
  { seq: 3, meta: { id: 2, name: 'got.jpg', size: 4096, type: '' }, direction: 'receive', bytesMoved: 4096, bytesPerSecond: 0, done: true, blobUrl: 'blob:x' },
];
const NOTES: TrackedNote[] = [
  { seq: 2, direction: 'receive', content: 'https://example.com/thing' },
  { seq: 4, direction: 'send', content: 'meeting at 4' },
];

describe('TransferRecord', () => {
  it('shows files and notes in one list, newest first', () => {
    render(<TransferRecord files={FILES} notes={NOTES} />);
    const rows = screen.getAllByRole('listitem').map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('meeting at 4');
    expect(rows[1]).toContain('got.jpg');
    expect(rows[2]).toContain('https://example.com/thing');
    expect(rows[3]).toContain('sent.pdf');
  });

  it('filters by direction and reflects the choice in the URL', async () => {
    render(<TransferRecord files={FILES} notes={NOTES} />);
    await userEvent.click(screen.getByRole('button', { name: /^sent$/i }));
    const rows = screen.getAllByRole('listitem').map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows.join(' ')).toContain('meeting at 4');
    expect(rows.join(' ')).toContain('sent.pdf');
    expect(location.search).toBe('?filter=sent');
  });

  it('starts from the filter already in the URL', () => {
    history.replaceState(null, '', '/s/ABC123?filter=received#key');
    render(<TransferRecord files={FILES} notes={NOTES} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('says what to do when nothing has crossed yet', () => {
    render(<TransferRecord files={[]} notes={[]} />);
    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
  });

  /*
   * A filter can empty a non-empty record. That is a different situation
   * from an empty session and must not read as one — the user needs to know
   * their filter is hiding things, not that nothing was ever sent.
   */
  it('distinguishes "filtered to nothing" from "nothing has happened"', async () => {
    render(<TransferRecord files={[FILES[0]!]} notes={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /^received$/i }));
    expect(screen.getByText(/nothing received/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing yet/i)).not.toBeInTheDocument();
  });

  it('offers Copy on a note and Save on a completed received file', () => {
    render(<TransferRecord files={FILES} notes={NOTES} />);
    expect(screen.getAllByRole('button', { name: /copy/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /save got\.jpg/i })).toBeInTheDocument();
  });

  /*
   * The one genuinely new mechanism in this component: two row heights
   * chosen by kind, not measured. `virtual-core`'s own positioning math
   * guarantees rows tile with no gap and no overlap by construction
   * (start_i = start_{i-1} + size_{i-1}), so what actually needs proving
   * here is that TransferRecord feeds it the right per-kind sizes and that
   * virtualization itself is engaged past the threshold — not the tiling
   * arithmetic, which lives in the library.
   */
  it('virtualizes a mixed list of files and notes with two row heights, tiled with no gap or overlap', () => {
    // jsdom does no layout, so the scroll container's real offsetHeight is
    // always 0 — which the virtualizer would read as "nothing is visible"
    // and render zero rows, proving nothing about virtualization either
    // way. Stubbed to a plausible viewport height so its actual windowing
    // logic runs the same way it would in a browser. Same technique as
    // FileQueue's own virtualization test (tests/ui/transfer-panel.test.tsx).
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
    try {
      // 60 items, alternating kind, so the mix is interleaved rather than
      // two same-kind blocks — a bug that only shows up when consecutive
      // rendered rows differ in height would otherwise hide behind a run of
      // same-kind rows.
      const manyFiles: TrackedFile[] = [];
      const manyNotes: TrackedNote[] = [];
      let seq = 1;
      for (let i = 0; i < 60; i++) {
        if (i % 2 === 0) {
          manyFiles.push({
            seq: seq++, meta: { id: i, name: `file-${i}.bin`, size: 10, type: '' },
            direction: 'send', bytesMoved: 0, bytesPerSecond: 0, done: false,
          });
        } else {
          manyNotes.push({ seq: seq++, direction: 'send', content: `note ${i}` });
        }
      }

      const { container } = render(<TransferRecord files={manyFiles} notes={manyNotes} />);

      // Fewer than all 60 are actually mounted.
      const rendered = screen.getAllByRole('listitem');
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered.length).toBeLessThan(60);

      // The scroll spacer's total height is the sum of every item's real
      // size — files and notes both, not just the ones currently rendered.
      const list = container.querySelector('ul')!;
      const expectedTotal = manyFiles.length * FILE_ROW_HEIGHT + manyNotes.length * NOTE_ROW_HEIGHT;
      expect(list.style.height).toBe(`${expectedTotal}px`);

      // Consecutive rendered rows tile with no gap and no overlap: the next
      // row's translateY equals the current row's translateY plus its own
      // height. This is the two-heights case, so it fails if either
      // constant is wrong or estimateSize picks the wrong one for an index.
      const translateY = (el: Element): number => {
        const match = /translateY\((\d+(?:\.\d+)?)px\)/.exec((el as HTMLElement).style.transform);
        return Number(match?.[1]);
      };
      const rowHeight = (el: Element): number => Number((el as HTMLElement).style.height.replace('px', ''));
      for (let i = 0; i < rendered.length - 1; i++) {
        const current = rendered[i]!;
        const next = rendered[i + 1]!;
        expect(translateY(next)).toBe(translateY(current) + rowHeight(current));
      }
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  /*
   * Every dimension that actually fills a row — the `text-sm`/`text-xs` line
   * heights, `py-2`, `gap-1.5`, `mt-1.5`, `h-1.5`, `min-h-11` — is expressed
   * in rem, so a user who raises their browser's default text size (the
   * accessibility setting, not zoom, which scales px too) gets taller rows
   * while FILE_ROW_HEIGHT/NOTE_ROW_HEIGHT stay at the px numbers they were
   * derived at. At a 20px root a file row measures 80 against a declared 64,
   * and the absolutely-positioned rows overlap. This pins the scaling that
   * stops that: every estimate is (root / 16) of its constant.
   *
   * jsdom resolves no rem units of its own, but it does report an inline
   * `font-size` back through `getComputedStyle` — which is the one value the
   * component reads, so the branch under test runs exactly as it would in a
   * browser even though nothing here is laid out.
   */
  it('scales its row estimates with the root font size rather than assuming 16px', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
    document.documentElement.style.fontSize = '20px';
    try {
      const manyFiles: TrackedFile[] = [];
      const manyNotes: TrackedNote[] = [];
      let seq = 1;
      for (let i = 0; i < 60; i++) {
        if (i % 2 === 0) {
          manyFiles.push({
            seq: seq++, meta: { id: i, name: `file-${i}.bin`, size: 10, type: '' },
            direction: 'send', bytesMoved: 0, bytesPerSecond: 0, done: false,
          });
        } else {
          manyNotes.push({ seq: seq++, direction: 'send', content: `note ${i}` });
        }
      }

      const { container } = render(<TransferRecord files={manyFiles} notes={manyNotes} />);

      const list = container.querySelector('ul')!;
      const at16 = manyFiles.length * FILE_ROW_HEIGHT + manyNotes.length * NOTE_ROW_HEIGHT;
      expect(list.style.height).toBe(`${at16 * (20 / 16)}px`);
    } finally {
      document.documentElement.style.fontSize = '';
      height.mockRestore();
      width.mockRestore();
    }
  });

  /*
   * `virtual-core` memoises its measurements on
   * `[getMeasurementOptions(), itemSizeCacheVersion]`, and
   * `getMeasurementOptions` depends on count, paddingStart, scrollMargin,
   * getItemKey, enabled, lanes, laneAssignmentMode and gap — *not* on
   * `estimateSize` (@tanstack/virtual-core/dist/esm/index.js:542-576). So a
   * list whose count is unchanged but whose kinds differ — 51 sent files
   * swapped for 51 received notes, which one filter click can produce —
   * would reuse the previous kind sequence's sizes, laying a note out in a
   * file-sized box and overlapping the row beneath it. Returning the right
   * answer from `estimateSize` is not enough when nothing asks it again.
   *
   * This asserts the consequence rather than the mechanism: the two
   * same-count lists must measure differently. It fails without the
   * `items`-keyed `getItemKey`, which is what makes the memo's dependency
   * list change exactly when the item sequence does.
   */
  it('re-measures when the item count is unchanged but the kinds differ', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
    try {
      const COUNT = 51;
      const onlyFiles: TrackedFile[] = Array.from({ length: COUNT }, (_, i) => ({
        seq: i + 1, meta: { id: i, name: `file-${i}.bin`, size: 10, type: '' },
        direction: 'send' as const, bytesMoved: 0, bytesPerSecond: 0, done: false,
      }));
      const onlyNotes: TrackedNote[] = Array.from({ length: COUNT }, (_, i) => ({
        seq: i + 1, direction: 'receive' as const, content: `note ${i}`,
      }));

      // One component instance throughout, hence one virtualizer: rendering
      // the second list fresh would build a fresh measurement cache and pass
      // whether or not the memo ever invalidates.
      const { container, rerender } = render(<TransferRecord files={onlyFiles} notes={[]} />);
      const totalHeight = (): string => container.querySelector('ul')!.style.height;
      expect(totalHeight()).toBe(`${COUNT * FILE_ROW_HEIGHT}px`);

      rerender(<TransferRecord files={[]} notes={onlyNotes} />);
      expect(totalHeight()).toBe(`${COUNT * NOTE_ROW_HEIGHT}px`);
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });
});

/**
 * `blobUrl` is set only for a received file the in-memory tier produced a
 * Blob for (TrackedFile's own doc comment). On the sw-stream and FS-Access
 * tiers the bytes never exist in the page, so there is nothing to preview —
 * hence a preview that is conditional on the blob, not on the media type
 * alone.
 */
describe('TransferRecord: image preview', () => {
  const image = (over: Partial<TrackedFile> = {}): TrackedFile => ({
    seq: 1,
    meta: { id: 9, name: 'shot.png', size: 1024, type: 'image/png' },
    direction: 'receive', bytesMoved: 1024, bytesPerSecond: 0, done: true,
    blobUrl: 'blob:preview',
    ...over,
  });

  it('previews a received image the in-memory tier produced a blob for', () => {
    const { container } = render(<TransferRecord files={[image()]} notes={[]} />);
    expect(container.querySelector('[data-thumb]')).toHaveAttribute('src', 'blob:preview');
  });

  it('previews nothing for a non-image file, even when a blob exists', () => {
    const file = image({ meta: { id: 9, name: 'notes.txt', size: 1024, type: 'text/plain' } });
    const { container } = render(<TransferRecord files={[file]} notes={[]} />);
    expect(container.querySelector('[data-thumb]')).toBeNull();
  });

  it('previews nothing on a save tier that never held the bytes', () => {
    const { container } = render(<TransferRecord files={[image({ blobUrl: undefined })]} notes={[]} />);
    expect(container.querySelector('[data-thumb]')).toBeNull();
  });

  /*
   * The thumbnail must not push a file row past FILE_ROW_HEIGHT: the
   * virtualizer positions rows from that constant with no clipping, so an
   * over-tall row overlaps the one beneath it.
   *
   * Asserted on the img's own `height` attribute against the component's
   * exported constant, not on computed style — jsdom loads no CSS, so a
   * Tailwind size class computes to nothing here and the check would pass
   * for a thumbnail of any size at all. The attribute is also what stops the
   * row reflowing as the blob decodes, so this pins the thing that matters
   * twice over.
   */
  it('declares a thumbnail height the row constant can absorb', () => {
    const { container } = render(<TransferRecord files={[image()]} notes={[]} />);
    const thumb = container.querySelector('[data-thumb]') as HTMLImageElement;
    const declared = Number(thumb.getAttribute('height'));
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(FILE_ROW_HEIGHT);
  });
});

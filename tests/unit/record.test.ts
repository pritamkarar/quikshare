import { describe, expect, it } from 'vitest';
import { applyFilter, buildRecord } from '../../client/ui/record.js';
import type { TrackedFile, TrackedNote } from '../../client/hooks/useSession.js';

const file = (seq: number, direction: 'send' | 'receive', name: string): TrackedFile => ({
  seq, meta: { id: seq, name, size: 100, type: '' },
  direction, bytesMoved: 0, bytesPerSecond: 0, done: false,
});
const note = (seq: number, direction: 'send' | 'receive', content: string): TrackedNote =>
  ({ seq, direction, content });

describe('buildRecord', () => {
  /*
   * Newest first, across BOTH kinds. Files and notes arrive on separate
   * channels, so a naive "files then notes" concatenation would put a note
   * from the start of the session above a file that arrived a second ago.
   * The shared arrival ordinal is what makes one ordering possible.
   */
  it('interleaves files and notes by arrival, newest first', () => {
    const items = buildRecord(
      [file(1, 'send', 'a.bin'), file(4, 'receive', 'b.bin')],
      [note(2, 'receive', 'hi'), note(3, 'send', 'bye')],
    );
    expect(items.map((i) => i.seq)).toEqual([4, 3, 2, 1]);
    expect(items.map((i) => i.kind)).toEqual(['file', 'note', 'note', 'file']);
  });

  it('carries each item its own direction, whichever kind it is', () => {
    const items = buildRecord([file(1, 'send', 'a.bin')], [note(2, 'receive', 'hi')]);
    expect(items.map((i) => i.direction)).toEqual(['receive', 'send']);
  });

  it('handles either side being empty', () => {
    expect(buildRecord([], [])).toEqual([]);
    expect(buildRecord([file(1, 'send', 'a.bin')], [])).toHaveLength(1);
    expect(buildRecord([], [note(1, 'send', 'hi')])).toHaveLength(1);
  });

  it('never mutates its input arrays', () => {
    const files = [file(1, 'send', 'a.bin'), file(4, 'receive', 'b.bin')];
    const notes = [note(2, 'receive', 'hi'), note(3, 'send', 'bye')];
    const filesBefore = files.map((f) => ({ ...f }));
    const notesBefore = notes.map((n) => ({ ...n }));
    buildRecord(files, notes);
    expect(files).toEqual(filesBefore);
    expect(notes).toEqual(notesBefore);
  });
});

describe('applyFilter', () => {
  const items = buildRecord(
    [file(1, 'send', 'a.bin'), file(2, 'receive', 'b.bin')],
    [note(3, 'send', 'hi'), note(4, 'receive', 'bye')],
  );

  it('returns everything for "all", in the same order', () => {
    expect(applyFilter(items, 'all').map((i) => i.seq)).toEqual([4, 3, 2, 1]);
  });

  it('selects by direction across both kinds', () => {
    expect(applyFilter(items, 'sent').map((i) => i.seq)).toEqual([3, 1]);
    expect(applyFilter(items, 'received').map((i) => i.seq)).toEqual([4, 2]);
  });

  it('never mutates its input', () => {
    const before = items.map((i) => i.seq);
    applyFilter(items, 'sent');
    expect(items.map((i) => i.seq)).toEqual(before);
  });
});

import type { TrackedFile, TrackedNote } from '../hooks/useSession.js';

/**
 * Everything that has crossed this session, in one list.
 *
 * Files and notes arrive on separate worker events and were previously
 * rendered by separate components — a queue and a list of received notes,
 * each with its own notion of order and neither aware of the other. A user
 * asking "did that go?" had to look in two places, and a note sent between
 * two files appeared above or below both depending on which component it
 * landed in. One list with one ordering is the whole point of this module.
 */

export type RecordFilter = 'all' | 'sent' | 'received';

/** Chip order in the UI, and the set `parseFilter` will accept. */
export const RECORD_FILTERS = ['all', 'sent', 'received'] as const;

/*
 * `TrackedNote` is deliberately NOT declared here — it lives beside
 * `TrackedFile` in client/hooks/useSession.ts, because both are shapes of
 * the hook's own state. Declaring it here would make this module and the
 * hook import from each other; the cycle would be type-only and therefore
 * legal, but a source cycle is a trap for whoever next adds a runtime value
 * to either side. Imports here run one way only.
 */

/**
 * A discriminated union, not a single shape with optional fields. A file row
 * and a note row share almost nothing but their ordinal and direction — seq
 * and direction are common, but a file owns a TrackedFile and a note owns a
 * string. A merged shape would force every consumer to check which half is
 * populated; a union instead guarantees the right half is there.
 */
export type RecordItem =
  | { kind: 'file'; seq: number; direction: 'send' | 'receive'; file: TrackedFile }
  | { kind: 'note'; seq: number; direction: 'send' | 'receive'; content: string };

/**
 * Newest first. A fresh array every call — React state must never be sorted
 * in place, and `applyFilter` below relies on being handed something it may
 * read without copying again.
 */
export function buildRecord(files: TrackedFile[], notes: TrackedNote[]): RecordItem[] {
  const items: RecordItem[] = [
    ...files.map((file): RecordItem => ({
      kind: 'file', seq: file.seq, direction: file.direction, file,
    })),
    ...notes.map((note): RecordItem => ({
      kind: 'note', seq: note.seq, direction: note.direction, content: note.content,
    })),
  ];
  return items.sort((a, b) => b.seq - a.seq);
}

/**
 * Select items by direction, collapsing the filter's terminology to match
 * the direction field: 'sent' becomes 'send', 'received' becomes 'receive'.
 *
 * The 'all' case returns the input array itself (not a copy), so if the caller
 * mutates the result, the record is mutated too — and this function will not
 * prevent it. Copying on every render would be worse, and the callers are
 * read-only.
 */
export function applyFilter(items: RecordItem[], filter: RecordFilter): RecordItem[] {
  if (filter === 'all') return items;
  const wanted = filter === 'sent' ? 'send' : 'receive';
  return items.filter((item) => item.direction === wanted);
}

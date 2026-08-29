# Session Layout Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the connected session screen into distinct regions — what you **start**, what has **crossed**, and what you are **paired with** — with a single filterable record replacing today's separate file queue and received-notes list.

**Architecture:** `TransferPanel` becomes a two-column layout (Share | Transfers) with Devices spanning beneath, inside a shell widened for the session route only. A new `TransferRecord` component owns the record: files and notes in one list, newest first, filtered by All / Sent / Received with the active filter reflected in the URL. Sent notes become trackable for the first time — the worker reports them once they are actually on the wire, mirroring how file sends are already reported rather than guessing optimistically.

**Tech Stack:** TypeScript 5.6, React 19, Tailwind 4, Vite 6, Vitest 3, Playwright.

**Spec:** [`docs/superpowers/specs/2026-08-27-live-media-and-session-layout-design.md`](../specs/2026-08-27-live-media-and-session-layout-design.md) — this plan implements §6 (The session screen) and §9 phase 2.

**Plan 02 of 4.** Plan 01 (transport realm fix) is merged. Plans 03 and 04 cover TURN infrastructure and live media.

**Execution order is T1, T3, T2, T4, T5, T6, T7** — not task-number order. `client/ui/record.ts` (Task 2) imports `TrackedFile` and `TrackedNote` as types from `client/hooks/useSession.ts` (Task 3), so the types must exist before the module that imports them. The two are independent in content; only their compile order is fixed.

**No Live section in this plan.** Spec §6 puts a Live region above the columns, but it has nothing to show until plan 04 — `MediaPeer` does not exist yet. Building an empty region now would mean shipping a control that cannot work. The column layout is arranged so plan 04 inserts Live above it without moving anything else.

## Global Constraints

- Node **≥ 22**. On this machine `node` is not on the default `PATH`; prefix commands with `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"`.
- **`AGENTS.md` is binding**, and this plan is almost entirely UI. The clauses it will actually trip over:
  - URL reflects state — deep-linkable filters.
  - Virtualize lists past 50 items.
  - Design empty / sparse / dense / error states.
  - Hit target ≥24px desktop, ≥44px mobile.
  - Flex children need `min-w-0` to allow truncation; text containers handle long content.
  - `font-variant-numeric: tabular-nums` for compared numbers (the `numeric` class).
  - Accessible names exist even when visuals omit labels; icon-only buttons carry `aria-label`.
  - No dead ends.
- Every AES-GCM operation and the session key stay in the worker. This plan touches no crypto.
- **No optimistic UI in the record.** A row appears when the worker says the thing actually happened, never when the user clicked. The file path already works this way (`useSession`'s comment: "No optimistic rows: the worker announces the real metas via 'outgoing'"); notes must match it.
- This codebase's commenting standard is unusually high — doc comments explain *why*, at length, including rationale for rejected alternatives.
- Conventional commit messages. Commit after every task.
- Baseline: 789 tests across 63 files, `npm run typecheck` clean, `npm run test:e2e` 16 passing.

## File Structure

| File | Responsibility |
| --- | --- |
| `client/worker/messages.ts` *(modify)* | `text-sent` event — a note that actually reached the wire |
| `client/worker/transfer-worker.ts` *(modify)* | Emits it after `session.sendText` resolves |
| `client/hooks/useSession.ts` *(modify)* | `notes: TrackedNote[]` replaces `texts: string[]`; arrival ordinals |
| `client/ui/record.ts` *(create)* | The record's ordering and filtering logic. No React, and **imports from `useSession` in one direction only** |
| `client/routing.ts` *(modify)* | `parseFilter` / `setFilterParam` — filter in the URL, fragment preserved |
| `client/ui/TransferRecord.tsx` *(create)* | The Transfers card: filter chips, virtualized rows, empty state |
| `client/ui/TextSnippet.tsx` *(modify)* | Becomes the composer only; its received-notes list moves to the record |
| `client/ui/FileQueue.tsx` *(delete)* | Superseded by `TransferRecord` |
| `client/screens/TransferPanel.tsx` *(modify)* | Two-column layout |
| `client/App.tsx`, `client/ui/AppHeader.tsx` *(modify)* | Per-route shell width |
| `tests/unit/record.test.ts` *(create)* | Ordering, filtering, edge cases |
| `tests/ui/transfer-record.test.tsx` *(create)* | Rendering, filters, states, virtualization |
| `tests/ui/transfer-panel.test.tsx` *(modify)* | Layout assertions; FileQueue tests migrate |

---

### Task 1: Report a sent note

A note that was sent leaves no trace today — `texts` holds only what arrived. The record needs both directions, and the honest source is the worker, after the send resolves.

**Files:**
- Modify: `client/worker/messages.ts` (`FromWorker`)
- Modify: `client/worker/transfer-worker.ts` (`case 'send-text'`)
- Test: `tests/unit/transfer-worker.test.ts`

**Interfaces:**
- Produces: `{ t: 'text-sent'; content: string }` on `FromWorker`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/transfer-worker.test.ts`, matching the file's existing harness:

```ts
it('reports a sent note only once it is actually on the wire', async () => {
  // Mirrors how file sends are reported: the row appears because the worker
  // says the bytes went, never because the user pressed a button. A note
  // that failed to seal must not leave a "Sent" row behind claiming it did.
  await init();
  scope.sent.length = 0;

  await send({ t: 'send-text', content: 'hello' });

  expect(scope.sent.map((s) => s.msg.t)).toContain('text-sent');
  expect(scope.sent.find((s) => s.msg.t === 'text-sent')?.msg)
    .toMatchObject({ content: 'hello' });
});

it('reports no sent note when the send rejects', async () => {
  await init();
  captured.session!.sendText = () => Promise.reject(new Error('peer-left'));
  scope.sent.length = 0;

  await send({ t: 'send-text', content: 'hello' });

  expect(scope.sent.map((s) => s.msg.t)).not.toContain('text-sent');
  // The failure still surfaces the way every other worker failure does.
  expect(scope.sent.map((s) => s.msg.t)).toContain('error');
});
```

Read the file first and adapt `init`, `send`, `scope` and `captured` to the names it actually uses — do not invent a second harness.

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/transfer-worker.test.ts -t 'sent note'
```

Expected: FAIL — no `text-sent` is ever posted.

- [ ] **Step 3: Add the message type**

In `client/worker/messages.ts`, on `FromWorker`, beside `'text'`:

```ts
  /**
   * A note this device sent, reported once `Session.sendText` has resolved —
   * i.e. once it is sealed and on the wire, not when the user pressed Send.
   *
   * The record shows sent and received notes side by side, and a row that
   * appeared on the click would be a claim the app cannot support: a send
   * that rejects (peer left mid-seal, transport died) would leave a "Sent"
   * row behind for a note that never left. File sends already work this way
   * — see the `outgoing` comment in useSession — and notes now match.
   */
  | { t: 'text-sent'; content: string }
```

- [ ] **Step 4: Emit it**

In `client/worker/transfer-worker.ts`, replace the `send-text` case:

```ts
        // Awaited, then reported: `sendText` resolves only once the note is
        // sealed and handed to the transport. A rejection falls through to
        // the catch below and surfaces as an 'error' — with no `text-sent`,
        // so no row claims a note went that did not.
        case 'send-text':
          await session?.sendText(msg.content);
          post({ t: 'text-sent', content: msg.content });
          return;
```

- [ ] **Step 5: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/worker/messages.ts client/worker/transfer-worker.ts tests/unit/transfer-worker.test.ts
git commit -m "feat(worker): report a note once it is actually sent

The record needs both directions, and a row that appeared on the click
would claim a note went that a rejected send never delivered. Mirrors how
file sends are already reported."
```

---

### Task 2: The record's data model

Pure logic, no React: what an item is, how items order, how a filter selects them. Extracted so the ordering and filtering rules are testable without rendering anything.

**Files:**
- Create: `client/ui/record.ts`
- Test: `tests/unit/record.test.ts`

**Interfaces:**
- Consumes: `TrackedFile` **and `TrackedNote`** from `client/hooks/useSession.js`
- Produces:
  ```ts
  export type RecordFilter = 'all' | 'sent' | 'received';
  export type RecordItem =
    | { kind: 'file'; seq: number; direction: 'send' | 'receive'; file: TrackedFile }
    | { kind: 'note'; seq: number; direction: 'send' | 'receive'; content: string };
  export function buildRecord(files: TrackedFile[], notes: TrackedNote[]): RecordItem[];
  export function applyFilter(items: RecordItem[], filter: RecordFilter): RecordItem[];
  export const RECORD_FILTERS: readonly RecordFilter[];
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/record.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/record.test.ts
```

Expected: FAIL — `client/ui/record.ts` does not exist, and `TrackedFile` has no `seq` yet (Task 3 adds it; for now the test's cast is what drives the field into being).

- [ ] **Step 3: Implement**

Create `client/ui/record.ts`:

```ts
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

export function applyFilter(items: RecordItem[], filter: RecordFilter): RecordItem[] {
  if (filter === 'all') return items;
  const wanted = filter === 'sent' ? 'send' : 'receive';
  return items.filter((item) => item.direction === wanted);
}
```

- [ ] **Step 4: Run the test**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/record.test.ts
```

Expected: PASS once Task 3 has added `seq` to `TrackedFile`. If `tsc` complains about the missing field, do Task 3's `TrackedFile` change now and commit them together — the two are one change split across two files.

- [ ] **Step 5: Commit**

```bash
git add client/ui/record.ts tests/unit/record.test.ts
git commit -m "feat(ui): one record model for files and notes together"
```

---

### Task 3: Arrival ordinals and note tracking in useSession

**Files:**
- Modify: `client/hooks/useSession.ts`
- Test: `tests/ui/create-screen.test.tsx` (its `FakeWorker` harness already drives this hook end to end)

**Interfaces:**
- Consumes: `text-sent` (Task 1)
- Produces: `TrackedFile.seq: number`; `TrackedNote` (declared here, beside `TrackedFile`); `SessionHandle.notes: TrackedNote[]` replacing `texts: string[]`

- [ ] **Step 1: Write the failing test**

Append to `tests/ui/create-screen.test.tsx`. This asserts on the hook's own state through the rendered session, **not** on the record's rendering — `TransferRecord` does not exist until Task 5, and a task should not leave a red test behind for a later one to turn green.

```ts
it('stamps files and notes with one shared arrival order', async () => {
  const { worker } = await startSession();
  act(() => worker.emit({ ...READY, device: SELF_DEVICE }));
  act(() => worker.emit({ t: 'peer-joined' }));
  await screen.findByText(/connected/i);

  // A note arriving between two files is the case a per-kind counter gets
  // wrong: file ids and note positions each count from their own zero, so
  // only a shared ordinal can say which of a file and a note came first.
  act(() => worker.emit({ t: 'outgoing', files: [{ id: 1, name: 'first.bin', size: 10, type: '' }] }));
  act(() => worker.emit({ t: 'text', content: 'a received note' }));
  act(() => worker.emit({ t: 'text-sent', content: 'a sent note' }));
  act(() => worker.emit({ t: 'offer', files: [{ id: 2, name: 'second.bin', size: 10, type: '' }] }));

  // Only what genuinely renders at this point. The `texts` -> `notes`
  // migration must not lose received notes or files — that is what this
  // asserts. A note this device SENT renders nowhere yet: the only surface
  // for notes until Task 5 is TextSnippet's received-only list, so
  // asserting it here would fail no matter how correct the hook is.
  // Sent-note tracking is proven at the worker boundary by Task 1, and its
  // rendering by Task 5's ordering test once TransferRecord exists.
  expect(screen.getByText('a received note')).toBeInTheDocument();
  expect(screen.getByText('first.bin')).toBeInTheDocument();
  expect(screen.getByText('second.bin')).toBeInTheDocument();
});
```

While migrating, `TransferPanel` needs a temporary shim so `TextSnippet` keeps its received-only list working:

```tsx
        <TextSnippet
          onSend={session.sendText}
          received={session.notes.filter((n) => n.direction === 'receive').map((n) => n.content)}
        />
```

Task 6 deletes both the shim and the prop. It exists only so this task can land without breaking the screen.

The ordering itself is proven twice over without needing the record rendered: `tests/unit/record.test.ts` (Task 2) covers `buildRecord`'s interleaving directly, and Task 5 adds the rendered-order assertion once there is something to render.

- [ ] **Step 2: Add the ordinal and the note list**

In `client/hooks/useSession.ts`:

Add to `TrackedFile`:

```ts
  /**
   * Arrival order within this session, from the same counter that stamps
   * notes. Not the worker's file id: ids are minted per-kind and restart
   * per session, so they cannot order a file against a note that arrived
   * between two of them. See client/ui/record.ts.
   */
  seq: number;
```

Declare `TrackedNote` immediately after `TrackedFile` — both are shapes of this hook's state, and keeping them together is what stops `record.ts` and this file importing from each other:

```ts
/**
 * A note that crossed, tagged with its direction and the ordinal it arrived
 * on. `seq` comes from the same counter that stamps files, which is the only
 * thing that can order a note against a file: the worker's file ids are
 * minted per-kind, so they cannot.
 */
export interface TrackedNote {
  seq: number;
  direction: 'send' | 'receive';
  content: string;
}
```

Replace `texts` on `SessionHandle`:

```ts
  /**
   * Every note that crossed, in either direction — replacing the
   * received-only `texts` this hook used to expose. A sent note is recorded
   * when the worker confirms it went (`text-sent`), never on the click.
   */
  notes: TrackedNote[];
```

Inside the hook, replace the `texts` state and add the counter:

```ts
  const [notes, setNotes] = useState<TrackedNote[]>([]);
  /**
   * One counter for both kinds, in a ref rather than state: it is read and
   * incremented inside the worker message handler, where a stale closure
   * over a state value would hand two items the same ordinal and make their
   * order arbitrary.
   */
  const arrivalSeq = useRef(0);
```

Stamp files where they are created — both the `offer` and `outgoing` handlers:

```ts
              meta, seq: ++arrivalSeq.current, direction: 'receive' as const,
              bytesMoved: 0, bytesPerSecond: 0, done: false,
```

(and `'send' as const` in the `outgoing` handler.)

Replace the `text` case and add `text-sent`:

```ts
        case 'text':
          setNotes((prev) => [...prev, { seq: ++arrivalSeq.current, direction: 'receive', content: msg.content }]);
          return;
        case 'text-sent':
          setNotes((prev) => [...prev, { seq: ++arrivalSeq.current, direction: 'send', content: msg.content }]);
          return;
```

Return `notes` instead of `texts` from the hook.

- [ ] **Step 3: Update every consumer**

`texts` is read by `TransferPanel` (passing it to `TextSnippet`) and by test fixtures. Compile-drive it:

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck
```

Fix each error. `tests/ui/transfer-panel.test.tsx`'s `fakeSession` helper needs `notes: []` in place of `texts: []`.

- [ ] **Step 4: Run the suite**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
```

Expected: PASS apart from the deliberately-red test from Step 1, if you kept it in rendered form.

- [ ] **Step 5: Commit**

```bash
git add client/hooks/useSession.ts client/screens/TransferPanel.tsx tests/
git commit -m "feat(ui): stamp files and notes with one arrival order, track sent notes"
```

---

### Task 4: The filter in the URL

AGENTS.md asks for deep-linkable filters. The session key lives in the fragment, so a query parameter does not disturb it — but the write must be `replaceState`, or Back becomes a filter-undo button.

**Files:**
- Modify: `client/routing.ts`
- Test: `tests/unit/routing.test.ts`

**Interfaces:**
- Produces: `parseFilter(url: URL): RecordFilter`, `setFilterParam(filter: RecordFilter): void`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/routing.test.ts`:

```ts
describe('record filter in the URL', () => {
  it('reads a valid filter', () => {
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=sent#key'))).toBe('sent');
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=received#key'))).toBe('received');
  });

  /*
   * A URL is user-editable and shared by hand. Anything unrecognised — a
   * typo, an old link from before a filter was renamed — falls back to
   * showing everything rather than an empty list the user cannot explain.
   */
  it('falls back to "all" for anything unrecognised', () => {
    expect(parseFilter(new URL('https://x.dev/s/ABC123#key'))).toBe('all');
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=nonsense#key'))).toBe('all');
    expect(parseFilter(new URL('https://x.dev/s/ABC123?filter=#key'))).toBe('all');
  });

  it('writes the filter without disturbing the key in the fragment', () => {
    history.replaceState(null, '', '/s/ABC123#thekey');
    setFilterParam('received');
    expect(location.search).toBe('?filter=received');
    // The fragment carries the decryption key. Losing it here would break
    // the session for anyone who copied the URL afterwards.
    expect(location.hash).toBe('#thekey');
  });

  it('drops the parameter entirely for the default rather than writing ?filter=all', () => {
    history.replaceState(null, '', '/s/ABC123?filter=sent#thekey');
    setFilterParam('all');
    expect(location.search).toBe('');
    expect(location.hash).toBe('#thekey');
  });

  /*
   * replaceState, not pushState: a filter is a view preference, and pushing
   * one history entry per chip click turns Back into a filter-undo button
   * instead of the way out of the session.
   */
  it('does not add a history entry', () => {
    history.replaceState(null, '', '/s/ABC123#thekey');
    const pushState = vi.spyOn(history, 'pushState');
    setFilterParam('sent');
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/routing.test.ts -t 'record filter'
```

Expected: FAIL — neither function exists.

- [ ] **Step 3: Implement**

In `client/routing.ts`:

```ts
import { RECORD_FILTERS, type RecordFilter } from './ui/record.js';

/**
 * The record's active filter, read from `?filter=`.
 *
 * A query parameter rather than part of the path or the fragment: the path
 * identifies the room, and the fragment carries the decryption key and must
 * not be touched. Anything unrecognised reads as 'all' — this URL is
 * user-editable and gets pasted between devices, and an unknown value
 * should show everything rather than an empty list with no explanation.
 */
export function parseFilter(url: URL): RecordFilter {
  const raw = url.searchParams.get('filter');
  return RECORD_FILTERS.find((known) => known === raw) ?? 'all';
}

/**
 * Writes the filter back, preserving everything else about the URL.
 *
 * `replaceState`, never `pushState`: a filter is a view preference, and one
 * history entry per chip click would turn Back into a filter-undo button
 * rather than the way out of the session — which AGENTS.md's "no dead ends"
 * and the user's own expectation both depend on.
 *
 * The default drops the parameter instead of writing `?filter=all`, so the
 * URL someone copies out of the address bar is the same clean share link
 * they started with.
 */
export function setFilterParam(filter: RecordFilter): void {
  const url = new URL(location.href);
  if (filter === 'all') url.searchParams.delete('filter');
  else url.searchParams.set('filter', filter);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npx vitest run tests/unit/routing.test.ts
```

Expected: PASS. Add `parseFilter`, `setFilterParam` and `vi` to the test file's imports.

- [ ] **Step 5: Commit**

```bash
git add client/routing.ts tests/unit/routing.test.ts
git commit -m "feat(ui): deep-linkable record filter, fragment preserved"
```

---

### Task 5: `TransferRecord`

The Transfers card: filter chips, one virtualized list of both kinds, empty state.

**Files:**
- Create: `client/ui/TransferRecord.tsx`
- Test: `tests/ui/transfer-record.test.tsx`
- Read first: `client/ui/FileQueue.tsx` (the row markup, progress presentation, save link and live region to carry over) and `client/ui/TextSnippet.tsx` (its received-note row and Copy button)

**Interfaces:**
- Consumes: `buildRecord`, `applyFilter`, `RecordItem`, `RecordFilter` (Task 2); `parseFilter`, `setFilterParam` (Task 4)
- Produces: `<TransferRecord files={...} notes={...} />`

**Two row heights, not dynamic measurement.** `FileQueue` virtualizes on a single fixed `ROW_HEIGHT`. Notes carry text and are taller. `useVirtualizer`'s `estimateSize` takes the index, so the height can be chosen by the item's kind — deterministic, no measurement pass, no layout thrash. Notes clamp to three lines (`line-clamp-3`) so the height is honest; the full text stays reachable through Copy.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/transfer-record.test.tsx` covering, at minimum:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransferRecord } from '../../client/ui/TransferRecord.js';
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
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/transfer-record.test.tsx
```

Expected: FAIL — the component does not exist.

- [ ] **Step 3: Implement**

Two halves. The **row internals are lifted, not rewritten** — the file row's progress bar, rate, size formatting, completion state and `aria-label`led save link already exist in `client/ui/FileQueue.tsx`, and the note row's Copy button with its `COPIED_MS` confirmation and insecure-origin fallback already exist in `client/ui/TextSnippet.tsx`. Move those in as they are. That fallback in particular is load-bearing and non-obvious: `navigator.clipboard` is `undefined` on a plain-http LAN origin, and reading through it throws inside the click handler.

The **structure is new**, so here it is in full:

```tsx
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TrackedFile, TrackedNote } from '../hooks/useSession.js';
import { applyFilter, buildRecord, RECORD_FILTERS, type RecordFilter } from './record.js';
import { parseFilter, setFilterParam } from '../routing.js';

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
 */
const FILE_ROW_HEIGHT = 64;
const NOTE_ROW_HEIGHT = 92;

export interface TransferRecordProps {
  files: TrackedFile[];
  notes: TrackedNote[];
}

export function TransferRecord({ files, notes }: TransferRecordProps) {
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
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]!.kind === 'note' ? NOTE_ROW_HEIGHT : FILE_ROW_HEIGHT),
    overscan: 6,
  });
  const virtualize = items.length > VIRTUALIZE_ABOVE;

  /**
   * Two different nothings. An empty session and a filter that happens to
   * match nothing look identical on screen and mean opposite things — one
   * says "get started", the other says "your filter is hiding things".
   * AGENTS.md asks for empty states to be designed; these are two of them.
   */
  const nothingAtAll = files.length === 0 && notes.length === 0;

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div role="group" aria-label="Filter transfers" className="mb-2 flex gap-1">
        {RECORD_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => choose(option)}
            className={`min-h-11 rounded-full px-3 text-sm capitalize ${
              filter === option
                ? 'border border-[var(--color-border)] bg-[var(--color-surface-2)] font-semibold'
                : 'text-[var(--color-text-muted)]'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {/* Present before it has anything to say, so a change is announced
          rather than the region's arrival. Per-row progress is deliberately
          not announced — reciting every percent would be unusable; this is
          the summary that replaces it, same as FileQueue's. */}
      <p role="status" aria-live="polite" className="sr-only">
        {nothingAtAll ? '' : `${items.length} items`}
      </p>

      {nothingAtAll ? (
        <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">
          Nothing yet. Drop a file or paste a note to start.
        </p>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">
          Nothing {filter === 'sent' ? 'sent' : 'received'} yet.
        </p>
      ) : (
        // Scrolls inside its own card rather than growing the page, so a
        // forty-file session does not push Devices off the bottom.
        <div ref={scrollRef} className="max-h-[22rem] overflow-y-auto">
          {virtualize ? (
            <ul style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((row) => (
                <li
                  key={items[row.index]!.seq}
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    height: row.size, transform: `translateY(${row.start}px)`,
                  }}
                >
                  <RecordRow item={items[row.index]!} />
                </li>
              ))}
            </ul>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.seq}><RecordRow item={item} /></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

`RecordRow` dispatches on `item.kind` to a file row and a note row, both built from the lifted markup named above. Give each row `min-w-0` on its flexible child so a long filename or URL truncates instead of widening the column, and the `mono numeric` classes on sizes and rates.

- [ ] **Step 4: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npx vitest run tests/ui/transfer-record.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add client/ui/TransferRecord.tsx tests/ui/transfer-record.test.tsx
git commit -m "feat(ui): one filterable record for files and notes"
```

---

### Task 6: Two columns, and a wider shell for the session route

**Files:**
- Modify: `client/screens/TransferPanel.tsx`
- Modify: `client/ui/TextSnippet.tsx` (drop its received list; it becomes the composer)
- Delete: `client/ui/FileQueue.tsx`
- Modify: `client/App.tsx`, `client/ui/AppHeader.tsx`
- Test: `tests/ui/transfer-panel.test.tsx`, `tests/ui/a11y.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `tests/ui/transfer-panel.test.tsx`:

```ts
it('groups the screen into Share, Transfers and Devices', () => {
  render(<TransferPanel session={fakeSession()} />);
  expect(screen.getByRole('region', { name: /share/i })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: /transfers/i })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: /devices/i })).toBeInTheDocument();
});

it('puts the record beside the controls rather than below them', () => {
  const { container } = render(<TransferPanel session={fakeSession()} />);
  // The two-column wrapper is what makes the record visible without
  // scrolling past the drop zone; asserted because nothing else in the
  // suite can see a layout class.
  expect(container.querySelector('[data-session-columns]')).toHaveClass('sm:grid-cols-2');
});

it('no longer renders received notes under the composer', () => {
  const session = fakeSession({ notes: [{ seq: 1, direction: 'receive', content: 'a note' }] });
  render(<TransferPanel session={session} />);
  // Exactly once — in the record, not also under the text box.
  expect(screen.getAllByText(/a note/)).toHaveLength(1);
});
```

And to `tests/ui/app-routing.test.tsx`:

```ts
it('widens the shell on the session route only, header included', () => {
  history.pushState(null, '', `/s/K7M3QP#${KEY}`);
  const { unmount } = render(<App />);
  expect(screen.getByRole('main')).toHaveClass('max-w-5xl');
  expect(within(screen.getByRole('banner')).getByRole('link', { name: /quik share/i })
    .closest('div')).toHaveClass('max-w-5xl');
  unmount();

  history.pushState(null, '', '/');
  render(<App />);
  expect(screen.getByRole('main')).toHaveClass('max-w-2xl');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/ui/transfer-panel.test.tsx tests/ui/app-routing.test.tsx
```

- [ ] **Step 3: Restructure `TransferPanel`**

Order: header (Connected / End session / TransportBadge), then a two-column grid holding Share and Transfers, then Devices, then the notice/error slots, then `JoinLink`. Both columns are `<section>`s with headings, so they surface as landmarks.

```tsx
      <div data-session-columns className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="share-heading" className="flex flex-col gap-4">
          <h2 id="share-heading" className="text-sm font-semibold text-[var(--color-text-muted)]">Share</h2>
          <DropZone onFiles={session.sendFiles} />
          <TextSnippet onSend={session.sendText} />
        </section>

        <section aria-labelledby="transfers-heading" className="flex flex-col gap-4">
          <h2 id="transfers-heading" className="text-sm font-semibold text-[var(--color-text-muted)]">Transfers</h2>
          <TransferRecord files={session.files} notes={session.notes} />
        </section>
      </div>
```

`DevicePanel` keeps its current position beneath — it already renders its own `Devices` heading and was deliberately moved to the bottom.

- [ ] **Step 4: Reduce `TextSnippet` to a composer**

Delete its `received` prop, its received-notes list, and the copy state that served it — that state moves to `TransferRecord`'s note rows. Keep the textarea, the character bound, the ⌘/Ctrl+Enter handling and the Send button exactly as they are.

- [ ] **Step 5: Delete `FileQueue`**

```bash
git rm client/ui/FileQueue.tsx
```

Migrate any test in `tests/ui/transfer-panel.test.tsx` that exercised it onto `TransferRecord`, rather than deleting the coverage. `tests/ui/a11y.test.tsx` renders `FileQueue` — swap it for `TransferRecord` in both a populated and an empty state.

- [ ] **Step 6: Per-route shell width**

`App` computes the width once and hands it to both `AppHeader` and `<main>`, so the bar can never sit at a different width from the content beneath it:

```tsx
  // The session screen is two columns; every other screen is a single
  // column of prose that reads badly stretched. Computed here rather than
  // inside each component so the header and the content cannot disagree —
  // a header visibly narrower than the page under it reads as a bug.
  const shellWidth = route.t === 'session' ? 'max-w-5xl' : 'max-w-2xl';
```

Give `AppHeader` a `width` prop applied to its inner container.

- [ ] **Step 7: Full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ui): two-column session screen, one record, wider shell

Share and Transfers sit side by side so the record is visible without
scrolling past the drop zone. FileQueue and TextSnippet's received list
are superseded by TransferRecord."
```

---

### Task 7: Prove it in a real browser

The layout claims are geometric and the filter claim is a URL round-trip; both are things jsdom cannot see.

**Files:**
- Modify: `tests/e2e/transfer.spec.ts` or create `tests/e2e/session-layout.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts` (its tap-target sweep covers the new chips for free once the panel renders them)

- [ ] **Step 1: Write the tests**

Using `pair()` from `tests/e2e/helpers.ts`:

**Drive the guest, not the host.** `pair()` navigates the host to `/new` and only the **guest** to `/s/CODE#key`. The host's URL has no fragment at all, so reloading it would start a brand-new session and prove nothing — neither that the filter survives nor that the key does.

```ts
test('a filter write survives a reload and preserves the key in the fragment', async ({ browser }) => {
  const session = await pair(browser, 'relay');
  try {
    // The guest is the peer whose URL is the share link: /s/CODE#key.
    const { guest } = session;
    await guest.page.getByRole('button', { name: /^sent$/i }).click();
    await expect(guest.page).toHaveURL(/\?filter=sent/);
    // The decryption key lives in the fragment; a filter write that dropped
    // it would break the link for anyone who copied it afterwards.
    await expect(guest.page).toHaveURL(/#.+$/);

    await guest.page.reload();
    await expect(guest.page.getByRole('button', { name: /^sent$/i }))
      .toHaveAttribute('aria-pressed', 'true');
  } finally {
    await closePair(session);
  }
});
```

A reload re-mounts the session and rejoins from the URL, which is the same path a scanned QR takes — so this also exercises that the filter parameter does not interfere with joining. If rejoining after a reload turns out not to work for reasons unrelated to this plan, assert the two URL properties and drop the reload, saying so in your report rather than working around a real defect.

- [ ] **Step 2: Run**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
CI=1 npm run test:e2e
```

- [ ] **Step 3: Look at it**

Take a screenshot at 900px and at 412px and check the two-column layout, the filter chips and the record's scroll behaviour with a dense list. jsdom cannot tell you whether this looks right; a screenshot can.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): session layout, filter round-trip, key preserved"
```

---

## Verification

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test && npm run build && CI=1 npm run test:e2e
```

Plus the check no test performs: open the app in two windows, pair, send a file and a note in each direction, and confirm the record shows all four in arrival order with the filters selecting correctly.

## What this plan deliberately does not do

- **No Live section.** Nothing to put in it until plan 04 builds `MediaPeer`.
- **No TURN.** Plan 03.
- **No change to the transfer path.** This is presentation only; `Sender`, `Receiver`, `Session` and the transports are untouched.

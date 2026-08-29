import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from '../../shared/messages.js';
import {
  SHARE_CACHE,
  foldNote,
  stashShare,
  takeShare,
} from '../../client/share/inbox.js';

/**
 * A Cache/CacheStorage good enough for these tests and no more.
 *
 * Node has no `caches`, and the real one is not worth reaching for: what
 * these tests are about is the shape of what gets written and that taking it
 * removes it, neither of which needs a browser.
 */
function fakeStorage(): CacheStorage & { names(): string[] } {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string): Promise<Cache> => {
    const entries = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, entries);
    return {
      put: async (request: RequestInfo | URL, response: Response) => {
        entries.set(String(request), response);
      },
      match: async (request: RequestInfo | URL) => entries.get(String(request)),
    } as unknown as Cache;
  };
  return {
    open,
    delete: async (name: string) => stores.delete(name),
    names: () => [...stores.keys()],
  } as unknown as CacheStorage & { names(): string[] };
}

function shareForm(files: File[], fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

describe('foldNote', () => {
  it('folds title, text and url into one note', () => {
    expect(foldNote(shareForm([], { title: 'Docs', text: 'read this', url: 'https://e.example' })))
      .toBe('Docs\nread this\nhttps://e.example');
  });

  it('says nothing when the share carried no text at all', () => {
    expect(foldNote(shareForm([]))).toBeUndefined();
    expect(foldNote(shareForm([], { title: '  ', text: '' }))).toBeUndefined();
  });

  it('does not repeat a value the share sent under two names', () => {
    // Chrome commonly sends the same URL as both `text` and `url`; a note
    // that says it twice is noise on the other device.
    expect(foldNote(shareForm([], { text: 'https://e.example', url: 'https://e.example' })))
      .toBe('https://e.example');
  });

  it('truncates to the note limit the transfer path enforces', () => {
    const note = foldNote(shareForm([], { text: 'x'.repeat(MAX_TEXT_CHARS + 500) }));
    expect(note).toHaveLength(MAX_TEXT_CHARS);
  });
});

describe('the share inbox', () => {
  it('round-trips files with their names and types intact', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([
      new File(['hello'], 'note.txt', { type: 'text/plain' }),
      new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }),
    ]));

    const payload = await takeShare(storage);

    expect(payload?.files.map((file) => [file.name, file.type, file.size]))
      .toEqual([['note.txt', 'text/plain', 5], ['shot.png', 'image/png', 3]]);
    expect(await payload?.files[0]!.text()).toBe('hello');
  });

  it('carries the note alongside the files', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([], { url: 'https://e.example' }));
    expect((await takeShare(storage))?.note).toBe('https://e.example');
  });

  it('leaves nothing behind once the page has taken it', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([new File(['x'], 'a.txt', { type: 'text/plain' })]));

    await takeShare(storage);

    // The shared copy exists on this device only to be handed to the page.
    expect(storage.names()).not.toContain(SHARE_CACHE);
    expect(await takeShare(storage)).toBeUndefined();
  });

  it('reports nothing when no share was ever stashed', async () => {
    expect(await takeShare(fakeStorage())).toBeUndefined();
  });

  it('does not leave an unclaimed share behind when a second one arrives', async () => {
    const storage = fakeStorage();
    await stashShare(storage, shareForm([
      new File(['1'], 'first.txt', { type: 'text/plain' }),
      new File(['2'], 'second.txt', { type: 'text/plain' }),
    ]));
    await stashShare(storage, shareForm([new File(['3'], 'third.txt', { type: 'text/plain' })]));

    const payload = await takeShare(storage);

    // Not "third, plus whatever the first share left at the same keys".
    expect(payload?.files.map((file) => file.name)).toEqual(['third.txt']);
  });
});

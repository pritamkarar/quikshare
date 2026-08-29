import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseSaveDirectory, createDirectorySink, createFileSystemSink, safeFileName,
  supportsDirectoryPicker, supportsFileSystemAccess,
} from '../../client/save/fsaccess.js';
import type { FileSystemDirectoryHandleLike } from '../../client/save/fsaccess.js';

const meta = { id: 1, name: 'a.bin', size: 3, type: 'application/octet-stream' };

/**
 * Installs a fake `showSaveFilePicker` on globalThis and returns the writable
 * spy plus the picker spy, so tests can assert directly on `writable.write.mock.calls`,
 * `writable.close`, and `writable.abort` without an intermediate state-tracking layer.
 */
function installPicker(): {
  writable: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
  picker: ReturnType<typeof vi.fn>;
} {
  const writable = {
    write: vi.fn(async (_chunk: Uint8Array) => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const picker = vi.fn(async () => ({ createWritable: async () => writable }));
  Reflect.set(globalThis, 'showSaveFilePicker', picker);
  return { writable, picker };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
  Reflect.deleteProperty(globalThis, 'showDirectoryPicker');
});

describe('file system access sink', () => {
  it('reports unsupported when the picker is absent', () => {
    expect(supportsFileSystemAccess()).toBe(false);
  });

  it('reports supported when the picker exists', () => {
    installPicker();
    expect(supportsFileSystemAccess()).toBe(true);
  });

  it('suggests the incoming filename', async () => {
    const { picker } = installPicker();
    await createFileSystemSink(meta);
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'a.bin' }));
  });

  it('streams chunks to the writable and closes it', async () => {
    const { writable } = installPicker();
    const sink = await createFileSystemSink(meta);
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    expect(await sink.close()).toBeUndefined();
    expect(writable.write.mock.calls.map(([chunk]) => [...(chunk as Uint8Array)])).toEqual([[1, 2], [3]]);
    expect(writable.close).toHaveBeenCalled();
  });

  it('has no practical size cap', async () => {
    installPicker();
    const sink = await createFileSystemSink(meta);
    expect(() => sink.assertWithinCap(50 * 1024 ** 3)).not.toThrow();
  });

  it('aborts the writable so a partial file is discarded', async () => {
    const { writable } = installPicker();
    const sink = await createFileSystemSink(meta);
    await sink.write(new Uint8Array([1]));
    await sink.abort('integrity failure');
    expect(writable.abort).toHaveBeenCalledWith('integrity failure');
  });
});

/**
 * A directory handle backed by a set of names, so a test can start with a
 * folder that already holds something and assert on what got created — the
 * collision behaviour is the whole reason `freeName` exists, and a handle
 * that always says "free" could not exercise it.
 */
function fakeDir(existing: string[] = []): {
  dir: FileSystemDirectoryHandleLike;
  writable: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
  created: string[];
} {
  const names = new Set(existing);
  const created: string[] = [];
  const writable = {
    write: vi.fn(async (_chunk: Uint8Array) => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const dir: FileSystemDirectoryHandleLike = {
    name: 'Shared',
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!names.has(name)) {
        // What a real handle does for a name nothing holds, which is exactly
        // the signal `freeName` reads as "this one is free".
        if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
        names.add(name);
        created.push(name);
      }
      return { createWritable: async () => writable };
    },
  };
  return { dir, writable, created };
}

describe('directory picker', () => {
  it('reports unsupported when the picker is absent', () => {
    expect(supportsDirectoryPicker()).toBe(false);
  });

  it('asks for write permission at pick time, so no file needs its own prompt', async () => {
    const { dir } = fakeDir();
    const show = vi.fn(async () => dir);
    Reflect.set(globalThis, 'showDirectoryPicker', show);

    expect(supportsDirectoryPicker()).toBe(true);
    expect(await chooseSaveDirectory()).toBe(dir);
    expect(show).toHaveBeenCalledWith({ mode: 'readwrite' });
  });
});

describe('safeFileName', () => {
  it('replaces the separators a name could try to escape the folder with', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('a\\b.txt')).toBe('a_b.txt');
  });

  it('never returns a name that means the folder itself', () => {
    expect(safeFileName('.')).toBe('file');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('   ')).toBe('file');
  });

  it('leaves an ordinary name, and a non-Latin one, alone', () => {
    expect(safeFileName('report.pdf')).toBe('report.pdf');
    expect(safeFileName('計画.pdf')).toBe('計画.pdf');
  });
});

describe('directory sink', () => {
  it('creates the file in the chosen folder and streams to it', async () => {
    const { dir, writable, created } = fakeDir();
    const sink = await createDirectorySink(meta, dir);
    await sink.write(new Uint8Array([1, 2]));
    expect(await sink.close()).toBeUndefined();

    expect(created).toEqual(['a.bin']);
    expect(writable.write.mock.calls.map(([chunk]) => [...(chunk as Uint8Array)])).toEqual([[1, 2]]);
    expect(writable.close).toHaveBeenCalled();
  });

  it('numbers a colliding name instead of overwriting what is there', async () => {
    const { dir, created } = fakeDir(['a.bin', 'a (1).bin']);
    await createDirectorySink(meta, dir);
    expect(created).toEqual(['a (2).bin']);
  });

  it('numbers a dotfile after the whole name, not inside it', async () => {
    const { dir, created } = fakeDir(['.env']);
    await createDirectorySink({ ...meta, name: '.env' }, dir);
    expect(created).toEqual(['.env (1)']);
  });

  it('writes a peer-authored path under a flattened name inside the folder', async () => {
    const { dir, created } = fakeDir();
    await createDirectorySink({ ...meta, name: '../../etc/passwd' }, dir);
    expect(created).toEqual(['.._.._etc_passwd']);
  });

  it('has no practical size cap', async () => {
    const { dir } = fakeDir();
    const sink = await createDirectorySink(meta, dir);
    expect(() => sink.assertWithinCap(50 * 1024 ** 3)).not.toThrow();
  });

  it('aborts the writable so a partial file is discarded', async () => {
    const { dir, writable } = fakeDir();
    const sink = await createDirectorySink(meta, dir);
    await sink.abort('integrity failure');
    expect(writable.abort).toHaveBeenCalledWith('integrity failure');
  });
});

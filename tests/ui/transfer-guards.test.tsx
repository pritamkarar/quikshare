// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransferGuards } from '../../client/hooks/useTransferGuards.js';
import type { TrackedFile } from '../../client/hooks/useSession.js';

/** Stands in for whatever another owner (routing, CreateScreen, ...) put
 *  there. Distinctive on purpose so a test can tell "restored" from "wiped". */
const BASE_TITLE = 'Session ABC123 — Quik Share';

const tracked = (over: Partial<TrackedFile> = {}): TrackedFile => ({
  meta: { id: 1, name: 'a.bin', size: 100, type: '' },
  direction: 'send', bytesMoved: 40, bytesPerSecond: 10, done: false, seq: 1, ...over,
});

function fireBeforeUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  dispatchEvent(event);
  return event.defaultPrevented;
}

interface FakeSentinel { released: boolean; release: () => Promise<void> }

/** Every lock `request('screen')` has handed out in the current test. */
let sentinels: FakeSentinel[] = [];
let requestScreenLock: ReturnType<typeof vi.fn>;

/**
 * A `navigator.wakeLock` that grants everything and records what it granted.
 *
 * Stubbed onto a clone of the real navigator rather than replacing it: the
 * hook reads nothing else off it today, but a bare object would make any
 * future read fail for a reason that has nothing to do with the test.
 */
function installWakeLock(): void {
  sentinels = [];
  requestScreenLock = vi.fn(async () => {
    const sentinel: FakeSentinel = {
      released: false,
      release: async () => { sentinel.released = true; },
    };
    sentinels.push(sentinel);
    return sentinel;
  });
  vi.stubGlobal('navigator', Object.create(navigator, {
    wakeLock: { value: { request: requestScreenLock }, configurable: true },
  }));
}

/** Drives the visibility transition the OS uses to drop a lock. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setVisibility('visible');
});

describe('useTransferGuards', () => {
  beforeEach(() => {
    document.title = BASE_TITLE;
  });

  it('blocks navigation while a transfer is in flight', () => {
    renderHook(() => useTransferGuards([tracked()]));
    expect(fireBeforeUnload()).toBe(true);
  });

  it('stops blocking once every file is done', () => {
    // A single static render of "done" can't tell a real guard-removal from a
    // hook that never blocked in the first place, so this asserts the
    // transition: blocked while in flight, then released once done.
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    expect(fireBeforeUnload()).toBe(true);

    rerender({ files: [tracked({ done: true })] });
    expect(fireBeforeUnload()).toBe(false);
  });

  it('stops blocking once the file list empties', () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    expect(fireBeforeUnload()).toBe(true);

    rerender({ files: [] });
    expect(fireBeforeUnload()).toBe(false);
  });

  it('shows aggregate progress in the document title, decorating whatever title is already there', () => {
    renderHook(() => useTransferGuards([tracked()]));
    expect(document.title).toBe(`40% · ${BASE_TITLE}`);
  });

  it('aggregates over every file, not just the ones still moving', () => {
    // Two 100-byte files, one finished and one halfway. Counting only the
    // in-flight file would drop the finished one from both sides of the
    // ratio and the percent would fall the instant it completed.
    const files = [
      tracked({ meta: { id: 1, name: 'a.bin', size: 100, type: '' }, done: true, bytesMoved: 100 }),
      tracked({ meta: { id: 2, name: 'b.bin', size: 100, type: '' }, done: false, bytesMoved: 50 }),
    ];
    renderHook(() => useTransferGuards(files));
    expect(document.title).toBe(`75% · ${BASE_TITLE}`);
  });

  it('restores the exact original title once every file is done', () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    expect(document.title).toBe(`40% · ${BASE_TITLE}`);

    rerender({ files: [tracked({ done: true })] });
    expect(document.title).toBe(BASE_TITLE);
  });

  it('does not stack prefixes when it reapplies its own decoration', () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked({ bytesMoved: 40 })] },
    });
    expect(document.title).toBe(`40% · ${BASE_TITLE}`);

    // Same percent, but a new `files` array — the effect re-runs (this is
    // what makes the title self-healing if some other owner clobbers it
    // mid-transfer) and must not double up on its own prefix.
    rerender({ files: [tracked({ bytesMoved: 40 })] });
    expect(document.title).toBe(`40% · ${BASE_TITLE}`);

    // Progress moves on: the old prefix is replaced, never stacked in front of.
    rerender({ files: [tracked({ bytesMoved: 70 })] });
    expect(document.title).toBe(`70% · ${BASE_TITLE}`);
  });

  it('strips its own prefix on unmount, instead of leaving it stale forever', () => {
    // TransferPanel unmounts mid-transfer whenever a peer disconnects
    // (session.state flips to 'ended'), and nothing downstream ever rewrites
    // the title after that. Without cleanup here the tab would read
    // "40% · ..." forever, long after the UI has moved on.
    const { unmount } = renderHook(() => useTransferGuards([tracked()]));
    expect(document.title).toBe(`40% · ${BASE_TITLE}`);

    unmount();

    expect(document.title).toBe(BASE_TITLE);
  });
});

describe('the screen wake lock', () => {
  beforeEach(installWakeLock);

  it('is taken while a transfer is in flight', async () => {
    renderHook(() => useTransferGuards([tracked()]));

    // A phone that sleeps mid-transfer does not pause it — it drops the
    // connection, and there is no resume.
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledWith('screen'));
  });

  it('is not taken when nothing is moving', () => {
    renderHook(() => useTransferGuards([tracked({ done: true })]));
    expect(requestScreenLock).not.toHaveBeenCalled();
  });

  it('is released once the last file finishes', async () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    await vi.waitFor(() => expect(sentinels).toHaveLength(1));

    rerender({ files: [tracked({ done: true })] });

    // Holding it past the transfer would keep a phone awake indefinitely on
    // a screen nobody is looking at.
    await vi.waitFor(() => expect(sentinels[0]!.released).toBe(true));
  });

  it('is released when the screen goes away mid-transfer', async () => {
    const { unmount } = renderHook(() => useTransferGuards([tracked()]));
    await vi.waitFor(() => expect(sentinels).toHaveLength(1));

    unmount();

    await vi.waitFor(() => expect(sentinels[0]!.released).toBe(true));
  });

  it('is taken again after the user switches away and comes back', async () => {
    renderHook(() => useTransferGuards([tracked()]));
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledTimes(1));

    // The OS releases the lock on hide and never restores it — and someone
    // who just came back to a still-running transfer is exactly the person
    // whose screen was about to sleep.
    setVisibility('hidden');
    setVisibility('visible');

    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledTimes(2));
  });

  it('does not re-take it after the transfer has finished', async () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalledTimes(1));

    rerender({ files: [tracked({ done: true })] });
    setVisibility('hidden');
    setVisibility('visible');

    expect(requestScreenLock).toHaveBeenCalledTimes(1);
  });

  it('changes nothing on a browser without the API', () => {
    // Safari below 16.4, and any insecure origin. The transfer must run
    // exactly as it does today rather than throw on a missing property.
    vi.stubGlobal('navigator', Object.create(navigator, {
      wakeLock: { value: undefined, configurable: true },
    }));

    expect(() => renderHook(() => useTransferGuards([tracked()]))).not.toThrow();
  });

  it('survives a refusal without disturbing the transfer', async () => {
    requestScreenLock.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));

    const { unmount } = renderHook(() => useTransferGuards([tracked()]));
    await vi.waitFor(() => expect(requestScreenLock).toHaveBeenCalled());

    // Nothing to tell the user: the transfer still works, the screen just
    // may sleep, and there is nothing they could do about it from here.
    expect(() => unmount()).not.toThrow();
  });
});

/**
 * A cancelled file is `{ cancelled: true, done: false }` (useSession.ts's
 * `file-cancelled` case), so a guard keyed on `!done` alone never releases
 * for one. `TransferRecord` already reads the pair correctly
 * (`moving = !complete && !cancelled`); this hook did not, which left every
 * guard armed for the rest of the session on a transfer that was over.
 */
describe('useTransferGuards: a cancelled file is not in flight', () => {
  it('stops blocking navigation once the only file was cancelled', () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    expect(fireBeforeUnload()).toBe(true);

    rerender({ files: [tracked({ cancelled: true, done: false })] });
    expect(fireBeforeUnload()).toBe(false);
  });

  it('strips its progress prefix off the title once the only file was cancelled', () => {
    const { rerender } = renderHook(({ files }: { files: TrackedFile[] }) => useTransferGuards(files), {
      initialProps: { files: [tracked()] },
    });
    expect(document.title).not.toBe(BASE_TITLE);

    rerender({ files: [tracked({ cancelled: true, done: false })] });
    expect(document.title).toBe(BASE_TITLE);
  });
});

/** Every notification constructed in the current test. */
let notifications: { title: string; options: NotificationOptions | undefined }[] = [];

/**
 * A `Notification` constructor that records rather than displays. jsdom has
 * none at all, so this is the whole API surface the hook can see — which is
 * also why the absent case below can be tested by simply not calling this.
 */
function installNotifications(permission: NotificationPermission = 'granted'): void {
  notifications = [];
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => permission);
    constructor(title: string, options?: NotificationOptions) {
      notifications.push({ title, options });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
}

/**
 * Asserts on *whether* a notification fired, never on its wording — the body
 * text is a product decision that should be free to change without breaking
 * the mechanism's tests.
 */
describe('useTransferGuards: completion notification', () => {
  const finish = (files: TrackedFile[]) => {
    const { rerender } = renderHook(({ f }: { f: TrackedFile[] }) => useTransferGuards(f), {
      initialProps: { f: [tracked()] },
    });
    rerender({ f: files });
  };

  it('notifies when the last file lands while the tab is hidden', () => {
    installNotifications();
    setVisibility('hidden');
    finish([tracked({ done: true, bytesMoved: 100 })]);
    expect(notifications).toHaveLength(1);
  });

  it('stays quiet when the user is already looking at the tab', () => {
    installNotifications();
    setVisibility('visible');
    finish([tracked({ done: true, bytesMoved: 100 })]);
    expect(notifications).toHaveLength(0);
  });

  it('stays quiet when the transfer was cancelled rather than delivered', () => {
    installNotifications();
    setVisibility('hidden');
    finish([tracked({ cancelled: true, done: false })]);
    expect(notifications).toHaveLength(0);
  });

  it('stays quiet when permission was never granted', () => {
    installNotifications('default');
    setVisibility('hidden');
    finish([tracked({ done: true, bytesMoved: 100 })]);
    expect(notifications).toHaveLength(0);
  });

  it('does not throw on a browser with no Notification at all', () => {
    setVisibility('hidden');
    expect(() => finish([tracked({ done: true, bytesMoved: 100 })])).not.toThrow();
  });
});

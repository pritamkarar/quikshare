import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSinkFactory, describeCapability, detectSaveCapability, resolvePageSave,
} from '../../client/save/select.js';
import { BLOB_SINK_MAX_BYTES } from '../../client/save/blob.js';
import { DOWNLOAD_CONTROL_TIMEOUT_MS } from '../../client/save/swstream.js';
import type { FileMeta } from '../../shared/messages.js';

const meta: FileMeta = { id: 1, name: 'report.pdf', size: 10, type: 'application/pdf' };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A `navigator.serviceWorker` that can be handed control on demand, so the
 * window between "registered" and "controlling" is testable.
 */
function fakeServiceWorkerContainer({ controlled = false } = {}) {
  const listeners = new Set<() => void>();
  const container = {
    controller: controlled ? {} : null,
    ready: Promise.resolve({ active: {} }),
    register: vi.fn(async () => ({ active: {} } as ServiceWorkerRegistration)),
    addEventListener: (_type: string, cb: () => void): void => { listeners.add(cb); },
    removeEventListener: (_type: string, cb: () => void): void => { listeners.delete(cb); },
    takeControl(): void {
      container.controller = {};
      for (const cb of [...listeners]) cb();
    },
  };
  return container;
}

/** Everything the service worker tier needs: a container, and a document to host its iframe. */
function installServiceWorkerBrowser(): void {
  vi.stubGlobal('navigator', { serviceWorker: {} });
  vi.stubGlobal('document', { createElement: () => ({}), body: { append: () => undefined } });
}

describe('detectSaveCapability', () => {
  it('prefers the service worker stream even when File System Access is also available', () => {
    installServiceWorkerBrowser();
    vi.stubGlobal('showSaveFilePicker', vi.fn());
    // Both tiers are available here. 'fs-access' looks more capable but
    // cannot actually be used: showSaveFilePicker needs a user gesture this
    // app never has (offers auto-accept, and sinks are opened lazily inside
    // a message handler), so 'sw-stream' has to win instead.
    expect(detectSaveCapability()).toBe('sw-stream');
  });

  it('chooses the service worker stream when it is the only tier available', () => {
    installServiceWorkerBrowser();
    expect(detectSaveCapability()).toBe('sw-stream');
  });

  it('falls back to File System Access when the service worker stream is unavailable', () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('showSaveFilePicker', vi.fn());
    expect(detectSaveCapability()).toBe('fs-access');
  });

  it('falls back to an in-memory blob as a last resort', () => {
    vi.stubGlobal('navigator', {});
    expect(detectSaveCapability()).toBe('blob');
  });

  it('does not claim the service worker tier when a stream cannot be transferred', () => {
    installServiceWorkerBrowser();
    vi.stubGlobal('MessageChannel', class {
      port1 = {
        postMessage: (): never => { throw new DOMException('could not be cloned', 'DataCloneError'); },
        close: (): void => undefined,
      };
      port2 = { close: (): void => undefined };
    });
    // Safari 15.0–16.3. Advertising 'sw-stream' here would tell the peer to
    // send a file this browser cannot save a byte of.
    expect(detectSaveCapability()).toBe('blob');
  });
});

describe('describeCapability', () => {
  it('reports no limit for disk-backed tiers', () => {
    expect(describeCapability('fs-access').limitBytes).toBeUndefined();
    expect(describeCapability('sw-stream').limitBytes).toBeUndefined();
  });

  it('reports the memory ceiling for the blob tier', () => {
    expect(describeCapability('blob').limitBytes).toBe(BLOB_SINK_MAX_BYTES);
  });

  it('gives every tier a human label', () => {
    for (const capability of ['fs-access', 'sw-stream', 'blob'] as const) {
      expect(describeCapability(capability).label.length).toBeGreaterThan(0);
    }
  });
});

describe('createSinkFactory', () => {
  it('builds an in-memory sink that enforces the blob ceiling', async () => {
    const sink = await createSinkFactory('blob')(meta);
    expect(() => sink.assertWithinCap(BLOB_SINK_MAX_BYTES)).not.toThrow();
    expect(() => sink.assertWithinCap(BLOB_SINK_MAX_BYTES + 1)).toThrow(/too large/i);
  });

  it('builds a File System Access sink from the picker', async () => {
    const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    const picker = vi.fn(async () => ({ createWritable: async () => writable }));
    vi.stubGlobal('showSaveFilePicker', picker);

    const sink = await createSinkFactory('fs-access')(meta);
    await sink.write(new Uint8Array([1]));
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'report.pdf' }));
    expect(writable.write).toHaveBeenCalled();
    // Disk-backed, so nothing this side can hold is too large for it.
    expect(() => sink.assertWithinCap(50 * 1024 ** 3)).not.toThrow();
  });

  it('refuses the service worker tier without a registration rather than saving nowhere', () => {
    // Thrown, not downgraded to a blob sink: this side has already told the
    // peer it can take a file of any size.
    expect(() => createSinkFactory('sw-stream')(meta)).toThrow(/not registered/);
  });

  it('builds a service worker sink from a registration', async () => {
    const posted: { port: MessagePort; token: string }[] = [];
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {
          postMessage: (message: { port: MessagePort; token: string }) => {
            posted.push(message);
            message.port.postMessage({ t: 'download-started', token: message.token });
          },
        },
      },
    });
    vi.stubGlobal('document', {
      createElement: () => ({ remove: () => undefined }),
      body: { append: () => undefined },
    });

    const registration = { active: {} } as unknown as ServiceWorkerRegistration;
    const sink = await createSinkFactory('sw-stream', registration)(meta);
    expect(posted).toHaveLength(1);
    expect(() => sink.assertWithinCap(50 * 1024 ** 3)).not.toThrow();
    await sink.abort('done with it');
  });
});

describe('resolvePageSave', () => {
  it('needs no setup for a tier that needs none', async () => {
    vi.stubGlobal('navigator', {});

    const save = await resolvePageSave();

    expect(save.capability).toBe('blob');
    expect(save.notice).toBeUndefined();
    expect(await save.createSink(meta)).toBeDefined();
  });

  it('registers the download helper before a transfer can need it', async () => {
    const container = fakeServiceWorkerContainer({ controlled: true });
    vi.stubGlobal('navigator', { serviceWorker: container });
    vi.stubGlobal('document', { createElement: () => ({}), body: { append: () => undefined } });

    // At startup rather than at the first transfer: a worker registered then
    // is active but not yet *controlling* the page, and only a controlling
    // worker intercepts the download.
    expect((await resolvePageSave()).capability).toBe('sw-stream');
    expect(container.register).toHaveBeenCalledTimes(1);
  });

  it('waits for the helper to take control before advertising the tier', async () => {
    const container = fakeServiceWorkerContainer();
    vi.stubGlobal('navigator', { serviceWorker: container });
    vi.stubGlobal('document', { createElement: () => ({}), body: { append: () => undefined } });

    const pending = resolvePageSave();
    // `clients.claim()` lands a moment after registration resolves.
    setTimeout(() => container.takeControl(), 0);

    expect((await pending).capability).toBe('sw-stream');
  });

  it('downgrades when the helper never takes control of the page', async () => {
    const container = fakeServiceWorkerContainer();
    vi.stubGlobal('navigator', { serviceWorker: container });
    vi.stubGlobal('document', { createElement: () => ({}), body: { append: () => undefined } });
    vi.useFakeTimers();

    try {
      const pending = resolvePageSave();
      await vi.advanceTimersByTimeAsync(DOWNLOAD_CONTROL_TIMEOUT_MS);
      const save = await pending;

      // Registered but not controlling saves nothing at all: the download
      // iframe would go to the network and 404. Advertising 'sw-stream' here
      // would promise the peer a ceiling this device does not have.
      expect(save.capability).toBe('blob');
      expect(save.notice).toMatch(/control/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('downgrades to memory, and says why, when the helper cannot be registered', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { register: () => Promise.reject(new Error('blocked by policy')) },
    });
    vi.stubGlobal('document', { createElement: () => ({}), body: { append: () => undefined } });

    const save = await resolvePageSave();

    // Downgraded here, strictly before the capability is advertised, so the
    // hello still describes what this device can really do — and the reason is
    // surfaced, because the size ceiling has just dropped enormously.
    expect(save.capability).toBe('blob');
    expect(save.notice).toMatch(/blocked by policy/);
  });
});

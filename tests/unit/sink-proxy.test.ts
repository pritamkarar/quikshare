import { describe, expect, it, vi } from 'vitest';
import { createSinkProxy } from '../../client/worker/sink-proxy.js';
import { createSinkHost } from '../../client/worker/sink-host.js';
import { createSinkFactory } from '../../client/save/select.js';
import { BLOB_SINK_MAX_BYTES } from '../../client/save/blob.js';
import type { SinkFactory } from '../../client/save/select.js';
import type { SaveSink } from '../../client/save/types.js';
import type { FileMeta, SaveCapability } from '../../shared/messages.js';
import type { FromWorker } from '../../client/worker/messages.js';

const meta: FileMeta = { id: 7, name: 'report.pdf', size: 6, type: 'application/pdf' };

/** Drains the microtask queue and any zero-delay timers the wire uses. */
const settleAll = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Wire {
  /** The worker half: what `Session` is handed as its sink factory. */
  createSink: SinkFactory;
  rejectAll(reason: string): void;
  /** The page half. */
  abortAll(reason: string): void;
  /** Every request the worker posted, with the transfer list it posted it with. */
  sent: { msg: FromWorker; transfer: Transferable[] }[];
}

/**
 * Wires a worker-side proxy to a page-side host across an asynchronous
 * boundary, the way `postMessage` would. Delivery is deferred on both sides so
 * nothing can accidentally resolve synchronously and pass a test that a real
 * worker boundary would fail.
 */
function connect(factory: SinkFactory, capability: SaveCapability = 'blob'): Wire {
  const sent: { msg: FromWorker; transfer: Transferable[] }[] = [];

  const proxy = createSinkProxy(capability, (msg, transfer = []) => {
    sent.push({ msg, transfer });
    setTimeout(() => host.handle(msg), 0);
  });

  const host = createSinkHost({
    factory,
    post: (msg) => { setTimeout(() => proxy.settle(msg), 0); },
  });

  return { createSink: proxy.createSink, rejectAll: proxy.rejectAll, abortAll: host.abortAll, sent };
}

/** A sink whose every operation is observable and individually controllable. */
function fakeSink(over: Partial<SaveSink> = {}): SaveSink & { written: Uint8Array[]; aborted: string[] } {
  const written: Uint8Array[] = [];
  const aborted: string[] = [];
  return {
    written,
    aborted,
    assertWithinCap: (): void => undefined,
    async write(chunk: Uint8Array): Promise<void> { written.push(chunk); },
    async close(): Promise<Blob | undefined> { return undefined; },
    async abort(reason: string): Promise<void> { aborted.push(reason); },
    ...over,
  };
}

describe('sink proxy', () => {
  it('builds the page-side sink for the offered file', async () => {
    const sink = fakeSink();
    const factory = vi.fn(() => sink);
    const wire = connect(factory);

    await wire.createSink(meta);

    expect(factory).toHaveBeenCalledWith(meta);
  });

  it('rejects the factory when the page cannot build a sink', async () => {
    // A cancelled Save-As dialog. The receiver turns this into a per-file
    // failure; swallowing it would leave the file silently unsaved.
    const wire = connect(() => { throw new Error('The user cancelled the save dialog.'); });

    await expect(wire.createSink(meta)).rejects.toThrow(/cancelled the save dialog/);
  });

  /**
   * The single most important property of the proxy. Without it the receiver's
   * `await` returns before the bytes reach the disk, backpressure is lost, and
   * the receive loop outruns the sink — putting back exactly the memory the
   * disk-backed tiers exist to bound.
   */
  it('does not resolve a write until the page-side write has resolved', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sink = fakeSink({
      async write(chunk: Uint8Array): Promise<void> {
        sink.written.push(chunk);
        await blocked;
      },
    });
    const wire = connect(() => sink);
    const proxied = await wire.createSink(meta);

    let resolved = false;
    const write = proxied.write(new Uint8Array([1, 2, 3])).then(() => { resolved = true; });

    // Twice, deliberately. One tick only gets the request to the page; a page
    // that acked *before* awaiting its real write would post that ack on the
    // next tick, so a single tick would read `resolved === false` either way
    // and the assertion below would prove nothing about the page's half.
    await settleAll();
    await settleAll();
    // The chunk reached the page…
    expect(sink.written).toHaveLength(1);
    // …but the worker is still waiting on it.
    expect(resolved).toBe(false);

    release();
    await write;
    expect(resolved).toBe(true);
  });

  it('surfaces a page-side write failure as a rejected proxy write', async () => {
    const sink = fakeSink({
      write: (): Promise<void> => Promise.reject(new Error('The disk is full.')),
    });
    const wire = connect(() => sink);
    const proxied = await wire.createSink(meta);

    // The receiver's #failFile path depends on this rejection. Swallowed, the
    // file would simply stop with no error and then "complete" with a hole.
    await expect(proxied.write(new Uint8Array([1]))).rejects.toThrow(/disk is full/);
  });

  it('returns the blob the page-side sink produced on close', async () => {
    const wire = connect(createSinkFactory('blob'));
    const proxied = await wire.createSink(meta);

    await proxied.write(new Uint8Array([104, 101, 108]));
    await proxied.write(new Uint8Array([108, 111, 33]));
    const blob = await proxied.close();

    expect(blob).toBeInstanceOf(Blob);
    expect(await blob!.text()).toBe('hello!');
  });

  it('returns undefined on close for a disk-backed sink that produces no blob', async () => {
    const wire = connect(() => fakeSink(), 'fs-access');
    const proxied = await wire.createSink(meta);

    expect(await proxied.close()).toBeUndefined();
  });

  it('aborts the page-side sink with the reason it was given', async () => {
    const sink = fakeSink();
    const wire = connect(() => sink);
    const proxied = await wire.createSink(meta);

    await proxied.abort('it failed its integrity check');

    expect(sink.aborted).toEqual(['it failed its integrity check']);
  });

  it('hands the plaintext over as a transferable buffer rather than a copy', async () => {
    const wire = connect(() => fakeSink());
    const proxied = await wire.createSink(meta);
    const chunk = new Uint8Array([1, 2, 3, 4]);

    await proxied.write(chunk);

    const write = wire.sent.find((s) => s.msg.t === 'sink-write');
    expect(write?.transfer).toEqual([chunk.buffer]);
  });

  /**
   * `describeCapability` answers the tier's ceiling with no sink instance,
   * which is exactly why the ceiling check needs no round trip. Making it
   * async would widen the SaveSink interface for nothing.
   */
  it('answers assertWithinCap synchronously, without a round trip', async () => {
    const wire = connect(createSinkFactory('blob'));
    const proxied = await wire.createSink(meta);
    const before = wire.sent.length;

    expect(() => proxied.assertWithinCap(BLOB_SINK_MAX_BYTES + 1)).toThrow(/in-memory limit/);
    expect(() => proxied.assertWithinCap(BLOB_SINK_MAX_BYTES)).not.toThrow();

    expect(wire.sent).toHaveLength(before);
  });

  it('imposes no ceiling for a disk-backed tier', async () => {
    const wire = connect(() => fakeSink(), 'fs-access');
    const proxied = await wire.createSink(meta);

    expect(() => proxied.assertWithinCap(8 * 1024 ** 4)).not.toThrow();
  });

  it('fails a write for a sink the page no longer holds, rather than hanging', async () => {
    const wire = connect(() => fakeSink());
    const proxied = await wire.createSink(meta);
    await proxied.close();

    await expect(proxied.write(new Uint8Array([1]))).rejects.toThrow(/no sink/i);
  });

  it('fails every in-flight request when the worker session goes away', async () => {
    const sink = fakeSink({ write: () => new Promise<void>(() => undefined) });
    const wire = connect(() => sink);
    const proxied = await wire.createSink(meta);

    const write = proxied.write(new Uint8Array([1]));
    wire.rejectAll('session closed');

    await expect(write).rejects.toThrow(/session closed/);
  });

  /**
   * The worker routes every `sink-result` to whichever proxy is current, so a
   * result still in flight from a retired session arrives at the live one. If
   * ids restarted per proxy, that stale answer would settle the live request
   * that happens to share its id — and for a `sink-write` that means a write
   * acked before its bytes ever reached the page: backpressure silently gone,
   * and a chunk counted as landed that never did.
   */
  it("never settles a live request with a retired session's answer", async () => {
    const retiredSent: FromWorker[] = [];
    const retired = createSinkProxy('blob', (msg) => retiredSent.push(msg));
    const abandoned = retired.createSink(meta);
    const staleId = (retiredSent[0] as { id: number }).id;
    retired.rejectAll('the session was restarted');
    await expect(abandoned).rejects.toThrow(/restarted/);

    const liveSent: FromWorker[] = [];
    const live = createSinkProxy('blob', (msg) => liveSent.push(msg));
    let settled = false;
    const opening = Promise.resolve(live.createSink(meta))
      .then(() => { settled = true; }, () => { settled = true; });
    const liveId = (liveSent[0] as { id: number }).id;

    // The page's answer to the *retired* session's request, arriving late.
    live.settle({ t: 'sink-result', id: staleId, ok: true });
    await settleAll();

    expect(liveId).not.toBe(staleId);
    expect(settled).toBe(false);

    live.settle({ t: 'sink-result', id: liveId, ok: true });
    await opening;
    expect(settled).toBe(true);
  });
});

describe('sink host teardown', () => {
  /**
   * Dropping the page's half of the proxy without aborting leaves a
   * FileSystemWritableFileStream open and a partial file on disk. The page
   * cannot wait for the worker to ask: the worker is terminated at the same
   * moment.
   */
  it('aborts sinks still open on the page', async () => {
    const sink = fakeSink();
    const wire = connect(() => sink);
    await wire.createSink(meta);

    wire.abortAll('the session was closed');
    await settleAll();

    expect(sink.aborted).toEqual(['the session was closed']);
  });

  it('aborts every open sink, not just the first', async () => {
    const sinks = [fakeSink(), fakeSink()];
    let next = 0;
    const wire = connect(() => sinks[next++]!);
    await wire.createSink({ ...meta, id: 1 });
    await wire.createSink({ ...meta, id: 2 });

    wire.abortAll('the session was closed');
    await settleAll();

    expect(sinks.map((s) => s.aborted)).toEqual([['the session was closed'], ['the session was closed']]);
  });

  it('refuses to open a new sink after teardown', async () => {
    const wire = connect(() => fakeSink());
    wire.abortAll('the session was closed');

    await expect(wire.createSink(meta)).rejects.toThrow(/closed/i);
  });

  it('releases a sink whose build finished after teardown', async () => {
    const sink = fakeSink();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const wire = connect(async () => { await slow; return sink; });

    const building = wire.createSink(meta);
    // The request has reached the page and the factory is already running —
    // a Save-As dialog waiting on the user — when teardown lands.
    await settleAll();
    wire.abortAll('the session was closed');
    release();

    // The Save-As dialog resolved into a session that no longer exists: the
    // handle it opened must be released rather than leaked.
    await expect(building).rejects.toThrow(/closed/i);
    await settleAll();
    expect(sink.aborted).toEqual(['the session was closed']);
  });
});

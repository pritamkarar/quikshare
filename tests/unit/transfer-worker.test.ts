import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWorker, ToWorker } from '../../client/worker/messages.js';
import type { SessionOptions } from '../../client/session.js';
import type { SaveCapability } from '../../shared/messages.js';

/**
 * The worker's job at this level is wiring, not transport: which options it
 * builds a Session with, and how it routes the page's sink answers back to the
 * proxy. A stand-in Session keeps all of that observable without a relay.
 */
interface CapturedSession {
  sendText(content: string): Promise<void>;
}

const captured: { options: SessionOptions | undefined; session: CapturedSession | undefined } = { options: undefined, session: undefined };

vi.mock('../../client/session.js', () => {
  class FakeSession {
    readonly code = 'K7M3QP';
    readonly peerId = 'a' as const;
    readonly shareUrl = 'https://quik.share/s/K7M3QP#key';
    readonly events: Record<string, unknown> = {};
    closed = false;
    async sendText(content: string): Promise<void> {
      // Default implementation; tests may override
    }
    static async create(_wsUrl: string, options: SessionOptions): Promise<FakeSession> {
      captured.options = options;
      const instance = new FakeSession();
      captured.session = instance;
      return instance;
    }
    static async join(_wsUrl: string, _code: string, _key: string, options: SessionOptions): Promise<FakeSession> {
      captured.options = options;
      const instance = new FakeSession();
      captured.session = instance;
      return instance;
    }
    close(): void { this.closed = true; }
  }
  return { Session: FakeSession };
});

/** Real-time polling: the worker handles every message in an async IIFE. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Sent {
  msg: FromWorker;
  transfer: Transferable[];
}

interface FakeScope {
  handlers: Map<string, (event: unknown) => void>;
  sent: Sent[];
  posted: FromWorker[];
  addEventListener(type: string, handler: (event: unknown) => void): void;
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
}

function fakeScope(): FakeScope {
  const handlers = new Map<string, (event: unknown) => void>();
  const sent: Sent[] = [];
  return {
    handlers,
    sent,
    get posted(): FromWorker[] { return sent.map((s) => s.msg); },
    addEventListener(type, handler): void { handlers.set(type, handler); },
    postMessage(msg, transfer = []): void { sent.push({ msg, transfer }); },
  };
}

describe('transfer worker', () => {
  const scope = fakeScope();

  beforeAll(async () => {
    // The worker registers its message listener on `self` at import time, so
    // the fake global scope has to be in place before the module is evaluated.
    vi.stubGlobal('self', scope);
    await import('../../client/worker/transfer-worker.js');
  });

  beforeEach(() => {
    vi.stubGlobal('self', scope);
    scope.sent.length = 0;
    captured.options = undefined;
    // The worker module is imported once, in beforeAll, so its module-scoped
    // session survives from one test to the next — and a test that inherits a
    // live session from its predecessor can pass while proving nothing about
    // the branch it names. That has already happened once in this branch (a
    // send-with-no-session test that was green because a previous test had
    // left a session behind). Resetting `options` alone left the more
    // dangerous half of that state in place.
    captured.session = undefined;
  });

  function send(msg: ToWorker): void {
    const handler = scope.handlers.get('message');
    if (!handler) throw new Error('the worker registered no message handler');
    handler({ data: msg });
  }

  async function init(saveCapability: SaveCapability, forceTransport?: 'relay'): Promise<void> {
    send({ t: 'init', wsUrl: 'ws://relay.invalid/ws', intent: { t: 'create' }, saveCapability, forceTransport });
    await waitFor(() => scope.posted.some((m) => m.t === 'ready'));
  }

  /**
   * `Session` runs inside this worker, and a worker's own `location.href` is
   * the worker SCRIPT's URL, not the page's — so the forceTransport escape
   * hatch can only reach Session if this worker forwards it from the 'init'
   * message it was handed, rather than trying to read it itself.
   */
  it('forwards forceTransport from the init message to the session options', async () => {
    await init('blob', 'relay');
    expect(captured.options?.forceTransport).toBe('relay');
  });

  it('does not force the relay when the init message omits it', async () => {
    await init('blob');
    expect(captured.options?.forceTransport).toBeUndefined();
  });

  /**
   * The worker cannot ask `RTCPeerConnection` whether it exists here — it
   * doesn't, it's [Exposed=Window] — so `SessionOptions.webrtc.available`
   * has to be exactly the page's answer, carried in on 'init'. Asserted both
   * ways: a hardcoded `true` or `false` inside the worker would pass one of
   * these and fail the other.
   */
  it("passes the page's webrtc availability into the session options", async () => {
    send({
      t: 'init', wsUrl: 'ws://relay.invalid/ws', intent: { t: 'create' },
      saveCapability: 'blob', webrtcAvailable: true,
    });
    await waitFor(() => scope.posted.some((m) => m.t === 'ready'));
    expect(captured.options?.webrtc?.available).toBe(true);
  });

  it('defaults webrtc availability to false when the init message omits it', async () => {
    await init('blob');
    expect(captured.options?.webrtc?.available).toBe(false);
  });

  /**
   * The worker's message switch has no explicit case for any `peer-*` reply
   * — they are caught by the trailing `default:` arm, which hands them to
   * the peer proxy. Proven end to end here rather than by unit-testing
   * `createPeerProxy` again (already covered in tests/unit/peer-proxy.test.ts):
   * what this file owns is that the worker's own routing reaches it at all.
   * Deleting the `default:` arm leaves this test hanging until its own
   * timeout, rather than merely reading a wrong value.
   */
  it("routes a page-originated peer-message into the transport this worker's Session was handed", async () => {
    await init('blob', undefined);
    const transport = captured.options!.webrtc!.createTransport(true, () => undefined);
    const received: Uint8Array[] = [];
    transport.onMessage((frame) => received.push(frame));

    await waitFor(() => scope.posted.some((m) => m.t === 'peer-open'));
    const opened = scope.posted.find((m) => m.t === 'peer-open') as Extract<FromWorker, { t: 'peer-open' }>;

    send({ t: 'peer-message', id: opened.id, frame: new Uint8Array([7]) });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(new Uint8Array([7]));
  });

  /**
   * A dedicated worker has no `showSaveFilePicker` and no document, so it
   * cannot build either disk-backed sink itself — but it no longer has to.
   * The sink lives on the page and this worker writes through a proxy, so a
   * disk-backed tier is accepted rather than refused.
   */
  it('accepts a disk-backed tier and advertises it unchanged', async () => {
    await init('fs-access');

    expect(scope.posted.some((m) => m.t === 'error')).toBe(false);
    // Never quietly downgraded: the hello advertises this to the peer, and a
    // silent downgrade is exactly the lie the capability handshake prevents.
    expect(captured.options?.saveCapability).toBe('fs-access');
  });

  it('gives the session a sink factory that runs on the page', async () => {
    await init('fs-access');

    expect(captured.options?.createSink).toBeTypeOf('function');
  });

  it('asks the page to open a sink and resolves when the page answers', async () => {
    await init('fs-access');
    const meta = { id: 1, name: 'report.pdf', size: 4, type: 'application/pdf' };

    const building = captured.options!.createSink!(meta);
    await waitFor(() => scope.posted.some((m) => m.t === 'sink-open'));
    const open = scope.posted.find((m) => m.t === 'sink-open')!;
    expect(open).toMatchObject({ fileId: 1, meta });

    send({ t: 'sink-result', id: (open as { id: number }).id, ok: true });
    const sink = await building;

    // The tier's own ceiling, with no round trip: a disk-backed tier has none.
    expect(() => sink.assertWithinCap(8 * 1024 ** 4)).not.toThrow();
  });

  it('transfers the plaintext to the page rather than copying it', async () => {
    await init('fs-access');
    const sink = await (async () => {
      const building = captured.options!.createSink!({ id: 1, name: 'a.bin', size: 2, type: '' });
      await waitFor(() => scope.posted.some((m) => m.t === 'sink-open'));
      send({ t: 'sink-result', id: (scope.posted.find((m) => m.t === 'sink-open') as { id: number }).id, ok: true });
      return building;
    })();

    const chunk = new Uint8Array([1, 2]);
    const write = sink.write(chunk);
    await waitFor(() => scope.sent.some((s) => s.msg.t === 'sink-write'));

    const sent = scope.sent.find((s) => s.msg.t === 'sink-write')!;
    expect(sent.transfer).toEqual([chunk.buffer]);
    send({ t: 'sink-result', id: (sent.msg as { id: number }).id, ok: true });
    await expect(write).resolves.toBeUndefined();
  });

  it('fails a sink request still in flight when the session closes', async () => {
    await init('blob');
    const building = captured.options!.createSink!({ id: 1, name: 'a.bin', size: 2, type: '' });
    await waitFor(() => scope.posted.some((m) => m.t === 'sink-open'));

    send({ t: 'close' });

    // Otherwise it would await an answer from a page that has, in all
    // likelihood, already terminated this worker.
    await expect(building).rejects.toThrow(/closed/i);
  });

  it('reports a sent note only once it is actually on the wire', async () => {
    // Mirrors how file sends are reported: the row appears because the worker
    // says the bytes went, never because the user pressed a button. A note
    // that failed to seal must not leave a "Sent" row behind claiming it did.
    await init('blob');
    scope.sent.length = 0;

    send({ t: 'send-text', content: 'hello' });

    await waitFor(() => scope.posted.some((s) => s.t === 'text-sent'));
    expect(scope.sent.map((s) => s.msg.t)).toContain('text-sent');
    expect(scope.sent.find((s) => s.msg.t === 'text-sent')?.msg)
      .toMatchObject({ content: 'hello' });
  });

  it('reports no sent note when the send rejects', async () => {
    await init('blob');
    captured.session!.sendText = () => Promise.reject(new Error('peer-left'));
    scope.sent.length = 0;

    send({ t: 'send-text', content: 'hello' });

    await waitFor(() => scope.posted.some((s) => s.t === 'error'));
    expect(scope.sent.map((s) => s.msg.t)).not.toContain('text-sent');
    // The failure still surfaces the way every other worker failure does.
    expect(scope.sent.map((s) => s.msg.t)).toContain('error');
  });

  it('reports no sent note when no session is established', async () => {
    // A Send click racing "End session" makes the worker silently do nothing
    // — but must not claim a note went out. Optional chaining in the send-text
    // case would short-circuit without throwing, leaving the post to run
    // unconditionally and falsely claim success. Without the early return guard,
    // session?.sendText(...) is undefined, so it does nothing and execution
    // falls straight through to post({t:'text-sent'}), which must be prevented.
    await init('blob');
    send({ t: 'close' });
    scope.sent.length = 0;

    send({ t: 'send-text', content: 'hello' });

    // The worker must do nothing at all — neither post text-sent nor error.
    // Pinning the silent behaviour guards against later "helpfully" adding
    // an error report for this case, which would be a behaviour change.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scope.sent.map((s) => s.msg.t)).not.toContain('text-sent');
    expect(scope.sent.map((s) => s.msg.t)).not.toContain('error');
  });
});

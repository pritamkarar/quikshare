import {
  afterEach, beforeEach, describe, expect, it, vi, type MockInstance,
} from 'vitest';
import { MAX_ATTEMPTS, computeBackoff, Reconnector } from '../../client/transport/reconnect.js';
import { RelayTransport, type RelayConnection } from '../../client/transport/relay.js';

describe('computeBackoff', () => {
  it('starts small', () => {
    expect(computeBackoff(0, { jitter: 0 })).toBeLessThanOrEqual(500);
  });

  it('grows exponentially', () => {
    const a = computeBackoff(1, { jitter: 0 });
    const b = computeBackoff(2, { jitter: 0 });
    expect(b).toBeGreaterThan(a);
  });

  // Discriminates exponential growth from a linear-growth mutant (e.g.
  // BASE * (attempt + 1)): with jitter pinned to zero the ratio between two
  // attempts two apart must be exactly 4x (2^2), which only the exponential
  // formula produces exactly.
  it('quadruples two attempts apart, not merely "more"', () => {
    const first = computeBackoff(0, { jitter: 0 });
    const third = computeBackoff(2, { jitter: 0 });
    expect(third).toBe(first * 4);
  });

  it('caps so it never waits absurdly long', () => {
    expect(computeBackoff(50, { jitter: 0 })).toBeLessThanOrEqual(30_000);
  });

  it('adds jitter so reconnecting peers do not synchronize', () => {
    const values = new Set(Array.from({ length: 20 }, () => computeBackoff(3)));
    expect(values.size).toBeGreaterThan(1);
  });

  // The test above alone would also pass for a broken implementation that
  // ignores `opts.jitter` and always injects randomness. Pinning jitter to
  // zero and requiring a single, stable value closes that gap: a mutant that
  // drops the `opts.jitter ?? 0.3` short-circuit (always randomizing) fails
  // this, while a correct implementation collapses to one exact number.
  it('is exactly reproducible once jitter is pinned to zero', () => {
    const values = new Set(Array.from({ length: 20 }, () => computeBackoff(3, { jitter: 0 })));
    expect(values.size).toBe(1);
  });

  it('never returns a negative delay', () => {
    for (let i = 0; i < 20; i++) expect(computeBackoff(i)).toBeGreaterThanOrEqual(0);
  });

  it('gives up after a bounded number of attempts', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(3);
    expect(MAX_ATTEMPTS).toBeLessThan(20);
  });
});

/** A minimal stand-in for a resolved RelayTransport.connect() result. */
function fakeConnection(): RelayConnection {
  return {
    transport: { close: vi.fn() } as unknown as RelayConnection['transport'],
    code: 'K7M3QP',
    peerId: 'b',
    peerPresent: true,
  };
}

describe('Reconnector', () => {
  let connect: MockInstance<typeof RelayTransport.connect>;

  beforeEach(() => {
    vi.useFakeTimers();
    connect = vi.spyOn(RelayTransport, 'connect');
  });

  afterEach(() => {
    connect.mockRestore();
    vi.useRealTimers();
  });

  it('rejoins the same room, never re-creates it', async () => {
    const conn = fakeConnection();
    connect.mockResolvedValue(conn);
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    const onReconnected = vi.fn();
    reconnector.onReconnected(onReconnected);

    reconnector.start();
    await vi.runOnlyPendingTimersAsync();

    expect(connect).toHaveBeenCalledWith('ws://x/ws', { t: 'join', code: 'K7M3QP' });
    expect(onReconnected).toHaveBeenCalledWith(conn);
  });

  it('retries a genuine network failure and reconnects once the relay answers', async () => {
    const conn = fakeConnection();
    connect
      .mockRejectedValueOnce(new Error('websocket error'))
      .mockResolvedValueOnce(conn);
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    const onReconnected = vi.fn();
    const onGaveUp = vi.fn();
    reconnector.onReconnected(onReconnected);
    reconnector.onGaveUp(onGaveUp);

    reconnector.start();
    await vi.runAllTimersAsync();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(onReconnected).toHaveBeenCalledWith(conn);
    expect(onGaveUp).not.toHaveBeenCalled();
  });

  it('gives up after MAX_ATTEMPTS network failures without ever reconnecting', async () => {
    connect.mockRejectedValue(new Error('websocket error'));
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    const onReconnected = vi.fn();
    const onGaveUp = vi.fn();
    const onRoomGone = vi.fn();
    reconnector.onReconnected(onReconnected);
    reconnector.onGaveUp(onGaveUp);
    reconnector.onRoomGone(onRoomGone);

    reconnector.start();
    await vi.runAllTimersAsync();

    expect(connect).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
    expect(onReconnected).not.toHaveBeenCalled();
    expect(onRoomGone).not.toHaveBeenCalled();
  });

  // Ruling A: 'not-found' means the room itself is gone. Retrying cannot ever
  // succeed, and it is a different user story from "we gave up trying" — so
  // it gets its own callback rather than being folded into onGaveUp.
  it('routes not-found to onRoomGone, and does not retry', async () => {
    connect.mockRejectedValue(new Error('not-found'));
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    const onGaveUp = vi.fn();
    const onRoomGone = vi.fn();
    reconnector.onGaveUp(onGaveUp);
    reconnector.onRoomGone(onRoomGone);

    reconnector.start();
    await vi.runAllTimersAsync();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(onRoomGone).toHaveBeenCalledTimes(1);
    expect(onGaveUp).not.toHaveBeenCalled();
  });

  // Ruling A: 'full' and 'bad-request' cannot be fixed by repetition either,
  // and 'rate-limited' is actively harmful to retry — the server is asking
  // us to stop. All three are terminal, distinct from the room-gone case.
  it.each(['full', 'bad-request', 'rate-limited'])(
    'treats %s as terminal and gives up without retrying',
    async (reason) => {
      connect.mockRejectedValue(new Error(reason));
      const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
      const onGaveUp = vi.fn();
      const onRoomGone = vi.fn();
      reconnector.onGaveUp(onGaveUp);
      reconnector.onRoomGone(onRoomGone);

      reconnector.start();
      await vi.runAllTimersAsync();

      expect(connect).toHaveBeenCalledTimes(1);
      expect(onGaveUp).toHaveBeenCalledTimes(1);
      expect(onRoomGone).not.toHaveBeenCalled();
    },
  );

  it('stop() cancels a pending timer before it ever calls connect', async () => {
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    reconnector.start();
    reconnector.stop();

    await vi.runAllTimersAsync();

    expect(connect).not.toHaveBeenCalled();
  });

  // Ruling B: stop() only clears a pending *timer*. If RelayTransport.connect
  // is already in flight, its .then/.catch still runs — a naive stop() would
  // let that resurrect a session the user deliberately ended, and leak the
  // socket it opened. Both continuations must check #stopped and close
  // anything that arrives late.
  it('does not resurrect the session if stop() lands while connect is in flight (success)', async () => {
    let resolveConnect!: (conn: RelayConnection) => void;
    connect.mockReturnValue(new Promise<RelayConnection>((resolve) => { resolveConnect = resolve; }));
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    const onReconnected = vi.fn();
    reconnector.onReconnected(onReconnected);

    reconnector.start();
    // Advance exactly to the point where the timer fires and connect() is
    // called, but do not let its promise settle yet.
    await vi.runOnlyPendingTimersAsync();
    expect(connect).toHaveBeenCalledTimes(1);

    reconnector.stop();
    const conn = fakeConnection();
    resolveConnect(conn);
    await vi.waitFor(() => expect(conn.transport.close).toHaveBeenCalled());

    expect(onReconnected).not.toHaveBeenCalled();
  });

  it('does not retry or give up if stop() lands while connect is in flight (failure)', async () => {
    let rejectConnect!: (error: unknown) => void;
    connect.mockReturnValue(new Promise<RelayConnection>((_resolve, reject) => { rejectConnect = reject; }));
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    const onGaveUp = vi.fn();
    reconnector.onGaveUp(onGaveUp);

    reconnector.start();
    await vi.runOnlyPendingTimersAsync();
    expect(connect).toHaveBeenCalledTimes(1);

    reconnector.stop();
    rejectConnect(new Error('websocket error'));
    // Let the rejection's microtask run.
    await Promise.resolve().then(() => Promise.resolve());
    await vi.runAllTimersAsync();

    // A stopped reconnector must neither schedule another attempt nor
    // report giving up — it was told to go away, not that it failed.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onGaveUp).not.toHaveBeenCalled();
  });

  // Carried in from Task 5: start() while a timer from a previous start() is
  // still pending used to overwrite #timer without clearing it, leaking a
  // setTimeout that still fires later and schedules its own, now-duplicate,
  // attempt. One Reconnector is meant to serve one disconnect episode, so a
  // caller that (by bug or by design) calls start() twice should get exactly
  // one attempt in flight, not two racing each other.
  it('does not leak a duplicate timer if start() is called again while one is already pending', async () => {
    const conn = fakeConnection();
    connect.mockResolvedValue(conn);
    const reconnector = new Reconnector('ws://x/ws', 'K7M3QP');
    const onReconnected = vi.fn();
    reconnector.onReconnected(onReconnected);

    reconnector.start();
    expect(vi.getTimerCount()).toBe(1);
    reconnector.start();
    // The decisive check: a leaked first timer would leave two pending here,
    // and — since start() also resets #attempt to 0 — the leaked one would
    // schedule its own extra connect() attempt when it fires.
    expect(vi.getTimerCount()).toBe(1);

    await vi.runAllTimersAsync();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });
});

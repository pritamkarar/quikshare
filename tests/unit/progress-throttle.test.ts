import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressThrottle } from '../../client/worker/client.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createProgressThrottle', () => {
  it('emits the first report immediately', () => {
    const emit = vi.fn();
    createProgressThrottle(200, emit).report({ fileId: 1, bytesMoved: 10, totalBytes: 100 });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst into one emission per interval', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    for (let i = 0; i < 1000; i++) throttle.report({ fileId: 1, bytesMoved: i, totalBytes: 1000 });
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('emits the latest value, not a stale one', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 100 });
    throttle.report({ fileId: 1, bytesMoved: 50, totalBytes: 100 });
    vi.advanceTimersByTime(200);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ bytesMoved: 50 }));
  });

  it('throttles each file independently', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 10 });
    throttle.report({ fileId: 2, bytesMoved: 1, totalBytes: 10 });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('computes a transfer rate from elapsed time', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 0, totalBytes: 1000 });
    vi.advanceTimersByTime(1000);
    throttle.report({ fileId: 1, bytesMoved: 500, totalBytes: 1000 });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ bytesPerSecond: expect.any(Number) }));
    const last = emit.mock.calls.at(-1)![0] as { bytesPerSecond: number };
    expect(last.bytesPerSecond).toBeGreaterThan(0);
  });

  it('flush emits any pending value straight away', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 10 });
    throttle.report({ fileId: 1, bytesMoved: 9, totalBytes: 10 });
    throttle.flush(1);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ bytesMoved: 9 }));
  });

  // Fix round 1, Important 1: the leading edge must be gated on real elapsed
  // time, not merely on "no cooldown timer currently running" — otherwise the
  // report that lands the instant a trailing emission fires is wrongly
  // treated as a fresh leading edge, producing three emissions inside one
  // interval and a spiky near-instantaneous rate.
  it('does not double-emit at the throttle boundary under continuous reporting', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(50, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 100 }); // t=0, leading edge
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10); // t=10
    throttle.report({ fileId: 1, bytesMoved: 50, totalBytes: 100 }); // buffered
    vi.advanceTimersByTime(40); // t=50, trailing timer fires
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1); // t=51
    throttle.report({ fileId: 1, bytesMoved: 51, totalBytes: 100 }); // must NOT be a fresh leading edge
    expect(emit).toHaveBeenCalledTimes(2);
  });

  // Fix round 1, Important 3: throttle state must not survive a reset —
  // otherwise a stale lastEmitAt/lastEmitBytes baseline from a previous
  // session corrupts the first rate computed for a reused file id (ids
  // restart at 1 per session).
  it('reset clears cooldown state so the next report is a fresh leading edge', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 100 }); // leading edge
    throttle.report({ fileId: 1, bytesMoved: 50, totalBytes: 100 }); // buffered against the old baseline
    throttle.reset();
    emit.mockClear();
    throttle.report({ fileId: 1, bytesMoved: 5, totalBytes: 100 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ bytesMoved: 5 }));
  });

  it('a pending timer cannot fire after reset', () => {
    const emit = vi.fn();
    const throttle = createProgressThrottle(200, emit);
    throttle.report({ fileId: 1, bytesMoved: 1, totalBytes: 100 }); // leading edge, call 1
    throttle.report({ fileId: 1, bytesMoved: 50, totalBytes: 100 }); // buffered, trailing timer scheduled
    throttle.reset();
    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

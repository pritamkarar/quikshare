import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../server/rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to capacity immediately', () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerMs: 0, now: () => 0 });
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });

  it('tracks each key separately', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerMs: 0, now: () => 0 });
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });

  it('refills over time', () => {
    let clock = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerMs: 1 / 1000, now: () => clock });
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
    clock = 1000;
    expect(limiter.tryConsume('ip')).toBe(true);
  });

  it('never refills beyond capacity', () => {
    let clock = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1, now: () => clock });
    clock = 1_000_000;
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });

  it('sweeps buckets that have been idle', () => {
    let clock = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerMs: 0, now: () => clock });
    limiter.tryConsume('ip');
    clock = 60_000;
    limiter.sweep(30_000);
    expect(limiter.tryConsume('ip')).toBe(true);
  });

  it('denies everything at zero capacity', () => {
    const limiter = new RateLimiter({ capacity: 0, refillPerMs: 0, now: () => 0 });
    expect(limiter.tryConsume('ip')).toBe(false);
  });
});

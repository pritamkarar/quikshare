interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterOptions {
  capacity: number;
  /** Tokens restored per millisecond. 0 means no refill. */
  refillPerMs: number;
  now?: () => number;
}

/**
 * A per-key token bucket. Each key (e.g. a client IP) gets its own bucket
 * that starts full and refills over time, up to capacity.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.#capacity = opts.capacity;
    this.#refillPerMs = opts.refillPerMs;
    this.#now = opts.now ?? Date.now;
  }

  tryConsume(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, lastRefill: now };

    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerMs);
    bucket.lastRefill = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    this.#buckets.set(key, bucket);
    return allowed;
  }

  /** Drops buckets untouched for longer than idleMs so the map cannot grow without bound. */
  sweep(idleMs: number): void {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.lastRefill >= idleMs) this.#buckets.delete(key);
    }
  }
}

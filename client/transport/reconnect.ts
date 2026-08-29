import { RelayTransport, type RelayConnection } from './relay.js';

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 30_000;

/**
 * The relay's four documented refusals (shared/signals.ts). All four are
 * terminal — none of them becomes true by repeating the request:
 * 'not-found' means the room is gone, 'bad-request' means the frame itself
 * was malformed, 'full' means both seats are already taken, and
 * 'rate-limited' is the one case where retrying is actively harmful — the
 * server is explicitly asking this client to stop, and backing off into it
 * anyway makes things worse for every client sharing that limit.
 *
 * Only genuine network/socket failures (a closed connection, a WebSocket
 * error) are retried — anything the relay actively refused is not.
 */
const REFUSAL_REASONS = new Set(['not-found', 'full', 'bad-request', 'rate-limited']);

/** The refusal reason if `error` is one of the relay's four, else undefined. */
function refusalReason(error: unknown): string | undefined {
  return error instanceof Error && REFUSAL_REASONS.has(error.message) ? error.message : undefined;
}

/**
 * Exponential backoff with jitter, in milliseconds. `opts.jitter` is a
 * fraction (default 0.3) of the exponential delay to randomize by — pass 0
 * for a deterministic value, which every caller other than the reconnect
 * loop itself wants (tests, mainly).
 */
export function computeBackoff(attempt: number, opts: { jitter?: number } = {}): number {
  const jitterFactor = opts.jitter ?? 0.3;
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  // Centered jitter: spreads the delay across
  // [exponential * (1 - jitterFactor/2), exponential * (1 + jitterFactor/2)]
  // so two peers backing off from the same failure do not retry in lockstep
  // and collide again on the next attempt.
  const jitter = exponential * jitterFactor * Math.random();
  return Math.max(0, Math.round(exponential - (exponential * jitterFactor) / 2 + jitter));
}

/**
 * Worst-case total time a full Reconnector retry cycle can take: the sum of
 * every attempt's backoff delay (jitter excluded — jitter only ever adds up
 * to +15%, well inside the 20% margin below), plus slack for the connect()
 * round trips themselves.
 *
 * Session uses this to size how long it keeps a departed peer's Receiver
 * alive (Ruling H) before giving up on ever hearing from it again — see
 * #unpair's gap timer in session.ts. There is no protocol-level "the peer
 * is never coming back" signal on that side (unlike the reconnecting side's
 * own Reconnector, which has one), so the only honest bound available is
 * "at least as long as a full retry cycle could plausibly take".
 */
export const RECONNECT_BUDGET_MS = (() => {
  let total = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) total += computeBackoff(attempt, { jitter: 0 });
  return Math.ceil(total * 1.2);
})();

/**
 * Retries a dropped relay connection with exponential backoff, always by
 * rejoining the existing room (`{ t: 'join', code }`) — never by creating a
 * new one. A `create` retry would allocate a fresh room with a fresh code,
 * silently invalidating whatever QR code or link was already shared and
 * orphaning the peer still waiting in the old room.
 *
 * Three distinct outcomes, each with its own callback, because they are
 * three different stories for a caller to tell the user:
 *  - `onReconnected`: back online, carry on.
 *  - `onRoomGone`: the relay said `not-found` — the room itself no longer
 *    exists. No number of retries would have helped.
 *  - `onGaveUp`: retries were exhausted, or the relay refused for a reason
 *    that will not change on its own (`full`, `bad-request`,
 *    `rate-limited`) — "we stopped trying", not "there is nothing to try".
 */
export class Reconnector {
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #onReconnected: ((conn: RelayConnection) => void) | undefined;
  #onGaveUp: (() => void) | undefined;
  #onRoomGone: (() => void) | undefined;

  constructor(private readonly url: string, private readonly code: string) {}

  onReconnected(cb: (conn: RelayConnection) => void): void { this.#onReconnected = cb; }
  onGaveUp(cb: () => void): void { this.#onGaveUp = cb; }
  onRoomGone(cb: () => void): void { this.#onRoomGone = cb; }

  /**
   * A second `start()` while a timer from a previous call is still pending
   * would otherwise overwrite `#timer` without clearing it, leaking a
   * `setTimeout` that still fires later and schedules its own, now-duplicate,
   * attempt. Clearing first makes a stray extra `start()` idempotent instead
   * of doubling the reconnect loop.
   */
  start(): void {
    this.#stopped = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#attempt = 0;
    this.#schedule();
  }

  /**
   * Stops future attempts. This can only cancel a *pending timer* — if
   * RelayTransport.connect is already in flight, this cannot un-send that
   * request. #stopped is checked again when that promise settles (see
   * #schedule) so a late arrival is closed and dropped instead of
   * resurrecting a session the caller deliberately walked away from.
   */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#attempt >= MAX_ATTEMPTS) { this.#onGaveUp?.(); return; }

    const delay = computeBackoff(this.#attempt++);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      RelayTransport.connect(this.url, { t: 'join', code: this.code }).then(
        (conn) => {
          if (this.#stopped) { conn.transport.close(); return; }
          this.#attempt = 0;
          this.#onReconnected?.(conn);
        },
        (error: unknown) => {
          if (this.#stopped) return;
          const reason = refusalReason(error);
          if (reason === 'not-found') { this.#onRoomGone?.(); return; }
          if (reason !== undefined) { this.#onGaveUp?.(); return; }
          this.#schedule();
        },
      );
    }, delay);
  }
}

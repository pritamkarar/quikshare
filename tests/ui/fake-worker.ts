import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { FromWorker, ToWorker } from '../../client/worker/messages.js';

/**
 * jsdom implements no Worker at all, so anything that constructs one has to be
 * given a stand-in. This one records what the page posted and lets a test
 * drive the worker's half of the conversation.
 */
export class FakeWorker {
  static instances: FakeWorker[] = [];

  /**
   * Every message plus its transfer list, mirroring the `Sent` shape
   * tests/unit/transfer-worker.test.ts already uses for the worker's own
   * side of this same boundary — so a test can assert a page→worker post
   * moved a buffer rather than copied it, the same way the worker-side
   * tests already can for worker→page posts.
   */
  readonly sent: Array<{ msg: ToWorker; transfer: Transferable[] }> = [];
  /** `sent.map(s => s.msg)`, kept as its own array because most tests only ever want this. */
  readonly posted: ToWorker[] = [];
  terminated = false;
  readonly #listeners = new Set<(event: MessageEvent<FromWorker>) => void>();

  constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  /** The worker the component under test just constructed. */
  static latest(): FakeWorker | undefined {
    return FakeWorker.instances.at(-1);
  }

  addEventListener(type: string, cb: (event: MessageEvent<FromWorker>) => void): void {
    if (type === 'message') this.#listeners.add(cb);
  }

  removeEventListener(type: string, cb: (event: MessageEvent<FromWorker>) => void): void {
    if (type === 'message') this.#listeners.delete(cb);
  }

  postMessage(msg: ToWorker, transfer: Transferable[] = []): void {
    this.sent.push({ msg, transfer });
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers a message as if the worker had posted it. */
  emit(msg: FromWorker): void {
    for (const listener of this.#listeners) listener({ data: msg } as MessageEvent<FromWorker>);
  }

  /** The last message of a kind the page posted, for asserting on a reply. */
  last<T extends ToWorker['t']>(t: T): Extract<ToWorker, { t: T }> | undefined {
    return [...this.posted].reverse().find((m): m is Extract<ToWorker, { t: T }> => m.t === t);
  }
}

/** Installs the stand-in for the duration of a test file. */
export function installFakeWorker(): void {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
}

/**
 * Drives a paired session through the verification gate.
 *
 * A UI step rather than a worker one, and it lives here anyway because both
 * suites that render a real screen over a FakeWorker need it: TransferPanel
 * renders Share, Transfers and Devices only once BOTH devices have confirmed
 * the number (client/screens/TransferPanel.tsx), so a test that wants a
 * transfer record on screen has to pass this first. It used not to — the
 * columns stayed mounted through the gate — which is why these calls read as
 * new setup in tests that never mentioned verification.
 *
 * Order matters: a `verification` message is a NEW number, and useSession
 * drops both confirmations with it. The peer's confirmation has to arrive
 * after it, and this device's click after that.
 */
export async function passVerification(worker: FakeWorker, digits = '482193'): Promise<void> {
  act(() => worker.emit({ t: 'verification', digits }));
  act(() => worker.emit({ t: 'peer-verified' }));
  await userEvent.click(await screen.findByRole('button', { name: /numbers match/i }));
}

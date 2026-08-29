import { describe, expect, it, vi } from 'vitest';
import { WorkerClient } from '../../client/worker/client.js';
import type { FromWorker, ToWorker } from '../../client/worker/messages.js';

class FakeWorker implements Pick<Worker, 'addEventListener' | 'postMessage' | 'terminate'> {
  listener: ((event: MessageEvent) => void) | undefined;
  readonly posted: unknown[] = [];
  addEventListener(_type: string, cb: EventListenerOrEventListenerObject): void {
    this.listener = cb as (event: MessageEvent) => void;
  }
  postMessage(msg: unknown): void { this.posted.push(msg); }
  terminate(): void { /* no-op */ }
  emit(data: FromWorker): void { this.listener?.({ data } as MessageEvent); }
}

describe('WorkerClient', () => {
  it('forwards posts to the worker', () => {
    const fake = new FakeWorker();
    new WorkerClient(fake as unknown as Worker).post({ t: 'close' });
    expect(fake.posted).toEqual([{ t: 'close' }]);
  });

  it('delivers worker messages to the handler', () => {
    const fake = new FakeWorker();
    const client = new WorkerClient(fake as unknown as Worker);
    const seen = vi.fn();
    client.on(seen);
    fake.emit({ t: 'peer-joined' });
    expect(seen).toHaveBeenCalledWith({ t: 'peer-joined' });
  });
});

/*
 * These two are TYPE assertions, and they are written this way on purpose.
 *
 * Their predecessors annotated a correct object literal and then asserted
 * things about it at runtime (`expect(msg.t).toBe('peer-send')`), which
 * cannot fail: the literal is right there three lines up. All the real
 * enforcement lived in the annotation, i.e. in `tsc`, which vitest does not
 * run — so they read as runtime coverage while providing none.
 *
 * `@ts-expect-error` inverts that. It is an error *if the line compiles*, so
 * the assertion is now about the shape being rejected, and the failure is
 * visible in the place that actually checks it. This repo has no CI at all,
 * so `npm run typecheck` and `npm test` running together is a convention
 * rather than a guarantee; that is an argument for making the type check
 * self-announcing here, not for pretending vitest performs it.
 *
 * The wire shapes matter because both messages cross the worker boundary as
 * structured clones: a `peer-send` whose `frame` is not the transferable
 * view is a silent per-chunk copy on the hot path, and a `peer-drain`
 * missing either half of its (acceptedSeq, bufferedAmount) pair is the
 * backpressure estimate losing the coherence the proxy depends on.
 */
it('types peer-send as a transferable frame view with an id and a seq', () => {
  const frame = new Uint8Array([1, 2, 3]);
  const msg: FromWorker = { t: 'peer-send', id: 1, seq: 7, frame };
  expect(msg.frame).toBe(frame);

  // @ts-expect-error `seq` is required — without it the host cannot echo an
  // acceptedSeq and the proxy can never prune a frame from #inFlight.
  const noSeq: FromWorker = { t: 'peer-send', id: 1, frame };
  // @ts-expect-error a plain array is not a transferable view.
  const notAView: FromWorker = { t: 'peer-send', id: 1, seq: 7, frame: [1, 2, 3] };
  // @ts-expect-error excess properties are rejected: the wire shape is closed.
  const extra: FromWorker = { t: 'peer-send', id: 1, seq: 7, frame, urgent: true };
  expect([noSeq, notAView, extra].length).toBe(3);
});

it('types peer-drain as an accepted seq paired with the real bufferedAmount', () => {
  const msg: ToWorker = { t: 'peer-drain', id: 1, acceptedSeq: 7, bufferedAmount: 2048 };
  expect(msg.acceptedSeq).toBe(7);

  // @ts-expect-error the two halves travel together or the reading is
  // uninterpretable — see the `peer-drain` arm in peer-proxy.ts.
  const noSeq: ToWorker = { t: 'peer-drain', id: 1, bufferedAmount: 2048 };
  // @ts-expect-error same, the other way round.
  const noBytes: ToWorker = { t: 'peer-drain', id: 1, acceptedSeq: 7 };
  // @ts-expect-error bufferedAmount is a byte count, not a flag.
  const notBytes: ToWorker = { t: 'peer-drain', id: 1, acceptedSeq: 7, bufferedAmount: true };
  expect([noSeq, noBytes, notBytes].length).toBe(3);
});

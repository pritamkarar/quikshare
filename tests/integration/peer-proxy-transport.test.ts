import { describe, expect, it, vi } from 'vitest';
import { createPeerProxy } from '../../client/worker/peer-proxy.js';
import { createPeerHost } from '../../client/worker/peer-host.js';
import { TransportSwapGate, type UpgradeTransport } from '../../client/transport/upgrade.js';
import { HIGH_WATER_BYTES, MAX_FRAME_BYTES } from '../../client/transport/types.js';
import { Sender } from '../../client/transfer/sender.js';
import { generateNoncePrefix, generateRawKey, importKey } from '../../client/crypto.js';

/**
 * A recording stand-in for the page's real connection. Written here rather
 * than reused from client/transport/memory.ts: `MemoryTransport` is not
 * exported (only `createMemoryPair` is), reports a constant
 * `bufferedAmount` of 0, and has no record of what it sent — and every
 * assertion below is about exactly those two things.
 */
function recordingTransport() {
  const sent: Uint8Array[] = [];
  let buffered = 0;
  let onMessage: ((f: Uint8Array) => void) | undefined;
  const transport: UpgradeTransport = {
    kind: 'webrtc',
    get bufferedAmount() { return buffered; },
    send: (f) => { sent.push(f); },
    onMessage: (cb) => { onMessage = cb; },
    onDrain: () => undefined,
    onClose: () => undefined,
    close: () => undefined,
    whenOpen: () => Promise.resolve(),
    handleSignal: () => Promise.resolve(),
  };
  return {
    transport,
    sent,
    setBuffered: (n: number) => { buffered = n; },
    deliver: (f: Uint8Array) => onMessage?.(f),
  };
}

/**
 * Proxy and host wired to each other through `queueMicrotask`, standing in
 * for postMessage. Async on purpose: a synchronous hop would hide every
 * ordering and staleness bug the real boundary can produce, which is the
 * only reason this test exists rather than a second unit test.
 *
 * What it CANNOT see, and this is worth knowing before trusting it: a
 * microtask hop is strictly faster than the real boundary, so anything whose
 * correctness depends on a message landing *after* the code that will
 * consume it has already parked is invisible here. `postMessage` is a task.
 * That gap hid a backpressure bug through an entire review — see
 * `taskBoundary` below and the `peer-drain` arm of peer-proxy.ts: with
 * microtasks the page's drain report is consumed before `Sender.#awaitDrain`
 * ever parks, so an unconditional wakeup has nothing to wake and looks
 * harmless. Keep this helper exactly as it is; it is the right model for the
 * ordering and staleness assertions below. Reach for `taskBoundary` for
 * anything about *timing*.
 */
function boundary(real: UpgradeTransport) {
  const proxy = createPeerProxy((msg) => { queueMicrotask(() => host.handle(msg)); });
  const host = createPeerHost({
    post: (msg) => { queueMicrotask(() => proxy.handle(msg)); },
    createTransport: () => real,
  });
  return { proxy, host };
}

/**
 * The same wiring over `setTimeout(…, 0)` instead of `queueMicrotask`.
 *
 * THE BOUNDARY TYPE IS LOAD-BEARING. Do not "simplify" this back to
 * `queueMicrotask` to make the tests faster or to share the helper above: a
 * real `postMessage` schedules a TASK, and the whole class of bug the tests
 * at the bottom of this file cover only exists because the page's reply
 * lands *after* the worker has already parked waiting for it. Microtasks
 * drain before the current task yields, so they deliver the reply first, the
 * park never happens, and a completely disabled backpressure gate passes.
 */
function taskBoundary(real: UpgradeTransport) {
  const proxy = createPeerProxy((msg) => { setTimeout(() => host.handle(msg), 0); });
  const host = createPeerHost({
    post: (msg) => { setTimeout(() => proxy.handle(msg), 0); },
    createTransport: () => real,
  });
  return { proxy, host };
}

/**
 * A page transport that accepts everything and only drains when told to —
 * the honest model of an `RTCDataChannel` whose peer has stopped reading,
 * and of any transfer big enough to outrun the wire. Chromium closes the
 * channel once 16 MiB is buffered, so "does not drain on its own" is not a
 * pathological fixture; it is the shape of the failure the high-water mark
 * exists to prevent.
 */
function saturatingTransport() {
  const state = { buffered: 0, frames: 0 };
  let onDrain: (() => void) | undefined;
  const transport: UpgradeTransport = {
    kind: 'webrtc',
    get bufferedAmount() { return state.buffered; },
    send: (f) => { state.buffered += f.byteLength; state.frames += 1; },
    onMessage: () => undefined,
    onDrain: (cb) => { onDrain = cb; },
    onClose: () => undefined,
    close: () => undefined,
    whenOpen: () => Promise.resolve(),
    handleSignal: () => Promise.resolve(),
  };
  return {
    transport,
    state,
    /**
     * Drains the buffer to `to` and then fires the drain callback under the
     * platform's own rule, which is EDGE-triggered, not level-triggered:
     * `bufferedamountlow` fires on the transition from
     * `> bufferedAmountLowThreshold` to `<= threshold` (WebRTC 1.0 §6.2), and
     * `WebRTCTransport` sets that threshold to `HIGH_WATER_BYTES` exactly.
     *
     * Modelling that faithfully is what makes the boundary observable. A
     * fixture that unconditionally emptied to zero and always called back
     * could only ever produce a report of 0, which any gate passes — so it
     * could not tell an inclusive comparison from an exclusive one, and the
     * exclusive one deadlocks. Carrying the real post-drain value, and only
     * firing on a genuine crossing, is the difference between a test that
     * asserts "a wakeup is not lost" and one that merely asserts zero is
     * below a million.
     */
    drain: (to = 0) => {
      const crossed = state.buffered > HIGH_WATER_BYTES && to <= HIGH_WATER_BYTES;
      state.buffered = to;
      if (crossed) onDrain?.();
    },
  };
}

/**
 * Resolves once `read()` has stopped changing for `quietMs`. Both outcomes
 * these tests distinguish are quiescent states — a sender correctly parked
 * on a buffer that will never drain, and a sender that ran the entire file
 * to completion — so waiting for "stopped moving" rather than sleeping a
 * fixed span keeps the passing case fast and the failing case unambiguous.
 */
async function untilQuiet(read: () => number, quietMs = 300, capMs = 20_000): Promise<void> {
  const started = Date.now();
  let last = read();
  let lastChange = Date.now();
  while (Date.now() - started < capMs) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    const now = read();
    if (now !== last) { last = now; lastChange = Date.now(); continue; }
    if (Date.now() - lastChange >= quietMs) return;
  }
}

describe('peer proxy over a simulated worker boundary', () => {
  it('carries frames to the page in order', async () => {
    const page = recordingTransport();
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    transport.send(new Uint8Array([1]));
    transport.send(new Uint8Array([2]));

    await vi.waitFor(() => { expect(page.sent.length).toBe(2); });
    expect(page.sent.map((f) => f[0])).toEqual([1, 2]);
  });

  it('carries frames back from the page in order', async () => {
    const page = recordingTransport();
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    const received: number[] = [];
    transport.onMessage((f) => received.push(f[0]!));
    // The host only wires its callbacks once the connection is built, and
    // that build is one microtask hop away.
    await vi.waitFor(() => { expect(page.sent).toEqual([]); });

    page.deliver(new Uint8Array([7]));
    page.deliver(new Uint8Array([8]));
    await vi.waitFor(() => { expect(received).toEqual([7, 8]); });
  });

  it('collapses its bufferedAmount estimate to the real reading once the page reports', async () => {
    const page = recordingTransport();
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    transport.send(new Uint8Array(4096));
    // Nothing confirmed yet, so every byte still counts against the sender.
    expect(transport.bufferedAmount).toBe(4096);

    // The page's channel took it and drained; the estimate must follow the
    // truth rather than stay inflated forever, or Sender parks permanently.
    await vi.waitFor(() => { expect(transport.bufferedAmount).toBe(0); });
  });

  it('tracks a page buffer that has NOT drained, so the sender still backs off', async () => {
    const page = recordingTransport();
    page.setBuffered(3000);
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    transport.send(new Uint8Array(1000));
    await vi.waitFor(() => { expect(transport.bufferedAmount).toBe(3000); });
  });
});

/**
 * The regression harness for the backpressure bug, and the only shape that
 * can see it: a real `Sender`, a real proxy, a real host, a page buffer that
 * does not drain by itself, and — critically — a TASK boundary between the
 * two halves.
 *
 * The bug. The host reports the buffer on every `peer-send`, not only on a
 * real drain event, because the worker's `bufferedAmount` is a synchronous
 * getter that is only ever as fresh as its last report. The proxy then fired
 * `onDrain` on every report it received, unconditionally — and
 * `Sender.#awaitDrain` resolves every parked waiter from that callback
 * without re-reading `bufferedAmount`. So the sender parked and was
 * immediately unparked by the report generated by the very frame that had
 * pushed it over the mark: one extra frame per worker->page round trip,
 * forever, however full the real channel was. Both real transports gate this
 * (`relay.ts`, `webrtc.ts`); the proxy did not.
 *
 * Measured on the unfixed code with this exact fixture: all 8,392,473 bytes
 * of the file land in a page buffer that never drains. With the gate the
 * sender parks at 1,048,700 — one frame's worth past the mark, which is
 * exactly right.
 */
describe('backpressure across a task boundary (the real postMessage timing)', () => {
  const FILE_BYTES = 8 * 1024 * 1024;

  async function makeSender(transport: UpgradeTransport): Promise<Sender> {
    return new Sender({
      transport,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      initialSeq: 0n,
      initialFileId: 1,
      gate: new TransportSwapGate(),
      events: { onProgress: () => undefined, onFileDone: () => undefined },
    });
  }

  it('parks the sender near HIGH_WATER_BYTES instead of pushing the whole file', async () => {
    const page = saturatingTransport();
    const { proxy } = taskBoundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);
    const sender = await makeSender(transport);

    // Never settles while the gate holds — the buffer it is waiting on will
    // not drain — so it is deliberately not awaited here; the abort below is
    // what finally rejects it.
    const sending = sender
      .sendFiles([new File([new Uint8Array(FILE_BYTES)], 'big.bin')])
      .catch(() => undefined);

    await untilQuiet(() => page.state.buffered);

    // One frame of overshoot is expected and correct: the sender consults
    // bufferedAmount once per chunk, so it always discovers it has crossed
    // the mark by having crossed it. Anything past that means the wakeup
    // gate is not holding.
    expect(page.state.buffered).toBeLessThan(HIGH_WATER_BYTES + MAX_FRAME_BYTES * 2);
    expect(page.state.buffered).toBeLessThan(FILE_BYTES);
    // And a genuinely parked sender, not one that quietly stopped before it
    // ever backed up — which would pass the bound above for the wrong reason.
    expect(page.state.buffered).toBeGreaterThanOrEqual(HIGH_WATER_BYTES);

    sender.abort('test over');
    await sending;
  });

  it('still wakes the parked sender when the page buffer genuinely drains', async () => {
    const page = saturatingTransport();
    const { proxy } = taskBoundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);
    const sender = await makeSender(transport);

    const sending = sender
      .sendFiles([new File([new Uint8Array(FILE_BYTES)], 'big.bin')])
      .catch(() => undefined);

    await untilQuiet(() => page.state.buffered);
    const framesAtPark = page.state.frames;
    expect(page.state.buffered).toBeLessThan(FILE_BYTES);

    // The other half of the gate: holding a wakeup back must never LOSE it.
    // A gate that parked the sender permanently would be a worse bug than
    // the one it replaced, so this drives the real `bufferedamountlow` path
    // — the page's channel empties and the host reports it — and requires
    // the transfer to pick up where it left off.
    page.drain();
    await untilQuiet(() => page.state.frames);
    expect(page.state.frames).toBeGreaterThan(framesAtPark);

    sender.abort('test over');
    await sending;
  });

  /*
   * The same property at the one value that actually occurs in production,
   * and the reason the gate is `<=` rather than `<`.
   *
   * `bufferedamountlow` fires on the edge from `> threshold` to
   * `<= threshold`, and that threshold is `HIGH_WATER_BYTES` exactly. Frames
   * are exactly MAX_FRAME_BYTES and HIGH_WATER_BYTES is exactly 16 of them,
   * so the report that carries the crossing holds exactly HIGH_WATER_BYTES.
   * A strict comparison rejects it, and because the event is edge-triggered
   * and a parked sender issues no further sends, no second report ever comes:
   * the transfer stops forever. This is the case the drain-to-zero test above
   * cannot see, because zero passes either comparison.
   */
  it('resumes on a crossing report that lands exactly on the mark', async () => {
    const page = saturatingTransport();
    const { proxy } = taskBoundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);
    const sender = await makeSender(transport);

    const sending = sender
      .sendFiles([new File([new Uint8Array(FILE_BYTES)], 'big.bin')])
      .catch(() => undefined);

    await untilQuiet(() => page.state.buffered);
    const framesAtPark = page.state.frames;
    expect(page.state.buffered).toBeGreaterThan(HIGH_WATER_BYTES);

    // Exactly the mark, which is exactly where the platform's edge fires.
    page.drain(HIGH_WATER_BYTES);
    await untilQuiet(() => page.state.frames);
    expect(page.state.frames).toBeGreaterThan(framesAtPark);

    sender.abort('test over');
    await sending;
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createPeerHost } from '../../client/worker/peer-host.js';
import type { ToWorker } from '../../client/worker/messages.js';
import type { UpgradeTransport } from '../../client/transport/upgrade.js';

function fakeTransport() {
  let onMessage: ((f: Uint8Array) => void) | undefined;
  let onDrain: (() => void) | undefined;
  let onClose: ((r: string) => void) | undefined;
  const sent: Uint8Array[] = [];
  const sendSpy = vi.fn((f: Uint8Array) => { sent.push(f); });
  const transport: UpgradeTransport & { fire: (kind: 'message' | 'drain' | 'close', value?: unknown) => void } = {
    kind: 'webrtc', bufferedAmount: 0,
    send: sendSpy,
    onMessage: (cb) => { onMessage = cb; },
    onDrain: (cb) => { onDrain = cb; },
    onClose: (cb) => { onClose = cb; },
    close: vi.fn(),
    whenOpen: () => Promise.resolve(),
    handleSignal: vi.fn(async () => undefined),
    fire: (...args) => fire(...args),
  };
  function fire(kind: 'message' | 'drain' | 'close', value?: unknown): void {
    if (kind === 'message') onMessage?.(value as Uint8Array);
    if (kind === 'drain') onDrain?.();
    if (kind === 'close') onClose?.(value as string);
  }
  return { transport, sent };
}

/**
 * A transport whose `send` can be made to throw on demand — the one thing
 * `fakeTransport` above cannot do, and the only way to reach the `peer-send`
 * guard. Both real failure modes are synchronous throws from `send`:
 * `WebRTCTransport.send` above MAX_FRAME_BYTES, and `RTCDataChannel.send`
 * with an OperationError at the user agent's send-buffer cap.
 */
function throwingTransport() {
  const sent: Uint8Array[] = [];
  let throwing = false;
  let isClosed = false;
  const transport: UpgradeTransport = {
    kind: 'webrtc', bufferedAmount: 0,
    send: (f) => {
      if (throwing) throw new Error('OperationError');
      sent.push(f);
    },
    onMessage: () => undefined,
    onDrain: () => undefined,
    onClose: () => undefined,
    close: () => { isClosed = true; },
    whenOpen: () => Promise.resolve(),
    handleSignal: () => Promise.resolve(),
  };
  return {
    transport, sent,
    closed: () => isClosed,
    throwOnSend: (on: boolean) => { throwing = on; },
  };
}

describe('PeerHost', () => {
  it('builds a connection on peer-open and reports success', async () => {
    const posted: ToWorker[] = [];
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-wait-open', id: 1, timeoutMs: 100 });
    await vi.waitFor(() => expect(posted.some((m) => m.t === 'peer-opened')).toBe(true));
    expect(posted.find((m) => m.t === 'peer-opened')).toMatchObject({ id: 1, ok: true });
  });

  it('forwards a worker frame onto the real transport', () => {
    const { transport, sent } = fakeTransport();
    const host = createPeerHost({ post: () => undefined, createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-send', id: 1, seq: 1, frame: new Uint8Array([9]) });
    expect(sent).toEqual([new Uint8Array([9])]);
  });

  /*
   * `WebRTCTransport.send` throws above MAX_FRAME_BYTES, and a real
   * `RTCDataChannel.send` throws OperationError once the user agent's
   * send-buffer maximum is exceeded. Unguarded, the throw escaped through
   * `useSession`'s worker listener as an uncaught page error — but the worse
   * half was what it skipped: no `acceptedSeq` update and no `peer-drain`,
   * so the worker's bufferedAmount estimate stayed inflated over the mark
   * forever and `Sender` parked with nothing left to unpark it. A silent
   * hang beats a loud error only in the sense that nobody sees it.
   */
  it('does not let a throwing send escape, and tells the worker the connection is gone', () => {
    const posted: ToWorker[] = [];
    const { transport, closed, sent, throwOnSend } = throwingTransport();
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });

    throwOnSend(true);
    expect(() => host.handle({ t: 'peer-send', id: 1, seq: 1, frame: new Uint8Array([9]) })).not.toThrow();
    // Falls back rather than stalls: `peer-closed` is what the proxy turns
    // into `#onClose`, which is what puts SwitchableTransport back on the
    // relay with resume intact. And the connection is really closed, not
    // merely forgotten — an abandoned RTCPeerConnection gathers ICE forever.
    expect(posted.some((m) => m.t === 'peer-closed')).toBe(true);
    expect(closed()).toBe(true);
    // Never a drain report for a frame that did not go anywhere: that would
    // be the worker told its buffer shrank when it did not.
    expect(posted.some((m) => m.t === 'peer-drain')).toBe(false);

    // Retired, so nothing is handed to a channel that has already thrown.
    throwOnSend(false);
    host.handle({ t: 'peer-send', id: 1, seq: 2, frame: new Uint8Array([8]) });
    expect(sent).toEqual([]);
  });

  it('reports inbound frames, and echoes the accepted seq on a drain', () => {
    const posted: ToWorker[] = [];
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });

    transport.fire('message', new Uint8Array([4]));
    expect(posted.some((m) => m.t === 'peer-message')).toBe(true);

    // A frame first, THEN the drain: `acceptedSeq` exists to echo the last
    // seq this side actually took, and asserting it while nothing has been
    // sent would only test its initial value. The echo is the whole reason
    // the worker can reconstruct bufferedAmount at all.
    host.handle({ t: 'peer-send', id: 1, seq: 1, frame: new Uint8Array([9]) });
    transport.fire('drain');

    const drains = posted.filter((m) => m.t === 'peer-drain');
    expect(drains.at(-1)).toMatchObject({ id: 1, acceptedSeq: 1 });
  });

  it('answers a signal request with its outcome rather than swallowing it', async () => {
    const posted: ToWorker[] = [];
    const { transport } = fakeTransport();
    transport.handleSignal = vi.fn(async () => { throw new Error('bad sdp'); });
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-signal-in', id: 1, requestId: 5, payload: {} });
    await vi.waitFor(() => expect(posted.some((m) => m.t === 'peer-signal-result')).toBe(true));
    expect(posted.find((m) => m.t === 'peer-signal-result')).toMatchObject({ requestId: 5, ok: false });
  });

  it('closes every connection on teardown so no RTCPeerConnection is left gathering', () => {
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: () => undefined, createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.closeAll();
    expect(transport.close).toHaveBeenCalled();
  });

  it('never builds two connections for the same id — idempotent guard prevents orphaned RTCPeerConnection', () => {
    const createTransportSpy = vi.fn(() => fakeTransport().transport);
    const host = createPeerHost({ post: () => undefined, createTransport: createTransportSpy });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    expect(createTransportSpy).toHaveBeenCalledTimes(1);
  });

  it('converts synchronous createTransport errors to peer-opened failure', () => {
    const posted: ToWorker[] = [];
    const createTransportSpy = vi.fn(() => { throw new Error('STUN URL parse failed'); });
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: createTransportSpy });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    expect(posted.find((m) => m.t === 'peer-opened')).toMatchObject({
      id: 1, ok: false, reason: 'failed',
    });
  });

  it('slices outbound frames and transfers the distinct buffer to prevent pooled-buffer hazards', () => {
    const posted: Array<{ msg: ToWorker; transfer?: Transferable[] }> = [];
    const { transport } = fakeTransport();
    const host = createPeerHost({
      post: (msg, transfer) => posted.push({ msg, transfer }),
      createTransport: () => transport,
    });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });

    // Create inbound frame as a view over a larger pooled buffer, the way real
    // network reads hand them out. If someone replaces .slice() with .subarray(),
    // this test catches it: subarray creates a view with a *shared* buffer.
    const pool = new ArrayBuffer(256);
    const inboundFrame = new Uint8Array(pool, 100, 3); // 3-byte view at offset 100
    inboundFrame[0] = 42; inboundFrame[1] = 43; inboundFrame[2] = 44;
    transport.fire('message', inboundFrame);

    const postedMessage = posted.find((p) => (p.msg as any).t === 'peer-message');
    expect(postedMessage).toBeDefined();
    const postedFrame = (postedMessage?.msg as any).frame as Uint8Array;

    // The posted frame must be backed by a *different* buffer, not the pool.
    // This is the property .slice() ensures: a copy, not a view.
    expect(postedFrame.buffer).not.toBe(pool);
    expect(postedFrame.buffer).not.toBe(inboundFrame.buffer);

    // The posted frame must be a copy of the right slice, not the whole pool.
    // byteLength proves we copied only the frame's range, not the entire pool.
    expect(postedFrame.byteLength).toBe(3);
    expect(postedFrame).toEqual(inboundFrame);

    // The transfer array must contain the posted frame's buffer, not the pool.
    expect(postedMessage?.transfer).toContain(postedFrame.buffer);
    expect(postedMessage?.transfer).not.toContain(pool);
  });

  it('handles peer-close: closes transport and removes from live', () => {
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: () => undefined, createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-close', id: 1 });
    expect(transport.close).toHaveBeenCalled();
    // Verify the connection is removed by sending again — should be silently ignored
    host.handle({ t: 'peer-send', id: 1, seq: 1, frame: new Uint8Array([1]) });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('maintains monotonic acceptedSeq across interleaved sends and drains', () => {
    const posted: ToWorker[] = [];
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });

    // Two sends in a row
    host.handle({ t: 'peer-send', id: 1, seq: 1, frame: new Uint8Array([9]) });
    host.handle({ t: 'peer-send', id: 1, seq: 2, frame: new Uint8Array([10]) });

    // Drain fires without an intervening send
    transport.fire('drain');

    // Drain fires again
    transport.fire('drain');

    const drains = posted.filter((m) => m.t === 'peer-drain');
    const seqs = drains.map((d) => (d as any).acceptedSeq);

    // Should be: 1 (from first send), 2 (from second send), 2 (from first drain), 2 (from second drain)
    expect(seqs).toEqual([1, 2, 2, 2]);
    // Most importantly: no seq ever decreases
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThanOrEqual(seqs[i - 1]);
    }
  });
});

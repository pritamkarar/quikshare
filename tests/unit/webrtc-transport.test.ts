// tests/unit/webrtc-transport.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIGH_WATER_BYTES, MAX_FRAME_BYTES } from '../../client/transport/types.js';
import { WebRTCTransport, defaultRtcConfig } from '../../client/transport/webrtc.js';

// ---------------------------------------------------------------------------
// Fakes. Node has no RTCPeerConnection/RTCDataChannel, so these stand in for
// the browser objects WebRTCTransport drives. They implement just enough of
// the real event-target/negotiation surface to exercise the transport's
// wiring; they prove nothing about real ICE/SDP/SCTP behaviour, which is
// covered later by Task 7's Playwright suite.
// ---------------------------------------------------------------------------

type Listener = (event: any) => void;

class FakeEventTarget {
  #listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, cb: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) { set = new Set(); this.#listeners.set(type, set); }
    set.add(cb);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.#listeners.get(type)?.delete(cb);
  }
  emit(type: string, event: unknown = {}): void {
    for (const cb of [...(this.#listeners.get(type) ?? [])]) cb(event);
  }
}

class FakeDataChannel extends FakeEventTarget {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  closed = false;
  readonly sent: ArrayBuffer[] = [];

  constructor(public label: string, public options?: unknown) { super(); }

  send(data: ArrayBuffer): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 'closed'; }

  simulateOpen(): void { this.readyState = 'open'; this.emit('open'); }
}

class FakePeerConnection extends FakeEventTarget {
  connectionState: string = 'new';
  localDescription: RTCSessionDescriptionInit | undefined;
  remoteDescription: RTCSessionDescriptionInit | undefined;
  readonly iceCandidates: RTCIceCandidateInit[] = [];
  readonly dataChannels: FakeDataChannel[] = [];
  closed = false;

  failCreateOffer = false;

  constructor(public config: RTCConfiguration) { super(); }

  createDataChannel(label: string, options?: unknown): FakeDataChannel {
    const channel = new FakeDataChannel(label, options);
    this.dataChannels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.failCreateOffer) throw new Error('createOffer failed');
    return { type: 'offer', sdp: 'fake-offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer-sdp' };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.iceCandidates.push(candidate);
  }

  close(): void { this.closed = true; }
}

/**
 * Flush every pending microtask — chained promises, then()/catch() handlers,
 * and queueMicrotask callbacks — by waiting for a real macrotask boundary.
 * Node always drains the whole microtask queue before running any timer
 * callback, however many ticks deep the chain is, which counting a fixed
 * number of `await Promise.resolve()` calls cannot guarantee. Matches the
 * same pattern already used in tests/unit/transport-memory.test.ts.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let lastPc: FakePeerConnection | undefined;

beforeEach(() => {
  lastPc = undefined;
  class TrackedFakePeerConnection extends FakePeerConnection {
    constructor(config: RTCConfiguration) {
      super(config);
      lastPc = this;
    }
  }
  vi.stubGlobal('RTCPeerConnection', TrackedFakePeerConnection as unknown as typeof RTCPeerConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function pc(): FakePeerConnection {
  if (!lastPc) throw new Error('no peer connection constructed yet');
  return lastPc;
}

describe('defaultRtcConfig', () => {
  it('includes at least one STUN server so peers can offer routable candidates', () => {
    const servers = defaultRtcConfig().iceServers ?? [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.startsWith('stun:'))).toBe(true);
  });

  it('spreads the default STUN list across more than one operator', () => {
    // Not "more than one URL": three names behind one operator's DNS fail
    // together, and a failed STUN lookup means no server-reflexive candidate
    // at all, not a slow one. See DEFAULT_STUN's comment for the session this
    // is guarding against.
    const urls = (defaultRtcConfig().iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    const operators = new Set(urls.map((u) => u.replace(/^stuns?:/, '').split(':')[0]?.split('.').slice(-2).join('.')));

    expect(operators.size).toBeGreaterThan(1);
  });

  it('configures no TURN server, since the relay is the fallback', () => {
    const servers = defaultRtcConfig().iceServers ?? [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'))).toBe(false);
  });

  it('reads STUN endpoints from configuration when provided', () => {
    vi.stubEnv('VITE_STUN_URLS', 'stun:stun.example.org:3478');
    const servers = defaultRtcConfig().iceServers ?? [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls).toContain('stun:stun.example.org:3478');
  });

  it('falls back to the default STUN server when VITE_STUN_URLS is configured but empty', () => {
    // An explicit but empty override must not degrade to zero ICE servers:
    // some browsers reject that outright, others silently force relay-only.
    vi.stubEnv('VITE_STUN_URLS', '');
    const servers = defaultRtcConfig().iceServers ?? [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.startsWith('stun:'))).toBe(true);
  });
});

describe('WebRTCTransport signaling', () => {
  it('reports kind webrtc', () => {
    const transport = WebRTCTransport.offer(vi.fn());
    expect(transport.kind).toBe('webrtc');
  });

  it('offer() creates an ordered data channel named "files"', () => {
    WebRTCTransport.offer(vi.fn());
    expect(pc().dataChannels).toHaveLength(1);
    expect(pc().dataChannels[0]?.label).toBe('files');
    expect(pc().dataChannels[0]?.options).toMatchObject({ ordered: true });
  });

  it('offer() sends its local SDP offer through the signal callback', async () => {
    const signal = vi.fn();
    WebRTCTransport.offer(signal);
    await flush();
    expect(signal).toHaveBeenCalledWith({ kind: 'sdp', description: { type: 'offer', sdp: 'fake-offer-sdp' } });
  });

  it('offer() forwards local ICE candidates through the signal callback', () => {
    const signal = vi.fn();
    WebRTCTransport.offer(signal);
    const candidate = { candidate: 'candidate-line', sdpMid: '0', sdpMLineIndex: 0 };
    pc().emit('icecandidate', { candidate: { toJSON: () => candidate } });
    expect(signal).toHaveBeenCalledWith({ kind: 'ice', candidate });
  });

  it('offer() ignores the end-of-candidates null event', () => {
    const signal = vi.fn();
    WebRTCTransport.offer(signal);
    pc().emit('icecandidate', { candidate: null });
    expect(signal).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ice' }));
  });

  it('offer() and answer() default to defaultRtcConfig() when no config is given', () => {
    WebRTCTransport.offer(vi.fn());
    expect(pc().config).toEqual(defaultRtcConfig());
  });

  it('answer() does not create its own data channel, it waits for the peer\'s', () => {
    WebRTCTransport.answer(vi.fn());
    expect(pc().dataChannels).toHaveLength(0);
  });

  it('answer() attaches the channel handed to it via the datachannel event', () => {
    WebRTCTransport.answer(vi.fn());
    const channel = new FakeDataChannel('files');
    pc().emit('datachannel', { channel });
    // Attaching sets the shared drain threshold; if #attach were never
    // called this stays at the FakeDataChannel default of 0.
    expect(channel.bufferedAmountLowThreshold).toBe(HIGH_WATER_BYTES);
  });

  it('handleSignal() turns an incoming offer into a local answer', async () => {
    const signal = vi.fn();
    const transport = WebRTCTransport.answer(signal);
    const offer = { type: 'offer' as const, sdp: 'remote-offer-sdp' };
    await transport.handleSignal({ kind: 'sdp', description: offer });
    expect(pc().remoteDescription).toEqual(offer);
    expect(signal).toHaveBeenCalledWith({ kind: 'sdp', description: { type: 'answer', sdp: 'fake-answer-sdp' } });
  });

  it('handleSignal() sets the remote description for an incoming answer without replying again', async () => {
    const signal = vi.fn();
    const transport = WebRTCTransport.offer(signal);
    await flush();
    signal.mockClear();
    const answer = { type: 'answer' as const, sdp: 'remote-answer-sdp' };
    await transport.handleSignal({ kind: 'sdp', description: answer });
    expect(pc().remoteDescription).toEqual(answer);
    expect(signal).not.toHaveBeenCalled();
  });

  it('handleSignal() adds an incoming ICE candidate to the peer connection', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    const candidate = { candidate: 'remote-candidate', sdpMid: '0', sdpMLineIndex: 0 };
    await transport.handleSignal({ kind: 'ice', candidate });
    expect(pc().iceCandidates).toEqual([candidate]);
  });

  // ---------------------------------------------------------------------
  // handleSignal() validation. SDP and ICE candidates travel through the
  // relay, which this project's threat model treats as an active adversary
  // (it can reorder, drop, duplicate, or splice) — `msg` is untrusted, and
  // a malformed value must never reach setRemoteDescription/addIceCandidate.
  // ---------------------------------------------------------------------

  it('handleSignal() rejects a non-object message rather than passing it through', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await expect(transport.handleSignal('bogus')).rejects.toThrow();
    await expect(transport.handleSignal(null)).rejects.toThrow();
    await expect(transport.handleSignal(42)).rejects.toThrow();
    expect(pc().remoteDescription).toBeUndefined();
    expect(pc().iceCandidates).toEqual([]);
  });

  it('handleSignal() rejects a message with an unrecognised kind', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await expect(transport.handleSignal({ kind: 'exec', payload: 'rm -rf /' })).rejects.toThrow();
    expect(pc().remoteDescription).toBeUndefined();
  });

  it('handleSignal() rejects an sdp message whose description is missing required fields', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await expect(transport.handleSignal({ kind: 'sdp', description: { type: 'offer' } })).rejects.toThrow();
    await expect(transport.handleSignal({ kind: 'sdp', description: { sdp: 'x' } })).rejects.toThrow();
    await expect(transport.handleSignal({ kind: 'sdp' })).rejects.toThrow();
    expect(pc().remoteDescription).toBeUndefined();
  });

  it('handleSignal() rejects an sdp message whose fields have the wrong type', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await expect(transport.handleSignal({ kind: 'sdp', description: { type: 'offer', sdp: 123 } }))
      .rejects.toThrow();
    expect(pc().remoteDescription).toBeUndefined();
  });

  it('handleSignal() rejects an sdp description with a type outside offer/answer', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await expect(transport.handleSignal({ kind: 'sdp', description: { type: 'rollback', sdp: 'x' } }))
      .rejects.toThrow();
    expect(pc().remoteDescription).toBeUndefined();
  });

  it('handleSignal() constructs a fresh sdp object rather than trusting the one it was handed', async () => {
    // Guards the actual fix, not merely the validation: a cast (`msg as
    // SignalMessage`) would pass every check above and still leak
    // unexpected fields straight into setRemoteDescription.
    const transport = WebRTCTransport.answer(vi.fn());
    await transport.handleSignal({ kind: 'sdp', description: { type: 'answer', sdp: 'x', evil: 'payload' } });
    expect(pc().remoteDescription).toEqual({ type: 'answer', sdp: 'x' });
  });

  it('handleSignal() rejects an ice message whose candidate is not an object', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await expect(transport.handleSignal({ kind: 'ice', candidate: 'not-an-object' })).rejects.toThrow();
    await expect(transport.handleSignal({ kind: 'ice' })).rejects.toThrow();
    expect(pc().iceCandidates).toEqual([]);
  });

  it('handleSignal() rejects an ice candidate missing its required candidate string', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await expect(transport.handleSignal({ kind: 'ice', candidate: { sdpMid: '0' } })).rejects.toThrow();
    expect(pc().iceCandidates).toEqual([]);
  });

  it('handleSignal() constructs a fresh ice candidate rather than trusting the one it was handed', async () => {
    const transport = WebRTCTransport.answer(vi.fn());
    await transport.handleSignal({
      kind: 'ice',
      candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, evil: 'payload' },
    });
    expect(pc().iceCandidates).toEqual([{ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 }]);
  });

  it('reports closure if local offer negotiation itself fails', async () => {
    const onClose = vi.fn();
    // Fail on the peer connection this call is about to construct.
    class FailingPeerConnection extends FakePeerConnection {
      constructor(config: RTCConfiguration) { super(config); this.failCreateOffer = true; lastPc = this; }
    }
    vi.stubGlobal('RTCPeerConnection', FailingPeerConnection as unknown as typeof RTCPeerConnection);
    const transport = WebRTCTransport.offer(vi.fn());
    transport.onClose(onClose);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('WebRTCTransport data plane', () => {
  function offerWithOpenChannel(): { transport: WebRTCTransport; channel: FakeDataChannel } {
    const transport = WebRTCTransport.offer(vi.fn());
    const channel = pc().dataChannels[0]!;
    channel.simulateOpen();
    return { transport, channel };
  }

  it('reports bufferedAmount 0 before any channel is attached', () => {
    const transport = WebRTCTransport.answer(vi.fn());
    expect(transport.bufferedAmount).toBe(0);
  });

  it('reports bufferedAmount from the underlying channel once attached', () => {
    const { transport, channel } = offerWithOpenChannel();
    channel.bufferedAmount = 12345;
    expect(transport.bufferedAmount).toBe(12345);
  });

  it('does not send while the channel is not open', () => {
    const transport = WebRTCTransport.offer(vi.fn());
    const channel = pc().dataChannels[0]!;
    transport.send(new Uint8Array([1, 2, 3]));
    expect(channel.sent).toHaveLength(0);
  });

  it('sends a frame once the channel is open', () => {
    const { transport, channel } = offerWithOpenChannel();
    transport.send(new Uint8Array([1, 2, 3]));
    expect(channel.sent).toHaveLength(1);
    expect([...new Uint8Array(channel.sent[0]!)]).toEqual([1, 2, 3]);
  });

  it('copies only the frame\'s own bytes, never the pooled buffer behind it', () => {
    const { transport, channel } = offerWithOpenChannel();
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const frame = pool.subarray(2, 5); // a view: byteLength 3, but pool.buffer is 7 bytes
    transport.send(frame);
    expect(channel.sent[0]!.byteLength).toBe(3);
    expect([...new Uint8Array(channel.sent[0]!)]).toEqual([1, 2, 3]);
  });

  it('rejects a frame larger than MAX_FRAME_BYTES rather than handing it to the channel', () => {
    // Plan 3's Global Constraints: a single DataChannel message must never
    // exceed MAX_FRAME_BYTES. This is the actual boundary asserted at the
    // actual send() call site, not merely inferred from how CHUNK_SIZE
    // happens to be derived.
    const { transport, channel } = offerWithOpenChannel();
    expect(() => transport.send(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow();
    expect(channel.sent).toHaveLength(0);
  });

  it('accepts a frame exactly at MAX_FRAME_BYTES', () => {
    const { transport, channel } = offerWithOpenChannel();
    expect(() => transport.send(new Uint8Array(MAX_FRAME_BYTES))).not.toThrow();
    expect(channel.sent).toHaveLength(1);
  });

  it('delivers an incoming channel message to onMessage as a Uint8Array', () => {
    const { transport, channel } = offerWithOpenChannel();
    const received: Uint8Array[] = [];
    transport.onMessage((f) => received.push(f));
    channel.emit('message', { data: new Uint8Array([4, 5, 6]).buffer });
    expect([...(received[0] ?? [])]).toEqual([4, 5, 6]);
  });

  it('sets bufferedAmountLowThreshold to the shared HIGH_WATER_BYTES mark, so resume matches RelayTransport\'s pause point', () => {
    const { channel } = offerWithOpenChannel();
    expect(channel.bufferedAmountLowThreshold).toBe(HIGH_WATER_BYTES);
  });

  it('fires onDrain when the channel signals bufferedamountlow', () => {
    const { transport, channel } = offerWithOpenChannel();
    const onDrain = vi.fn();
    transport.onDrain(onDrain);
    channel.emit('bufferedamountlow');
    expect(onDrain).toHaveBeenCalledTimes(1);
  });

  it('fires onClose with a data-channel reason when the channel closes', async () => {
    const { transport, channel } = offerWithOpenChannel();
    const onClose = vi.fn();
    transport.onClose(onClose);
    channel.emit('close');
    await flush();
    expect(onClose).toHaveBeenCalledWith('data channel closed');
  });

  it('fires onClose with a peer-connection reason when the connection fails', async () => {
    const transport = WebRTCTransport.offer(vi.fn());
    const onClose = vi.fn();
    transport.onClose(onClose);
    pc().connectionState = 'failed';
    pc().emit('connectionstatechange');
    await flush();
    expect(onClose).toHaveBeenCalledWith('peer connection failed');
  });

  /*
   * Reported from a real session (2026-08-29): two computers on different
   * networks, connected Direct, and a screen share that "dropped on its own
   * after a few seconds" — with the transport badge flipping to Relayed at
   * the same moment. Both are this: 'disconnected' is not a failure. It is
   * ICE saying connectivity checks have stopped answering *for now*, and a
   * browser routinely passes through it on a wifi roam, a NAT rebinding, or
   * a burst of loss on a relayed stream, then returns to 'connected' by
   * itself. Only 'failed' is ICE giving up. Tearing the connection down on
   * the blip turns a two-second hiccup into a permanent downgrade — and, on
   * the media path, into a share the user has to start again.
   */
  it('rides out an ICE blip: a disconnected connection state is not a close', async () => {
    const { transport } = offerWithOpenChannel();
    const onClose = vi.fn();
    transport.onClose(onClose);

    pc().connectionState = 'disconnected';
    pc().emit('connectionstatechange');
    await flush();
    expect(onClose).not.toHaveBeenCalled();

    // ...and the recovery ICE was waiting for actually arrives.
    pc().connectionState = 'connected';
    pc().emit('connectionstatechange');
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes once a disconnected connection gives up for good', async () => {
    const { transport } = offerWithOpenChannel();
    const onClose = vi.fn();
    transport.onClose(onClose);

    pc().connectionState = 'disconnected';
    pc().emit('connectionstatechange');
    pc().connectionState = 'failed';
    pc().emit('connectionstatechange');
    await flush();
    expect(onClose).toHaveBeenCalledWith('peer connection failed');
  });

  it('fires onClose only once even when both the channel and the connection report closure', async () => {
    const { transport, channel } = offerWithOpenChannel();
    const onClose = vi.fn();
    transport.onClose(onClose);
    channel.emit('close');
    pc().connectionState = 'closed';
    pc().emit('connectionstatechange');
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() closes both the data channel and the peer connection', () => {
    const { transport, channel } = offerWithOpenChannel();
    transport.close();
    expect(channel.closed).toBe(true);
    expect(pc().closed).toBe(true);
  });

  it('defers the public onClose notification by a microtask, so close() never synchronously re-enters caller code', async () => {
    const { transport } = offerWithOpenChannel();
    const onClose = vi.fn();
    transport.onClose(onClose);
    transport.close();
    // Not synchronous: a caller (e.g. Session.close()) that calls
    // transport.close() from inside its own onClose handler must not be
    // re-entered before close() itself has returned.
    expect(onClose).not.toHaveBeenCalled();
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('transport closed');
  });
});

describe('WebRTCTransport.whenOpen', () => {
  it('resolves once the channel opens', async () => {
    const transport = WebRTCTransport.offer(vi.fn());
    const channel = pc().dataChannels[0]!;
    const opened = transport.whenOpen(1000);
    channel.simulateOpen();
    await expect(opened).resolves.toBeUndefined();
  });

  it('resolves immediately if the channel is already open', async () => {
    const transport = WebRTCTransport.offer(vi.fn());
    pc().dataChannels[0]!.simulateOpen();
    await expect(transport.whenOpen(1000)).resolves.toBeUndefined();
  });

  it('rejects if the channel never opens before the timeout', async () => {
    vi.useFakeTimers();
    const transport = WebRTCTransport.offer(vi.fn());
    const opened = transport.whenOpen(1000);
    const assertion = expect(opened).rejects.toThrow('data channel did not open in time');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('rejects if the peer connection fails before the channel opens', async () => {
    const transport = WebRTCTransport.offer(vi.fn());
    const opened = transport.whenOpen(1000);
    pc().connectionState = 'failed';
    pc().emit('connectionstatechange');
    await expect(opened).rejects.toThrow('peer connection failed');
  });

  it('rejects a pending whenOpen immediately when close() is called, not only once the timeout elapses', async () => {
    vi.useFakeTimers();
    const transport = WebRTCTransport.offer(vi.fn());
    const opened = transport.whenOpen(1000);
    const assertion = expect(opened).rejects.toThrow();
    transport.close();
    // No time advanced: if this only rejects via the timeout, the assertion
    // below hangs (and the test times out) rather than passing for free.
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('rejects a pending whenOpen promptly if the channel closes before it ever opens', async () => {
    // e.g. an SCTP-level failure while ICE is still nominally connected:
    // connectionstatechange never fires 'failed', only the channel does.
    vi.useFakeTimers();
    const transport = WebRTCTransport.offer(vi.fn());
    const channel = pc().dataChannels[0]!;
    const opened = transport.whenOpen(1000);
    const assertion = expect(opened).rejects.toThrow();
    channel.emit('close');
    // No time advanced: if this only rejects via the timeout, the assertion
    // below hangs (and the test times out) rather than passing for free.
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('rejects a pending whenOpen promptly if offer negotiation fails', async () => {
    vi.useFakeTimers();
    class FailingPeerConnection extends FakePeerConnection {
      constructor(config: RTCConfiguration) { super(config); this.failCreateOffer = true; lastPc = this; }
    }
    vi.stubGlobal('RTCPeerConnection', FailingPeerConnection as unknown as typeof RTCPeerConnection);
    const transport = WebRTCTransport.offer(vi.fn());
    const opened = transport.whenOpen(1000);
    const assertion = expect(opened).rejects.toThrow();
    // No time advanced: if this only rejects via the timeout, the assertion
    // below hangs (and the test times out) rather than passing for free.
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});

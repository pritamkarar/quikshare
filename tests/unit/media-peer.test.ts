// tests/unit/media-peer.test.ts
/*
 * MediaPeer proven the same way WebRTCTransport is in
 * tests/unit/webrtc-transport.test.ts: Node has no RTCPeerConnection, so a
 * fake stands in for the browser object, wired to just enough of the real
 * negotiation/event surface to exercise MediaPeer's own logic. It proves
 * nothing about real SDP/ICE/SCTP behaviour, which belongs to a Playwright
 * suite (later task), and it does not prove `t: media-*` frames actually
 * reach `MediaPeer` from the wire — `MediaPeer` never parses, so these
 * tests feed it `MediaControl` values directly, exactly like a caller who
 * already went through the Receiver's whitelist (shared/media-signal.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARE_QUALITY } from '../../client/media/share-quality.js';
import { MediaPeer, type MediaPeerEvents } from '../../client/media/media-peer.js';
import type { MediaControl } from '../../shared/messages.js';

type Listener = (event: any) => void;

class FakeEventTarget {
  #listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, cb: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) { set = new Set(); this.#listeners.set(type, set); }
    set.add(cb);
  }
  emit(type: string, event: unknown = {}): void {
    for (const cb of [...(this.#listeners.get(type) ?? [])]) cb(event);
  }
}

/** Stands in for a local MediaStreamTrack: only `stop()`/`stopped` matter here. */
class FakeTrack {
  stopped = false;
  /** Where `applyVideoQuality` writes the encoder's 'detail' / 'motion' hint. */
  contentHint = '';
  constructor(public kind: 'audio' | 'video') {}
  stop(): void { this.stopped = true; }
}

/**
 * Stands in for an RTCRtpSender, faithful on the one point that matters:
 * `setParameters` insists on being handed the object `getParameters` just
 * returned. A real browser rejects a hand-built RTCRtpSendParameters — the
 * transaction id has to match — so a fake that accepted anything would let
 * a wrong implementation pass.
 */
class FakeSender {
  #parameters: RTCRtpSendParameters;
  readonly applied: RTCRtpSendParameters[] = [];
  constructor(readonly track: FakeTrack | null, encodings: RTCRtpEncodingParameters[] = [{}]) {
    this.#parameters = { transactionId: 'tx-1', encodings, codecs: [], headerExtensions: [], rtcp: {} };
  }
  getParameters(): RTCRtpSendParameters { return this.#parameters; }
  async setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    if (parameters.transactionId !== this.#parameters.transactionId) {
      throw new Error('InvalidModificationError: parameters are not the last returned');
    }
    this.applied.push(structuredClone(parameters));
    this.#parameters = parameters;
  }
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

class FakeTransceiver {
  direction: RTCRtpTransceiverDirection;
  constructor(public track: unknown, init?: RTCRtpTransceiverInit) {
    this.direction = init?.direction ?? 'sendrecv';
  }
}

class FakePeerConnection extends FakeEventTarget {
  connectionState = 'new';
  localDescription: RTCSessionDescriptionInit | undefined;
  remoteDescription: RTCSessionDescriptionInit | undefined;
  readonly transceivers: FakeTransceiver[] = [];
  readonly iceCandidates: RTCIceCandidateInit[] = [];
  closed = false;
  /** Candidate strings that should make addIceCandidate reject, simulating a real browser's OperationError on a stale ufrag. */
  readonly rejectCandidates = new Set<string>();

  constructor(public config: RTCConfiguration) { super(); }

  addTransceiver(track: unknown, init?: RTCRtpTransceiverInit): FakeTransceiver {
    const t = new FakeTransceiver(track, init);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers(): FakeTransceiver[] { return this.transceivers; }
  senders: FakeSender[] = [];
  getSenders(): FakeSender[] { return this.senders; }
  statsReport: RTCStatsReport = new Map() as unknown as RTCStatsReport;
  async getStats(): Promise<RTCStatsReport> { return this.statsReport; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> { this.localDescription = desc; }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> { this.remoteDescription = desc; }
  /**
   * Deliberately does NOT implement a real browser's own "queue candidates
   * added before the remote description is set" behaviour — throwing here
   * instead. If MediaPeer relied on the browser to queue for it, this fake
   * would need to fake that queue too, and a test built on it would prove
   * nothing about MediaPeer's own handling. Throwing forces MediaPeer to
   * own the buffering itself, which is the decision this task makes (see
   * media-peer.ts's #pendingIce doc comment).
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) throw new Error('remote description not set');
    if (candidate.candidate && this.rejectCandidates.has(candidate.candidate)) {
      throw new Error('OperationError: usernameFragment does not match any applied remote description');
    }
    this.iceCandidates.push(candidate);
  }
  close(): void { this.closed = true; }
}

let lastPc: FakePeerConnection | undefined;

beforeEach(() => {
  lastPc = undefined;
  class Tracked extends FakePeerConnection { constructor(config: RTCConfiguration) { super(config); lastPc = this; } }
  vi.stubGlobal('RTCPeerConnection', Tracked as unknown as typeof RTCPeerConnection);
  // mediaRtcConfig() always makes one fetch('/turn'); stub it to resolve
  // fast and empty so these tests aren't about TURN at all.
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ iceServers: [], ttl: 0 }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pc(): FakePeerConnection {
  if (!lastPc) throw new Error('no peer connection constructed yet');
  return lastPc;
}

function fakeEvents(): MediaPeerEvents & {
  signals: MediaControl[];
  streams: MediaStream[];
  closes: string[];
} {
  const signals: MediaControl[] = [];
  const streams: MediaStream[] = [];
  const closes: string[] = [];
  return {
    signals,
    streams,
    closes,
    onSignal: (s) => signals.push(s),
    onRemoteStream: (s) => streams.push(s),
    onClosed: (r) => closes.push(r),
  };
}

/** Flushes the queueMicrotask() deferral #reportClosed uses, matching the
 * house pattern for WebRTCTransport's onClose (see its own doc comment). */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('MediaPeer', () => {
  /*
   * The other half of the no-TURN caution. `hasTurnServer` decides what a
   * config means (tests/unit/media-ice.test.ts); this proves the config it
   * gets to judge is the one actually handed to the connection, and that it
   * arrives without a second fetch. Both halves went untested when the
   * pairing-time /turn probe was removed, which put the gap on exactly the
   * code that change was about.
   */
  it('reports the fetched ICE config to onIceConfig, and builds the connection from that same config', async () => {
    const turn = { urls: ['turn:t.example.com:3478'], username: '123:quikshare', credential: 'abc==' };
    let fetches = 0;
    vi.stubGlobal('fetch', () => {
      fetches += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ iceServers: [turn], ttl: 600 }) });
    });
    const configs: RTCConfiguration[] = [];
    const events = { ...fakeEvents(), onIceConfig: (c: RTCConfiguration) => configs.push(c) };

    await MediaPeer.offer(fakeStream([]), 'camera', events);

    expect(configs).toHaveLength(1);
    // The relay must be present, or hasTurnServer would read this as no-TURN
    // and the caution would show on a deployment that has TURN working.
    expect(configs[0]!.iceServers).toContainEqual(turn);
    // Same object the connection got: reporting a config the peer did not
    // use would make the caution describe a deployment nobody is on.
    expect(pc().config).toBe(configs[0]);
    // One request per attempt. Two would defeat the point of removing the
    // mount-time probe, and /turn is rate limited per IP — which two devices
    // behind one NAT share between them.
    expect(fetches).toBe(1);
  });

  /*
   * answer() carries the identical two lines. Covering only offer() would
   * reproduce the asymmetry that shipped a Critical earlier in this work:
   * one termination path stopped its tracks and two did not, and the tests
   * mirrored the gap instead of catching it.
   */
  it('reports the fetched ICE config from answer() too', async () => {
    const turn = { urls: ['turn:t.example.com:3478'], username: '123:quikshare', credential: 'abc==' };
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ iceServers: [turn], ttl: 600 }),
    }));
    const configs: RTCConfiguration[] = [];
    const events = { ...fakeEvents(), onIceConfig: (c: RTCConfiguration) => configs.push(c) };

    await MediaPeer.answer(events);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.iceServers).toContainEqual(turn);
    expect(pc().config).toBe(configs[0]);
  });

  it('offer() adds every track from the stream as a sendonly transceiver, and emits a media-offer', async () => {
    const video = new FakeTrack('video');
    const audio = new FakeTrack('audio');
    const events = fakeEvents();

    await MediaPeer.offer(fakeStream([video, audio]), 'camera', events);

    expect(pc().transceivers).toHaveLength(2);
    expect(pc().transceivers.every((t) => t.direction === 'sendonly')).toBe(true);
    expect(events.signals).toEqual([{ t: 'media-offer', offer: { sdp: 'offer-sdp', kind: 'camera' } }]);
  });

  it('answer() sets every transceiver from the offer to recvonly and replies with media-answer', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.answer(events);
    // A real setRemoteDescription(offer) creates the transceiver; the fake
    // doesn't, so this stands in for the one it would have created.
    pc().transceivers.push(new FakeTransceiver(null));

    await peer.accept({ t: 'media-offer', offer: { sdp: 'remote-offer-sdp', kind: 'screen' } });

    expect(pc().remoteDescription).toEqual({ type: 'offer', sdp: 'remote-offer-sdp' });
    expect(pc().transceivers[0]?.direction).toBe('recvonly');
    expect(events.signals).toEqual([{ t: 'media-answer', answer: { sdp: 'answer-sdp' } }]);
  });

  it('accept() with an inbound media-answer reaches setRemoteDescription', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([]), 'camera', events);

    await peer.accept({ t: 'media-answer', answer: { sdp: 'remote-answer-sdp' } });

    expect(pc().remoteDescription).toEqual({ type: 'answer', sdp: 'remote-answer-sdp' });
  });

  it('emits locally-gathered ICE candidates as media-ice signals, and ignores end-of-candidates', async () => {
    const events = fakeEvents();
    await MediaPeer.offer(fakeStream([]), 'camera', events);
    events.signals.length = 0; // drop the media-offer emitted by offer() itself

    pc().emit('icecandidate', { candidate: { candidate: 'cand-a', sdpMid: '0', sdpMLineIndex: 0 } });
    pc().emit('icecandidate', { candidate: null });

    expect(events.signals).toEqual([
      { t: 'media-ice', ice: { candidate: 'cand-a', sdpMid: '0', sdpMLineIndex: 0 } },
    ]);
  });

  it('forwards an inbound media-ice to addIceCandidate once the remote description is already set', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([]), 'camera', events);
    await peer.accept({ t: 'media-answer', answer: { sdp: 'sdp' } });

    await peer.accept({ t: 'media-ice', ice: { candidate: 'cand-b', sdpMid: '0', sdpMLineIndex: 0 } });

    expect(pc().iceCandidates).toEqual([{ candidate: 'cand-b', sdpMid: '0', sdpMLineIndex: 0 }]);
  });

  /*
   * Fix round 1: usernameFragment used to be dropped by the whitelist
   * (shared/media-signal.ts) on the theory that addIceCandidate doesn't
   * strictly need it. That theory missed what the field is for — a
   * browser uses it to bind a candidate to the ICE generation it was
   * gathered for, and *rejects* addIceCandidate outright for a mismatched
   * one (webrtc-pc's OperationError — see the swallowed-rejection test 25
   * lines below) rather than silently ignoring it. Proving it all
   * the way through here (out on the wire, and back in to
   * addIceCandidate) is what LiveSession's glare handling leans on to make
   * a stale candidate from an abandoned attempt harmless without this
   * class tracking negotiation generations itself.
   */
  it('carries usernameFragment through in both directions', async () => {
    const events = fakeEvents();
    await MediaPeer.offer(fakeStream([]), 'camera', events);
    events.signals.length = 0;

    pc().emit('icecandidate', { candidate: { candidate: 'cand-a', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag-1' } });
    expect(events.signals).toEqual([
      { t: 'media-ice', ice: { candidate: 'cand-a', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag-1' } },
    ]);

    const peer = await MediaPeer.answer(events);
    await peer.accept({ t: 'media-offer', offer: { sdp: 'sdp', kind: 'camera' } });
    await peer.accept({ t: 'media-ice', ice: { candidate: 'cand-b', usernameFragment: 'ufrag-2' } });

    expect(pc().iceCandidates).toEqual([{ candidate: 'cand-b', usernameFragment: 'ufrag-2' }]);
  });

  /*
   * Fix round 2: a stale candidate's usernameFragment mismatch makes
   * addIceCandidate *reject* (webrtc-pc's OperationError) — that is the
   * whole point of carrying the field through (see the test above and
   * shared/media-signal.ts's doc comment). If that rejection propagated
   * out of accept(), LiveSession would treat one ordinary stale candidate
   * as the entire negotiation failing and tear down a connection that was
   * never actually broken. It must not propagate.
   */
  it('an ICE candidate rejecting (e.g. a stale ufrag) does not reject accept()', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([]), 'camera', events);
    await peer.accept({ t: 'media-answer', answer: { sdp: 'sdp' } });
    pc().rejectCandidates.add('stale');

    await expect(
      peer.accept({ t: 'media-ice', ice: { candidate: 'stale', usernameFragment: 'old-gen' } }),
    ).resolves.toBeUndefined();
    expect(pc().iceCandidates).toEqual([]);
  });

  it('flushing buffered ICE candidates keeps going past one that rejects, instead of dropping the rest of the queue', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([]), 'camera', events);

    await peer.accept({ t: 'media-ice', ice: { candidate: 'good-1' } });
    await peer.accept({ t: 'media-ice', ice: { candidate: 'stale' } });
    await peer.accept({ t: 'media-ice', ice: { candidate: 'good-2' } });
    pc().rejectCandidates.add('stale');

    await peer.accept({ t: 'media-answer', answer: { sdp: 'sdp' } });

    expect(pc().iceCandidates).toEqual([{ candidate: 'good-1' }, { candidate: 'good-2' }]);
  });

  it('buffers an inbound ICE candidate that arrives before the remote description, and flushes it once set', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([]), 'camera', events);

    // The fake's addIceCandidate throws unless remoteDescription is already
    // set (see its doc comment); this resolving cleanly is the proof
    // MediaPeer buffered instead of calling straight through.
    await expect(
      peer.accept({ t: 'media-ice', ice: { candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 } }),
    ).resolves.toBeUndefined();
    expect(pc().iceCandidates).toEqual([]);

    await peer.accept({ t: 'media-answer', answer: { sdp: 'sdp' } });

    expect(pc().iceCandidates).toEqual([{ candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 }]);
  });

  // Fix round 1 (Important): #pendingIce had no cap, so a peer that
  // trickles candidates but never sends an offer/answer could grow it
  // without bound. MAX_PENDING_ICE is 256 in the implementation; this uses
  // a smaller stand-in count for speed, proving the drop-beyond-cap
  // behaviour rather than the exact constant.
  it('drops buffered ICE candidates beyond the cap instead of growing without bound', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([]), 'camera', events);

    for (let i = 0; i < 300; i++) {
      await peer.accept({ t: 'media-ice', ice: { candidate: `c${i}`, sdpMid: '0', sdpMLineIndex: 0 } });
    }
    await peer.accept({ t: 'media-answer', answer: { sdp: 'sdp' } });

    expect(pc().iceCandidates.length).toBeLessThanOrEqual(256);
  });

  it('close() closes the connection, stops every local track, and fires onClosed exactly once', async () => {
    const video = new FakeTrack('video');
    const audio = new FakeTrack('audio');
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([video, audio]), 'camera', events);

    peer.close();
    peer.close(); // idempotent: still exactly one onClosed
    await flush();

    expect(pc().closed).toBe(true);
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
    expect(events.closes).toEqual(['closed locally']);
  });

  it('fires onClosed with a usable reason on a failed connection state', async () => {
    const events = fakeEvents();
    await MediaPeer.offer(fakeStream([]), 'camera', events);

    pc().connectionState = 'failed';
    pc().emit('connectionstatechange');
    await flush();

    expect(events.closes).toEqual(['peer connection failed']);
  });

  /*
   * The share that "dropped on its own after a few seconds", from a real
   * session on 2026-08-29. 'disconnected' is recoverable by definition — ICE
   * has stopped hearing back but has not given up — and a TURN-relayed
   * screen share across two networks passes through it on any burst of
   * loss. Ending the share there costs the user the whole stream for a blip
   * the browser would have healed on its own. Same ruling as the data path;
   * see tests/unit/webrtc-transport.test.ts.
   */
  it('rides out an ICE blip rather than ending the share on a disconnected state', async () => {
    const video = new FakeTrack('video');
    const events = fakeEvents();
    await MediaPeer.offer(fakeStream([video]), 'screen', events);

    pc().connectionState = 'disconnected';
    pc().emit('connectionstatechange');
    await flush();

    expect(events.closes).toEqual([]);
    // The stream is still running, not stopped out from under the preview.
    expect(video.stopped).toBe(false);

    pc().connectionState = 'connected';
    pc().emit('connectionstatechange');
    await flush();
    expect(events.closes).toEqual([]);
  });

  it('still ends the share once a disconnected connection gives up for good', async () => {
    const events = fakeEvents();
    await MediaPeer.offer(fakeStream([]), 'screen', events);

    pc().connectionState = 'disconnected';
    pc().emit('connectionstatechange');
    pc().connectionState = 'failed';
    pc().emit('connectionstatechange');
    await flush();

    expect(events.closes).toEqual(['peer connection failed']);
  });

  // Fix round 1 (Critical): track-stopping lived only in close() and left
  // the camera running on the other two termination paths. These two tests
  // fail against that code — a failed connection state, and a remote
  // media-stop, must each stop every local track exactly as close() does.

  it('stops every local track when the connection state goes to failed, not just on an explicit close()', async () => {
    const video = new FakeTrack('video');
    const audio = new FakeTrack('audio');
    const events = fakeEvents();
    await MediaPeer.offer(fakeStream([video, audio]), 'camera', events);

    pc().connectionState = 'failed';
    pc().emit('connectionstatechange');
    await flush();

    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
  });

  it('a remote media-stop fires onClosed exactly once, even alongside a later failed state, and stops local tracks', async () => {
    const video = new FakeTrack('video');
    const events = fakeEvents();
    const peer = await MediaPeer.offer(fakeStream([video]), 'camera', events);

    await peer.accept({ t: 'media-stop' });
    pc().connectionState = 'failed';
    pc().emit('connectionstatechange');
    await flush();

    expect(events.closes).toEqual(['remote stopped sharing']);
    expect(video.stopped).toBe(true);
  });

  it('delivers an inbound remote stream via onRemoteStream', async () => {
    const events = fakeEvents();
    await MediaPeer.answer(events);
    const remoteStream = fakeStream([]);

    pc().emit('track', { streams: [remoteStream] });

    expect(events.streams).toEqual([remoteStream]);
  });
});

describe('MediaPeer.applyVideoQuality', () => {
  async function offering() {
    const events = fakeEvents();
    const video = new FakeTrack('video');
    const peer = await MediaPeer.offer(fakeStream([video]), 'screen', events);
    const sender = new FakeSender(video);
    pc().senders = [sender];
    return { peer, sender, video };
  }

  it('steers the browser\'s own adaptation rather than setting a bitrate', async () => {
    const { peer, sender, video } = await offering();

    await peer.applyVideoQuality(SHARE_QUALITY.text);

    // The two knobs that decide HOW WebRTC's congestion control degrades.
    expect(video.contentHint).toBe('detail');
    expect(sender.applied.at(-1)?.degradationPreference).toBe('maintain-resolution');
    // And emphatically no ceiling: guessing a number for a network this
    // side has not measured is the mistake this design avoids.
    expect(sender.applied.at(-1)?.encodings[0]).toMatchObject({
      maxBitrate: undefined, maxFramerate: undefined, scaleResolutionDownBy: undefined,
    });
  });

  it('makes the opposite trade for motion', async () => {
    const { peer, sender, video } = await offering();
    await peer.applyVideoQuality(SHARE_QUALITY.motion);
    expect(video.contentHint).toBe('motion');
    expect(sender.applied.at(-1)?.degradationPreference).toBe('maintain-framerate');
  });

  it('applies a real ceiling only where the user asked for one', async () => {
    const { peer, sender } = await offering();
    await peer.applyVideoQuality(SHARE_QUALITY.data);
    // A ceiling is a constraint, not a second controller: congestion
    // control goes on working normally underneath it.
    expect(sender.applied.at(-1)?.encodings[0]).toMatchObject({
      maxBitrate: 600_000, maxFramerate: 10, scaleResolutionDownBy: 2,
    });
  });

  it('lifts a previous preset\'s ceiling instead of leaving it in force', async () => {
    const { peer, sender } = await offering();

    await peer.applyVideoQuality(SHARE_QUALITY.data);
    await peer.applyVideoQuality(SHARE_QUALITY.motion);

    // Without clearing these unconditionally, "Save data" would be a
    // one-way door: every later preset would still be capped at 0.6 Mbps
    // and ten frames a second, with nothing on screen to say so.
    expect(sender.applied.at(-1)?.encodings[0]).toMatchObject({
      maxBitrate: undefined, maxFramerate: undefined, scaleResolutionDownBy: undefined,
    });
  });

  it('leaves a sender with no encodings alone rather than inventing one', async () => {
    const events = fakeEvents();
    const video = new FakeTrack('video');
    const peer = await MediaPeer.offer(fakeStream([video]), 'screen', events);
    const sender = new FakeSender(video, []);
    pc().senders = [sender];

    await peer.applyVideoQuality(SHARE_QUALITY.data);

    // The preference still applies; an encoding entry is not conjured,
    // because adding one changes what is negotiated.
    expect(sender.applied.at(-1)?.degradationPreference).toBe('balanced');
    expect(sender.applied.at(-1)?.encodings).toEqual([]);
  });

  it('does nothing at all when there is no video sender', async () => {
    const events = fakeEvents();
    const peer = await MediaPeer.answer(events);
    pc().senders = [];
    await expect(peer.applyVideoQuality(SHARE_QUALITY.text)).resolves.toBeUndefined();
  });
});

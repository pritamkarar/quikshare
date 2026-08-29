// tests/unit/live-session.test.ts
/*
 * LiveSession owns the session's one live-media slot: who holds it, what
 * happens when both peers grab it in the same instant (glare), and every
 * way it gets torn down. It is proven here the same way MediaPeer is in
 * tests/unit/media-peer.test.ts — with fakes standing in for the browser
 * surface, so the suite runs under Node and says nothing about real SDP/ICE
 * negotiation, which is MediaPeer's job (and Playwright's, later).
 *
 * Both of LiveSession's collaborators are replaced with fakes via vi.mock:
 *  - client/media/media-peer.js: a FakeMediaPeer that records what it was
 *    given and lets a test simulate a remote track, a peer-initiated
 *    signal, or a connection failure by calling straight into the
 *    MediaPeerEvents LiveSession handed it.
 *  - client/media/capture.js: captureCamera/captureScreen become
 *    vi.fn()s a test points at a resolved stream or a rejected
 *    CaptureError, and onStreamEnded becomes a vi.fn() that stashes the
 *    callback LiveSession subscribed so a test can fire the browser's own
 *    "Stop sharing" chrome by hand. CaptureError/CaptureFailure are kept
 *    real (via importOriginal) since LiveSession does an `instanceof`
 *    check on the former and tests construct both directly.
 *
 * Every test that ends a share asserts the stream's tracks actually
 * stopped — per the task brief, that assertion is the one that matters.
 * A test that only checked `Slot` state could pass while the camera light
 * stayed on, exactly the Task 4 defect shape this task exists to not
 * repeat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaControl } from '../../shared/messages.js';
import type { MediaKind } from '../../shared/media-signal.js';
import type { MediaPeerEvents } from '../../client/media/media-peer.js';
import { DEFAULT_SHARE_PRESET, SHARE_QUALITY } from '../../client/media/share-quality.js';

/**
 * Stands in for a local MediaStreamTrack. `stop()`/`stopped` are what most
 * of this file needs; `getSettings`/`getCapabilities` exist so the camera
 * controls can be tested against the REAL `facingOf`/`hasTorch` (both are
 * pure reads, left unmocked below) rather than against a stub of them.
 */
class FakeTrack {
  stopped = false;
  constructor(
    public kind: 'audio' | 'video',
    readonly facingMode?: string,
    readonly torch = false,
  ) {}
  getSettings(): MediaTrackSettings {
    return (this.facingMode ? { facingMode: this.facingMode } : {}) as MediaTrackSettings;
  }
  getCapabilities(): MediaTrackCapabilities {
    return (this.torch ? { torch: true } : {}) as MediaTrackCapabilities;
  }
  stop(): void {
    this.stopped = true;
  }
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  // The SAME array every call, never a copy: a flip splices the video track
  // in place (FakeMediaPeer.replaceVideoTrack, mirroring the real
  // #localStream update), and a fresh array per call would hide that.
  return {
    getTracks: () => tracks,
    // Read by the camera-control state (LiveSession's #refreshCamera), which
    // runs after every successful camera start. A double missing it does not
    // fail a test on its own — the call is fire-and-forget — it surfaces as
    // an unhandled rejection attributed to whatever test happened to be
    // running at the time.
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

/**
 * One FakeMediaPeer per `offer()`/`answer()` call, tracked in the module-
 * scoped `peers` arrays below so a test can reach back into "the peer
 * LiveSession just created" without LiveSession exposing anything of its
 * own beyond the public `Slot`.
 *
 * `close()` mirrors the one piece of real MediaPeer behaviour these tests
 * depend on: it stops every track of the local stream it was built with
 * (undefined for an answerer, exactly like the real class). Everything
 * else — negotiation, ICE — is out of scope here; see media-peer.test.ts.
 */
class FakeMediaPeer {
  closed = false;
  readonly accepted: MediaControl[] = [];
  /** Every track handed to replaceVideoTrack, in order. */
  readonly replaced: MediaStreamTrack[] = [];
  /** Every quality preset applied, in order. */
  readonly qualities: unknown[] = [];
  /** What the next getStats() call resolves with. */
  statsReport: RTCStatsReport = new Map() as unknown as RTCStatsReport;
  statsCalls = 0;

  async applyVideoQuality(quality: unknown): Promise<void> {
    if (failures.qualityRejects) throw new Error('setParameters failed');
    this.qualities.push(quality);
  }

  async getStats(): Promise<RTCStatsReport> {
    this.statsCalls++;
    return this.statsReport;
  }

  constructor(
    readonly events: MediaPeerEvents,
    readonly stream?: MediaStream,
  ) {}

  async accept(signal: MediaControl): Promise<void> {
    // Lets a test hold this specific accept() call open at exactly the
    // point a real setRemoteDescription/addIceCandidate would still be
    // pending, so a *different* onMediaSignal()/start() call can be driven
    // to completion first — proving the identity guards in
    // onMediaSignal's catches (client/media/live-session.ts) protect a
    // concurrently-claimed attempt rather than assuming there's only ever
    // one in flight.
    if (failures.gateAccept) await nextGate();
    // Lets a test simulate Task 1's whitelist letting through a
    // syntactically-fine but unusable SDP/candidate — the whitelist
    // checks shape and length, never validity, so setRemoteDescription /
    // addIceCandidate rejecting on real garbage is a real, reachable path.
    if (failures.acceptRejects) throw new Error('setRemoteDescription failed');
    this.accepted.push(signal);
    // The real answerer emits media-answer from inside accept() once it has
    // processed the offer; faking that here is what lets a "did we answer"
    // assertion look at events.onSignal instead of reaching into the fake.
    if (signal.t === 'media-offer') {
      this.events.onSignal({ t: 'media-answer', answer: { sdp: 'fake-answer-sdp' } });
    }
  }

  /**
   * Mirrors the real class closely enough for a flip to be observable: the
   * swap lands in `#localStream`, which is the same object the slot and the
   * local preview hold, and the connection is emphatically NOT closed —
   * that is the whole property a flip has over a restart.
   */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    this.replaced.push(track);
    const stream = this.stream as unknown as { getTracks(): FakeTrack[] } | undefined;
    if (!stream) return;
    const tracks = stream.getTracks();
    const index = tracks.findIndex((t) => t.kind === 'video');
    if (index >= 0) tracks.splice(index, 1, track as unknown as FakeTrack);
  }

  close(): void {
    this.closed = true;
    this.stream?.getTracks().forEach((track) => track.stop());
  }
}

const peers: { offers: FakeMediaPeer[]; answers: FakeMediaPeer[] } = { offers: [], answers: [] };
/** Lets a test make the next MediaPeer.offer()/answer()/accept() call reject, simulating a real negotiation failure. */
const failures = { offerRejects: false, answerRejects: false, acceptRejects: false, gateCreation: false, gateAccept: false, qualityRejects: false };
/**
 * Resolvers for pending `nextGate()` promises, in the order they were
 * requested. Only consulted when `failures.gateCreation` or
 * `failures.gateAccept` is true — lets a test hold `MediaPeer.offer()`/
 * `answer()`/`accept()` open exactly at the point a real one would be
 * mid-negotiation, so two calls into `LiveSession` can be interleaved
 * deterministically and resolved in either order, instead of racing on
 * real timing.
 */
const gates: Array<() => void> = [];
function nextGate(): Promise<void> {
  return new Promise((resolve) => { gates.push(resolve); });
}
/** Flushes pending microtasks — lets an async LiveSession call run up to (or past) its next await before the test inspects or drives it further. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

vi.mock('../../client/media/media-peer.js', () => {
  class MockMediaPeer extends FakeMediaPeer {
    static async offer(stream: MediaStream, kind: MediaKind, events: MediaPeerEvents): Promise<MockMediaPeer> {
      if (failures.offerRejects) throw new Error('createOffer failed');
      if (failures.gateCreation) await nextGate();
      const peer = new MockMediaPeer(events, stream);
      events.onSignal({ t: 'media-offer', offer: { sdp: 'fake-offer-sdp', kind } });
      peers.offers.push(peer);
      return peer;
    }
    static async answer(events: MediaPeerEvents): Promise<MockMediaPeer> {
      if (failures.answerRejects) throw new Error('RTCPeerConnection construction failed');
      if (failures.gateCreation) await nextGate();
      const peer = new MockMediaPeer(events);
      peers.answers.push(peer);
      return peer;
    }
  }
  return { MediaPeer: MockMediaPeer };
});

const captureState: { onStreamEndedCb: (() => void) | undefined; unsub: ReturnType<typeof vi.fn> } = {
  onStreamEndedCb: undefined,
  unsub: vi.fn(),
};

vi.mock('../../client/media/capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/media/capture.js')>();
  return {
    ...actual,
    captureCamera: vi.fn(),
    captureCameraVideo: vi.fn(),
    captureScreen: vi.fn(),
    // Stubbed rather than left real: the real one reads
    // navigator.mediaDevices.enumerateDevices, and stubbing the global
    // navigator for this whole file would reach tests that have nothing to
    // do with cameras. `facingOf`/`hasTorch` stay real — they are pure
    // reads off the track, which FakeTrack above implements.
    countCameras: vi.fn(async () => 1),
    onStreamEnded: vi.fn((_stream: MediaStream, cb: () => void) => {
      captureState.onStreamEndedCb = cb;
      return captureState.unsub;
    }),
  };
});

// Imported after the mocks above so both modules resolve to the fakes.
const { LiveSession } = await import('../../client/media/live-session.js');
const {
  captureCamera, captureCameraVideo, captureScreen, countCameras, CaptureError,
} = await import('../../client/media/capture.js');

function fakeEvents() {
  return {
    onSlotChanged: vi.fn(),
    onSignal: vi.fn(),
    onFailure: vi.fn(),
    onStats: vi.fn(),
  };
}

/** How many of `events.onSignal`'s calls were a media-stop frame. */
function stopSignalCount(events: ReturnType<typeof fakeEvents>): number {
  return events.onSignal.mock.calls.filter((call: MediaControl[]) => call[0]?.t === 'media-stop').length;
}

beforeEach(() => {
  peers.offers = [];
  peers.answers = [];
  failures.offerRejects = false;
  failures.answerRejects = false;
  failures.acceptRejects = false;
  failures.gateCreation = false;
  failures.gateAccept = false;
  failures.qualityRejects = false;
  gates.length = 0;
  captureState.onStreamEndedCb = undefined;
  captureState.unsub.mockClear();
  vi.mocked(captureCamera).mockReset();
  vi.mocked(captureCameraVideo).mockReset();
  vi.mocked(captureScreen).mockReset();
  vi.mocked(countCameras).mockReset();
  // One camera by default, so every pre-existing test in this file keeps
  // rendering a share with no flip control, exactly as it did before.
  vi.mocked(countCameras).mockResolvedValue(1);
});

describe('LiveSession', () => {
  it('starting a share on a free slot offers and marks the slot owned locally', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    const stream = fakeStream(tracks);
    vi.mocked(captureCamera).mockResolvedValue(stream);
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');

    expect(peers.offers).toHaveLength(1);
    expect(peers.offers[0]?.stream).toBe(stream);
    expect(events.onSignal).toHaveBeenCalledWith({ t: 'media-offer', offer: { sdp: 'fake-offer-sdp', kind: 'camera' } });
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'offering', kind: 'camera', stream }));
  });

  it('an inbound offer on a free slot answers it and marks the slot owned remotely', async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'screen' } });

    expect(peers.answers).toHaveLength(1);
    expect(peers.answers[0]?.accepted).toEqual([{ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'screen' } }]);
    expect(events.onSignal).toHaveBeenCalledWith({ t: 'media-answer', answer: { sdp: 'fake-answer-sdp' } });
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving', kind: 'screen' }));
  });

  it('candidates that arrive before the offer they belong to are replayed into the peer, not dropped', async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    // An offerer trickles its first host candidates within a millisecond of
    // setLocalDescription — while this side is still fetching /turn and has
    // no MediaPeer at all. Dropping them left the connection to rediscover
    // the offerer peer-reflexively, which is what fails across a real
    // network.
    await session.onMediaSignal({ t: 'media-ice', ice: { candidate: 'cand-1' } });
    await session.onMediaSignal({ t: 'media-ice', ice: { candidate: 'cand-2' } });
    expect(peers.answers).toHaveLength(0);

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'camera' } });

    expect(peers.answers[0]?.accepted).toEqual([
      { t: 'media-ice', ice: { candidate: 'cand-1' } },
      { t: 'media-ice', ice: { candidate: 'cand-2' } },
      { t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'camera' } },
    ]);
  });

  it('a buffered candidate belongs to one offer only — a second negotiation does not replay it again', async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.onMediaSignal({ t: 'media-ice', ice: { candidate: 'cand-1' } });
    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'first', kind: 'camera' } });
    await session.onMediaSignal({ t: 'media-stop' });
    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'second', kind: 'camera' } });

    expect(peers.answers[1]?.accepted).toEqual([{ t: 'media-offer', offer: { sdp: 'second', kind: 'camera' } }]);
  });

  it('an answer arriving with no peer to apply it to is still discarded', async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.onMediaSignal({ t: 'media-answer', answer: { sdp: 'nobody-asked' } });
    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'camera' } });

    expect(peers.answers[0]?.accepted).toEqual([{ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'camera' } }]);
  });

  it('glare as the polite peer (b): abandons its own offer, stops its tracks, answers the incoming offer', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('b', events);

    await session.start('camera');
    const ownAttempt = peers.offers[0]!;

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'incoming-sdp', kind: 'screen' } });

    // The privacy-critical assertion: our own abandoned attempt actually
    // released the camera, not just the RTCPeerConnection object.
    expect(ownAttempt.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);

    expect(peers.answers).toHaveLength(1);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving', kind: 'screen' }));

    // No echo: our offer never reached a MediaPeer on the far end (they
    // were mid-offer themselves), so there is nothing there to tell.
    expect(stopSignalCount(events)).toBe(0);
  });

  it('glare as the impolite peer (a): ignores the incoming offer, its own attempt continues', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    const ownAttempt = peers.offers[0]!;

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'incoming-sdp', kind: 'screen' } });

    expect(ownAttempt.closed).toBe(false);
    expect(tracks.some((t) => t.stopped)).toBe(false);
    expect(peers.answers).toHaveLength(0);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'offering', kind: 'camera' }));
  });

  it('media-stop from the peer releases the slot and stops local tracks, without echoing media-stop back', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    // The peer answers, so this also exercises the offering -> sending
    // transition on the way to the state media-stop has to release from.
    await session.onMediaSignal({ t: 'media-answer', answer: { sdp: 'their-answer' } });
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'sending' }));
    const peer = peers.offers[0]!;

    await session.onMediaSignal({ t: 'media-stop' });

    expect(peer.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith({ state: 'idle' });
    // The teardown was caused by receiving media-stop; echoing it back
    // would bounce forever between two peers each announcing "I stopped".
    expect(stopSignalCount(events)).toBe(0);
  });

  it('starting a second share locally replaces the first, stopping its tracks', async () => {
    const firstTracks = [new FakeTrack('video'), new FakeTrack('audio')];
    const secondTracks = [new FakeTrack('video')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(firstTracks));
    vi.mocked(captureScreen).mockResolvedValue(fakeStream(secondTracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    const first = peers.offers[0]!;
    await session.start('screen');

    expect(first.closed).toBe(true);
    expect(firstTracks.every((t) => t.stopped)).toBe(true);
    expect(secondTracks.every((t) => t.stopped)).toBe(false);
    expect(peers.offers).toHaveLength(2);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'offering', kind: 'screen' }));
    // We were sending the first stream; the peer needs to be told it ended
    // before the new offer arrives, or their UI keeps rendering it.
    expect(stopSignalCount(events)).toBe(1);
  });

  it('a peer leaving releases the slot and stops local tracks', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    const peer = peers.offers[0]!;

    session.onPeerLeft();

    expect(peer.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith({ state: 'idle' });
  });

  it('stop() ends a locally-started share, telling the peer', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    const peer = peers.offers[0]!;

    session.stop();

    expect(peer.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith({ state: 'idle' });
    expect(stopSignalCount(events)).toBe(1);
  });

  it('a connection failure releases the slot, stops tracks, tells the peer, and reports the failure', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    const peer = peers.offers[0]!;

    // Simulates MediaPeer's connectionstatechange handler reporting a
    // terminal state, exactly as it would after real ICE gives up.
    peer.events.onClosed('peer connection failed');

    expect(peer.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith({ state: 'idle' });
    expect(stopSignalCount(events)).toBe(1);
    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'connect-failed' });
  });

  it('the browser\'s own "Stop sharing" chrome ends a screen share the same way a local stop does', async () => {
    const tracks = [new FakeTrack('video')];
    vi.mocked(captureScreen).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('screen');
    const peer = peers.offers[0]!;
    expect(captureState.onStreamEndedCb).toBeDefined();

    // The user clicked the browser's native "Stop sharing" bar, not our UI.
    captureState.onStreamEndedCb!();

    expect(peer.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith({ state: 'idle' });
    expect(stopSignalCount(events)).toBe(1);
  });

  it('a capture failure reports onFailure and leaves the slot untouched', async () => {
    vi.mocked(captureCamera).mockRejectedValue(new CaptureError({ reason: 'denied' }));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');

    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'denied' });
    expect(peers.offers).toHaveLength(0);
    expect(events.onSlotChanged).not.toHaveBeenCalled();
  });

  /*
   * Fix round 1, Critical: MediaPeer.offer() rejecting used to leave a
   * captured MediaStream that nothing in this class could ever reach
   * again. The slot stayed 'idle' (it only ever moves off idle *after*
   * offer() resolves), so #release() — which only acts when the slot is
   * non-idle — silently no-op'd against it for the lifetime of the page.
   * The tracks-stopped assertion below is the one that would have caught
   * it; a state-only assertion would have passed on the broken code, since
   * the slot really was (wrongly) idle.
   */
  it("MediaPeer.offer() rejecting stops the already-captured tracks and reports connect-failed", async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    failures.offerRejects = true;
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');

    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'connect-failed' });
    expect(peers.offers).toHaveLength(0);
    // Never claimed the slot, so there is nothing to announce as offering
    // and nothing for a later stop()/onPeerLeft() to find and no-op on.
    expect(events.onSlotChanged).not.toHaveBeenCalled();
    // The onStreamEnded subscription start() registered for this stream
    // must not be left dangling either.
    expect(captureState.unsub).toHaveBeenCalled();
  });

  it('MediaPeer.answer() rejecting an inbound offer reports connect-failed without claiming the slot', async () => {
    failures.answerRejects = true;
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'camera' } });

    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'connect-failed' });
    expect(peers.answers).toHaveLength(0);
    expect(events.onSlotChanged).not.toHaveBeenCalled();
  });

  it("a peer's unusable answer (past the whitelist, rejected by setRemoteDescription) releases the offering slot and reports connect-failed", async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    const peer = peers.offers[0]!;
    failures.acceptRejects = true;

    await session.onMediaSignal({ t: 'media-answer', answer: { sdp: 'garbage' } });

    expect(peer.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith({ state: 'idle' });
    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'connect-failed' });
  });

  it("a peer's unusable offer (past the whitelist, rejected by setRemoteDescription) leaves the slot idle and reports connect-failed", async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);
    failures.acceptRejects = true;

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'garbage', kind: 'camera' } });

    expect(peers.answers).toHaveLength(1);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith({ state: 'idle' });
    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'connect-failed' });
  });

  /*
   * Fix round 2, Critical (residue): round 1's fix only covered
   * MediaPeer.offer()/answer() *rejecting*. A second attempt claiming (or
   * clearing) #slot while the first is still awaiting its own
   * MediaPeer.offer()/answer() to *resolve* left the loser's peer/stream
   * just as unreachable — #slot never pointed to it, so #release() had no
   * way to find it. This is the exact moment simultaneous Share clicks (or
   * a local Share racing an inbound offer) actually collide in real use;
   * the synchronous 'offering'-state glare check the rest of this suite
   * exercises only sees the race once both sides have already finished
   * negotiating.
   *
   * failures.gateCreation holds MediaPeer.offer()/answer() open at exactly
   * that point so these tests can resolve two concurrent attempts in
   * either order, deterministically, rather than racing on real timing.
   */
  it('start() racing an inbound offer: start() finishing first wins, the answer attempt is abandoned and closed', async () => {
    const localTracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(localTracks));
    failures.gateCreation = true;
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    const startPromise = session.start('camera');
    await flush(); // let start() run through capture()/#release() up to its own gate
    const signalPromise = session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'screen' } });
    await flush(); // onMediaSignal has no await before its own gate, but flush for symmetry/safety
    expect(gates).toHaveLength(2);

    gates[0]!(); // start()'s MediaPeer.offer() finishes first
    await startPromise;
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'offering', kind: 'camera' }));

    gates[1]!(); // onMediaSignal's MediaPeer.answer() finishes second, into a slot start() already claimed
    await signalPromise;

    expect(peers.answers).toHaveLength(1);
    expect(peers.answers[0]!.closed).toBe(true); // the abandoned answer attempt's own MediaPeer, closed directly
    expect(localTracks.some((t) => t.stopped)).toBe(false); // start()'s own share is untouched
    expect(events.onFailure).not.toHaveBeenCalled(); // overtaken, not a failure
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'offering', kind: 'camera' })); // never overwritten
  });

  it('start() racing an inbound offer: the inbound offer finishing first wins, start()\'s captured stream is released', async () => {
    const localTracks = [new FakeTrack('video'), new FakeTrack('audio')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(localTracks));
    failures.gateCreation = true;
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    const startPromise = session.start('camera');
    await flush();
    const signalPromise = session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'screen' } });
    await flush();
    expect(gates).toHaveLength(2);

    gates[1]!(); // the inbound offer's MediaPeer.answer() finishes first
    await signalPromise;
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving', kind: 'screen' }));

    gates[0]!(); // start()'s MediaPeer.offer() finishes second, into a slot it no longer owns
    await startPromise;

    expect(peers.offers).toHaveLength(1);
    expect(peers.offers[0]!.closed).toBe(true); // start()'s own MediaPeer, closed rather than written to #slot
    expect(localTracks.every((t) => t.stopped)).toBe(true); // the camera light actually goes out
    expect(events.onFailure).not.toHaveBeenCalled(); // overtaken, not a failure
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving', kind: 'screen' })); // never overwritten
  });

  it('two overlapping start() calls: whichever finishes first wins, the other is abandoned and its tracks stopped', async () => {
    const firstTracks = [new FakeTrack('video')];
    const secondTracks = [new FakeTrack('video')];
    vi.mocked(captureCamera)
      .mockResolvedValueOnce(fakeStream(firstTracks))
      .mockResolvedValueOnce(fakeStream(secondTracks));
    failures.gateCreation = true;
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    const firstStart = session.start('camera');
    await flush();
    const secondStart = session.start('camera');
    await flush();
    expect(gates).toHaveLength(2);

    gates[1]!(); // the second call's offer() finishes first
    await secondStart;
    expect(peers.offers).toHaveLength(1);
    const winner = peers.offers[0]!;

    gates[0]!(); // the first call's offer() finishes second, into a slot it no longer owns
    await firstStart;

    expect(peers.offers).toHaveLength(2);
    const loser = peers.offers[1]!;
    expect(loser).not.toBe(winner);
    expect(loser.closed).toBe(true);
    expect(firstTracks.every((t) => t.stopped)).toBe(true); // the first call's own capture is released
    expect(secondTracks.some((t) => t.stopped)).toBe(false); // the winning share is untouched
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'offering', peer: winner }));
  });

  /*
   * Fix round 3, Critical (residue continued): the creation-race guards
   * above protect a peer/stream that hasn't been written to #slot yet.
   * These three guard the opposite moment — a peer that *was* written to
   * #slot, but whose accept() is still pending when a completely
   * different, later attempt legitimately takes the slot in its place.
   * onMediaSignal is dispatched fire-and-forget per signal
   * (client/transfer/receiver.ts:496-511), so this interleaving is real,
   * not hypothetical: since the whitelist validates SDP by shape and
   * length only, never validity, a peer can trigger it deliberately by
   * sending a garbage follow-up for an exchange it has itself since
   * abandoned, timed to land while a different, unrelated share is live.
   * failures.gateAccept + the same gates/nextGate() plumbing as the
   * creation-race tests holds one specific accept() call open so a test
   * can let a different attempt legitimately claim the slot first.
   */
  it("a stale attempt's accept() rejecting does not tear down a different, currently-claimed attempt", async () => {
    const currentTracks = [new FakeTrack('video')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream([new FakeTrack('video')]));
    vi.mocked(captureScreen).mockResolvedValue(fakeStream(currentTracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    // The stale attempt: we start sharing, the peer answers, but that
    // accept() is gated (and, once released, rejects) so it's still
    // pending when the slot moves on to something else.
    await session.start('camera');
    const stalePeer = peers.offers[0]!;
    failures.gateAccept = true;
    failures.acceptRejects = true;
    const stalePromise = session.onMediaSignal({ t: 'media-answer', answer: { sdp: 'stale-answer' } });
    await flush();
    expect(gates).toHaveLength(1);

    // While that's still pending, this share ends and a different,
    // unrelated one legitimately takes the slot.
    session.stop();
    await session.start('screen');
    const currentPeer = peers.offers[1]!;
    expect(stalePeer.closed).toBe(true); // closed legitimately, by stop() above
    events.onSlotChanged.mockClear();
    events.onFailure.mockClear();

    gates[0]!(); // the stale accept() finally rejects
    await stalePromise;

    expect(events.onFailure).not.toHaveBeenCalled(); // no spurious connect-failed blamed on the current attempt's peer
    expect(events.onSlotChanged).not.toHaveBeenCalled(); // the current attempt's slot is untouched
    expect(currentTracks.every((t) => t.stopped)).toBe(false); // its camera/screen light stays on
    expect(currentPeer.closed).toBe(false);
  });

  it("a stale attempt's accept() resolving does not mislabel a different, currently-offering attempt as sending", async () => {
    vi.mocked(captureCamera).mockResolvedValue(fakeStream([new FakeTrack('video')]));
    vi.mocked(captureScreen).mockResolvedValue(fakeStream([new FakeTrack('video')]));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.start('camera');
    failures.gateAccept = true;
    const stalePromise = session.onMediaSignal({ t: 'media-answer', answer: { sdp: 'stale-answer' } });
    await flush();
    expect(gates).toHaveLength(1);

    session.stop();
    await session.start('screen'); // a different, unrelated attempt is now 'offering'
    events.onSlotChanged.mockClear();

    gates[0]!(); // the stale accept() now succeeds, too late to matter
    await stalePromise;

    // Must still be 'offering' — not promoted to 'sending' by an answer
    // that belonged to a different, already-abandoned attempt.
    expect(events.onSlotChanged).not.toHaveBeenCalled();
  });

  it("a stale receiving attempt's accept() rejecting does not tear down a different, currently-claimed attempt", async () => {
    const currentTracks = [new FakeTrack('video')];
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(currentTracks));
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    // An inbound offer is answered, but the accept() that processes it —
    // the same call that would emit media-answer — is gated (and, once
    // released, rejects), so it's still pending when the slot moves on.
    failures.gateAccept = true;
    failures.acceptRejects = true;
    const stalePromise = session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'screen' } });
    await flush();
    expect(gates).toHaveLength(1);
    const stalePeer = peers.answers[0]!;
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving', kind: 'screen' }));

    // While that's still pending, the local user starts their own share
    // instead — start()'s #release() legitimately overrides it.
    await session.start('camera');
    const currentPeer = peers.offers[0]!;
    expect(stalePeer.closed).toBe(true);
    events.onSlotChanged.mockClear();
    events.onFailure.mockClear();

    gates[0]!(); // the stale attempt's accept() finally rejects
    await stalePromise;

    expect(events.onFailure).not.toHaveBeenCalled();
    expect(events.onSlotChanged).not.toHaveBeenCalled();
    expect(currentTracks.every((t) => t.stopped)).toBe(false);
    expect(currentPeer.closed).toBe(false);
  });

  /*
   * onRemoteStream is the connecting -> live transition — the moment the
   * "connecting" state Slot's optional receiving.stream exists to express
   * actually resolves into something the UI can render. Untested until
   * fix round 1.
   */
  it('a remote track arriving fills in the receiving slot\'s stream', async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'camera' } });
    const peer = peers.answers[0]!;
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving' }));
    expect((events.onSlotChanged.mock.calls.at(-1)?.[0] as { stream?: MediaStream }).stream).toBeUndefined();

    const remoteStream = fakeStream([new FakeTrack('video')]);
    peer.events.onRemoteStream(remoteStream);

    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving', stream: remoteStream }));
  });

  it("a stale MediaPeer's remote track, arriving after the slot moved on, is ignored", async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'remote-sdp', kind: 'camera' } });
    const stalePeer = peers.answers[0]!;
    session.stop(); // the slot is idle again; stalePeer is no longer this session's peer
    events.onSlotChanged.mockClear();

    stalePeer.events.onRemoteStream(fakeStream([new FakeTrack('video')]));

    expect(events.onSlotChanged).not.toHaveBeenCalled();
  });

  // Fix round 2 (Minor): the test above reaches idle via stop(), so it only
  // pins the `state === 'receiving'` half of onRemoteStream's guard — a
  // weakened guard that dropped the `peer === getPeer()` identity check
  // would still pass it. This pins the identity half: the slot stays
  // 'receiving' throughout, just for a different peer.
  it("a stale MediaPeer's remote track is ignored even while the slot is still 'receiving', for a different peer", async () => {
    const events = fakeEvents();
    const session = new LiveSession('a', events);

    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'first', kind: 'camera' } });
    const stalePeer = peers.answers[0]!;
    await session.onMediaSignal({ t: 'media-offer', offer: { sdp: 'second', kind: 'screen' } }); // replaces it, still 'receiving'
    const currentPeer = peers.answers[1]!;
    events.onSlotChanged.mockClear();

    stalePeer.events.onRemoteStream(fakeStream([new FakeTrack('video')]));
    expect(events.onSlotChanged).not.toHaveBeenCalled();

    // Sanity: the guard isn't just "state === receiving" — the current peer's own stream still works.
    const currentStream = fakeStream([new FakeTrack('video')]);
    currentPeer.events.onRemoteStream(currentStream);
    expect(events.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'receiving', stream: currentStream }));
  });
});

describe('LiveSession camera controls', () => {
  /** A camera share already running, with the slot's camera state settled. */
  async function sharing(
    events: ReturnType<typeof fakeEvents>,
    tracks: FakeTrack[],
    cameras = 2,
  ) {
    vi.mocked(countCameras).mockResolvedValue(cameras);
    vi.mocked(captureCamera).mockResolvedValue(fakeStream(tracks));
    const session = new LiveSession('a', events);
    await session.start('camera');
    // #refreshCamera is fire-and-forget, so the controls arrive one turn
    // after the preview does.
    await flush();
    return session;
  }

  /** The most recent slot the session published. */
  function latestSlot(events: ReturnType<typeof fakeEvents>) {
    return events.onSlotChanged.mock.calls.at(-1)?.[0];
  }

  it('reports what the live track can do, not what the device might', async () => {
    const events = fakeEvents();
    await sharing(events, [new FakeTrack('video', 'user', true), new FakeTrack('audio')]);

    expect(latestSlot(events).camera).toEqual({
      facing: 'user', canFlip: true, canTorch: true, torchOn: false, busy: false,
    });
  });

  it('offers no flip on a device with one camera', async () => {
    const events = fakeEvents();
    await sharing(events, [new FakeTrack('video', 'user')], 1);
    expect(latestSlot(events).camera).toMatchObject({ canFlip: false, canTorch: false });
  });

  it('has no camera state at all for a screen share', async () => {
    const events = fakeEvents();
    vi.mocked(countCameras).mockResolvedValue(2);
    vi.mocked(captureScreen).mockResolvedValue(fakeStream([new FakeTrack('video')]));
    const session = new LiveSession('a', events);
    await session.start('screen');
    await flush();

    expect(latestSlot(events).camera).toBeUndefined();
    // And the controls cannot be driven into one either.
    await session.flipCamera();
    expect(vi.mocked(captureCameraVideo)).not.toHaveBeenCalled();
  });

  it('swaps the track into the live connection instead of restarting the share', async () => {
    const events = fakeEvents();
    const front = new FakeTrack('video', 'user');
    const audio = new FakeTrack('audio');
    const session = await sharing(events, [front, audio]);
    const rear = new FakeTrack('video', 'environment', true);
    vi.mocked(captureCameraVideo).mockResolvedValue(fakeStream([rear]));

    await session.flipCamera();
    await flush();

    const peer = peers.offers[0]!;
    expect(vi.mocked(captureCameraVideo)).toHaveBeenCalledWith('environment');
    expect(peer.replaced).toEqual([rear]);
    // The whole point: the peer connection survives, so the receiver's
    // video never stops — it just shows a different view.
    expect(peer.closed).toBe(false);
    expect(stopSignalCount(events)).toBe(0);
    // The old camera is released, the microphone is untouched.
    expect(front.stopped).toBe(true);
    expect(audio.stopped).toBe(false);
  });

  it('re-derives the controls from the camera it flipped to', async () => {
    const events = fakeEvents();
    const session = await sharing(events, [new FakeTrack('video', 'user'), new FakeTrack('audio')]);
    vi.mocked(captureCameraVideo).mockResolvedValue(fakeStream([new FakeTrack('video', 'environment', true)]));

    await session.flipCamera();
    await flush();

    // The front camera had no lamp and the rear one does: a control carried
    // forward from the previous track would have been wrong in both
    // directions.
    expect(latestSlot(events).camera).toEqual({
      facing: 'environment', canFlip: true, canTorch: true, torchOn: false, busy: false,
    });
  });

  it('re-arms the ended listener, so a camera lost after a flip is still noticed', async () => {
    const events = fakeEvents();
    const session = await sharing(events, [new FakeTrack('video', 'user'), new FakeTrack('audio')]);
    vi.mocked(captureCameraVideo).mockResolvedValue(fakeStream([new FakeTrack('video', 'environment')]));
    captureState.unsub.mockClear();

    await session.flipCamera();
    await flush();

    // The listener start() registered was on the track just stopped. Without
    // re-subscribing, this device would keep claiming to share a stream
    // nothing feeds.
    expect(captureState.unsub).toHaveBeenCalled();
    captureState.onStreamEndedCb?.();
    expect(latestSlot(events).state).toBe('idle');
  });

  it('drops a flip that was overtaken, rather than lighting a camera nobody owns', async () => {
    const events = fakeEvents();
    const session = await sharing(events, [new FakeTrack('video', 'user'), new FakeTrack('audio')]);
    const orphan = new FakeTrack('video', 'environment');
    let release!: () => void;
    vi.mocked(captureCameraVideo).mockReturnValue(new Promise((resolve) => {
      release = () => resolve(fakeStream([orphan]));
    }));

    const flipping = session.flipCamera();
    // The user gave up on the whole share while the camera was still opening.
    session.stop();
    release();
    await flipping;

    // Nothing else knows about this track — the slot is idle, so the normal
    // teardown path cannot find it. Left running, its recording indicator
    // would stay lit.
    expect(orphan.stopped).toBe(true);
    expect(peers.offers[0]?.replaced).toEqual([]);
  });

  it('reports a refused camera without tearing down the share already running', async () => {
    const events = fakeEvents();
    const video = new FakeTrack('video', 'user');
    const session = await sharing(events, [video, new FakeTrack('audio')]);
    vi.mocked(captureCameraVideo).mockRejectedValue(new CaptureError({ reason: 'denied' }));

    await session.flipCamera();

    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'denied' });
    // The share the user already had is worth more than the flip they asked
    // for: it keeps running, and the control comes back off busy.
    expect(latestSlot(events).state).toBe('offering');
    expect(latestSlot(events).camera).toMatchObject({ facing: 'user', busy: false });
    expect(video.stopped).toBe(false);
  });

  it('drives the lamp on the live track and publishes that it is lit', async () => {
    const events = fakeEvents();
    const video = new FakeTrack('video', 'environment', true);
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    Reflect.set(video, 'applyConstraints', applyConstraints);
    const session = await sharing(events, [video, new FakeTrack('audio')]);

    await session.setTorch(true);

    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    expect(latestSlot(events).camera).toMatchObject({ torchOn: true });
  });

  it('will not try to light a camera that has no lamp', async () => {
    const events = fakeEvents();
    const video = new FakeTrack('video', 'user');
    const applyConstraints = vi.fn();
    Reflect.set(video, 'applyConstraints', applyConstraints);
    const session = await sharing(events, [video, new FakeTrack('audio')]);

    await session.setTorch(true);

    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it('says so when the lamp refuses, rather than leaving a button that looks like it worked', async () => {
    const events = fakeEvents();
    const video = new FakeTrack('video', 'environment', true);
    Reflect.set(video, 'applyConstraints', vi.fn().mockRejectedValue(new Error('torch unsupported')));
    const session = await sharing(events, [video, new FakeTrack('audio')]);

    await session.setTorch(true);

    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'failed', detail: 'torch unsupported' });
    expect(latestSlot(events).camera).toMatchObject({ torchOn: false });
  });
});

describe('LiveSession screen share quality', () => {
  function statsReport(bytesSent: number, timestamp: number): RTCStatsReport {
    return new Map([
      ['v', {
        type: 'outbound-rtp', kind: 'video', bytesSent, timestamp,
        frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30,
      }],
    ]) as unknown as RTCStatsReport;
  }

  async function screenSharing(events: ReturnType<typeof fakeEvents>) {
    vi.mocked(captureScreen).mockResolvedValue(fakeStream([new FakeTrack('video')]));
    const session = new LiveSession('a', events);
    await session.start('screen');
    await flush();
    return session;
  }

  function latestSlot(events: ReturnType<typeof fakeEvents>) {
    return events.onSlotChanged.mock.calls.at(-1)?.[0];
  }

  it('opens a screen share on the readable preset rather than the encoder\'s guess', async () => {
    const events = fakeEvents();
    await screenSharing(events);

    expect(peers.offers[0]?.qualities).toEqual([SHARE_QUALITY[DEFAULT_SHARE_PRESET]]);
    expect(latestSlot(events).preset).toBe(DEFAULT_SHARE_PRESET);
  });

  it('applies a chosen preset and publishes which one is in force', async () => {
    const events = fakeEvents();
    const session = await screenSharing(events);

    await session.setSharePreset('data');

    expect(peers.offers[0]?.qualities.at(-1)).toEqual(SHARE_QUALITY.data);
    expect(latestSlot(events).preset).toBe('data');
  });

  it('leaves a camera share alone — it has its own controls', async () => {
    const events = fakeEvents();
    vi.mocked(countCameras).mockResolvedValue(1);
    vi.mocked(captureCamera).mockResolvedValue(fakeStream([new FakeTrack('video', 'user')]));
    const session = new LiveSession('a', events);
    await session.start('camera');
    await flush();

    await session.setSharePreset('motion');

    expect(peers.offers[0]?.qualities).toEqual([]);
    expect(latestSlot(events).preset).toBeUndefined();
  });

  it('says so when a preset will not apply, instead of showing it as selected', async () => {
    const events = fakeEvents();
    const session = await screenSharing(events);
    failures.qualityRejects = true;

    await session.setSharePreset('motion');

    expect(events.onFailure).toHaveBeenCalledWith({ reason: 'failed', detail: 'setParameters failed' });
    // Still the preset that is actually in force, not the one that failed.
    expect(latestSlot(events).preset).toBe(DEFAULT_SHARE_PRESET);
  });

  it('reports what the stream is doing, and clears it the moment sharing stops', async () => {
    // shouldAdvanceTime, so this file's own setTimeout-based flush() still
    // resolves while the stats interval is under test control.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const events = fakeEvents();
      const session = await screenSharing(events);
      const peer = peers.offers[0]!;

      peer.statsReport = statsReport(1_000_000, 10_000);
      await vi.advanceTimersByTimeAsync(2_000);
      // First reading has no history, so resolution but no rate. The key is
      // omitted rather than set to undefined, which is why this is two
      // assertions and not one toMatchObject.
      expect(events.onStats.mock.calls.at(-1)?.[0]).toMatchObject({ width: 1920, height: 1080, fps: 30 });
      expect(events.onStats.mock.calls.at(-1)?.[0]?.kbps).toBeUndefined();

      peer.statsReport = statsReport(1_250_000, 12_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(events.onStats.mock.calls.at(-1)?.[0]).toMatchObject({ kbps: 1000 });

      session.stop();
      // Cleared explicitly: a stopped share must not leave its last reading
      // on screen looking live.
      expect(events.onStats.mock.calls.at(-1)?.[0]).toBeUndefined();

      const callsAfterStop = peer.statsCalls;
      await vi.advanceTimersByTimeAsync(10_000);
      // And the timer is gone, not merely ignored — it would otherwise poll
      // a closed connection for the life of the page.
      expect(peer.statsCalls).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * The reason stats are an event of their own rather than a field on Slot.
   *
   * A slot change bumps #generation, which is precisely how an in-flight
   * start()/accept() learns it was overtaken. A reading published on a
   * two-second timer would bump it continuously and cancel negotiations
   * that had nothing wrong with them — a bug that would only ever show up
   * on a slow connection, where the negotiation is long enough for a tick
   * to land inside it.
   */
  it('never lets a stats reading count as the slot changing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const events = fakeEvents();
      await screenSharing(events);
      peers.offers[0]!.statsReport = statsReport(1_000_000, 10_000);
      const slotChangesBefore = events.onSlotChanged.mock.calls.length;

      await vi.advanceTimersByTimeAsync(6_000);

      expect(events.onStats.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(events.onSlotChanged.mock.calls.length).toBe(slotChangesBefore);
      // And the share the readings describe is still the one in hand.
      expect(latestSlot(events).state).toBe('offering');
    } finally {
      vi.useRealTimers();
    }
  });
});

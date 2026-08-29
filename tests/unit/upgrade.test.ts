import { describe, expect, it, vi } from 'vitest';
import { SwitchableTransport, TransportSwapGate, negotiateUpgrade } from '../../client/transport/upgrade.js';
import { createMemoryPair } from '../../client/transport/memory.js';
import type { Transport, TransportKind } from '../../client/transport/types.js';
import { HIGH_WATER_BYTES } from '../../client/transport/types.js';

/** A transport whose bufferedAmount is fixed, for exercising the drain-release
 * branch that real MemoryTransport (always 0) and WebRTCTransport (needs a
 * live DataChannel) can't drive directly. */
class FakeBufferedTransport implements Transport {
  readonly kind: TransportKind = 'relay';
  constructor(public bufferedAmount: number) {}
  send(): void { /* not exercised */ }
  onMessage(): void { /* not exercised */ }
  onDrain(): void { /* not exercised */ }
  onClose(): void { /* not exercised */ }
  close(): void { /* not exercised */ }
}

/**
 * A stand-in for the upgraded transport: the one thing `createMemoryPair`
 * cannot be — it reports `kind: 'webrtc'`, which is what makes a downgrade
 * observable at all (a memory pair swapped in for another reports 'relay'
 * both before and after, so nothing about the badge can be told apart).
 * `die()` drives the close that a dead data channel would report.
 */
class FakeUpgradedTransport implements Transport {
  readonly kind: TransportKind = 'webrtc';
  bufferedAmount = 0;
  closed = false;
  #onClose: ((reason: string) => void) | undefined;
  send(): void { /* not exercised */ }
  onMessage(): void { /* not exercised */ }
  onDrain(): void { /* not exercised */ }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }
  close(): void { this.closed = true; }
  die(): void { this.#onClose?.('data channel closed'); }
}

const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); };

// ---------------------------------------------------------------------------
// Fakes for negotiateUpgrade. Node has no RTCPeerConnection/RTCDataChannel;
// this is a smaller subset of tests/unit/webrtc-transport.test.ts's fakes,
// scoped to only what negotiateUpgrade's own tests need to drive (open,
// fail, feed signals) — WebRTCTransport's own wiring is already covered
// there in full.
// ---------------------------------------------------------------------------

type Listener = (event?: unknown) => void;

class FakeTarget {
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

class FakeChannel extends FakeTarget {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  send(): void { /* not exercised by these tests */ }
  close(): void { this.readyState = 'closed'; }
  open(): void { this.readyState = 'open'; this.emit('open'); }
}

class FakePeer extends FakeTarget {
  connectionState = 'new';
  channels: FakeChannel[] = [];
  createDataChannel(): FakeChannel { const c = new FakeChannel(); this.channels.push(c); return c; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'sdp' }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'sdp' }; }
  async setLocalDescription(): Promise<void> { /* no-op fake */ }
  async setRemoteDescription(): Promise<void> { /* no-op fake */ }
  async addIceCandidate(): Promise<void> { /* no-op fake */ }
  close(): void { /* no-op fake */ }
}

let lastPeer: FakePeer | undefined;

function stubPeerConnection(): void {
  lastPeer = undefined;
  class Tracked extends FakePeer {
    constructor() { super(); lastPeer = this; }
  }
  vi.stubGlobal('RTCPeerConnection', Tracked as unknown as typeof RTCPeerConnection);
}

function peer(): FakePeer {
  if (!lastPeer) throw new Error('no peer connection constructed yet');
  return lastPeer;
}

describe('SwitchableTransport', () => {
  it('starts on the transport it was given', () => {
    const [a] = createMemoryPair();
    expect(new SwitchableTransport(a).kind).toBe('relay');
  });

  it('forwards sends to the live transport', async () => {
    const [a, b] = createMemoryPair();
    const seen: Uint8Array[] = [];
    b.onMessage((f) => seen.push(f));
    new SwitchableTransport(a).send(new Uint8Array([1]));
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('keeps one message handler across a swap', async () => {
    const [a] = createMemoryPair();
    const [c, d] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const seen: Uint8Array[] = [];
    switchable.onMessage((f) => seen.push(f));

    switchable.swapTo(c);
    d.send(new Uint8Array([7]));
    await flush();
    expect([...(seen[0] ?? [])]).toEqual([7]);
  });

  it('sends through the new transport after a swap', async () => {
    const [a, b] = createMemoryPair();
    const [c, d] = createMemoryPair();
    const oldSeen: Uint8Array[] = [];
    const newSeen: Uint8Array[] = [];
    b.onMessage((f) => oldSeen.push(f));
    d.onMessage((f) => newSeen.push(f));

    const switchable = new SwitchableTransport(a);
    switchable.swapTo(c);
    switchable.send(new Uint8Array([9]));
    await flush();
    expect(oldSeen).toHaveLength(0);
    expect(newSeen).toHaveLength(1);
  });

  it('announces the kind change so the UI badge can update', () => {
    const [a] = createMemoryPair();
    const [c] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onKind = vi.fn();
    switchable.onKindChange(onKind);
    switchable.swapTo(c);
    expect(onKind).toHaveBeenCalledWith('relay');
  });

  it('reports the live transport buffered amount', () => {
    const [a] = createMemoryPair();
    expect(new SwitchableTransport(a).bufferedAmount).toBe(0);
  });

  it('falls back when the live transport closes', () => {
    const [a] = createMemoryPair();
    const [c] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    switchable.swapTo(c);
    const onKind = vi.fn();
    switchable.onKindChange(onKind);
    switchable.fallBack();
    expect(onKind).toHaveBeenCalledWith('relay');
  });

  it('closes the transport it is leaving when falling back, so a manual fallBack (e.g. Session re-pairing) does not leak the connection', () => {
    // The automatic path (this transport reporting its own onClose) doesn't
    // need this — it's already closing itself. But Session's #unpair also
    // calls fallBack proactively, on a transport that is very likely still
    // alive, and fallBack only ever detached it, never closed it.
    const [a] = createMemoryPair();
    const [c] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    switchable.swapTo(c);
    const closeC = vi.spyOn(c, 'close');
    switchable.fallBack();
    expect(closeC).toHaveBeenCalledTimes(1);
  });

  it('does not report the session closed when the upgraded transport dies mid-session, it falls back instead', async () => {
    // The baseline's onClose is the session's real "peer left" signal;
    // an upgraded transport dying must not be confused for that.
    const [a] = createMemoryPair();
    const [c, d] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onClose = vi.fn();
    switchable.onClose(onClose);
    switchable.swapTo(c);
    d.close();
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(switchable.kind).toBe('relay');
  });

  it('reports the session closed when the baseline transport closes', async () => {
    const [a, b] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onClose = vi.fn();
    switchable.onClose(onClose);
    b.close();
    await flush();
    expect(onClose).toHaveBeenCalledWith('peer-left');
  });

  it('does not end the session, or fall back, when the baseline closes after a successful upgrade', async () => {
    // A relay hiccup after we're happily on WebRTC must not kill a healthy
    // peer-to-peer session — the whole point of upgrading.
    const [a] = createMemoryPair();
    const [c, d] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onClose = vi.fn();
    switchable.onClose(onClose);
    switchable.swapTo(c);

    a.close();
    await flush();
    expect(onClose).not.toHaveBeenCalled();

    // Still fully live on c, unaffected by the baseline closing.
    const seen: Uint8Array[] = [];
    d.onMessage((f) => seen.push(f));
    switchable.send(new Uint8Array([3]));
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('reports the session closed instead of silently resuming a dead relay, when the baseline died while sidelined and the upgrade later falls back', async () => {
    // The double-death case: the relay dies while detached (a "hiccup" that
    // #detach correctly ignores on its own, per the test above), and *then*
    // the upgraded transport also dies, triggering fallBack. Without
    // tracking the first death, fallBack would silently re-bind a relay
    // whose socket will never fire another event — send() on it would
    // become a permanent, undetectable no-op.
    const [a] = createMemoryPair();
    const [c, d] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onClose = vi.fn();
    switchable.onClose(onClose);
    switchable.swapTo(c);

    // The relay's own socket dies first, while sidelined and detached.
    a.close();
    await flush();
    expect(onClose).not.toHaveBeenCalled(); // matches the test above: not surfaced yet

    // The upgraded transport now also dies, triggering an internal fallback
    // — with nothing left underneath to fall back to.
    d.close();
    await flush();

    expect(onClose).toHaveBeenCalledTimes(1);
    // Not merely "some string": the reason has to name the double death, or
    // a session that ended this way is indistinguishable from a plain
    // peer-left in whatever the user is eventually shown.
    expect(onClose).toHaveBeenCalledWith('relay closed while upgraded');
  });

  it('announces the downgrade even when the baseline died while sidelined, so the badge cannot keep claiming a direct connection', async () => {
    // The honest-badge bug: fallBack's dead-baseline branch returned after
    // #onClose without ever firing #onKindChange, so a session that went
    // webrtc -> (relay dies) -> (webrtc dies) -> reconnect-over-the-relay
    // kept telling the user their files were "Travelling straight between
    // your devices, with nothing in between" for the rest of a fully
    // relayed session. The transport badge is the one deliverable whose
    // entire purpose is honesty.
    const [a] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const events: string[] = [];
    switchable.onKindChange((kind) => events.push(`kind:${kind}`));
    switchable.onClose((reason) => events.push(`close:${reason}`));

    const rtc = new FakeUpgradedTransport();
    switchable.swapTo(rtc);
    a.close(); // the relay dies first, while sidelined and detached
    await flush();
    rtc.die(); // ...and only then does the upgraded transport die too
    await flush();

    // Order matters as much as the fact: the downgrade has to be announced
    // *before* the session is reported closed, or the last thing the UI
    // hears about the transport is still 'webrtc'.
    expect(events).toEqual(['kind:webrtc', 'kind:relay', 'close:relay closed while upgraded']);
    expect(switchable.kind).toBe('relay');
  });

  it('closes the transport it replaces on a second swap, rather than only detaching it', () => {
    // Unlike fallBack, swapTo only ever detached. The baseline is exempt (it
    // is what a later fallBack resumes on), but a *previous upgrade* being
    // swapped out has nothing left to keep it alive for — its
    // RTCPeerConnection would leak for the life of the page.
    const [a] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const closeA = vi.spyOn(a, 'close');
    const first = new FakeUpgradedTransport();
    const second = new FakeUpgradedTransport();

    switchable.swapTo(first);
    expect(closeA).not.toHaveBeenCalled(); // the baseline must survive the first upgrade

    switchable.swapTo(second);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(closeA).not.toHaveBeenCalled();
  });

  it('fires the drain callback once after a swap lands on an idle transport, so a real parked waiter would be released too', () => {
    // This test alone doesn't park a real Sender.#awaitDrain waiter (real
    // MemoryTransport always reports bufferedAmount 0) — it only proves the
    // callback fires post-swap when idle. Its sibling below ("does not fire
    // ... still backed up") is what actually discriminates this from an
    // unconditional fire; the two together cover the real requirement:
    // Sender.#awaitDrain parks by calling transport.onDrain(cb) while
    // backed up, and if the old (now-detached) transport was the only
    // thing that would ever have fired that callback, detaching it would
    // strand the waiter forever unless the swap itself releases it.
    const [a] = createMemoryPair();
    const [c] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onDrain = vi.fn();
    switchable.onDrain(onDrain);
    switchable.swapTo(c);
    expect(onDrain).toHaveBeenCalledTimes(1);
  });

  it('does not fire a spurious drain release when the newly-live transport is itself still backed up', () => {
    const [a] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onDrain = vi.fn();
    switchable.onDrain(onDrain);
    switchable.swapTo(new FakeBufferedTransport(HIGH_WATER_BYTES));
    expect(onDrain).not.toHaveBeenCalled();
  });

  /*
   * This replaces a test that asserted the opposite — that a frame arriving
   * on the sidelined baseline is dropped — and the reason is a real session
   * (2026-08-29) that lost a file to it.
   *
   * Each peer swaps on its own, with nothing on the wire to agree on. So
   * after a downgrade the two can disagree about which transport is live,
   * and the disagreement is not the narrow in-flight window an upgrade
   * produces: the peer whose WebRTC has not yet reported itself dead can sit
   * on it indefinitely. In that state the peer that HAS fallen back sends
   * every frame down the relay, into an onMessage that was overwritten with
   * a no-op — no error on either side, the sender's rows all read "Sent",
   * and the receiver's sit at 0 bytes forever. Muting incoming frames was
   * never what `#detach` was for: the class doc has always said a stray
   * message is safe to forward (it must still pass AEAD and the receiver's
   * own seq checks), and it is a stray *close* that had to be silenced.
   *
   * So the baseline stays heard. And a frame arriving on it is evidence the
   * peer has already gone back to the relay, which is the one thing this
   * side could not otherwise learn — so it follows them down, and the two
   * agree again after one frame instead of never.
   */
  it('delivers a straggler on the sidelined baseline without undoing the upgrade', async () => {
    const [a, b] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const upgraded = new FakeUpgradedTransport();
    switchable.swapTo(upgraded);

    const seen: Uint8Array[] = [];
    switchable.onMessage((f) => seen.push(f));
    // Sent down the relay by a peer that had not swapped yet, landing here
    // just after this side did: the ordinary shape of both peers upgrading.
    b.send(new Uint8Array([1]));
    await flush();

    expect(seen).toHaveLength(1);
    expect(switchable.kind).toBe('webrtc');
    expect(upgraded.closed).toBe(false);
  });

  it('falls back onto the baseline when the peer is plainly using it again', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const [a, b] = createMemoryPair();
      const switchable = new SwitchableTransport(a);
      const kinds: TransportKind[] = [];
      switchable.onKindChange((kind) => kinds.push(kind));
      const upgraded = new FakeUpgradedTransport();
      switchable.swapTo(upgraded);

      const seen: Uint8Array[] = [];
      switchable.onMessage((f) => seen.push(f));
      // Long past any straggler: the peer's own connection died and it went
      // back to the relay, while this side's has not reported itself dead.
      clock.mockReturnValue(30_000);
      b.send(new Uint8Array([1]));
      await flush();

      expect(seen).toHaveLength(1);
      expect(switchable.kind).toBe('relay');
      // Not merely unwired: the connection the peer has already abandoned
      // must not be left holding an RTCPeerConnection for the life of the page.
      expect(upgraded.closed).toBe(true);
      expect(kinds).toEqual(['webrtc', 'relay']);

      // And the relay is properly live again, not just nominally: everything
      // after the frame that triggered the fallback arrives the ordinary way.
      b.send(new Uint8Array([2]));
      await flush();
      expect(seen).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('closes only the live transport when no swap has happened', () => {
    const [a] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const closeA = vi.spyOn(a, 'close');
    switchable.close();
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it('closes both the live and baseline transports after a swap', () => {
    const [a] = createMemoryPair();
    const [c] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    switchable.swapTo(c);
    const closeA = vi.spyOn(a, 'close');
    const closeC = vi.spyOn(c, 'close');
    switchable.close();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeC).toHaveBeenCalledTimes(1);
  });
});

describe('TransportSwapGate', () => {
  it('runs the swap immediately when nothing is in flight', async () => {
    const gate = new TransportSwapGate();
    const perform = vi.fn();
    await gate.runExclusive(perform);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('lets independent in-flight sends proceed concurrently when no swap is pending', async () => {
    const gate = new TransportSwapGate();
    let releaseA: () => void = () => undefined;
    const a = gate.wrap(() => new Promise<void>((resolve) => { releaseA = resolve; }));
    const order: string[] = [];
    const b = gate.wrap(() => { order.push('b'); });
    await b;
    expect(order).toEqual(['b']);
    releaseA();
    await a;
  });

  it('holds the swap until every in-flight send has finished, then blocks new sends until the swap completes', async () => {
    const gate = new TransportSwapGate();
    const order: string[] = [];
    let releaseSend: () => void = () => undefined;

    const inFlight = gate.wrap(() => new Promise<void>((resolve) => {
      releaseSend = () => { order.push('old-send-done'); resolve(); };
    }));

    let swapped = false;
    const swap = gate.runExclusive(() => { swapped = true; order.push('swap'); });

    // The swap must not run while a send is still mid-flight.
    await flush();
    expect(swapped).toBe(false);

    // A brand-new send started while the swap is pending must not begin
    // its work either — it has to queue up behind the swap.
    const queued = gate.wrap(() => { order.push('new-send'); });
    await flush();
    expect(order).not.toContain('new-send');

    releaseSend();
    await swap;
    await queued;
    await inFlight;

    expect(order).toEqual(['old-send-done', 'swap', 'new-send']);
  });

  it('rejects a second runExclusive started while one is already pending', async () => {
    const gate = new TransportSwapGate();
    let release: () => void = () => undefined;
    const held = gate.wrap(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = gate.runExclusive(() => undefined);
    await expect(gate.runExclusive(() => undefined)).rejects.toThrow();
    release();
    await first;
    await held;
  });

  it('still releases the gate when a wrapped send throws, so a later swap is not stuck forever', async () => {
    const gate = new TransportSwapGate();
    await expect(gate.wrap(() => { throw new Error('send failed'); })).rejects.toThrow('send failed');
    const perform = vi.fn();
    await gate.runExclusive(perform);
    expect(perform).toHaveBeenCalledTimes(1);
  });
});

describe('negotiateUpgrade', () => {
  it('swaps the switchable transport to WebRTC once the channel opens and the gate is idle', async () => {
    stubPeerConnection();
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);
    const gate = new TransportSwapGate();

    const outcome = negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: () => undefined,
      gate,
    });

    await flush();
    peer().channels[0]!.open();
    await expect(outcome).resolves.toEqual({ ok: true });
    expect(switchable.kind).toBe('webrtc');
  });

  it('does not swap until in-flight sends drain, even after the channel opens', async () => {
    stubPeerConnection();
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);
    const gate = new TransportSwapGate();

    let releaseSend: () => void = () => undefined;
    const inFlightSend = gate.wrap(() => new Promise<void>((resolve) => { releaseSend = resolve; }));

    const outcome = negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: () => undefined,
      gate,
    });

    await flush();
    peer().channels[0]!.open();
    await flush();
    // The channel is open, but a send is still mid-flight: no swap yet.
    expect(switchable.kind).toBe('relay');

    releaseSend();
    await outcome;
    await inFlightSend;
    expect(switchable.kind).toBe('webrtc');
  });

  it('resolves with a timeout reason and leaves the switchable transport alone when the channel never opens', async () => {
    vi.useFakeTimers();
    try {
      stubPeerConnection();
      const [baseline] = createMemoryPair();
      const switchable = new SwitchableTransport(baseline);
      const gate = new TransportSwapGate();

      const outcome = negotiateUpgrade({
        switchable,
        isOfferer: true,
        sendSignal: vi.fn(),
        onSignal: () => undefined,
        gate,
        timeoutMs: 1000,
      });

      const assertion = expect(outcome).resolves.toEqual({ ok: false, reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(switchable.kind).toBe('relay');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with a failed reason without swapping when the peer connection fails before opening', async () => {
    stubPeerConnection();
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);
    const gate = new TransportSwapGate();

    const outcome = negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: () => undefined,
      gate,
    });

    await flush();
    peer().connectionState = 'failed';
    peer().emit('connectionstatechange');
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(switchable.kind).toBe('relay');
  });

  it('does not swap in a connection whose negotiation was aborted before it landed', async () => {
    // Session aborts a still-pending attempt when the peer it was
    // negotiating with leaves (see #unpair). Without this, a negotiation
    // that opens *after* the peer is already gone could still swap in a
    // connection to nobody — or, worse, race a replacement peer's own
    // upgrade.
    stubPeerConnection();
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);
    const gate = new TransportSwapGate();
    const controller = new AbortController();

    const outcome = negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: () => undefined,
      gate,
      signal: controller.signal,
    });

    await flush();
    controller.abort();
    peer().channels[0]!.open(); // the stale negotiation "finally" completes
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(switchable.kind).toBe('relay');
  });

  it('closes an aborted attempt straight away, rather than leaving it gathering ICE until the timeout', async () => {
    // An abort means this negotiation is talking to a peer that has already
    // left, and `peer-joined` — the signal that starts one — comes from a
    // relay this project treats as an active adversary. Waiting out
    // timeoutMs before closing would let a flood hold one live
    // RTCPeerConnection open per frame for the whole window.
    stubPeerConnection();
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);
    const controller = new AbortController();

    const outcome = negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: () => undefined,
      gate: new TransportSwapGate(),
      signal: controller.signal,
      // Far longer than this test is willing to wait: the point is that the
      // abort settles the attempt on its own, not that the timeout does.
      timeoutMs: 60_000,
    });

    await flush();
    const closed = vi.spyOn(peer(), 'close');
    controller.abort();

    await expect(outcome).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(closed).toHaveBeenCalled();
    expect(switchable.kind).toBe('relay');
  });

  it('resolves instead of rejecting when constructing the peer connection throws synchronously', async () => {
    // A malformed VITE_STUN_URLS entry ("stun.example.com", no scheme) is a
    // SyntaxError in Chrome and Firefox, and an exhausted peer-connection
    // pool throws too. Session fires this and forgets it — `void
    // negotiateUpgrade(...)`, on the documented promise that it never
    // rejects — so an escaping throw was an unhandled rejection once per
    // pairing for the life of a misconfigured deployment.
    vi.stubGlobal('RTCPeerConnection', class {
      constructor() { throw new SyntaxError('Failed to construct RTCPeerConnection: malformed URL'); }
    } as unknown as typeof RTCPeerConnection);
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);

    await expect(negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: () => undefined,
      gate: new TransportSwapGate(),
    })).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(switchable.kind).toBe('relay');
  });

  it('swaps normally when a signal is provided but never aborted', async () => {
    stubPeerConnection();
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);
    const gate = new TransportSwapGate();
    const controller = new AbortController();

    const outcome = negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: () => undefined,
      gate,
      signal: controller.signal,
    });

    await flush();
    peer().channels[0]!.open();
    await expect(outcome).resolves.toEqual({ ok: true });
    expect(switchable.kind).toBe('webrtc');
  });

  it('reports a malformed inbound signal without ending the negotiation attempt', async () => {
    stubPeerConnection();
    const [baseline] = createMemoryPair();
    const switchable = new SwitchableTransport(baseline);
    const gate = new TransportSwapGate();
    const onSignalRejected = vi.fn();
    let deliver: ((payload: unknown) => void) | undefined;

    const outcome = negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: vi.fn(),
      onSignal: (cb) => { deliver = cb; },
      gate,
      onSignalRejected,
    });

    await flush();
    deliver?.({ kind: 'not-a-real-kind' });
    await flush();
    expect(onSignalRejected).toHaveBeenCalledTimes(1);
    expect(onSignalRejected.mock.calls[0]![0]).toBeInstanceOf(Error);

    peer().channels[0]!.open();
    await expect(outcome).resolves.toEqual({ ok: true });
  });

  it('defaults onSignalRejected to a console warning, so a rejected signal is never silently swallowed', async () => {
    // Ruling 3's diagnosability guarantee must not depend on a future
    // caller remembering to pass onSignalRejected.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      stubPeerConnection();
      const [baseline] = createMemoryPair();
      const switchable = new SwitchableTransport(baseline);
      const gate = new TransportSwapGate();
      let deliver: ((payload: unknown) => void) | undefined;

      const outcome = negotiateUpgrade({
        switchable,
        isOfferer: true,
        sendSignal: vi.fn(),
        onSignal: (cb) => { deliver = cb; },
        gate,
        // onSignalRejected intentionally omitted.
      });

      await flush();
      deliver?.({ kind: 'not-a-real-kind' });
      await flush();
      expect(warn).toHaveBeenCalledTimes(1);

      peer().channels[0]!.open();
      await expect(outcome).resolves.toEqual({ ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('throttles the default warning so a flood of malformed signals cannot spam the console', async () => {
    // The relay is this project's active adversary, and the server does
    // not rate-limit its ongoing `rtc` forwarding path — so the default
    // must degrade gracefully under a flood rather than warn once per frame.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      stubPeerConnection();
      const [baseline] = createMemoryPair();
      const switchable = new SwitchableTransport(baseline);
      const gate = new TransportSwapGate();
      let deliver: ((payload: unknown) => void) | undefined;

      const outcome = negotiateUpgrade({
        switchable,
        isOfferer: true,
        sendSignal: vi.fn(),
        onSignal: (cb) => { deliver = cb; },
        gate,
        // onSignalRejected intentionally omitted.
      });

      await flush();
      for (let i = 0; i < 50; i++) deliver?.({ kind: 'not-a-real-kind' });
      await flush();
      expect(warn).toHaveBeenCalledTimes(1);

      peer().channels[0]!.open();
      await expect(outcome).resolves.toEqual({ ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('never lets a rejected signal reach the negotiation outcome as an unhandled failure', async () => {
    // The catch on the per-signal handler must never let a malformed
    // signal crash or fail the whole negotiateUpgrade() promise.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      stubPeerConnection();
      const [baseline] = createMemoryPair();
      const switchable = new SwitchableTransport(baseline);
      const gate = new TransportSwapGate();
      let deliver: ((payload: unknown) => void) | undefined;

      const outcome = negotiateUpgrade({
        switchable,
        isOfferer: true,
        sendSignal: vi.fn(),
        onSignal: (cb) => { deliver = cb; },
        gate,
      });

      await flush();
      deliver?.(null);
      deliver?.(42);
      deliver?.({ kind: 'sdp', description: { type: 'offer', sdp: 123 } });
      await flush();
      peer().channels[0]!.open();
      await expect(outcome).resolves.toEqual({ ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('constructs its transport through the injected factory rather than naming WebRTCTransport', async () => {
    // The whole point of the seam: in a Web Worker there is no
    // RTCPeerConnection, so the realm that runs negotiateUpgrade cannot be the
    // realm that builds the peer connection. Proving the factory is honoured
    // is what makes the worker-side proxy possible at all.
    // createMemoryPair, not `new MemoryTransport()` — the class is deliberately
    // not exported; the pair factory is the whole public surface.
    const [relay] = createMemoryPair();
    const switchable = new SwitchableTransport(relay);
    let builtWith: boolean | undefined;

    const outcome = await negotiateUpgrade({
      switchable,
      isOfferer: true,
      sendSignal: () => undefined,
      onSignal: () => undefined,
      gate: new TransportSwapGate(),
      timeoutMs: 50,
      createTransport: (isOfferer) => {
        builtWith = isOfferer;
        return {
          kind: 'webrtc' as const,
          bufferedAmount: 0,
          send: () => undefined,
          onMessage: () => undefined,
          onDrain: () => undefined,
          onClose: () => undefined,
          close: () => undefined,
          whenOpen: () => Promise.reject(new Error('never opens')),
          handleSignal: () => Promise.resolve(),
        };
      },
    });

    expect(builtWith).toBe(true);
    expect(outcome).toEqual({ ok: false, reason: 'failed' });
    // Never swapped, so the session is still on its relay baseline.
    expect(switchable.kind).toBe('relay');
  });
});

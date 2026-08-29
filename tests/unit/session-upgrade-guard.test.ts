// tests/unit/session-upgrade-guard.test.ts
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Session, type SessionOptions } from '../../client/session.js';
import { RelayTransport, type RelayConnection } from '../../client/transport/relay.js';
import { createLocalUpgradeTransport } from '../../client/transport/upgrade.js';

/**
 * `peer-joined` is a room-presence signal from the relay, and this project
 * treats the relay as an active adversary. `Session.#handlePeerJoined` calls
 * `#startUpgrade()`, and `WebRTCTransport.offer` constructs an
 * RTCPeerConnection and starts ICE the moment it is called — so an
 * unguarded handler turned N injected frames into N live peer connections,
 * with nothing client-side rate-limiting inbound signals. Chromium caps peer
 * connections per page and throws once that cap is reached.
 *
 * The same guard covers the non-adversarial case: a genuine duplicate
 * peer-joined after a successful upgrade must not start a second
 * negotiation, whose `swapTo` would detach the first transport.
 */

/**
 * A duck-typed stand-in for RelayTransport, cast past its private fields —
 * the same pattern tests/unit/session-peer-gone-timer.test.ts and
 * tests/unit/reconnect.test.ts use — with room presence driven by hand.
 */
function fakeRelay() {
  let onPeerJoined: (() => void) | undefined;
  const transport = {
    kind: 'relay' as const,
    bufferedAmount: 0,
    send: () => undefined,
    onMessage: () => undefined,
    onDrain: () => undefined,
    onClose: () => undefined,
    onPeerJoined: (cb: () => void) => { onPeerJoined = cb; },
    onPeerLeft: () => undefined,
    sendSignal: () => undefined,
    onSignal: () => undefined,
    close: () => undefined,
  };
  return {
    transport: transport as unknown as RelayTransport,
    triggerPeerJoined: () => onPeerJoined?.(),
  };
}

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
  send(): void { /* not exercised */ }
  close(): void { this.readyState = 'closed'; }
  open(): void { this.readyState = 'open'; this.emit('open'); }
}

class FakePeer extends FakeTarget {
  connectionState = 'new';
  closed = false;
  channels: FakeChannel[] = [];
  createDataChannel(): FakeChannel { const c = new FakeChannel(); this.channels.push(c); return c; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'sdp' }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'sdp' }; }
  async setLocalDescription(): Promise<void> { /* no-op fake */ }
  async setRemoteDescription(): Promise<void> { /* no-op fake */ }
  async addIceCandidate(): Promise<void> { /* no-op fake */ }
  close(): void { this.closed = true; }
}

const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); };

let connect: MockInstance<typeof RelayTransport.connect>;
let peers: FakePeer[];

beforeEach(() => {
  peers = [];
  class Tracked extends FakePeer { constructor() { super(); peers.push(this); } }
  vi.stubGlobal('RTCPeerConnection', Tracked as unknown as typeof RTCPeerConnection);
  connect = vi.spyOn(RelayTransport, 'connect');
});

afterEach(() => {
  connect.mockRestore();
  vi.unstubAllGlobals();
});

async function hostSession(
  webrtc: SessionOptions['webrtc'] = { available: true, createTransport: createLocalUpgradeTransport },
) {
  const relay = fakeRelay();
  connect.mockResolvedValue({
    transport: relay.transport, code: 'ABC123', peerId: 'a', peerPresent: false,
  } satisfies RelayConnection);
  const session = await Session.create('ws://test/ws', { webrtc });
  return { session, relay };
}

describe('Session upgrade guard (relay-controlled peer-joined)', () => {
  it('starts at most one negotiation for a flood of peer-joined signals', async () => {
    const { session, relay } = await hostSession();

    for (let i = 0; i < 8; i++) relay.triggerPeerJoined();
    await flush();

    expect(peers).toHaveLength(1);
    session.close();
  });

  it('starts no further negotiation once the session is already on WebRTC', async () => {
    const { session, relay } = await hostSession();

    relay.triggerPeerJoined();
    await flush();
    peers[0]!.channels[0]!.open();
    await flush();
    expect(session.transportKind).toBe('webrtc');

    // A duplicate peer-joined after a successful upgrade. A second
    // negotiation's swapTo would detach the live transport — with the first
    // one left open and unreachable.
    relay.triggerPeerJoined();
    await flush();

    expect(peers).toHaveLength(1);
    expect(session.transportKind).toBe('webrtc');
    session.close();
  });

  it('closes the peer connection when the session closes with a negotiation still in flight', async () => {
    const { session, relay } = await hostSession();

    relay.triggerPeerJoined();
    await flush();
    expect(peers).toHaveLength(1);

    // Never opened: the negotiation is still gathering when the user walks
    // away. Left alone it would keep the connection alive until whenOpen's
    // 8s timeout, then try to swap into an already-closed switchable.
    session.close();
    await flush();

    expect(peers[0]!.closed).toBe(true);
  });

  it('does not negotiate when the page reports no WebRTC, even though this realm has one', async () => {
    // The exact production shape, inverted. `beforeEach` has stubbed a global
    // RTCPeerConnection, so a realm check would say "yes, go ahead" — and for
    // the whole life of this project the realm check was the ONLY check, asked
    // inside a Web Worker where the answer is always no. Availability is the
    // page's answer now, and it is the only thing that may gate this.
    const { session, relay } = await hostSession({
      available: false,
      createTransport: () => { throw new Error('must not be built'); },
    });

    relay.triggerPeerJoined();
    await flush();

    expect(peers).toHaveLength(0);
    session.close();
  });
});

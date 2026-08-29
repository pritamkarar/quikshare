// tests/integration/upgrade-fallback.test.ts
/*
 * IMPORTANT, and the reason this suite was green while the feature was dead:
 * stubbing a global RTCPeerConnection proves the NEGOTIATION ALGORITHM in a
 * realm that has one. It cannot, by construction, prove that the realm which
 * actually runs `Session` in production has one — and for the entire life of
 * the project it did not, because Session runs in a Web Worker.
 *
 * Availability is proven only by tests/e2e/direct-transport.spec.ts, which
 * runs a real browser with real realms and asserts the badge reaches
 * "Direct". If you are tempted to delete that e2e test as slow or redundant,
 * this comment is why it is neither.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { Session, type SessionOptions } from '../../client/session.js';
import { createLocalUpgradeTransport } from '../../client/transport/upgrade.js';
import { confirmBoth } from '../pairing.js';

/**
 * The stubbed global RTCPeerConnection (see stubPeerConnection below) proves
 * the negotiation algorithm; it no longer doubles as the availability check
 * — that's `Session`'s job now, answered by this option, the same shape a
 * real page would supply. Shared by every test in this file that expects an
 * upgrade to actually happen.
 */
const webrtc: SessionOptions['webrtc'] = { available: true, createTransport: createLocalUpgradeTransport };

(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

/**
 * Counts real Sender constructions, for Ruling E: a swap must never rebuild
 * the Sender, since #nextSeq (the whole nonce-uniqueness argument) only
 * survives a rebuild via the `initialSeq` handoff, and a swap must not go
 * through that path at all. TrackedSender is a real, fully-functional
 * subclass — this instruments Session's actual construction site rather than
 * replacing Sender's behaviour, so every other test in this file still
 * exercises the genuine class.
 */
let senderConstructions = 0;
vi.mock('../../client/transfer/sender.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/transfer/sender.js')>();
  class TrackedSender extends actual.Sender {
    constructor(opts: ConstructorParameters<typeof actual.Sender>[0]) {
      super(opts);
      senderConstructions++;
    }
  }
  return { ...actual, Sender: TrackedSender };
});

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

beforeEach(() => { senderConstructions = 0; });

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
});

/** Real-time polling: signalling and negotiation cross a real WebSocket round trip. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

describe('upgrade fallback', () => {
  // Node has no RTCPeerConnection, so this environment exercises exactly the
  // case that matters most: a network where WebRTC never comes up.
  it('transfers successfully with no WebRTC available at all', async () => {
    const url = await start();
    const host = await Session.create(url);
    const guest = await Session.join(url, host.code);
    await confirmBoth(host, guest);

    const bytes = new Uint8Array(150_000).fill(7);
    const received = new Promise<Uint8Array>((resolve, reject) => {
      guest.events.onFileComplete = async ({ blob }) => {
        if (!blob) { reject(new Error('no blob')); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
      guest.events.onError = (e) => reject(new Error(e.message));
    });

    await host.sendFiles([new File([bytes], 'x.bin')]);
    expect(Buffer.compare(Buffer.from(await received), Buffer.from(bytes))).toBe(0);
    expect(host.transportKind).toBe('relay');

    host.close();
    guest.close();
  }, 20_000);

  it('reports the transport kind so the UI can show it honestly', async () => {
    const url = await start();
    const host = await Session.create(url);
    expect(host.transportKind).toBe('relay');
    host.close();
  });

  // ---------------------------------------------------------------------
  // A local fake RTCPeerConnection/RTCDataChannel, so the rest of this file
  // can drive a real upgrade end to end: real Session, real negotiateUpgrade,
  // real SwitchableTransport/TransportSwapGate/Sender/Receiver, real signals
  // over the real relay — only the browser WebRTC primitives are faked, the
  // same scope tests/unit/upgrade.test.ts and tests/unit/webrtc-transport.
  // test.ts already fake for exactly this reason (Node has neither).
  // ---------------------------------------------------------------------

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

  /** Two of these, linked, stand in for the one DataChannel a real
   * negotiation would produce on both ends. */
  class FakeChannel extends FakeTarget {
    readyState: 'connecting' | 'open' | 'closed' = 'connecting';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType = 'blob';
    peer: FakeChannel | undefined;
    send(data: ArrayBuffer): void {
      queueMicrotask(() => this.peer?.emit('message', { data }));
    }
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

  function stubPeerConnection(): FakePeer[] {
    const peers: FakePeer[] = [];
    class Tracked extends FakePeer { constructor() { super(); peers.push(this); } }
    vi.stubGlobal('RTCPeerConnection', Tracked as unknown as typeof RTCPeerConnection);
    return peers;
  }

  /** Wires the two constructed peer connections' fake data channels
   * together and opens both sides, completing the simulated upgrade. Which
   * peer is which is identified structurally, not by call order: only
   * WebRTCTransport.offer() ever calls createDataChannel(). */
  function linkAndOpen(peers: FakePeer[]): void {
    const offerPeer = peers.find((p) => p.channels.length > 0);
    const answerPeer = peers.find((p) => p !== offerPeer);
    if (!offerPeer || !answerPeer) throw new Error('expected exactly one offer and one answer peer connection');

    const offerChannel = offerPeer.channels[0]!;
    const answerChannel = new FakeChannel();
    offerChannel.peer = answerChannel;
    answerChannel.peer = offerChannel;
    answerPeer.emit('datachannel', { channel: answerChannel });

    offerChannel.open();
    answerChannel.open();
  }

  it('does not attempt an upgrade when forceTransport is relay, even though WebRTC is available', async () => {
    // Availability alone is not enough here: `webrtc: { available: true, ... }`
    // is passed alongside forceTransport so the guard's `||` actually reaches
    // its second operand. Without it, `!this.#webrtc?.available` is true on
    // its own and forceTransport is never the reason the upgrade is skipped —
    // this test would pass for the same reason the "no WebRTC available at
    // all" test does, and never prove forceTransport overrides availability.
    const peers = stubPeerConnection();
    const url = await start();
    const host = await Session.create(url, { forceTransport: 'relay', webrtc });
    const guest = await Session.join(url, host.code, { forceTransport: 'relay', webrtc });
    await confirmBoth(host, guest);

    // Give any (wrongly) attempted negotiation plenty of real time to show up.
    await new Promise((r) => { setTimeout(r, 300); });

    expect(peers).toHaveLength(0);
    expect(host.transportKind).toBe('relay');
    expect(guest.transportKind).toBe('relay');

    host.close();
    guest.close();
  });

  it('upgrades both peers to WebRTC and keeps sending through the switchable, without ever rebuilding the Sender', async () => {
    // Ruling A: proves the *Sender* actually sends through the switchable —
    // not merely that transportKind flips to 'webrtc'. If Session built the
    // switchable after handing the raw relay to #buildSender, transportKind
    // would still say 'webrtc' (SwitchableTransport itself swapped fine)
    // while every byte kept going out over the relay — and the relay's
    // onMessage slot on the receiving side is detached the moment *its own*
    // SwitchableTransport swaps, so a file sent after the upgrade over a
    // stale relay reference would simply never arrive: this test would time
    // out, not merely report a wrong transportKind.
    //
    // Ruling E: proves the Sender is never rebuilt across the swap, using the
    // real construction count from the vi.mock above.
    const peers = stubPeerConnection();
    const url = await start();
    const host = await Session.create(url, { webrtc });
    const guest = await Session.join(url, host.code, { webrtc });
    await confirmBoth(host, guest);
    expect(senderConstructions).toBe(2); // one per Session, at #init

    // One file over the relay, before any upgrade, to establish a nonzero
    // sequence baseline that a reset would visibly regress from.
    const before = new Uint8Array(20).fill(1);
    const gotBefore = new Promise<Uint8Array>((resolve, reject) => {
      guest.events.onFileComplete = async ({ blob }) => {
        if (!blob) { reject(new Error('no blob')); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
      guest.events.onError = (e) => reject(new Error(`before-upgrade: ${e.message}`));
    });
    await host.sendFiles([new File([before], 'before.bin')]);
    expect(Buffer.compare(Buffer.from(await gotBefore), Buffer.from(before))).toBe(0);

    // Both sides' #startUpgrade already fired (host from onPeerJoined, guest
    // right after its own hello in join()) and each constructed one
    // RTCPeerConnection. Link their fake channels and open both.
    await waitFor(() => peers.length >= 2);
    linkAndOpen(peers);

    await waitFor(() => host.transportKind === 'webrtc' && guest.transportKind === 'webrtc');

    // The decisive check: send another file *after* the upgrade, and it must
    // actually arrive. It can only arrive if the Sender is really using the
    // switchable (now pointing at the fake WebRTC channel) — see the Ruling A
    // note above for why a Sender still pinned to the raw relay would make
    // this hang rather than merely misreport.
    const after = new Uint8Array(30).fill(2);
    const gotAfter = new Promise<Uint8Array>((resolve, reject) => {
      guest.events.onFileComplete = async ({ blob }) => {
        if (!blob) { reject(new Error('no blob')); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
      guest.events.onError = (e) => reject(new Error(`after-upgrade: ${e.message}`));
    });
    await host.sendFiles([new File([after], 'after.bin')]);
    expect(Buffer.compare(Buffer.from(await gotAfter), Buffer.from(after))).toBe(0);

    // Ruling E, directly: still exactly one Sender per Session (host +
    // guest) for the whole test — the swap must never have rebuilt either
    // one. A test that only checked "did the second file arrive" would not,
    // by itself, rule out a rebuild that happened to carry initialSeq
    // correctly.
    expect(senderConstructions).toBe(2);

    host.close();
    guest.close();
  }, 20_000);

  it('falls back to the relay when the peer leaves after an upgrade, so a replacement peer is not left unreachable', async () => {
    // #unpair() must reset the transport, not only pairing state: an upgrade
    // was negotiated specifically with the peer that just left, and its
    // WebRTC transport has no way to know a new peer has taken the room
    // until its own (potentially slow) failure detection catches up. Without
    // an explicit fallback here, transportKind — and the hello meant for a
    // replacement peer — could both stay pinned to a dead connection.
    const peers = stubPeerConnection();
    const url = await start();
    const host = await Session.create(url, { webrtc });
    const guest = await Session.join(url, host.code, { webrtc });
    await confirmBoth(host, guest);

    await waitFor(() => peers.length >= 2);
    linkAndOpen(peers);
    await waitFor(() => host.transportKind === 'webrtc');

    const hostSawPeerLeave = new Promise<void>((resolve) => { host.events.onPeerLeft = () => resolve(); });
    guest.close();
    await hostSawPeerLeave;

    expect(host.transportKind).toBe('relay');

    host.close();
  });

  it('tells the session about the downgrade when the relay dies first and the upgraded transport dies after it', async () => {
    // The honest-badge scenario, end to end: a laptop changes network, the
    // WebSocket notices first and ICE only seconds later. The badge is fed
    // by onTransportChange alone, so a downgrade that never announces
    // leaves the user reading "Direct — travelling straight between your
    // devices, with nothing in between" while every byte goes through the
    // server.
    const peers = stubPeerConnection();
    const url = await start();
    const host = await Session.create(url, { webrtc });
    const guest = await Session.join(url, host.code, { webrtc });
    await confirmBoth(host, guest);

    const announced: string[] = [];
    host.events.onTransportChange = (kind) => { announced.push(kind); };

    await waitFor(() => peers.length >= 2);
    linkAndOpen(peers);
    await waitFor(() => host.transportKind === 'webrtc');
    expect(announced).toEqual(['webrtc']);

    // The relay goes down under both peers while WebRTC carries the session
    // — sidelined and detached, so nothing is reported yet.
    await app?.close();
    app = undefined;
    await new Promise((r) => { setTimeout(r, 100); });
    expect(host.transportKind).toBe('webrtc');

    // ...and only now does the direct connection notice its own peer is gone.
    const hostChannel = peers.find((p) => p.channels.length > 0)!.channels[0]!;
    hostChannel.emit('close');

    await waitFor(() => host.transportKind === 'relay');
    expect(announced).toEqual(['webrtc', 'relay']);

    host.close();
    guest.close();
  }, 20_000);

  it('aborts an in-flight negotiation when the peer leaves before it lands, so a stale connection cannot swap in later', async () => {
    // Host's negotiation is left pending (no linkAndOpen yet) when the guest
    // leaves. If #unpair doesn't cancel it, the stale attempt finishing
    // later would still swap in a connection negotiated with a peer that is
    // already gone.
    const peers = stubPeerConnection();
    const url = await start();
    const host = await Session.create(url, { webrtc });
    const guest = await Session.join(url, host.code, { webrtc });
    await confirmBoth(host, guest);

    await waitFor(() => peers.length >= 2);

    const hostSawPeerLeave = new Promise<void>((resolve) => { host.events.onPeerLeft = () => resolve(); });
    guest.close();
    await hostSawPeerLeave;

    // The stale negotiation "finally" completes, as if the departed peer's
    // answer had been in flight the whole time.
    linkAndOpen(peers);
    await new Promise((r) => { setTimeout(r, 200); });

    expect(host.transportKind).toBe('relay');

    host.close();
  });
});

// tests/unit/session-peer-gone-timer.test.ts
import {
  afterEach, beforeEach, describe, expect, it, vi, type MockInstance,
} from 'vitest';
import { Session } from '../../client/session.js';
import { RECONNECT_BUDGET_MS } from '../../client/transport/reconnect.js';
import { RelayTransport, type RelayConnection } from '../../client/transport/relay.js';
import { generateNoncePrefix, makeNonce, seal, toBase64Url } from '../../client/crypto.js';
import { agreedKey, rawHello, rawIdentity, type RawIdentity } from '../pairing.js';
import { FrameType, decodeFrame, encodeControl, encodeFrame, encodeHeader } from '../../client/protocol.js';
import { dataAad } from '../../client/transfer/data-aad.js';
import type { ControlMessage } from '../../shared/messages.js';

/**
 * A duck-typed stand-in for RelayTransport, cast past its private fields —
 * matching tests/unit/reconnect.test.ts's own fakeConnection() pattern —
 * so Session's constructor and #attachRelay can be exercised with no real
 * socket at all. Room-presence (onPeerJoined/onPeerLeft) and message
 * delivery are both driven manually by the test.
 */
function fakeRelay() {
  let onMessage: ((frame: Uint8Array) => void) | undefined;
  let onPeerJoined: (() => void) | undefined;
  let onPeerLeft: (() => void) | undefined;
  let onClose: ((reason: string) => void) | undefined;
  let closed = false;
  const sent: Uint8Array[] = [];
  const transport = {
    kind: 'relay' as const,
    bufferedAmount: 0,
    send: (frame: Uint8Array) => { sent.push(frame); },
    onMessage: (cb: (frame: Uint8Array) => void) => { onMessage = cb; },
    onDrain: () => undefined,
    onClose: (cb: (reason: string) => void) => { onClose = cb; },
    close: () => { closed = true; },
    onPeerJoined: (cb: () => void) => { onPeerJoined = cb; },
    onPeerLeft: (cb: () => void) => { onPeerLeft = cb; },
    sendSignal: () => undefined,
    onSignal: () => undefined,
  };
  return {
    transport: transport as unknown as RelayTransport,
    /** Every frame this session put on the wire, in order. */
    sent,
    /** Whether the session ever closed this socket. */
    isClosed: () => closed,
    deliver: (frame: Uint8Array) => onMessage?.(frame),
    /**
     * The relay announcing a peer. This is what prompts the session to put
     * its own hello — and so its ECDH public key — on the wire, which the
     * fake peer below needs before it can agree a key with it.
     */
    triggerPeerJoined: () => onPeerJoined?.(),
    triggerPeerLeft: () => onPeerLeft?.(),
    /** This session's OWN socket dying, as opposed to the peer's. */
    triggerClose: () => onClose?.('socket-closed'),
  };
}

function helloFrame(prefix: Uint8Array, identity: RawIdentity): Uint8Array {
  return rawHello(toBase64Url(prefix), identity.pub);
}

/** Data frames this session actually put on the wire — a resend is visible here and nowhere else. */
function dataFrameCount(sent: Uint8Array[]): number {
  return sent.filter((frame) => decodeFrame(frame).type === FrameType.Data).length;
}

async function sealedControl(
  key: CryptoKey, prefix: Uint8Array, seq: bigint, msg: ControlMessage,
): Promise<Uint8Array> {
  const header = encodeHeader(FrameType.Control, 0, seq);
  const sealed = await seal(key, makeNonce('b', prefix, seq), encodeControl(msg), header);
  return encodeFrame(FrameType.Control, 0, seq, sealed);
}

/** Each test here only ever sends one chunk per file, so offset is always 0. */
async function sealedData(
  key: CryptoKey, prefix: Uint8Array, seq: bigint, fileId: number, plaintext: Uint8Array, offset = 0,
): Promise<Uint8Array> {
  const header = encodeHeader(FrameType.Data, fileId, seq);
  const sealed = await seal(key, makeNonce('b', prefix, seq), plaintext, dataAad(header, offset));
  return encodeFrame(FrameType.Data, fileId, seq, sealed);
}

/**
 * The fake peer's side of pairing: agree a key with the session, then have
 * both ends confirm the verification number, since `Session` sends nothing
 * at all until they have.
 *
 * `vi.waitFor` rather than a plain loop: every wait in this file has to poll
 * in real wall-clock time while `vi.useFakeTimers()` holds the virtual clock
 * these tests advance by hand.
 */
async function pairWith(
  session: Session, relay: ReturnType<typeof fakeRelay>, identity: RawIdentity, prefix: Uint8Array,
): Promise<CryptoKey> {
  relay.triggerPeerJoined();
  const key = await agreedKey(relay.sent, identity, session.code);
  relay.deliver(helloFrame(prefix, identity));
  await vi.waitFor(() => expect(session.verification).toBeDefined());
  relay.deliver(await sealedControl(key, prefix, 0n, { t: 'verified' }));
  session.confirmVerification();
  await vi.waitFor(() => expect(session.verified).toBe(true));
  return key;
}

describe('Session peer-gone timer (Ruling H sink lifetime, fix-round-1)', () => {
  let connect: MockInstance<typeof RelayTransport.connect>;

  beforeEach(() => {
    vi.useFakeTimers();
    connect = vi.spyOn(RelayTransport, 'connect');
  });

  afterEach(() => {
    connect.mockRestore();
    vi.useRealTimers();
  });

  /** Pairs a fresh Session (peerId 'a') with a fake peer 'b' and offers one file. */
  async function pairedSession() {
    const relay = fakeRelay();
    connect.mockResolvedValue({
      transport: relay.transport, code: 'ABC123', peerId: 'a', peerPresent: false,
    } satisfies RelayConnection);

    const session = await Session.create('ws://test/ws');
    const identity = await rawIdentity();
    const prefix = generateNoncePrefix();

    const errors: { fileId?: number; message: string }[] = [];
    const progress: number[] = [];
    const offers: unknown[] = [];
    session.events.onError = (e) => { errors.push(e); };
    session.events.onReceiveProgress = (p) => { progress.push(p.bytesReceived); };
    session.events.onOffer = (files) => { offers.push(files); };

    // A hello is plaintext, but what it triggers is not: the session derives
    // its key from the public key inside it, so pairWith waits for that
    // before anything sealed is delivered. Seq 0n is the peer's 'verified',
    // sent in there, so this file's sealed frames start at 1n.
    const key = await pairWith(session, relay, identity, prefix);
    const meta = { id: 1, name: 'x.bin', size: 10, type: '' };
    relay.deliver(await sealedControl(key, prefix, 1n, { t: 'offer-batch', batchId: 'b1', files: [meta] }));
    // offer-batch IS sealed, and real crypto.subtle.decrypt goes through the
    // libuv threadpool — it does not settle within a fixed microtask-flush
    // count. vi.waitFor polls in real wall-clock time even while
    // vi.useFakeTimers() controls the virtual clock everything else in this
    // file advances through.
    await vi.waitFor(() => expect(offers).toHaveLength(1));

    return {
      session, relay, key, prefix, identity, meta, errors, progress,
    };
  }

  it('keeps the Receiver alive well within the budget after the peer leaves', async () => {
    const {
      relay, key, prefix, meta, errors, progress,
    } = await pairedSession();

    relay.triggerPeerLeft();
    await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS - 1000);

    // A positive signal that the chunk was genuinely accepted, not merely
    // "no error yet because decryption hadn't finished" — the receiver's
    // #incoming entry for this file is still there.
    relay.deliver(await sealedData(key, prefix, 2n, meta.id, new Uint8Array(5)));
    await vi.waitFor(() => expect(progress).toEqual([5]));
    expect(errors).toEqual([]);
  });

  it('aborts the Receiver once the budget fully elapses with no hello confirming the peer is back', async () => {
    const {
      relay, key, prefix, meta, errors,
    } = await pairedSession();

    relay.triggerPeerLeft();
    await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS + 1000);

    // The decisive check: the file's #incoming entry is gone, so a further
    // data frame for it is now "never offered" — proving the timer actually
    // fired and abortAll() ran, not merely that time passed.
    relay.deliver(await sealedData(key, prefix, 2n, meta.id, new Uint8Array(5)));
    await vi.waitFor(() => expect(errors).not.toEqual([]));
    expect(errors).toContainEqual(expect.objectContaining({
      fileId: meta.id, message: expect.stringContaining('never offered'),
    }));
  });

  it('cancels the timer once the same peer sends a fresh hello, keeping the Receiver alive indefinitely', async () => {
    const {
      relay, key, prefix, identity, meta, errors, progress,
    } = await pairedSession();

    relay.triggerPeerLeft();
    await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS - 1000);
    // The peer reconnects just in time, with the same prefix AND the same
    // public key — so nothing is re-derived and #route's clearTimeout still
    // runs synchronously, as it always did.
    relay.deliver(helloFrame(prefix, identity));

    // Long past the ORIGINAL budget — if the timer weren't cancelled, it
    // would already have fired by now.
    await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS * 2);
    relay.deliver(await sealedData(key, prefix, 3n, meta.id, new Uint8Array(5)));
    await vi.waitFor(() => expect(progress).toEqual([5]));
    expect(errors).toEqual([]);
  });
});

/**
 * Who the session thinks it is paired with, and what it forgets when that
 * changes. #queuedFiles maps a minted fileId back to the real File, so an
 * incoming resume-from can be honoured; it is pruned as files finish, so an
 * aborted batch leaves its entries behind. Handing those to a *replacement*
 * peer means resending a whole file to someone who never asked for it —
 * which their Receiver then rejects chunk by chunk, one error each.
 */
describe('Session peer replacement', () => {
  let connect: MockInstance<typeof RelayTransport.connect>;

  beforeEach(() => {
    vi.useFakeTimers();
    connect = vi.spyOn(RelayTransport, 'connect');
  });
  afterEach(() => {
    connect.mockRestore();
    vi.useRealTimers();
  });

  /** A session mid-send to peer 'b', whose batch is then aborted by that peer leaving. */
  async function abortedSend() {
    const relay = fakeRelay();
    connect.mockResolvedValue({
      transport: relay.transport, code: 'ABC123', peerId: 'a', peerPresent: false,
    } satisfies RelayConnection);

    const session = await Session.create('ws://test/ws');
    const identity = await rawIdentity();
    const first = generateNoncePrefix();
    const texts: string[] = [];
    session.events.onText = (content) => { texts.push(content); };

    const outgoing = new Promise<void>((resolve) => { session.events.onOutgoing = () => resolve(); });
    const key = await pairWith(session, relay, identity, first);
    // Not awaited: the point is a batch that never finishes, so its
    // #queuedFiles entry is still there when the peer leaves.
    const pending = session.sendFiles([new File([new Uint8Array(10)], 'x.bin')]).catch(() => undefined);
    await outgoing;
    relay.triggerPeerLeft();
    await pending;

    return { session, relay, key, first, identity, texts };
  }

  /**
   * Delivers a resume-from for the batch's fileId, then a text snippet
   * behind it. The Receiver serializes frames, so the text arriving proves
   * the resume-from ahead of it has already been handled — a plain wait
   * would only prove that time passed.
   */
  async function resumeThenText(
    relay: ReturnType<typeof fakeRelay>, key: CryptoKey, prefix: Uint8Array, texts: string[],
  ): Promise<void> {
    // Seq 1n and 2n: 0n was this peer's own 'verified' frame, sent while pairing.
    relay.deliver(await sealedControl(key, prefix, 1n, { t: 'resume-from', fileId: 1, bytesReceived: 0 }));
    relay.deliver(await sealedControl(key, prefix, 2n, { t: 'text', content: 'barrier' }));
    await vi.waitFor(() => expect(texts).toEqual(['barrier']));
  }

  it('does not resend a departed peer\'s file to a replacement peer that asks for it', async () => {
    const { session, relay, texts } = await abortedSend();
    // A different peer, so a different key agreement and a different
    // verification number — which is the shape a real replacement has, and
    // the reason its resume-from cannot inherit the departed peer's files.
    const other = await rawIdentity();
    const replacement = generateNoncePrefix();

    const replacementKey = await pairWith(session, relay, other, replacement);
    const before = dataFrameCount(relay.sent);
    await resumeThenText(relay, replacementKey, replacement, texts);

    expect(dataFrameCount(relay.sent)).toBe(before);
    session.close();
  });

  it('still resends to the same peer coming back, which is what the entries are kept for', async () => {
    // The other half of the pair: without it, "no resend" would also pass
    // for a session that had simply stopped resuming anything at all.
    const {
      session, relay, key, first, identity, texts,
    } = await abortedSend();

    relay.deliver(helloFrame(first, identity));
    const before = dataFrameCount(relay.sent);
    await resumeThenText(relay, key, first, texts);

    await vi.waitFor(() => expect(dataFrameCount(relay.sent)).toBeGreaterThan(before));
    session.close();
  });

  it('treats a replacement as a replacement even after the peer-gone timer dropped the Receiver', async () => {
    // The gap the old `if (this.#receiver && ...)` gate left open: with no
    // Receiver to compare prefixes against, a different peer read as the
    // same one purely by absence of evidence.
    const { session, relay, texts } = await abortedSend();

    // Long enough that #peerGoneTimer has fired and dropped the Receiver.
    await vi.advanceTimersByTimeAsync(RECONNECT_BUDGET_MS + 1000);

    const other = await rawIdentity();
    const replacement = generateNoncePrefix();
    const replacementKey = await pairWith(session, relay, other, replacement);
    const before = dataFrameCount(relay.sent);
    await resumeThenText(relay, replacementKey, replacement, texts);

    expect(dataFrameCount(relay.sent)).toBe(before);
    session.close();
  });

  it('closes the transport it is replacing when a reconnect lands', async () => {
    // #attachSwitchable builds a brand new SwitchableTransport around the
    // fresh socket. Dropping the reference to the old one alone leaks it —
    // and if that one had been upgraded, its RTCPeerConnection with it.
    const { session, relay } = await abortedSend();
    const replacement = fakeRelay();
    connect.mockResolvedValue({
      transport: replacement.transport, code: 'ABC123', peerId: 'a', peerPresent: true,
    } satisfies RelayConnection);

    relay.triggerClose();
    await vi.advanceTimersByTimeAsync(2000);

    expect(relay.isClosed()).toBe(true);
    expect(replacement.isClosed()).toBe(false);
    session.close();
  });

  it('leaves no timer running once the session is confirmed over', async () => {
    // giveUp is terminal — the relay said the room itself is gone — so the
    // ~92s "give up on this peer" timer #unpair armed has nothing left to
    // protect and must not outlive the session that armed it.
    const { session, relay } = await abortedSend();
    const ended: string[] = [];
    session.events.onSessionEnded = (reason) => { ended.push(reason); };

    // Armed by the peer-left inside abortedSend().
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // This session's OWN socket now dies, and the room turns out to be gone.
    connect.mockRejectedValue(new Error('not-found'));
    relay.triggerClose();
    await vi.advanceTimersByTimeAsync(2000);

    expect(ended).toEqual(['room-gone']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

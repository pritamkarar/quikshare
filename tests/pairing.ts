import { expect } from 'vitest';
import {
  deriveSession, exportPublicKey, generateKeyPair, importKey, makeNonce, seal,
} from '../client/crypto.js';
import {
  FrameType, decodeControl, decodeFrame, encodeControl, encodeFrame, encodeHeader,
} from '../client/protocol.js';
import type { ControlMessage } from '../shared/messages.js';

/**
 * The verification gate, from a test's point of view.
 *
 * The session key is agreed over the relay now rather than carried in the
 * link (client/crypto.ts, `deriveSession`), so `Session` refuses every send
 * until the people at both ends have confirmed they are looking at the same
 * six digits. Two real sessions in a test are two devices whose users would
 * do exactly that — so this is what a paired session looks like from here,
 * and every test that moves a byte goes through it.
 */
interface Verifiable {
  verification: string | undefined;
  verified: boolean;
  confirmVerification(): void;
}

/** Real-time polling: crypto.subtle work cannot be observed by flushing microtasks. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition was not met before the timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function confirmBoth(a: Verifiable, b: Verifiable): Promise<void> {
  await waitFor(() => a.verification !== undefined && b.verification !== undefined);
  // Not incidental to the setup — this IS the security property. Two devices
  // that agreed a key with each other, rather than with something in the
  // middle, are the only two that can reach the same number.
  expect(a.verification).toBe(b.verification);
  a.confirmVerification();
  b.confirmVerification();
  await waitFor(() => a.verified && b.verified);
}

/**
 * A raw relay peer's half of the key agreement.
 *
 * The session key is not in the share link any more — the two devices agree
 * it in the hello exchange (client/crypto.ts, `deriveSession`) — so a test
 * peer that wants to seal or open anything has to do the real exchange:
 * publish its own public key, read the session's out of the hello it sends
 * back, and derive. Shared by every integration test that stands up a bare
 * socket instead of a second `Session`.
 */
export interface RawIdentity { pair: CryptoKeyPair; pub: string }

export async function rawIdentity(): Promise<RawIdentity> {
  const pair = await generateKeyPair();
  return { pair, pub: await exportPublicKey(pair) };
}

/** The `pub` from the first hello in `frames`, or undefined if none has arrived. */
export function helloPub(frames: Uint8Array[]): string | undefined {
  for (const raw of frames) {
    const frame = decodeFrame(raw);
    if (frame.type !== FrameType.Hello) continue;
    const msg = decodeControl(frame.payload);
    if (msg.t === 'hello') return msg.pub;
  }
  return undefined;
}

export function rawHello(noncePrefix: unknown, pub: string, peerId: 'a' | 'b' = 'b'): Uint8Array {
  return encodeFrame(FrameType.Hello, 0, 0n, encodeControl({
    t: 'hello', peerId, noncePrefix, pub, saveCapability: 'blob', maxBufferedBytes: 1024 * 1024,
  } as unknown as ControlMessage));
}

/** The key this raw peer and the session agree on, once the session's hello has landed. */
export async function agreedKey(
  frames: Uint8Array[], identity: RawIdentity, code: string,
): Promise<CryptoKey> {
  await waitFor(() => helloPub(frames) !== undefined);
  const { rawKey } = await deriveSession(identity.pair.privateKey, helloPub(frames)!, code);
  return importKey(rawKey);
}

/**
 * A sealed control frame as the raw peer (always 'b') would send it, with the
 * frame header bound in as additional data.
 */
export async function sealedControl(
  key: CryptoKey, prefix: Uint8Array, seq: bigint, msg: ControlMessage,
): Promise<Uint8Array> {
  const header = encodeHeader(FrameType.Control, 0, seq);
  const sealed = await seal(key, makeNonce('b', prefix, seq), encodeControl(msg), header);
  return encodeFrame(FrameType.Control, 0, seq, sealed);
}

/**
 * Both ends confirm the six digits, with a raw peer standing in for one of
 * them — the gate `Session` puts in front of every send. The peer's half is a
 * sealed frame, which is the point of sealing it: only something holding the
 * derived key can send it.
 */
export async function rawConfirm(
  session: { verification: string | undefined; verified: boolean; confirmVerification(): void },
  send: (frame: Uint8Array) => void,
  key: CryptoKey, prefix: Uint8Array, seq: bigint,
): Promise<void> {
  await waitFor(() => session.verification !== undefined);
  send(await sealedControl(key, prefix, seq, { t: 'verified' }));
  session.confirmVerification();
  await waitFor(() => session.verified);
}

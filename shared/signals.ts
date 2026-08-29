// shared/signals.ts
// Text WebSocket frames only. Binary frames are never parsed by the server.

import { cleanText } from './device.js';

export type ClientSignal =
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'rtc'; payload: unknown };

export type ServerSignal =
  /**
   * `ip` is the address the relay observed this connection coming from — the
   * one thing about a device that only the server can know, since a browser
   * has no way to see its own public address. Optional on the wire so an
   * older relay (or one behind a proxy it was told not to trust) simply
   * omits it and the device panel renders that field as unknown, rather than
   * the client refusing a signal it otherwise understands perfectly.
   *
   * It is told only to the device it belongs to. Whether the *peer* ever
   * learns it is then that device's own decision, made one layer up: it
   * travels on in a sealed control frame (shared/messages.ts, `device`), so
   * the relay cannot read back out of its own traffic which two addresses it
   * just introduced to each other.
   */
  | { t: 'created'; code: string; peerId: 'a' | 'b'; ip?: string }
  | { t: 'joined'; code: string; peerId: 'a' | 'b'; ip?: string }
  | { t: 'peer-joined' }
  | { t: 'peer-left' }
  | { t: 'error'; reason: 'not-found' | 'full' | 'bad-request' | 'rate-limited' }
  | { t: 'rtc'; payload: unknown };

/**
 * Parses an untrusted text frame into a ClientSignal, or undefined if it is
 * not one. Constructs a fresh object rather than passing the caller's through,
 * so unexpected fields and prototype tampering cannot reach the handler.
 */
export function parseClientSignal(text: string): ClientSignal | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const signal = value as Record<string, unknown>;
  switch (signal.t) {
    case 'create':
      return { t: 'create' };
    case 'join':
      return typeof signal.code === 'string' ? { t: 'join', code: signal.code } : undefined;
    case 'rtc':
      return 'payload' in signal ? { t: 'rtc', payload: signal.payload } : undefined;
    default:
      return undefined;
  }
}

const ERROR_REASONS = ['not-found', 'full', 'bad-request', 'rate-limited'] as const;

function isPeerId(value: unknown): value is 'a' | 'b' {
  return value === 'a' || value === 'b';
}

/**
 * The client half of the same discipline, and it matters more: `peerId` from
 * this frame reaches `makeNonce`, where the relay is the untrusted party
 * supplying it. Returns undefined for anything that is not a signal, so the
 * caller ignores it rather than acting on a half-parsed object.
 */
export function parseServerSignal(text: string): ServerSignal | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const signal = value as Record<string, unknown>;
  switch (signal.t) {
    // `ip` goes through cleanText for the same reason every peer-supplied
    // field does: the relay is an active adversary here too, this string is
    // rendered as text in the device panel, and an unstripped bidi override
    // in it would repaint the labels around it. A missing or unusable value
    // yields undefined, which the panel already renders as unknown.
    case 'created':
      return typeof signal.code === 'string' && isPeerId(signal.peerId)
        ? { t: 'created', code: signal.code, peerId: signal.peerId, ip: cleanText(signal.ip) }
        : undefined;
    case 'joined':
      return typeof signal.code === 'string' && isPeerId(signal.peerId)
        ? { t: 'joined', code: signal.code, peerId: signal.peerId, ip: cleanText(signal.ip) }
        : undefined;
    case 'peer-joined':
      return { t: 'peer-joined' };
    case 'peer-left':
      return { t: 'peer-left' };
    case 'error': {
      const reason = ERROR_REASONS.find((known) => known === signal.reason);
      return reason ? { t: 'error', reason } : undefined;
    }
    case 'rtc':
      return 'payload' in signal ? { t: 'rtc', payload: signal.payload } : undefined;
    default:
      return undefined;
  }
}

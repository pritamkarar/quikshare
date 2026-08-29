import { describe, expect, it } from 'vitest';
import { parseClientSignal, parseServerSignal } from '../../shared/signals.js';

describe('parseClientSignal', () => {
  it('accepts a valid create signal', () => {
    expect(parseClientSignal(JSON.stringify({ t: 'create' }))).toEqual({ t: 'create' });
  });

  it('accepts a valid join signal with a string code', () => {
    expect(parseClientSignal(JSON.stringify({ t: 'join', code: 'K7M3QP' }))).toEqual({
      t: 'join',
      code: 'K7M3QP',
    });
  });

  it('rejects a join signal with a numeric code', () => {
    expect(parseClientSignal(JSON.stringify({ t: 'join', code: 123 }))).toBeUndefined();
  });

  it('rejects a join signal with a missing code', () => {
    expect(parseClientSignal(JSON.stringify({ t: 'join' }))).toBeUndefined();
  });

  it('accepts a valid rtc signal with a payload', () => {
    expect(parseClientSignal(JSON.stringify({ t: 'rtc', payload: { sdp: 'x' } }))).toEqual({
      t: 'rtc',
      payload: { sdp: 'x' },
    });
  });

  it('rejects null', () => {
    expect(parseClientSignal('null')).toBeUndefined();
  });

  it('rejects a bare string', () => {
    expect(parseClientSignal(JSON.stringify('hello'))).toBeUndefined();
  });

  it('rejects a bare number', () => {
    expect(parseClientSignal('42')).toBeUndefined();
  });

  it('rejects an array', () => {
    expect(parseClientSignal(JSON.stringify(['create']))).toBeUndefined();
  });

  it('rejects malformed JSON', () => {
    expect(parseClientSignal('not json at all')).toBeUndefined();
  });

  it('rejects an unknown t', () => {
    expect(parseClientSignal(JSON.stringify({ t: 'nope' }))).toBeUndefined();
  });

  it('does not propagate extra fields on a join signal', () => {
    const result = parseClientSignal(JSON.stringify({ t: 'join', code: 'K7M3QP', evil: true }));
    expect(result).toEqual({ t: 'join', code: 'K7M3QP' });
    expect(result).not.toHaveProperty('evil');
  });
});

describe('parseServerSignal', () => {
  /*
   * The address the relay observed, which is the one fact about a device a
   * browser cannot supply for itself. Optional on the wire so an older relay
   * simply omits it -- a signal the client otherwise understands perfectly
   * must not be refused over a cosmetic field.
   */
  it('carries the observed address when the relay sends one', () => {
    expect(parseServerSignal(JSON.stringify({ t: 'created', code: 'K7M3QP', peerId: 'a', ip: '203.0.113.7' })))
      .toEqual({ t: 'created', code: 'K7M3QP', peerId: 'a', ip: '203.0.113.7' });
    expect(parseServerSignal(JSON.stringify({ t: 'joined', code: 'K7M3QP', peerId: 'b', ip: '203.0.113.8' })))
      .toEqual({ t: 'joined', code: 'K7M3QP', peerId: 'b', ip: '203.0.113.8' });
  });

  it('accepts a signal from a relay that sends no address at all', () => {
    expect(parseServerSignal(JSON.stringify({ t: 'created', code: 'K7M3QP', peerId: 'a' })))
      .toMatchObject({ t: 'created', ip: undefined });
  });

  /*
   * The relay is an active adversary here as much as anywhere else, and this
   * string is rendered as text in the device panel -- an unstripped bidi
   * override in it would repaint the labels around it.
   */
  it('sanitises the address rather than passing it through', () => {
    expect(parseServerSignal(JSON.stringify({ t: 'created', code: 'K7M3QP', peerId: 'a', ip: 42 })))
      .toMatchObject({ ip: undefined });
    // Narrowed rather than cast: `ip` only exists on the created/joined
    // members of the union, and reaching for it off the whole union would be
    // a type error that a cast would have hidden.
    const clamped = parseServerSignal(JSON.stringify({ t: 'created', code: 'K7M3QP', peerId: 'a', ip: 'X'.repeat(400) }));
    expect(clamped?.t === 'created' && clamped.ip).toHaveLength(48);
  });

  it('accepts created and joined with a valid peer id', () => {
    expect(parseServerSignal(JSON.stringify({ t: 'created', code: 'K7M3QP', peerId: 'a' })))
      .toEqual({ t: 'created', code: 'K7M3QP', peerId: 'a' });
    expect(parseServerSignal(JSON.stringify({ t: 'joined', code: 'K7M3QP', peerId: 'b' })))
      .toEqual({ t: 'joined', code: 'K7M3QP', peerId: 'b' });
  });

  it('rejects a peer id outside a and b', () => {
    // This field becomes the leading byte of every nonce this peer derives,
    // and the relay supplies it. An unrecognised value must never reach
    // makeNonce, where an undefined lookup would coerce to peer byte 0.
    for (const peerId of ['c', 'A', '', 0, null, ['a'], '__proto__']) {
      expect(parseServerSignal(JSON.stringify({ t: 'created', code: 'K7M3QP', peerId }))).toBeUndefined();
    }
    expect(parseServerSignal(JSON.stringify({ t: 'joined', code: 'K7M3QP' }))).toBeUndefined();
  });

  it('rejects a non-string code', () => {
    expect(parseServerSignal(JSON.stringify({ t: 'created', code: 123, peerId: 'a' }))).toBeUndefined();
    expect(parseServerSignal(JSON.stringify({ t: 'joined', peerId: 'b' }))).toBeUndefined();
  });

  it('accepts the presence signals', () => {
    expect(parseServerSignal(JSON.stringify({ t: 'peer-joined' }))).toEqual({ t: 'peer-joined' });
    expect(parseServerSignal(JSON.stringify({ t: 'peer-left' }))).toEqual({ t: 'peer-left' });
  });

  it('accepts only the known error reasons', () => {
    for (const reason of ['not-found', 'full', 'bad-request', 'rate-limited']) {
      expect(parseServerSignal(JSON.stringify({ t: 'error', reason }))).toEqual({ t: 'error', reason });
    }
    expect(parseServerSignal(JSON.stringify({ t: 'error', reason: 'teapot' }))).toBeUndefined();
    expect(parseServerSignal(JSON.stringify({ t: 'error' }))).toBeUndefined();
  });

  it('accepts an rtc signal with a payload', () => {
    expect(parseServerSignal(JSON.stringify({ t: 'rtc', payload: { sdp: 'x' } })))
      .toEqual({ t: 'rtc', payload: { sdp: 'x' } });
    expect(parseServerSignal(JSON.stringify({ t: 'rtc' }))).toBeUndefined();
  });

  it('rejects malformed JSON, non-objects and unknown types', () => {
    expect(parseServerSignal('not json at all')).toBeUndefined();
    expect(parseServerSignal('null')).toBeUndefined();
    expect(parseServerSignal('42')).toBeUndefined();
    expect(parseServerSignal(JSON.stringify('peer-joined'))).toBeUndefined();
    expect(parseServerSignal(JSON.stringify(['peer-joined']))).toBeUndefined();
    expect(parseServerSignal(JSON.stringify({ t: 'nope' }))).toBeUndefined();
  });

  it('does not propagate extra fields', () => {
    const result = parseServerSignal(JSON.stringify({ t: 'created', code: 'K7M3QP', peerId: 'a', evil: true }));
    expect(result).toEqual({ t: 'created', code: 'K7M3QP', peerId: 'a' });
    expect(result).not.toHaveProperty('evil');
  });
});

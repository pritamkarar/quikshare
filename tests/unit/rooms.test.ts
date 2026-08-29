import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRegistry, type Peer } from '../../server/rooms.js';

function fakePeer(): Peer & { sent: (string | Uint8Array)[] } {
  const sent: (string | Uint8Array)[] = [];
  return { sent, send: (d) => sent.push(d), close: vi.fn() };
}

describe('RoomRegistry', () => {
  let registry: RoomRegistry;
  beforeEach(() => { registry = new RoomRegistry(); });

  it('creates a room with the creator as peer a', () => {
    const { code, peerId } = registry.create(fakePeer());
    expect(code).toHaveLength(6);
    expect(peerId).toBe('a');
    expect(registry.size).toBe(1);
  });

  it('lets a second peer join as peer b', () => {
    const { code } = registry.create(fakePeer());
    const result = registry.join(code, fakePeer());
    expect(result).toEqual({ ok: true, peerId: 'b' });
  });

  it('rejects a join for an unknown code', () => {
    expect(registry.join('ZZZZZZ', fakePeer())).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects a third peer', () => {
    const { code } = registry.create(fakePeer());
    registry.join(code, fakePeer());
    expect(registry.join(code, fakePeer())).toEqual({ ok: false, reason: 'full' });
  });

  it('resolves the other peer in the room', () => {
    const a = fakePeer();
    const b = fakePeer();
    const { code } = registry.create(a);
    registry.join(code, b);
    expect(registry.other(code, 'a')).toBe(b);
    expect(registry.other(code, 'b')).toBe(a);
  });

  it('returns undefined when the other peer has not joined', () => {
    const { code } = registry.create(fakePeer());
    expect(registry.other(code, 'a')).toBeUndefined();
  });

  it('frees the slot when a peer leaves so the peer can rejoin', () => {
    const { code } = registry.create(fakePeer());
    registry.join(code, fakePeer());
    registry.leave(code, 'b');
    expect(registry.join(code, fakePeer())).toEqual({ ok: true, peerId: 'b' });
  });

  it('deletes the room when the last peer leaves', () => {
    const { code } = registry.create(fakePeer());
    registry.leave(code, 'a');
    expect(registry.size).toBe(0);
    expect(registry.join(code, fakePeer())).toEqual({ ok: false, reason: 'not-found' });
  });

  it('sweeps rooms idle beyond the limit and closes their peers', () => {
    const registry = new RoomRegistry(undefined, () => 0);
    const a = fakePeer();
    const { code } = registry.create(a);
    expect(registry.sweep(60_000, 30_000)).toBe(1);
    expect(registry.size).toBe(0);
    expect(a.close).toHaveBeenCalled();
    expect(code).toHaveLength(6);
  });

  it('does not sweep rooms touched recently', () => {
    let clock = 0;
    const registry = new RoomRegistry(undefined, () => clock);
    const { code } = registry.create(fakePeer());
    clock = 20_000;
    registry.touch(code);
    expect(registry.sweep(40_000, 30_000)).toBe(0);
    expect(registry.size).toBe(1);
  });

  it('retries on code collision instead of overwriting a live room', () => {
    const codes = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
    let i = 0;
    const r = new RoomRegistry(() => codes[i++]!);
    expect(r.create(fakePeer()).code).toBe('AAAAAA');
    expect(r.create(fakePeer()).code).toBe('BBBBBB');
    expect(r.size).toBe(2);
  });
});

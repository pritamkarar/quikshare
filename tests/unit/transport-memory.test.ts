import { describe, expect, it } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';

describe('createMemoryPair', () => {
  it('delivers frames from one side to the other', async () => {
    const [a, b] = createMemoryPair();
    const received: Uint8Array[] = [];
    b.onMessage((f) => received.push(f));
    a.send(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    expect([...(received[0] ?? [])]).toEqual([1, 2, 3]);
  });

  it('delivers in both directions', async () => {
    const [a, b] = createMemoryPair();
    const received: Uint8Array[] = [];
    a.onMessage((f) => received.push(f));
    b.send(new Uint8Array([9]));
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });

  it('reports kind relay so consumers need no special case', () => {
    const [a] = createMemoryPair();
    expect(a.kind).toBe('relay');
  });

  it('tells the peer the partner left, and the closer its own socket closed', async () => {
    const [a, b] = createMemoryPair();
    let peerReason = '';
    let ownReason = '';
    b.onClose((reason) => { peerReason = reason; });
    a.onClose((reason) => { ownReason = reason; });
    a.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(peerReason).toBe('peer-left');
    expect(ownReason).toBe('socket-closed');
  });

  it('copies frames so the sender can reuse its buffer', async () => {
    const [a, b] = createMemoryPair();
    const received: Uint8Array[] = [];
    b.onMessage((f) => received.push(f));
    const buf = new Uint8Array([5]);
    a.send(buf);
    buf[0] = 0;
    await Promise.resolve();
    expect(received[0]?.[0]).toBe(5);
  });
});

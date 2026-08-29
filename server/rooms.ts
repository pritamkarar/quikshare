import { generateCode } from '../shared/codes.js';

export type PeerId = 'a' | 'b';

export interface Peer {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

interface Room {
  code: string;
  peers: Map<PeerId, Peer>;
  lastActivity: number;
}

const MAX_COLLISION_RETRIES = 8;

export class RoomRegistry {
  readonly #rooms = new Map<string, Room>();
  readonly #generate: () => string;
  #now: () => number;

  constructor(generate: () => string = generateCode, now: () => number = Date.now) {
    this.#generate = generate;
    this.#now = now;
  }

  get size(): number {
    return this.#rooms.size;
  }

  create(peer: Peer): { code: string; peerId: PeerId } {
    let code = '';
    for (let i = 0; i < MAX_COLLISION_RETRIES; i++) {
      const candidate = this.#generate();
      if (!this.#rooms.has(candidate)) { code = candidate; break; }
    }
    if (!code) throw new Error('could not allocate an unused room code');

    this.#rooms.set(code, {
      code,
      peers: new Map([['a', peer]]),
      lastActivity: this.#now(),
    });
    return { code, peerId: 'a' };
  }

  join(code: string, peer: Peer): { ok: true; peerId: PeerId } | { ok: false; reason: 'not-found' | 'full' } {
    const room = this.#rooms.get(code);
    if (!room) return { ok: false, reason: 'not-found' };

    const free: PeerId | undefined = (['a', 'b'] as const).find((id) => !room.peers.has(id));
    if (!free) return { ok: false, reason: 'full' };

    room.peers.set(free, peer);
    room.lastActivity = this.#now();
    return { ok: true, peerId: free };
  }

  leave(code: string, peerId: PeerId): void {
    const room = this.#rooms.get(code);
    if (!room) return;
    room.peers.delete(peerId);
    if (room.peers.size === 0) this.#rooms.delete(code);
    else room.lastActivity = this.#now();
  }

  other(code: string, peerId: PeerId): Peer | undefined {
    const room = this.#rooms.get(code);
    if (!room) return undefined;
    return room.peers.get(peerId === 'a' ? 'b' : 'a');
  }

  touch(code: string): void {
    const room = this.#rooms.get(code);
    if (room) room.lastActivity = this.#now();
  }

  /** Removes rooms idle longer than maxIdleMs. Returns the number swept. */
  sweep(now: number, maxIdleMs: number): number {
    let swept = 0;
    for (const [code, room] of this.#rooms) {
      if (now - room.lastActivity < maxIdleMs) continue;
      for (const peer of room.peers.values()) peer.close(1000, 'session expired');
      this.#rooms.delete(code);
      swept++;
    }
    return swept;
  }
}

# soja-share Plan 1 — Core Relay Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two browser tabs pair with a six-character code and move an end-to-end encrypted file between them through the server relay, byte-identical, with no file ever readable by the server.

**Architecture:** A single Fastify process serves static assets and a WebSocket endpoint. The server parses only *text* WebSocket frames (pairing control) and forwards *binary* frames between the two paired sockets without inspecting them. The client encrypts every 64 KB chunk with AES-GCM in a Web Worker and frames it with a 13-byte header. All transfer logic sits behind a `Transport` interface; this plan implements only `RelayTransport`.

**Tech Stack:** Node ≥ 20.11, TypeScript 5.6 (strict), Fastify 5, `@fastify/websocket`, Vite 6, Vitest 3, Web Crypto (`globalThis.crypto.subtle`).

**Spec:** `docs/superpowers/specs/2026-08-25-soja-share-design.md`

## Global Constraints

- Node ≥ 20.11. `File`, `Blob`, and `globalThis.crypto.subtle` are assumed present in both Node and browser; no polyfills.
- TypeScript `strict: true`. No `any` in committed code except where a test deliberately constructs an invalid value.
- The server MUST NOT parse, inspect, log, or persist binary WebSocket frames. It forwards them verbatim.
- The encryption key MUST NOT appear in any HTTP request line, header, query string, or server log. It lives only in the URL fragment and in client memory.
- Room codes are 6 characters of Crockford base32, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O`, `U`).
- Chunk size is derived, not chosen: `CHUNK_SIZE = 65536 - HEADER_BYTES - GCM_TAG_BYTES = 65507`.
  The wire frame is then exactly 65,536 bytes, the interoperable maximum for a single WebRTC
  DataChannel message. A round 64 KB plaintext would overrun it and force a fragmentation layer
  in Plan 3 for no benefit.
- Nonce layout is `[peerByte: 1][random: 3][seq: 8]`, big-endian seq. `peerByte` is `0x01` for peer `a` and `0x02` for peer `b`.
- Frame header is `[type: u8][fileId: u32][seq: u64]` = 13 bytes, big-endian.
- Every task ends with a commit. Tests must fail before implementation exists.

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore` (already exists — verify contents)
- Test: `tests/unit/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: npm scripts `test`, `test:watch`, `typecheck`. All later tasks run `npm test`.

- [ ] **Step 1: Write the smoke test**

```ts
// tests/unit/smoke.test.ts
import { describe, expect, it } from 'vitest';

describe('environment', () => {
  it('has Web Crypto subtle available', () => {
    expect(globalThis.crypto?.subtle).toBeDefined();
  });

  it('has File and Blob available', () => {
    expect(typeof Blob).toBe('function');
    expect(typeof File).toBe('function');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/smoke.test.ts`
Expected: FAIL — vitest is not installed, command errors out.

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "soja-share",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.11" },
  "scripts": {
    "dev:server": "tsx watch server/index.ts",
    "dev:client": "vite",
    "build": "vite build && tsc -p tsconfig.server.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/static": "^8.0.0",
    "@fastify/websocket": "^11.0.0",
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 4: Create `tsconfig.json` and `tsconfig.server.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["client", "server", "shared", "tests"]
}
```

`tsconfig.server.json` emits the server build. The client is bundled by Vite and never goes through `tsc`.

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["server", "shared"]
}
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
```

- [ ] **Step 6: Install and run the test**

Run: `npm install && npm test`
Expected: PASS — 2 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.server.json vitest.config.ts tests/unit/smoke.test.ts
git commit -m "chore: scaffold project with vitest harness"
```

---

### Task 2: Room code generation and normalization

**Files:**
- Create: `server/codes.ts`
- Test: `tests/unit/codes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ALPHABET: string` — the 32 Crockford characters.
  - `CODE_LENGTH: 6`
  - `generateCode(): string`
  - `normalizeCode(input: string): string` — uppercases, strips separators, maps ambiguous characters, returns `''` if the result is not exactly `CODE_LENGTH` valid characters.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/codes.test.ts
import { describe, expect, it } from 'vitest';
import { ALPHABET, CODE_LENGTH, generateCode, normalizeCode } from '../../server/codes.js';

describe('generateCode', () => {
  it('produces a code of the required length', () => {
    expect(generateCode()).toHaveLength(CODE_LENGTH);
  });

  it('only uses alphabet characters', () => {
    for (let i = 0; i < 200; i++) {
      for (const ch of generateCode()) expect(ALPHABET).toContain(ch);
    }
  });

  it('excludes visually ambiguous characters', () => {
    for (const ch of 'ILOU') expect(ALPHABET).not.toContain(ch);
  });

  it('does not obviously repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, generateCode));
    expect(seen.size).toBeGreaterThan(490);
  });
});

describe('normalizeCode', () => {
  it('uppercases input', () => {
    expect(normalizeCode('k7m3qp')).toBe('K7M3QP');
  });

  it('strips spaces and dashes people type or paste', () => {
    expect(normalizeCode(' K7M-3QP ')).toBe('K7M3QP');
  });

  it('maps ambiguous characters per Crockford', () => {
    expect(normalizeCode('I7M3QP')).toBe('17M3QP');
    expect(normalizeCode('l7M3QP')).toBe('17M3QP');
    expect(normalizeCode('O7M3QP')).toBe('07M3QP');
  });

  it('returns empty string when the result is the wrong length', () => {
    expect(normalizeCode('K7M')).toBe('');
    expect(normalizeCode('K7M3QPX')).toBe('');
  });

  it('returns empty string for characters outside the alphabet', () => {
    expect(normalizeCode('K7M3Q!')).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/codes.test.ts`
Expected: FAIL — cannot resolve `../../server/codes.js`.

- [ ] **Step 3: Implement `server/codes.ts`**

```ts
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

/** Crockford base32 decodes I and L as 1, and O as 0. */
const AMBIGUOUS: Record<string, string> = { I: '1', L: '1', O: '0' };

export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  // The non-null assertion is safe: b % 32 is always a valid index.
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]!;
  return out;
}

export function normalizeCode(input: string): string {
  let out = '';
  for (const raw of input.toUpperCase()) {
    if (raw === ' ' || raw === '-' || raw === '_') continue;
    const ch = AMBIGUOUS[raw] ?? raw;
    if (!ALPHABET.includes(ch)) return '';
    out += ch;
  }
  return out.length === CODE_LENGTH ? out : '';
}
```

Note on `b % ALPHABET.length`: 256 is an exact multiple of 32, so this is uniform with no modulo bias. If `ALPHABET` ever changes length, revisit this.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/codes.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/codes.ts tests/unit/codes.test.ts
git commit -m "feat(server): add room code generation and normalization"
```

---

### Task 3: Room registry

**Files:**
- Create: `server/rooms.ts`
- Test: `tests/unit/rooms.test.ts`

**Interfaces:**
- Consumes: `generateCode` from `server/codes.ts`.
- Produces:
  - `type PeerId = 'a' | 'b'`
  - `interface Peer { send(data: string | Uint8Array): void; close(code: number, reason: string): void }`
  - `class RoomRegistry` with:
    - `create(peer: Peer): { code: string; peerId: PeerId }`
    - `join(code: string, peer: Peer): { ok: true; peerId: PeerId } | { ok: false; reason: 'not-found' | 'full' }`
    - `leave(code: string, peerId: PeerId): void`
    - `other(code: string, peerId: PeerId): Peer | undefined`
    - `touch(code: string): void`
    - `sweep(now: number, maxIdleMs: number): number`
    - `size: number` (getter)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/rooms.test.ts
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
    const a = fakePeer();
    const { code } = registry.create(a);
    expect(registry.sweep(60_000, 30_000)).toBe(1);
    expect(registry.size).toBe(0);
    expect(a.close).toHaveBeenCalled();
    expect(code).toHaveLength(6);
  });

  it('does not sweep rooms touched recently', () => {
    const { code } = registry.create(fakePeer());
    registry.touch(code);
    expect(registry.sweep(1_000, 30_000)).toBe(0);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/rooms.test.ts`
Expected: FAIL — cannot resolve `../../server/rooms.js`.

- [ ] **Step 3: Implement `server/rooms.ts`**

```ts
import { generateCode } from './codes.js';

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
```

Note: `touch` uses the injected `now`, but `sweep` takes `now` as a parameter so tests can advance time without faking timers. The test above calls `create` at time 0 (real `Date.now` is irrelevant because `sweep(60_000, 30_000)` compares against `lastActivity`) — if that proves flaky, pass a fake `now` into the constructor.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/rooms.test.ts`
Expected: PASS — 11 tests. If the sweep tests fail because real `Date.now()` is large, construct the registry as `new RoomRegistry(generateCode, () => 0)` in those two tests.

- [ ] **Step 5: Commit**

```bash
git add server/rooms.ts tests/unit/rooms.test.ts
git commit -m "feat(server): add room registry with pairing and idle sweep"
```

---

### Task 4: Signaling types and WebSocket pairing

**Files:**
- Create: `shared/signals.ts`
- Create: `server/index.ts`
- Test: `tests/integration/pairing.test.ts`

**Interfaces:**
- Consumes: `RoomRegistry`, `normalizeCode`.
- Produces:
  - `shared/signals.ts` exports `ClientSignal` and `ServerSignal` union types.
  - `server/index.ts` exports `buildServer(): Promise<FastifyInstance>` so tests can start it on an ephemeral port.

- [ ] **Step 1: Write `shared/signals.ts` first (it is pure types, no test needed)**

```ts
// shared/signals.ts
// Text WebSocket frames only. Binary frames are never parsed by the server.

export type ClientSignal =
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'rtc'; payload: unknown };

export type ServerSignal =
  | { t: 'created'; code: string; peerId: 'a' | 'b' }
  | { t: 'joined'; code: string; peerId: 'a' | 'b' }
  | { t: 'peer-joined' }
  | { t: 'peer-left' }
  | { t: 'error'; reason: 'not-found' | 'full' | 'bad-request' }
  | { t: 'rtc'; payload: unknown };
```

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/pairing.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import type { ServerSignal } from '../../shared/signals.js';

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolves with the next text frame, decoded. */
function nextSignal(ws: WebSocket): Promise<ServerSignal> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) throw new Error('expected a text frame');
      resolve(JSON.parse(data.toString()) as ServerSignal);
    });
  });
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('pairing', () => {
  it('issues a code to the creator', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const signal = await nextSignal(a);
    expect(signal).toMatchObject({ t: 'created', peerId: 'a' });
    if (signal.t !== 'created') throw new Error('unreachable');
    expect(signal.code).toHaveLength(6);
    a.close();
  });

  it('notifies both peers when the second joins', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const aNotified = nextSignal(a);
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: created.code }));

    expect(await nextSignal(b)).toMatchObject({ t: 'joined', peerId: 'b' });
    expect(await aNotified).toEqual({ t: 'peer-joined' });
    a.close();
    b.close();
  });

  it('accepts a lowercase, dashed code', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const messy = `${created.code.slice(0, 3)}-${created.code.slice(3)}`.toLowerCase();
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: messy }));
    expect(await nextSignal(b)).toMatchObject({ t: 'joined' });
    a.close();
    b.close();
  });

  it('rejects an unknown code', async () => {
    const url = await start();
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: 'ZZZZZZ' }));
    expect(await nextSignal(b)).toEqual({ t: 'error', reason: 'not-found' });
    b.close();
  });

  it('rejects a third peer', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: created.code }));
    await nextSignal(b);

    const c = await connect(url);
    c.send(JSON.stringify({ t: 'join', code: created.code }));
    expect(await nextSignal(c)).toEqual({ t: 'error', reason: 'full' });
    a.close(); b.close(); c.close();
  });

  it('tells the remaining peer when the other disconnects', async () => {
    const url = await start();
    const a = await connect(url);
    a.send(JSON.stringify({ t: 'create' }));
    const created = await nextSignal(a);
    if (created.t !== 'created') throw new Error('unreachable');

    const aNotified = nextSignal(a);
    const b = await connect(url);
    b.send(JSON.stringify({ t: 'join', code: created.code }));
    await nextSignal(b);
    await aNotified;

    const aLeft = nextSignal(a);
    b.close();
    expect(await aLeft).toEqual({ t: 'peer-left' });
    a.close();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/integration/pairing.test.ts`
Expected: FAIL — cannot resolve `../../server/index.js`.

- [ ] **Step 4: Implement `server/index.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { RoomRegistry, type Peer, type PeerId } from './rooms.js';
import { normalizeCode } from './codes.js';
import type { ClientSignal, ServerSignal } from '../shared/signals.js';

const SWEEP_INTERVAL_MS = 30_000;
const MAX_IDLE_MS = 10 * 60_000;

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const registry = new RoomRegistry();

  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  const sweeper = setInterval(() => {
    registry.sweep(Date.now(), MAX_IDLE_MS);
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  app.get('/ws', { websocket: true }, (socket) => {
    let code: string | undefined;
    let peerId: PeerId | undefined;

    const peer: Peer = {
      send: (data) => { if (socket.readyState === socket.OPEN) socket.send(data); },
      close: (statusCode, reason) => socket.close(statusCode, reason),
    };

    const reply = (signal: ServerSignal): void => peer.send(JSON.stringify(signal));
    const tellOther = (signal: ServerSignal): void => {
      if (!code || !peerId) return;
      registry.other(code, peerId)?.send(JSON.stringify(signal));
    };

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      // Binary frames are opaque application data. Task 5 forwards them.
      if (isBinary) return;

      let signal: ClientSignal;
      try {
        signal = JSON.parse(raw.toString()) as ClientSignal;
      } catch {
        reply({ t: 'error', reason: 'bad-request' });
        return;
      }

      switch (signal.t) {
        case 'create': {
          if (code) { reply({ t: 'error', reason: 'bad-request' }); return; }
          const created = registry.create(peer);
          code = created.code;
          peerId = created.peerId;
          reply({ t: 'created', code, peerId });
          return;
        }
        case 'join': {
          if (code) { reply({ t: 'error', reason: 'bad-request' }); return; }
          const normalized = normalizeCode(signal.code ?? '');
          if (!normalized) { reply({ t: 'error', reason: 'not-found' }); return; }
          const result = registry.join(normalized, peer);
          if (!result.ok) { reply({ t: 'error', reason: result.reason }); return; }
          code = normalized;
          peerId = result.peerId;
          reply({ t: 'joined', code, peerId });
          tellOther({ t: 'peer-joined' });
          return;
        }
        case 'rtc': {
          if (!code || !peerId) return;
          registry.touch(code);
          tellOther({ t: 'rtc', payload: signal.payload });
          return;
        }
        default:
          reply({ t: 'error', reason: 'bad-request' });
      }
    });

    socket.on('close', () => {
      tellOther({ t: 'peer-left' });
      if (code && peerId) registry.leave(code, peerId);
      code = undefined;
      peerId = undefined;
    });
  });

  return app;
}
```

Note the ordering in `socket.on('close')`: `tellOther` runs *before* `registry.leave`, because after leaving there is no room membership left to resolve the other peer from.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/integration/pairing.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add shared/signals.ts server/index.ts tests/integration/pairing.test.ts
git commit -m "feat(server): pair peers over websocket with room codes"
```

---

### Task 5: Opaque binary relay

**Files:**
- Modify: `server/index.ts` — the `if (isBinary) return;` branch
- Test: `tests/integration/relay.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: binary frames sent by one paired peer arrive byte-identical at the other.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/relay.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import type { ServerSignal } from '../../shared/signals.js';

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextSignal(ws: WebSocket): Promise<ServerSignal> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) throw new Error('expected a text frame');
      resolve(JSON.parse(data.toString()) as ServerSignal);
    });
  });
}

function nextBinary(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (!isBinary) throw new Error('expected a binary frame');
      resolve(data as Buffer);
    });
  });
}

async function pair(url: string): Promise<[WebSocket, WebSocket]> {
  const a = await connect(url);
  a.send(JSON.stringify({ t: 'create' }));
  const created = await nextSignal(a);
  if (created.t !== 'created') throw new Error('unreachable');
  const aNotified = nextSignal(a);
  const b = await connect(url);
  b.send(JSON.stringify({ t: 'join', code: created.code }));
  await nextSignal(b);
  await aNotified;
  return [a, b];
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('binary relay', () => {
  it('forwards a binary frame verbatim from a to b', async () => {
    const url = await start();
    const [a, b] = await pair(url);
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
    const received = nextBinary(b);
    a.send(payload);
    expect(Buffer.compare(await received, payload)).toBe(0);
    a.close(); b.close();
  });

  it('forwards in both directions', async () => {
    const url = await start();
    const [a, b] = await pair(url);
    const payload = Buffer.from('reply bytes');
    const received = nextBinary(a);
    b.send(payload);
    expect(Buffer.compare(await received, payload)).toBe(0);
    a.close(); b.close();
  });

  it('preserves order across many frames', async () => {
    const url = await start();
    const [a, b] = await pair(url);
    const count = 200;
    const seen: number[] = [];
    const done = new Promise<void>((resolve) => {
      b.on('message', (data, isBinary) => {
        if (!isBinary) return;
        seen.push((data as Buffer).readUInt32BE(0));
        if (seen.length === count) resolve();
      });
    });
    for (let i = 0; i < count; i++) {
      const frame = Buffer.alloc(4);
      frame.writeUInt32BE(i, 0);
      a.send(frame);
    }
    await done;
    expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
    a.close(); b.close();
  });

  it('drops binary frames from an unpaired peer instead of crashing', async () => {
    const url = await start();
    const lonely = await connect(url);
    lonely.send(JSON.stringify({ t: 'create' }));
    await nextSignal(lonely);
    lonely.send(Buffer.from([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 50));
    expect(lonely.readyState).toBe(WebSocket.OPEN);
    lonely.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/relay.test.ts`
Expected: FAIL — the first three tests time out; binary frames are currently dropped.

- [ ] **Step 3: Replace the binary branch in `server/index.ts`**

Replace:

```ts
      // Binary frames are opaque application data. Task 5 forwards them.
      if (isBinary) return;
```

with:

```ts
      // Binary frames are opaque application ciphertext. Forward, never inspect.
      if (isBinary) {
        if (!code || !peerId) return;
        registry.touch(code);
        registry.other(code, peerId)?.send(new Uint8Array(raw));
        return;
      }
```

Also raise the websocket payload ceiling so a 64 KB chunk plus header and tag fits comfortably. Change the register call to:

```ts
  await app.register(websocket, {
    options: { maxPayload: 4 * 1024 * 1024 },
  });
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/relay.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Run the whole suite to check for regressions**

Run: `npm test`
Expected: PASS — all tests from Tasks 1–5.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts tests/integration/relay.test.ts
git commit -m "feat(server): relay opaque binary frames between paired peers"
```

---

### Task 6: Frame codec

**Files:**
- Create: `client/protocol.ts`
- Test: `tests/unit/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HEADER_BYTES = 13`
  - `enum FrameType { Control = 0, Data = 1 }`
  - `encodeFrame(type: FrameType, fileId: number, seq: bigint, payload: Uint8Array): Uint8Array`
  - `decodeFrame(buf: Uint8Array): { type: FrameType; fileId: number; seq: bigint; payload: Uint8Array }`
  - `encodeControl(msg: ControlMessage): Uint8Array` and `decodeControl(payload: Uint8Array): ControlMessage`
  - `shared/messages.ts` exporting `ControlMessage`, `FileMeta`, `SaveCapability`.

- [ ] **Step 1: Write `shared/messages.ts` (pure types)**

```ts
// shared/messages.ts
export type SaveCapability = 'fs-access' | 'sw-stream' | 'blob';

export interface FileMeta {
  id: number;
  name: string;
  size: number;
  type: string;
}

export type ControlMessage =
  | { t: 'hello'; peerId: 'a' | 'b'; noncePrefix: string; saveCapability: SaveCapability; maxBufferedBytes: number }
  | { t: 'offer-batch'; batchId: string; files: FileMeta[] }
  | { t: 'accept'; batchId: string }
  | { t: 'reject'; batchId: string; reason: string }
  | { t: 'file-end'; fileId: number }
  | { t: 'text'; content: string }
  | { t: 'switch-transport'; to: 'webrtc' }
  | { t: 'switch-ack' }
  | { t: 'resume-from'; fileId: number; bytesReceived: number };
```

`noncePrefix` is the sender's 3 random nonce bytes, base64url-encoded, so the receiver can reconstruct the nonce for each chunk. `resume-from` carries a byte offset rather than a sequence number: the sender still holds the `File` and can seek to that offset, so no replay buffer is needed.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/protocol.test.ts
import { describe, expect, it } from 'vitest';
import { FrameType, HEADER_BYTES, decodeControl, decodeFrame, encodeControl, encodeFrame } from '../../client/protocol.js';

describe('frame codec', () => {
  it('round-trips a data frame', () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = encodeFrame(FrameType.Data, 7, 42n, payload);
    const decoded = decodeFrame(frame);
    expect(decoded.type).toBe(FrameType.Data);
    expect(decoded.fileId).toBe(7);
    expect(decoded.seq).toBe(42n);
    expect([...decoded.payload]).toEqual([1, 2, 3, 250]);
  });

  it('uses a 13-byte header', () => {
    expect(encodeFrame(FrameType.Data, 0, 0n, new Uint8Array(0))).toHaveLength(HEADER_BYTES);
  });

  it('round-trips an empty payload', () => {
    const decoded = decodeFrame(encodeFrame(FrameType.Control, 0, 0n, new Uint8Array(0)));
    expect(decoded.payload).toHaveLength(0);
  });

  it('handles the maximum u32 file id', () => {
    const decoded = decodeFrame(encodeFrame(FrameType.Data, 0xffffffff, 0n, new Uint8Array(1)));
    expect(decoded.fileId).toBe(0xffffffff);
  });

  it('handles a sequence number beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 2n ** 53n + 7n;
    expect(decodeFrame(encodeFrame(FrameType.Data, 1, big, new Uint8Array(1))).seq).toBe(big);
  });

  it('round-trips a maximum-size payload', () => {
    const payload = new Uint8Array(65536 - HEADER_BYTES).fill(0xab);
    const frame = encodeFrame(FrameType.Data, 1, 1n, payload);
    expect(frame).toHaveLength(65536); // the WebRTC DataChannel ceiling
    expect(decodeFrame(frame).payload).toHaveLength(65536 - HEADER_BYTES);
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => decodeFrame(new Uint8Array(HEADER_BYTES - 1))).toThrow(/too short/i);
  });

  it('does not alias the source buffer', () => {
    const payload = new Uint8Array([9, 9, 9]);
    const decoded = decodeFrame(encodeFrame(FrameType.Data, 1, 1n, payload));
    payload[0] = 0;
    expect(decoded.payload[0]).toBe(9);
  });
});

describe('control codec', () => {
  it('round-trips a control message', () => {
    const msg = { t: 'text', content: 'hello — “curly”' } as const;
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });

  it('survives non-ASCII filenames', () => {
    const msg = {
      t: 'offer-batch',
      batchId: 'b1',
      files: [{ id: 1, name: 'résumé 日本語.pdf', size: 10, type: 'application/pdf' }],
    } as const;
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: FAIL — cannot resolve `../../client/protocol.js`.

- [ ] **Step 4: Implement `client/protocol.ts`**

```ts
import type { ControlMessage } from '../shared/messages.js';

export const HEADER_BYTES = 13;

export const FrameType = { Control: 0, Data: 1 } as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameType;
  fileId: number;
  seq: bigint;
  payload: Uint8Array;
}

export function encodeFrame(type: FrameType, fileId: number, seq: bigint, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, fileId, false);
  view.setBigUint64(5, seq, false);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < HEADER_BYTES) throw new Error(`frame too short: ${buf.length} bytes`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    type: view.getUint8(0) as FrameType,
    fileId: view.getUint32(1, false),
    seq: view.getBigUint64(5, false),
    // slice() copies, so the frame does not alias a reused network buffer.
    payload: buf.slice(HEADER_BYTES),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeControl(msg: ControlMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

export function decodeControl(payload: Uint8Array): ControlMessage {
  return JSON.parse(decoder.decode(payload)) as ControlMessage;
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 6: Commit**

```bash
git add shared/messages.ts client/protocol.ts tests/unit/protocol.test.ts
git commit -m "feat(client): add binary frame and control message codecs"
```

---

### Task 7: Session crypto

**Files:**
- Create: `client/crypto.ts`
- Test: `tests/unit/crypto.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `generateRawKey(): Uint8Array` (32 bytes)
  - `importKey(raw: Uint8Array): Promise<CryptoKey>`
  - `toBase64Url(bytes: Uint8Array): string` / `fromBase64Url(s: string): Uint8Array`
  - `generateNoncePrefix(): Uint8Array` (3 bytes)
  - `makeNonce(peerId: 'a' | 'b', prefix: Uint8Array, seq: bigint): Uint8Array` (12 bytes)
  - `seal(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>`
  - `open(key: CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/crypto.test.ts
import { describe, expect, it } from 'vitest';
import {
  fromBase64Url, generateNoncePrefix, generateRawKey, importKey, makeNonce, open, seal, toBase64Url,
} from '../../client/crypto.js';

describe('key material', () => {
  it('generates a 256-bit key', () => {
    expect(generateRawKey()).toHaveLength(32);
  });

  it('round-trips a key through base64url', () => {
    const raw = generateRawKey();
    expect([...fromBase64Url(toBase64Url(raw))]).toEqual([...raw]);
  });

  it('produces URL-fragment-safe text with no padding', () => {
    for (let i = 0; i < 50; i++) {
      const encoded = toBase64Url(generateRawKey());
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('nonce construction', () => {
  it('is 12 bytes', () => {
    expect(makeNonce('a', generateNoncePrefix(), 0n)).toHaveLength(12);
  });

  it('tags peer a and peer b differently', () => {
    const prefix = new Uint8Array([1, 2, 3]);
    expect(makeNonce('a', prefix, 5n)[0]).toBe(0x01);
    expect(makeNonce('b', prefix, 5n)[0]).toBe(0x02);
  });

  it('never collides across peers even with an identical prefix and counter', () => {
    const prefix = new Uint8Array([7, 7, 7]);
    const seen = new Set<string>();
    for (let seq = 0n; seq < 500n; seq++) {
      for (const peer of ['a', 'b'] as const) {
        seen.add(makeNonce(peer, prefix, seq).join(','));
      }
    }
    expect(seen.size).toBe(1000);
  });

  it('never repeats within one sender', () => {
    const prefix = generateNoncePrefix();
    const seen = new Set<string>();
    for (let seq = 0n; seq < 5000n; seq++) seen.add(makeNonce('a', prefix, seq).join(','));
    expect(seen.size).toBe(5000);
  });

  it('encodes the counter big-endian in the trailing 8 bytes', () => {
    const nonce = makeNonce('a', new Uint8Array([0, 0, 0]), 258n);
    expect([...nonce.slice(4)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
  });

  it('generates a 3-byte prefix', () => {
    expect(generateNoncePrefix()).toHaveLength(3);
  });
});

describe('seal and open', () => {
  it('round-trips a chunk', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    expect([...(await open(key, nonce, await seal(key, nonce, plaintext)))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips a full 64 KB chunk', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 1n);
    const plaintext = new Uint8Array(65536).fill(0x5a);
    expect(await open(key, nonce, await seal(key, nonce, plaintext))).toHaveLength(65536);
  });

  it('adds a 16-byte authentication tag', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const sealed = await seal(key, nonce, new Uint8Array(100));
    expect(sealed).toHaveLength(116);
  });

  it('rejects a tampered ciphertext', async () => {
    const key = await importKey(generateRawKey());
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const sealed = await seal(key, nonce, new Uint8Array([9, 9, 9]));
    sealed[2] ^= 0xff;
    await expect(open(key, nonce, sealed)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const nonce = makeNonce('a', generateNoncePrefix(), 0n);
    const sealed = await seal(await importKey(generateRawKey()), nonce, new Uint8Array([1]));
    await expect(open(await importKey(generateRawKey()), nonce, sealed)).rejects.toThrow();
  });

  it('rejects the wrong nonce', async () => {
    const key = await importKey(generateRawKey());
    const prefix = generateNoncePrefix();
    const sealed = await seal(key, makeNonce('a', prefix, 0n), new Uint8Array([1]));
    await expect(open(key, makeNonce('a', prefix, 1n), sealed)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/crypto.test.ts`
Expected: FAIL — cannot resolve `../../client/crypto.js`.

- [ ] **Step 3: Implement `client/crypto.ts`**

```ts
const KEY_BYTES = 32;
const NONCE_PREFIX_BYTES = 3;
const NONCE_BYTES = 12;
const TAG_BITS = 128;

const PEER_BYTE: Record<'a' | 'b', number> = { a: 0x01, b: 0x02 };

export function generateRawKey(): Uint8Array {
  const raw = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(raw);
  return raw;
}

export function generateNoncePrefix(): Uint8Array {
  const prefix = new Uint8Array(NONCE_PREFIX_BYTES);
  globalThis.crypto.getRandomValues(prefix);
  return prefix;
}

export function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Nonce layout: [peerByte:1][prefix:3][seq:8].
 * The peer byte guarantees the two senders in a session occupy disjoint
 * nonce space even though they share one key. Reuse would be catastrophic.
 */
export function makeNonce(peerId: 'a' | 'b', prefix: Uint8Array, seq: bigint): Uint8Array {
  if (prefix.length !== NONCE_PREFIX_BYTES) throw new Error('nonce prefix must be 3 bytes');
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce[0] = PEER_BYTE[peerId];
  nonce.set(prefix, 1);
  new DataView(nonce.buffer).setBigUint64(4, seq, false);
  return nonce;
}

export async function seal(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: TAG_BITS }, key, plaintext,
  );
  return new Uint8Array(sealed);
}

export async function open(key: CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: TAG_BITS }, key, ciphertext,
  );
  return new Uint8Array(opened);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64Url(s: string): Uint8Array {
  const padded = s.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/crypto.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add client/crypto.ts tests/unit/crypto.test.ts
git commit -m "feat(client): add AES-GCM session crypto with peer-tagged nonces"
```

---

### Task 8: Transport interface, in-memory double, and RelayTransport

**Files:**
- Create: `client/transport/types.ts`
- Create: `client/transport/memory.ts`
- Create: `client/transport/relay.ts`
- Test: `tests/unit/transport-memory.test.ts`
- Test: `tests/integration/transport-relay.test.ts`

**Interfaces:**
- Consumes: `shared/signals.ts`.
- Produces:
  - `interface Transport` as specified below.
  - `createMemoryPair(): [Transport, Transport]` — a synchronous in-process double used by every later transfer test.
  - `class RelayTransport implements Transport` with `static connect(url: string, intent: { t: 'create' } | { t: 'join'; code: string }): Promise<{ transport: RelayTransport; code: string; peerId: 'a' | 'b'; peerPresent: boolean }>`

- [ ] **Step 1: Write `client/transport/types.ts` (pure types)**

```ts
// client/transport/types.ts
export type TransportKind = 'relay' | 'webrtc';

export interface Transport {
  readonly kind: TransportKind;
  readonly bufferedAmount: number;
  send(frame: Uint8Array): void;
  onMessage(cb: (frame: Uint8Array) => void): void;
  onDrain(cb: () => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}
```

- [ ] **Step 2: Write the failing memory-transport test**

```ts
// tests/unit/transport-memory.test.ts
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

  it('notifies close handlers on both sides', () => {
    const [a, b] = createMemoryPair();
    let closed = '';
    b.onClose((reason) => { closed = reason; });
    a.close();
    expect(closed).toBe('peer closed');
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/unit/transport-memory.test.ts`
Expected: FAIL — cannot resolve `../../client/transport/memory.js`.

- [ ] **Step 4: Implement `client/transport/memory.ts`**

```ts
import type { Transport } from './types.js';

class MemoryTransport implements Transport {
  readonly kind = 'relay' as const;
  peer: MemoryTransport | undefined;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #closed = false;

  get bufferedAmount(): number { return 0; }

  send(frame: Uint8Array): void {
    if (this.#closed) return;
    const copy = frame.slice();
    // Deliver asynchronously so behaviour matches a real network transport.
    queueMicrotask(() => this.peer?.receive(copy));
  }

  receive(frame: Uint8Array): void {
    this.#onMessage?.(frame);
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(_cb: () => void): void { /* never buffers */ }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.peer?.remoteClosed();
  }

  remoteClosed(): void {
    this.#closed = true;
    this.#onClose?.('peer closed');
  }
}

export function createMemoryPair(): [Transport, Transport] {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
```

- [ ] **Step 5: Run the memory test**

Run: `npx vitest run tests/unit/transport-memory.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Write the failing relay-transport test**

```ts
// tests/integration/transport-relay.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { RelayTransport } from '../../client/transport/relay.js';

// RelayTransport uses the global WebSocket; Node 20 has one, but `ws` is
// closer to browser behaviour for binaryType handling in tests.
(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('RelayTransport', () => {
  it('creates a room and reports the code', async () => {
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    expect(created.code).toHaveLength(6);
    expect(created.peerId).toBe('a');
    expect(created.peerPresent).toBe(false);
    created.transport.close();
  });

  it('joins an existing room and carries frames both ways', async () => {
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    const joined = await RelayTransport.connect(url, { t: 'join', code: created.code });
    expect(joined.peerId).toBe('b');
    expect(joined.peerPresent).toBe(true);

    const atB = new Promise<Uint8Array>((r) => joined.transport.onMessage(r));
    created.transport.send(new Uint8Array([4, 5, 6]));
    expect([...(await atB)]).toEqual([4, 5, 6]);

    const atA = new Promise<Uint8Array>((r) => created.transport.onMessage(r));
    joined.transport.send(new Uint8Array([7]));
    expect([...(await atA)]).toEqual([7]);

    created.transport.close();
    joined.transport.close();
  });

  it('rejects a join for an unknown code', async () => {
    const url = await start();
    await expect(RelayTransport.connect(url, { t: 'join', code: 'ZZZZZZ' })).rejects.toThrow(/not-found/);
  });

  it('fires onClose when the peer disconnects', async () => {
    const url = await start();
    const created = await RelayTransport.connect(url, { t: 'create' });
    const joined = await RelayTransport.connect(url, { t: 'join', code: created.code });
    const closed = new Promise<string>((r) => created.transport.onClose(r));
    joined.transport.close();
    expect(await closed).toBe('peer-left');
    created.transport.close();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/integration/transport-relay.test.ts`
Expected: FAIL — cannot resolve `../../client/transport/relay.js`.

- [ ] **Step 8: Implement `client/transport/relay.ts`**

```ts
import type { Transport } from './types.js';
import type { ClientSignal, ServerSignal } from '../../shared/signals.js';

const HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 25;

export interface RelayConnection {
  transport: RelayTransport;
  code: string;
  peerId: 'a' | 'b';
  peerPresent: boolean;
}

export class RelayTransport implements Transport {
  readonly kind = 'relay' as const;
  readonly #socket: WebSocket;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #onPeerJoined: (() => void) | undefined;
  #onSignal: ((signal: ServerSignal) => void) | undefined;
  #drainTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        const signal = JSON.parse(event.data) as ServerSignal;
        if (signal.t === 'peer-joined') this.#onPeerJoined?.();
        else if (signal.t === 'peer-left') this.#onClose?.('peer-left');
        else this.#onSignal?.(signal);
        return;
      }
      this.#onMessage?.(new Uint8Array(event.data as ArrayBuffer));
    });

    socket.addEventListener('close', () => {
      this.#stopDrainPolling();
      this.#onClose?.('socket-closed');
    });
  }

  static connect(url: string, intent: { t: 'create' } | { t: 'join'; code: string }): Promise<RelayConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const transport = new RelayTransport(socket);

      const settle = (signal: ServerSignal): void => {
        if (signal.t === 'error') { socket.close(); reject(new Error(signal.reason)); return; }
        if (signal.t !== 'created' && signal.t !== 'joined') return;
        transport.#onSignal = undefined;
        resolve({
          transport,
          code: signal.code,
          peerId: signal.peerId,
          peerPresent: signal.t === 'joined',
        });
      };

      transport.#onSignal = settle;
      socket.addEventListener('error', () => reject(new Error('websocket error')));
      socket.addEventListener('open', () => socket.send(JSON.stringify(intent satisfies ClientSignal)));
    });
  }

  get bufferedAmount(): number { return this.#socket.bufferedAmount; }

  send(frame: Uint8Array): void {
    if (this.#socket.readyState !== 1) return;
    // Copy into a standalone ArrayBuffer: a view over a larger pooled buffer
    // would otherwise send the whole pool.
    this.#socket.send(frame.slice().buffer);
    this.#startDrainPollingIfNeeded();
  }

  sendSignal(signal: ClientSignal): void {
    if (this.#socket.readyState === 1) this.#socket.send(JSON.stringify(signal));
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }
  onPeerJoined(cb: () => void): void { this.#onPeerJoined = cb; }
  onSignal(cb: (signal: ServerSignal) => void): void { this.#onSignal = cb; }

  close(): void {
    this.#stopDrainPolling();
    this.#socket.close();
  }

  /**
   * WebSocket has no bufferedamountlow event, so drain is polled. The timer
   * only runs while the socket is actually backed up.
   */
  #startDrainPollingIfNeeded(): void {
    if (this.#drainTimer !== undefined) return;
    if (this.#socket.bufferedAmount < HIGH_WATER_BYTES) return;
    this.#drainTimer = setInterval(() => {
      if (this.#socket.bufferedAmount < HIGH_WATER_BYTES) {
        this.#stopDrainPolling();
        this.#onDrain?.();
      }
    }, DRAIN_POLL_MS);
  }

  #stopDrainPolling(): void {
    if (this.#drainTimer === undefined) return;
    clearInterval(this.#drainTimer);
    this.#drainTimer = undefined;
  }
}
```

- [ ] **Step 9: Run the relay test**

Run: `npx vitest run tests/integration/transport-relay.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 10: Commit**

```bash
git add client/transport tests/unit/transport-memory.test.ts tests/integration/transport-relay.test.ts
git commit -m "feat(client): add Transport interface with memory and relay implementations"
```

---

### Task 9: Save sinks

**Files:**
- Create: `client/save/types.ts`
- Create: `client/save/blob.ts`
- Test: `tests/unit/save-blob.test.ts`

**Interfaces:**
- Consumes: `shared/messages.ts` (`FileMeta`).
- Produces:
  - `interface SaveSink { write(chunk: Uint8Array): Promise<void>; close(): Promise<Blob | undefined>; abort(reason: string): Promise<void> }`
  - `createBlobSink(meta: FileMeta): SaveSink`
  - `BLOB_SINK_MAX_BYTES = 512 * 1024 * 1024`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/save-blob.test.ts
import { describe, expect, it } from 'vitest';
import { BLOB_SINK_MAX_BYTES, createBlobSink } from '../../client/save/blob.js';

const meta = { id: 1, name: 'a.bin', size: 3, type: 'application/octet-stream' };

describe('blob sink', () => {
  it('assembles written chunks in order', async () => {
    const sink = createBlobSink(meta);
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    const blob = await sink.close();
    expect(blob).toBeDefined();
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('applies the declared MIME type', async () => {
    const sink = createBlobSink({ ...meta, type: 'text/plain' });
    await sink.write(new Uint8Array([65]));
    expect((await sink.close())?.type).toBe('text/plain');
  });

  it('refuses writes beyond the memory ceiling', async () => {
    const sink = createBlobSink({ ...meta, size: BLOB_SINK_MAX_BYTES + 1 });
    await expect(sink.write(new Uint8Array(1))).resolves.toBeUndefined();
    // Simulate exceeding the cap without allocating half a gigabyte.
    await expect(
      sink.write(new Uint8Array(0)).then(() => sink.assertWithinCap(BLOB_SINK_MAX_BYTES + 1)),
    ).rejects.toThrow(/too large/i);
  });

  it('discards buffered chunks on abort', async () => {
    const sink = createBlobSink(meta);
    await sink.write(new Uint8Array([1]));
    await sink.abort('cancelled');
    expect(await sink.close()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/save-blob.test.ts`
Expected: FAIL — cannot resolve `../../client/save/blob.js`.

- [ ] **Step 3: Implement `client/save/types.ts`**

```ts
// client/save/types.ts
export interface SaveSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Finalizes the file. Returns a Blob only for the in-memory sink. */
  close(): Promise<Blob | undefined>;
  abort(reason: string): Promise<void>;
  /** Throws if `totalBytes` exceeds what this sink can hold. */
  assertWithinCap(totalBytes: number): void;
}
```

- [ ] **Step 4: Implement `client/save/blob.ts`**

```ts
import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from './types.js';

export const BLOB_SINK_MAX_BYTES = 512 * 1024 * 1024;

export function createBlobSink(meta: FileMeta): SaveSink {
  let chunks: Uint8Array[] | undefined = [];

  return {
    assertWithinCap(totalBytes: number): void {
      if (totalBytes > BLOB_SINK_MAX_BYTES) {
        throw new Error(
          `File too large for this browser: ${totalBytes} bytes exceeds the ${BLOB_SINK_MAX_BYTES}-byte in-memory limit.`,
        );
      }
    },
    async write(chunk: Uint8Array): Promise<void> {
      chunks?.push(chunk);
    },
    async close(): Promise<Blob | undefined> {
      if (!chunks) return undefined;
      const blob = new Blob(chunks as BlobPart[], { type: meta.type || 'application/octet-stream' });
      chunks = undefined;
      return blob;
    },
    async abort(): Promise<void> {
      chunks = undefined;
    },
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/unit/save-blob.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add client/save tests/unit/save-blob.test.ts
git commit -m "feat(client): add save sink interface and in-memory blob sink"
```

---

### Task 10: Sender

**Files:**
- Create: `client/transfer/sender.ts`
- Test: `tests/unit/sender.test.ts`

**Interfaces:**
- Consumes: `Transport`, `encodeFrame`, `encodeControl`, `FrameType`, `seal`, `makeNonce`, `importKey`, `generateNoncePrefix`.
- Produces:
  - `MAX_FRAME_BYTES = 65536`, `GCM_TAG_BYTES = 16`, `CHUNK_SIZE = 65507`
  - `HIGH_WATER_BYTES = 1024 * 1024`
  - `interface SenderEvents { onProgress(p: { fileId: number; bytesSent: number; totalBytes: number }): void; onFileDone(fileId: number): void }`
  - `class Sender` with `constructor(opts: { transport: Transport; key: CryptoKey; peerId: 'a' | 'b'; noncePrefix: Uint8Array; events: SenderEvents })`, `async sendFiles(files: File[]): Promise<FileMeta[]>`, `sendText(content: string): void`, `nextFileId(): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/sender.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey, makeNonce, open } from '../../client/crypto.js';
import { FrameType, decodeControl, decodeFrame } from '../../client/protocol.js';
import { CHUNK_SIZE, Sender } from '../../client/transfer/sender.js';

async function makeSender(): Promise<{ sender: Sender; frames: Uint8Array[]; key: CryptoKey; prefix: Uint8Array }> {
  const [a, b] = createMemoryPair();
  const frames: Uint8Array[] = [];
  b.onMessage((f) => frames.push(f));
  const key = await importKey(generateRawKey());
  const prefix = generateNoncePrefix();
  const sender = new Sender({
    transport: a, key, peerId: 'a', noncePrefix: prefix,
    events: { onProgress: vi.fn(), onFileDone: vi.fn() },
  });
  return { sender, frames, key, prefix };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('Sender', () => {
  it('announces the batch before sending data', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array([1, 2, 3])], 'a.bin', { type: 'text/plain' })]);
    await flush();
    const first = decodeFrame(frames[0]!);
    expect(first.type).toBe(FrameType.Control);
    const msg = decodeControl(first.payload);
    expect(msg.t).toBe('offer-batch');
    if (msg.t !== 'offer-batch') throw new Error('unreachable');
    expect(msg.files[0]).toMatchObject({ name: 'a.bin', size: 3, type: 'text/plain' });
  });

  it('encrypts each chunk so the raw bytes never appear on the wire', async () => {
    const { sender, frames } = await makeSender();
    const plaintext = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await sender.sendFiles([new File([plaintext], 'a.bin')]);
    await flush();
    const data = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data);
    expect(data).toHaveLength(1);
    expect([...data[0]!.payload]).not.toEqual([...plaintext]);
  });

  it('produces chunks the receiver can open with the matching nonce', async () => {
    const { sender, frames, key, prefix } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array([7, 7, 7])], 'a.bin')]);
    await flush();
    const chunk = frames.map(decodeFrame).find((f) => f.type === FrameType.Data)!;
    const opened = await open(key, makeNonce('a', prefix, chunk.seq), chunk.payload);
    expect([...opened]).toEqual([7, 7, 7]);
  });

  it('splits a file larger than one chunk and numbers sequences from zero', async () => {
    const { sender, frames } = await makeSender();
    const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(1);
    await sender.sendFiles([new File([bytes], 'big.bin')]);
    await flush();
    const seqs = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).map((f) => f.seq);
    expect(seqs).toEqual([0n, 1n]);
  });

  it('sends no data frames for a zero-byte file but still ends it', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendFiles([new File([], 'empty.bin')]);
    await flush();
    const decoded = frames.map(decodeFrame);
    expect(decoded.filter((f) => f.type === FrameType.Data)).toHaveLength(0);
    const ends = decoded
      .filter((f) => f.type === FrameType.Control)
      .map((f) => decodeControl(f.payload))
      .filter((m) => m.t === 'file-end');
    expect(ends).toHaveLength(1);
  });

  it('sends exactly one chunk for a file the size of one chunk', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array(CHUNK_SIZE)], 'exact.bin')]);
    await flush();
    expect(frames.map(decodeFrame).filter((f) => f.type === FrameType.Data)).toHaveLength(1);
  });

  it('never reuses a sequence number across files in one session', async () => {
    const { sender, frames } = await makeSender();
    await sender.sendFiles([new File([new Uint8Array(10)], 'a.bin'), new File([new Uint8Array(10)], 'b.bin')]);
    await flush();
    const seqs = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).map((f) => f.seq.toString());
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('reports progress and completion', async () => {
    const [a] = createMemoryPair();
    const onProgress = vi.fn();
    const onFileDone = vi.fn();
    const sender = new Sender({
      transport: a,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      events: { onProgress, onFileDone },
    });
    await sender.sendFiles([new File([new Uint8Array(CHUNK_SIZE * 2)], 'x.bin')]);
    expect(onProgress).toHaveBeenCalled();
    expect(onFileDone).toHaveBeenCalledTimes(1);
  });

  it('sends a text snippet as a control frame', async () => {
    const { sender, frames } = await makeSender();
    sender.sendText('hello');
    await flush();
    const msg = decodeControl(decodeFrame(frames[0]!).payload);
    expect(msg).toEqual({ t: 'text', content: 'hello' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/sender.test.ts`
Expected: FAIL — cannot resolve `../../client/transfer/sender.js`.

- [ ] **Step 3: Implement `client/transfer/sender.ts`**

```ts
import type { Transport } from '../transport/types.js';
import type { FileMeta } from '../../shared/messages.js';
import { FrameType, HEADER_BYTES, encodeControl, encodeFrame } from '../protocol.js';
import { makeNonce, seal } from '../crypto.js';

/**
 * Sized so header + ciphertext + GCM tag lands on exactly 65536 bytes, the
 * largest single message a WebRTC DataChannel is guaranteed to carry.
 */
export const MAX_FRAME_BYTES = 65536;
export const GCM_TAG_BYTES = 16;
export const CHUNK_SIZE = MAX_FRAME_BYTES - HEADER_BYTES - GCM_TAG_BYTES; // 65507
export const HIGH_WATER_BYTES = 1024 * 1024;

export interface SenderEvents {
  onProgress(p: { fileId: number; bytesSent: number; totalBytes: number }): void;
  onFileDone(fileId: number): void;
}

export interface SenderOptions {
  transport: Transport;
  key: CryptoKey;
  peerId: 'a' | 'b';
  noncePrefix: Uint8Array;
  events: SenderEvents;
}

export class Sender {
  readonly #opts: SenderOptions;
  #nextFileId = 1;
  #nextSeq = 0n;
  #batchCounter = 0;

  constructor(opts: SenderOptions) { this.#opts = opts; }

  nextFileId(): number { return this.#nextFileId++; }

  sendText(content: string): void {
    this.#sendControl({ t: 'text', content });
  }

  /** Returns the metas it minted, so callers can key progress by the same ids. */
  async sendFiles(files: File[]): Promise<FileMeta[]> {
    const metas: FileMeta[] = files.map((file) => ({
      id: this.nextFileId(),
      name: file.name,
      size: file.size,
      type: file.type,
    }));

    this.#sendControl({ t: 'offer-batch', batchId: `b${++this.#batchCounter}`, files: metas });

    for (const [index, file] of files.entries()) {
      const meta = metas[index]!;
      await this.#sendOneFile(file, meta);
      this.#sendControl({ t: 'file-end', fileId: meta.id });
      this.#opts.events.onFileDone(meta.id);
    }

    return metas;
  }

  async #sendOneFile(file: File, meta: FileMeta): Promise<void> {
    const { transport, key, peerId, noncePrefix, events } = this.#opts;
    let bytesSent = 0;

    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      const plaintext = new Uint8Array(await slice.arrayBuffer());

      const seq = this.#nextSeq++;
      const sealed = await seal(key, makeNonce(peerId, noncePrefix, seq), plaintext);
      transport.send(encodeFrame(FrameType.Data, meta.id, seq, sealed));

      bytesSent += plaintext.length;
      events.onProgress({ fileId: meta.id, bytesSent, totalBytes: file.size });

      await this.#awaitDrain();
    }
  }

  /** Blocks the send loop while the transport is backed up. */
  #awaitDrain(): Promise<void> {
    const { transport } = this.#opts;
    if (transport.bufferedAmount < HIGH_WATER_BYTES) return Promise.resolve();
    return new Promise((resolve) => transport.onDrain(() => resolve()));
  }

  #sendControl(msg: Parameters<typeof encodeControl>[0]): void {
    this.#opts.transport.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl(msg)));
  }
}
```

Note: `#nextSeq` is a single session-wide counter shared across all files. That is what makes the nonce unique — a per-file counter would repeat nonces on the second file.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/sender.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add client/transfer/sender.ts tests/unit/sender.test.ts
git commit -m "feat(client): add chunking sender with per-chunk encryption and backpressure"
```

---

### Task 11: Receiver

**Files:**
- Create: `client/transfer/receiver.ts`
- Test: `tests/unit/receiver.test.ts`
- Test: `tests/unit/loopback.test.ts`

**Interfaces:**
- Consumes: `Transport`, `decodeFrame`, `decodeControl`, `open`, `makeNonce`, `SaveSink`, `createBlobSink`.
- Produces:
  - `interface ReceiverEvents { onOffer(files: FileMeta[]): void; onProgress(p: { fileId: number; bytesReceived: number; totalBytes: number }): void; onFileComplete(r: { meta: FileMeta; blob?: Blob }): void; onText(content: string): void; onError(e: { fileId?: number; message: string }): void }`
  - `class Receiver` with `constructor(opts: { transport: Transport; key: CryptoKey; peerId: 'a' | 'b'; remoteNoncePrefix: Uint8Array; createSink?: (meta: FileMeta) => SaveSink; events: ReceiverEvents })` and `start(): void`

- [ ] **Step 1: Write the failing receiver test**

```ts
// tests/unit/receiver.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey, makeNonce, seal } from '../../client/crypto.js';
import { FrameType, encodeControl, encodeFrame } from '../../client/protocol.js';
import { Receiver } from '../../client/transfer/receiver.js';
import type { Transport } from '../../client/transport/types.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function setup() {
  const [a, b] = createMemoryPair();
  const key = await importKey(generateRawKey());
  const prefix = generateNoncePrefix();
  const events = {
    onOffer: vi.fn(), onProgress: vi.fn(), onFileComplete: vi.fn(),
    onText: vi.fn(), onError: vi.fn(),
  };
  const receiver = new Receiver({
    transport: b, key, peerId: 'b', remoteNoncePrefix: prefix, events,
  });
  receiver.start();
  return { sendSide: a as Transport, key, prefix, events };
}

const meta = { id: 1, name: 'a.bin', size: 3, type: 'text/plain' };

describe('Receiver', () => {
  it('surfaces an incoming batch offer', async () => {
    const { sendSide, events } = await setup();
    sendSide.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl({ t: 'offer-batch', batchId: 'b1', files: [meta] })));
    await flush();
    expect(events.onOffer).toHaveBeenCalledWith([meta]);
  });

  it('decrypts chunks and completes the file', async () => {
    const { sendSide, key, prefix, events } = await setup();
    sendSide.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl({ t: 'offer-batch', batchId: 'b1', files: [meta] })));
    const sealed = await seal(key, makeNonce('a', prefix, 0n), new Uint8Array([1, 2, 3]));
    sendSide.send(encodeFrame(FrameType.Data, 1, 0n, sealed));
    sendSide.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl({ t: 'file-end', fileId: 1 })));
    await flush();

    expect(events.onFileComplete).toHaveBeenCalledTimes(1);
    const arg = events.onFileComplete.mock.calls[0]![0] as { blob?: Blob };
    expect([...new Uint8Array(await arg.blob!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('reports an error and does not complete when a chunk fails its auth tag', async () => {
    const { sendSide, key, prefix, events } = await setup();
    sendSide.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl({ t: 'offer-batch', batchId: 'b1', files: [meta] })));
    const sealed = await seal(key, makeNonce('a', prefix, 0n), new Uint8Array([1, 2, 3]));
    sealed[0] ^= 0xff;
    sendSide.send(encodeFrame(FrameType.Data, 1, 0n, sealed));
    sendSide.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl({ t: 'file-end', fileId: 1 })));
    await flush();

    expect(events.onError).toHaveBeenCalled();
    expect(events.onFileComplete).not.toHaveBeenCalled();
  });

  it('surfaces a text snippet', async () => {
    const { sendSide, events } = await setup();
    sendSide.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl({ t: 'text', content: 'hi' })));
    await flush();
    expect(events.onText).toHaveBeenCalledWith('hi');
  });

  it('reports an error for a data frame with no matching offer', async () => {
    const { sendSide, events } = await setup();
    sendSide.send(encodeFrame(FrameType.Data, 99, 0n, new Uint8Array(20)));
    await flush();
    expect(events.onError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/receiver.test.ts`
Expected: FAIL — cannot resolve `../../client/transfer/receiver.js`.

- [ ] **Step 3: Implement `client/transfer/receiver.ts`**

```ts
import type { Transport } from '../transport/types.js';
import type { FileMeta } from '../../shared/messages.js';
import type { SaveSink } from '../save/types.js';
import { createBlobSink } from '../save/blob.js';
import { FrameType, decodeControl, decodeFrame } from '../protocol.js';
import { makeNonce, open } from '../crypto.js';

export interface ReceiverEvents {
  onOffer(files: FileMeta[]): void;
  onProgress(p: { fileId: number; bytesReceived: number; totalBytes: number }): void;
  onFileComplete(r: { meta: FileMeta; blob?: Blob }): void;
  onText(content: string): void;
  onError(e: { fileId?: number; message: string }): void;
}

export interface ReceiverOptions {
  transport: Transport;
  key: CryptoKey;
  peerId: 'a' | 'b';
  remoteNoncePrefix: Uint8Array;
  createSink?: (meta: FileMeta) => SaveSink;
  events: ReceiverEvents;
}

interface Incoming {
  meta: FileMeta;
  sink: SaveSink;
  bytesReceived: number;
  failed: boolean;
}

export class Receiver {
  readonly #opts: ReceiverOptions;
  readonly #incoming = new Map<number, Incoming>();
  /** The remote peer is whichever side this one is not. */
  readonly #remotePeerId: 'a' | 'b';
  /** Serializes decryption so chunks land in the sink in arrival order. */
  #chain: Promise<void> = Promise.resolve();

  constructor(opts: ReceiverOptions) {
    this.#opts = opts;
    this.#remotePeerId = opts.peerId === 'a' ? 'b' : 'a';
  }

  start(): void {
    this.#opts.transport.onMessage((raw) => {
      this.#chain = this.#chain.then(() => this.#handle(raw)).catch((error: unknown) => {
        this.#opts.events.onError({ message: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  async #handle(raw: Uint8Array): Promise<void> {
    const frame = decodeFrame(raw);
    if (frame.type === FrameType.Control) { this.#handleControl(decodeControl(frame.payload)); return; }

    const entry = this.#incoming.get(frame.fileId);
    if (!entry) {
      this.#opts.events.onError({ fileId: frame.fileId, message: 'Received data for a file that was never offered.' });
      return;
    }
    if (entry.failed) return;

    let plaintext: Uint8Array;
    try {
      const nonce = makeNonce(this.#remotePeerId, this.#opts.remoteNoncePrefix, frame.seq);
      plaintext = await open(this.#opts.key, nonce, frame.payload);
    } catch {
      entry.failed = true;
      await entry.sink.abort('authentication failed');
      this.#opts.events.onError({
        fileId: frame.fileId,
        message: `“${entry.meta.name}” failed its integrity check and was discarded.`,
      });
      return;
    }

    await entry.sink.write(plaintext);
    entry.bytesReceived += plaintext.length;
    this.#opts.events.onProgress({
      fileId: entry.meta.id, bytesReceived: entry.bytesReceived, totalBytes: entry.meta.size,
    });
  }

  #handleControl(msg: ReturnType<typeof decodeControl>): void {
    switch (msg.t) {
      case 'offer-batch': {
        for (const meta of msg.files) {
          const sink = (this.#opts.createSink ?? createBlobSink)(meta);
          try {
            sink.assertWithinCap(meta.size);
          } catch (error: unknown) {
            this.#opts.events.onError({
              fileId: meta.id,
              message: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          this.#incoming.set(meta.id, { meta, sink, bytesReceived: 0, failed: false });
        }
        this.#opts.events.onOffer(msg.files);
        return;
      }
      case 'file-end': {
        const entry = this.#incoming.get(msg.fileId);
        if (!entry) return;
        this.#incoming.delete(msg.fileId);
        if (entry.failed) return;
        void entry.sink.close().then((blob) => {
          this.#opts.events.onFileComplete({ meta: entry.meta, blob });
        });
        return;
      }
      case 'text':
        this.#opts.events.onText(msg.content);
        return;
      default:
        return;
    }
  }
}
```

- [ ] **Step 4: Run the receiver test**

Run: `npx vitest run tests/unit/receiver.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Write the loopback test — the milestone check**

```ts
// tests/unit/loopback.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey } from '../../client/crypto.js';
import { CHUNK_SIZE, Sender } from '../../client/transfer/sender.js';
import { Receiver } from '../../client/transfer/receiver.js';

async function transfer(bytes: Uint8Array, name = 'payload.bin'): Promise<Uint8Array> {
  const [a, b] = createMemoryPair();
  const raw = generateRawKey();
  const key = await importKey(raw);
  const senderPrefix = generateNoncePrefix();

  let resolveBlob!: (blob: Blob) => void;
  let rejectBlob!: (error: Error) => void;
  const done = new Promise<Blob>((resolve, reject) => { resolveBlob = resolve; rejectBlob = reject; });

  const receiver = new Receiver({
    transport: b,
    key,
    peerId: 'b',
    remoteNoncePrefix: senderPrefix,
    events: {
      onOffer: vi.fn(),
      onProgress: vi.fn(),
      onText: vi.fn(),
      onError: (e) => rejectBlob(new Error(e.message)),
      onFileComplete: ({ blob }) => { if (blob) resolveBlob(blob); },
    },
  });
  receiver.start();

  const sender = new Sender({
    transport: a,
    key,
    peerId: 'a',
    noncePrefix: senderPrefix,
    events: { onProgress: vi.fn(), onFileDone: vi.fn() },
  });
  await sender.sendFiles([new File([bytes], name)]);
  return new Uint8Array(await (await done).arrayBuffer());
}

describe('sender to receiver loopback', () => {
  it('moves a small file byte-identically', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect([...(await transfer(bytes))]).toEqual([...bytes]);
  });

  it('moves a multi-chunk file byte-identically', async () => {
    const bytes = new Uint8Array(CHUNK_SIZE * 3 + 17);
    globalThis.crypto.getRandomValues(bytes.subarray(0, 65536));
    for (let i = 65536; i < bytes.length; i++) bytes[i] = i % 251;
    const received = await transfer(bytes);
    expect(received.length).toBe(bytes.length);
    expect(Buffer.compare(Buffer.from(received), Buffer.from(bytes))).toBe(0);
  });
});
```

- [ ] **Step 6: Run the loopback test**

Run: `npx vitest run tests/unit/loopback.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 7: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add client/transfer/receiver.ts tests/unit/receiver.test.ts tests/unit/loopback.test.ts
git commit -m "feat(client): add receiver with decryption, reassembly and loopback test"
```

---

### Task 12: Session wiring and a manual dev harness

**Files:**
- Create: `client/session.ts`
- Create: `client/dev.html`
- Create: `client/dev.ts`
- Create: `vite.config.ts`
- Modify: `server/index.ts` — serve built client assets
- Test: `tests/integration/end-to-end-relay.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `class Session` with `static create(wsUrl: string): Promise<Session>`, `static join(wsUrl: string, code: string, keyFragment: string): Promise<Session>`, `readonly shareUrl: string`, `sendFiles(files: File[]): Promise<FileMeta[]>`, `sendText(s: string): void`, and an `events` hook. This is the single entry point the UI in Plan 2 consumes.

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// tests/integration/end-to-end-relay.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildServer } from '../../server/index.js';
import { Session } from '../../client/session.js';

(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

let app: FastifyInstance | undefined;

async function start(): Promise<string> {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('end-to-end over the relay', () => {
  it('transfers a file byte-identically between two sessions', async () => {
    const url = await start();
    const host = await Session.create(url);

    const fragment = new URL(host.shareUrl).hash.slice(1);
    const guest = await Session.join(url, host.code, fragment);

    const bytes = new Uint8Array(200_000);
    globalThis.crypto.getRandomValues(bytes.subarray(0, 65536));

    const received = new Promise<Uint8Array>((resolve, reject) => {
      guest.events.onFileComplete = async ({ blob }) => {
        if (!blob) { reject(new Error('no blob')); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
      guest.events.onError = (e) => reject(new Error(e.message));
    });

    await host.sendFiles([new File([bytes], 'big.bin', { type: 'application/octet-stream' })]);
    expect(Buffer.compare(Buffer.from(await received), Buffer.from(bytes))).toBe(0);

    host.close();
    guest.close();
  }, 20_000);

  it('carries a text snippet in the other direction', async () => {
    const url = await start();
    const host = await Session.create(url);
    const fragment = new URL(host.shareUrl).hash.slice(1);
    const guest = await Session.join(url, host.code, fragment);

    const got = new Promise<string>((resolve) => { host.events.onText = resolve; });
    guest.sendText('from the guest');
    expect(await got).toBe('from the guest');

    host.close();
    guest.close();
  }, 20_000);

  it('never exposes the key to the server', async () => {
    const url = await start();
    const host = await Session.create(url);
    // The key lives after '#', which is not transmitted in any request.
    expect(host.shareUrl).toMatch(/#[A-Za-z0-9_-]{43}$/);
    expect(new URL(host.shareUrl).search).toBe('');
    host.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/end-to-end-relay.test.ts`
Expected: FAIL — cannot resolve `../../client/session.js`.

- [ ] **Step 3: Implement `client/session.ts`**

```ts
import { RelayTransport } from './transport/relay.js';
import type { Transport } from './transport/types.js';
import type { FileMeta } from '../shared/messages.js';
import type { SaveSink } from './save/types.js';
import {
  fromBase64Url, generateNoncePrefix, generateRawKey, importKey, toBase64Url,
} from './crypto.js';
import { FrameType, decodeControl, decodeFrame, encodeControl, encodeFrame } from './protocol.js';
import { Sender } from './transfer/sender.js';
import { Receiver } from './transfer/receiver.js';

export interface SessionEvents {
  onPeerJoined?: () => void;
  onPeerLeft?: (reason: string) => void;
  onOffer?: (files: FileMeta[]) => void;
  onSendProgress?: (p: { fileId: number; bytesSent: number; totalBytes: number }) => void;
  onReceiveProgress?: (p: { fileId: number; bytesReceived: number; totalBytes: number }) => void;
  onFileComplete?: (r: { meta: FileMeta; blob?: Blob }) => void;
  onText?: (content: string) => void;
  onError?: (e: { fileId?: number; message: string }) => void;
}

const KEY_FRAGMENT_LENGTH = 43; // 32 bytes, base64url, unpadded

export class Session {
  readonly code: string;
  readonly peerId: 'a' | 'b';
  readonly events: SessionEvents = {};

  readonly #transport: RelayTransport;
  readonly #rawKey: Uint8Array;
  readonly #noncePrefix = generateNoncePrefix();
  #sender: Sender | undefined;
  #receiver: Receiver | undefined;
  #key: CryptoKey | undefined;
  #remoteNoncePrefix: Uint8Array | undefined;
  #pendingHello: (() => void) | undefined;

  private constructor(transport: RelayTransport, code: string, peerId: 'a' | 'b', rawKey: Uint8Array) {
    this.code = code;
    this.peerId = peerId;
    this.#transport = transport;
    this.#rawKey = rawKey;

    transport.onPeerJoined(() => {
      this.#sendHello();
      this.events.onPeerJoined?.();
    });
    transport.onClose((reason) => this.events.onPeerLeft?.(reason));
  }

  static async create(wsUrl: string): Promise<Session> {
    const rawKey = generateRawKey();
    const conn = await RelayTransport.connect(wsUrl, { t: 'create' });
    const session = new Session(conn.transport, conn.code, conn.peerId, rawKey);
    await session.#init();
    return session;
  }

  static async join(wsUrl: string, code: string, keyFragment: string): Promise<Session> {
    if (keyFragment.length !== KEY_FRAGMENT_LENGTH) {
      throw new Error('This link is missing its decryption key. Ask for the full link or scan the QR code again.');
    }
    const rawKey = fromBase64Url(keyFragment);
    const conn = await RelayTransport.connect(wsUrl, { t: 'join', code });
    const session = new Session(conn.transport, conn.code, conn.peerId, rawKey);
    await session.#init();
    session.#sendHello();
    return session;
  }

  /** The URL to encode as a QR code. The key is in the fragment, never sent to the server. */
  get shareUrl(): string {
    const base = typeof location === 'undefined'
      ? 'https://quik.share'
      : `${location.protocol}//${location.host}`;
    return `${base}/s/${this.code}#${toBase64Url(this.#rawKey)}`;
  }

  async sendFiles(files: File[]): Promise<FileMeta[]> {
    await this.#awaitHello();
    return this.#sender!.sendFiles(files);
  }

  sendText(content: string): void {
    this.#sender?.sendText(content);
  }

  close(): void { this.#transport.close(); }

  async #init(): Promise<void> {
    this.#key = await importKey(this.#rawKey);
    this.#sender = new Sender({
      transport: this.#transport as Transport,
      key: this.#key,
      peerId: this.peerId,
      noncePrefix: this.#noncePrefix,
      events: {
        onProgress: (p) => this.events.onSendProgress?.(p),
        onFileDone: () => undefined,
      },
    });
    // Hello frames arrive before the receiver's own prefix is known, so this
    // session listens for them directly and hands off once paired.
    this.#transport.onMessage((raw) => this.#route(raw));
  }

  #route(raw: Uint8Array): void {
    const frame = decodeFrame(raw);
    if (frame.type === FrameType.Control) {
      const msg = decodeControl(frame.payload);
      if (msg.t === 'hello') {
        this.#remoteNoncePrefix = fromBase64Url(msg.noncePrefix);
        this.#startReceiver();
        this.#pendingHello?.();
        this.#pendingHello = undefined;
        return;
      }
    }
    this.#deferred.push(raw);
    this.#drainDeferred();
  }

  readonly #deferred: Uint8Array[] = [];
  #forward: ((raw: Uint8Array) => void) | undefined;

  #drainDeferred(): void {
    if (!this.#forward) return;
    while (this.#deferred.length > 0) this.#forward(this.#deferred.shift()!);
  }

  #startReceiver(): void {
    if (this.#receiver || !this.#key || !this.#remoteNoncePrefix) return;
    this.#receiver = new Receiver({
      transport: {
        kind: 'relay',
        bufferedAmount: 0,
        send: (f: Uint8Array) => this.#transport.send(f),
        onMessage: (cb: (f: Uint8Array) => void) => { this.#forward = cb; this.#drainDeferred(); },
        onDrain: () => undefined,
        onClose: () => undefined,
        close: () => undefined,
      },
      key: this.#key,
      peerId: this.peerId,
      remoteNoncePrefix: this.#remoteNoncePrefix,
      events: {
        onOffer: (files) => this.events.onOffer?.(files),
        onProgress: (p) => this.events.onReceiveProgress?.(p),
        onFileComplete: (r) => this.events.onFileComplete?.(r),
        onText: (c) => this.events.onText?.(c),
        onError: (e) => this.events.onError?.(e),
      },
    });
    this.#receiver.start();
  }

  #sendHello(): void {
    this.#transport.send(encodeFrame(FrameType.Control, 0, 0n, encodeControl({
      t: 'hello',
      peerId: this.peerId,
      noncePrefix: toBase64Url(this.#noncePrefix),
      saveCapability: 'blob',
      maxBufferedBytes: 1024 * 1024,
    })));
  }

  #awaitHello(): Promise<void> {
    if (this.#remoteNoncePrefix) return Promise.resolve();
    return new Promise((resolve) => { this.#pendingHello = resolve; });
  }
}
```

- [ ] **Step 4: Run the end-to-end test**

Run: `npx vitest run tests/integration/end-to-end-relay.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } } },
});
```

- [ ] **Step 6: Create the manual harness `client/dev.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>soja-share dev harness</title>
  </head>
  <body>
    <h1>soja-share dev harness</h1>
    <button id="create" type="button">Create session</button>
    <p>Share URL: <code id="share">—</code></p>
    <label for="file">Send a file</label>
    <input id="file" type="file" multiple />
    <p id="status">idle</p>
    <ul id="received"></ul>
    <script type="module" src="./dev.ts"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `client/dev.ts`**

```ts
import { Session } from './session.js';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const share = document.querySelector<HTMLElement>('#share')!;
const received = document.querySelector<HTMLUListElement>('#received')!;

let session: Session | undefined;

function wire(s: Session): void {
  session = s;
  share.textContent = s.shareUrl;
  status.textContent = `session ${s.code} as peer ${s.peerId}`;
  s.events.onPeerJoined = () => { status.textContent = 'peer joined'; };
  s.events.onPeerLeft = () => { status.textContent = 'peer left'; };
  s.events.onError = (e) => { status.textContent = `error: ${e.message}`; };
  s.events.onSendProgress = (p) => { status.textContent = `sent ${p.bytesSent}/${p.totalBytes}`; };
  s.events.onReceiveProgress = (p) => { status.textContent = `received ${p.bytesReceived}/${p.totalBytes}`; };
  s.events.onFileComplete = ({ meta, blob }) => {
    if (!blob) return;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = meta.name;
    a.textContent = `${meta.name} (${meta.size} bytes)`;
    li.append(a);
    received.append(li);
  };
}

document.querySelector('#create')!.addEventListener('click', () => {
  void Session.create(wsUrl).then(wire);
});

document.querySelector('#file')!.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.files && session) void session.sendFiles([...input.files]);
});

const match = /^\/s\/([0-9A-Z]{6})$/.exec(location.pathname);
if (match) void Session.join(wsUrl, match[1]!, location.hash.slice(1)).then(wire);
```

- [ ] **Step 8: Serve built assets from `server/index.ts`**

Add near the top of `buildServer`, after creating `app`:

```ts
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ...inside buildServer, before app.get('/ws', ...):
  const clientDir = join(dirname(fileURLToPath(import.meta.url)), '../client');
  if (process.env.NODE_ENV === 'production') {
    await app.register(fastifyStatic, { root: clientDir });
    app.get('/s/:code', (_request, reply) => reply.sendFile('dev.html'));
  }
```

- [ ] **Step 9: Manual verification**

Run in two terminals: `npm run dev:server` and `npm run dev:client`.
Open `http://localhost:5173/dev.html`, click **Create session**, copy the share URL, open it in a second browser window, then pick a file in the first window.
Expected: the file appears as a download link in the second window and the bytes match.

- [ ] **Step 10: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 11: Commit**

```bash
git add client/session.ts client/dev.html client/dev.ts vite.config.ts server/index.ts tests/integration/end-to-end-relay.test.ts
git commit -m "feat: wire session facade and manual dev harness for relay transfers"
```

---

---

### Task 13: Per-IP rate limiting

Spec §6 requires rate limiting on both room creation (to prevent room-map
exhaustion) and joins (to make code guessing impractical before the encryption
backstop even applies). This task completes the server.

**Files:**
- Create: `server/rate-limit.ts`
- Modify: `shared/signals.ts` — add `'rate-limited'` to the error reasons
- Modify: `server/index.ts` — apply limits to `create` and `join`
- Test: `tests/unit/rate-limit.test.ts`
- Test: `tests/integration/rate-limit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class RateLimiter` with `constructor(opts: { capacity: number; refillPerMs: number; now?: () => number })`, `tryConsume(key: string): boolean`, `sweep(idleMs: number): void`.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/rate-limit.test.ts
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../server/rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to capacity immediately', () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerMs: 0, now: () => 0 });
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });

  it('tracks each key separately', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerMs: 0, now: () => 0 });
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });

  it('refills over time', () => {
    let clock = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerMs: 1 / 1000, now: () => clock });
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
    clock = 1000;
    expect(limiter.tryConsume('ip')).toBe(true);
  });

  it('never refills beyond capacity', () => {
    let clock = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1, now: () => clock });
    clock = 1_000_000;
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });

  it('sweeps buckets that have been idle', () => {
    let clock = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerMs: 0, now: () => clock });
    limiter.tryConsume('ip');
    clock = 60_000;
    limiter.sweep(30_000);
    expect(limiter.tryConsume('ip')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/rate-limit.test.ts`
Expected: FAIL — cannot resolve `../../server/rate-limit.js`.

- [ ] **Step 3: Implement `server/rate-limit.ts`**

```ts
interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterOptions {
  capacity: number;
  /** Tokens restored per millisecond. 0 means no refill. */
  refillPerMs: number;
  now?: () => number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.#capacity = opts.capacity;
    this.#refillPerMs = opts.refillPerMs;
    this.#now = opts.now ?? Date.now;
  }

  tryConsume(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, lastRefill: now };

    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerMs);
    bucket.lastRefill = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    this.#buckets.set(key, bucket);
    return allowed;
  }

  /** Drops buckets untouched for longer than idleMs so the map cannot grow without bound. */
  sweep(idleMs: number): void {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.lastRefill >= idleMs) this.#buckets.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run tests/unit/rate-limit.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the error reason to `shared/signals.ts`**

Replace:

```ts
  | { t: 'error'; reason: 'not-found' | 'full' | 'bad-request' }
```

with:

```ts
  | { t: 'error'; reason: 'not-found' | 'full' | 'bad-request' | 'rate-limited' }
```

- [ ] **Step 6: Write the failing integration test**

```ts
// tests/integration/rate-limit.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.js';
import type { ServerSignal } from '../../shared/signals.js';

let app: FastifyInstance | undefined;

async function start(limits?: { createPerMinute?: number; joinPerMinute?: number }): Promise<string> {
  app = await buildServer(limits);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `ws://127.0.0.1:${address.port}/ws`;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextSignal(ws: WebSocket): Promise<ServerSignal> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) throw new Error('expected a text frame');
      resolve(JSON.parse(data.toString()) as ServerSignal);
    });
  });
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('rate limiting', () => {
  it('rejects room creation past the per-IP budget', async () => {
    const url = await start({ createPerMinute: 2 });
    const sockets: WebSocket[] = [];
    const reasons: string[] = [];

    for (let i = 0; i < 3; i++) {
      const ws = await connect(url);
      sockets.push(ws);
      ws.send(JSON.stringify({ t: 'create' }));
      const signal = await nextSignal(ws);
      reasons.push(signal.t === 'error' ? signal.reason : signal.t);
    }

    expect(reasons).toEqual(['created', 'created', 'rate-limited']);
    for (const ws of sockets) ws.close();
  });

  it('rejects join attempts past the per-IP budget', async () => {
    const url = await start({ joinPerMinute: 2 });
    const sockets: WebSocket[] = [];
    const reasons: string[] = [];

    for (let i = 0; i < 3; i++) {
      const ws = await connect(url);
      sockets.push(ws);
      ws.send(JSON.stringify({ t: 'join', code: 'ZZZZZZ' }));
      const signal = await nextSignal(ws);
      reasons.push(signal.t === 'error' ? signal.reason : signal.t);
    }

    expect(reasons).toEqual(['not-found', 'not-found', 'rate-limited']);
    for (const ws of sockets) ws.close();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/integration/rate-limit.test.ts`
Expected: FAIL — `buildServer` takes no arguments and never returns `rate-limited`.

- [ ] **Step 8: Apply the limits in `server/index.ts`**

Change the signature and add the limiters:

```ts
import { RateLimiter } from './rate-limit.js';

export interface ServerLimits {
  createPerMinute?: number;
  joinPerMinute?: number;
}

export async function buildServer(limits: ServerLimits = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const registry = new RoomRegistry();

  const createLimiter = new RateLimiter({
    capacity: limits.createPerMinute ?? 20,
    refillPerMs: (limits.createPerMinute ?? 20) / 60_000,
  });
  const joinLimiter = new RateLimiter({
    capacity: limits.joinPerMinute ?? 30,
    refillPerMs: (limits.joinPerMinute ?? 30) / 60_000,
  });
```

Extend the existing sweeper to also sweep limiter buckets:

```ts
  const sweeper = setInterval(() => {
    registry.sweep(Date.now(), MAX_IDLE_MS);
    createLimiter.sweep(MAX_IDLE_MS);
    joinLimiter.sweep(MAX_IDLE_MS);
  }, SWEEP_INTERVAL_MS);
```

Capture the client address when the socket opens. Change the route handler signature to `(socket, request)` and add:

```ts
  app.get('/ws', { websocket: true }, (socket, request) => {
    const clientIp = request.ip;
```

Then guard the two cases. In `case 'create'`, immediately after the existing `if (code)` check:

```ts
          if (!createLimiter.tryConsume(clientIp)) {
            reply({ t: 'error', reason: 'rate-limited' });
            return;
          }
```

And in `case 'join'`, immediately after the existing `if (code)` check, *before* the code is normalized — a guesser must burn budget even on malformed codes:

```ts
          if (!joinLimiter.tryConsume(clientIp)) {
            reply({ t: 'error', reason: 'rate-limited' });
            return;
          }
```

- [ ] **Step 9: Run the integration test**

Run: `npx vitest run tests/integration/rate-limit.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 10: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors. Earlier integration tests call `buildServer()` with no arguments, which still works because `limits` defaults to `{}` and the default budgets are far above what those tests use.

- [ ] **Step 11: Commit**

```bash
git add server/rate-limit.ts shared/signals.ts server/index.ts tests/unit/rate-limit.test.ts tests/integration/rate-limit.test.ts
git commit -m "feat(server): rate-limit room creation and join attempts per IP"
```

---

## Plan 1 done when

- `npm test` is green and `npm run typecheck` is clean.
- Two browser windows pair by URL and move a real file, byte-identical.
- No plaintext file bytes and no key material ever reach the server.

## Deliberately deferred

These are spec requirements that Plan 1 does **not** implement. They are staged, not forgotten.

- **Web Worker boundary (spec §8).** Plan 1 runs `Sender` and `Receiver` on the main thread so the transfer logic can be tested directly with plain Vitest. Plan 2 moves them into a worker; the `Transport` interface and the event callbacks are already shaped for it, so the move is a wiring change rather than a rewrite.
- **File System Access and Service Worker save tiers (spec §9).** Plan 1 ships only the blob sink, behind the `SaveSink` interface the other two tiers implement.
- **WebRTC transport and the hot upgrade (spec §6).** Plan 1's `RelayTransport` is the guaranteed path; Plan 3 adds the fast one.
- **Reconnect and resume (spec §10).** The `resume-from` control message is defined in `shared/messages.ts` but nothing sends or handles it yet.
- **The real UI (spec §11, §12).** Plan 1 ends with `client/dev.html`, an unstyled harness that exists to prove the transport works and is deleted in Plan 2.

Plan 2 replaces the dev harness with the real UI, the design system, and the streaming save tiers. Plan 3 adds WebRTC, reconnection, and the end-to-end browser tests.

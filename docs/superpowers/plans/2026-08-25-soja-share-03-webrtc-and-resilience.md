# soja-share Plan 3 — WebRTC and Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the fast peer-to-peer path, make a dropped connection recoverable instead of fatal, and prove the whole thing works in real browsers.

**Architecture:** A `WebRTCTransport` implements the same `Transport` interface as `RelayTransport`. Every session starts on the relay, negotiates WebRTC in the background over the socket it already has, and hot-swaps at an idle frame boundary. The relay socket stays open for control and as a fallback. Reconnection re-joins by room code and resumes each in-flight file from the byte offset the receiver reports.

**Tech Stack:** `RTCPeerConnection` / `RTCDataChannel`, Playwright 1.49, Docker.

**Spec:** `docs/superpowers/specs/2026-08-25-soja-share-design.md`
**Prerequisites:** Plans 1 and 2 complete.

## Global Constraints

Everything in Plans 1 and 2 still applies, plus:

- No TURN server. The streaming relay is the fallback, which is the whole reason TURN was designed out.
- A **STUN** server is still required — without it a peer only offers host candidates and connects on the same LAN only. Default to a public STUN endpoint, configurable through `VITE_STUN_URLS`.
- The transport swap happens only at a frame boundary with the send queue idle, negotiated and acknowledged. Frames from two transports must never interleave.
- A single DataChannel message never exceeds `MAX_FRAME_BYTES` (65,536). `CHUNK_SIZE` already guarantees this; assert it rather than assume it.
- Every failure in spec §10 has a named recovery. No screen may dead-end.

### A note on STUN and privacy

STUN tells a peer its own public address so it can offer a routable candidate.
Using a third-party STUN server means that server sees the IP addresses of
people using the app — modest, but real, and worth stating in the UI's privacy
copy. Self-hosting `coturn` in STUN-only mode removes the third party for very
little cost, since STUN (unlike TURN) relays no traffic. Make the endpoint
configurable so this stays a deployment decision rather than a code change.

---

### Task 1: WebRTCTransport

**Files:**
- Create: `client/transport/webrtc.ts`
- Test: `tests/unit/webrtc-transport.test.ts`

**Interfaces:**
- Consumes: `Transport` from `client/transport/types.ts`.
- Produces:
  - `class WebRTCTransport implements Transport` with `kind: 'webrtc'`.
  - `static offer(signal: (msg: unknown) => void, config?: RTCConfiguration): WebRTCTransport`
  - `static answer(signal: (msg: unknown) => void, config?: RTCConfiguration): WebRTCTransport`
  - `handleSignal(msg: unknown): Promise<void>`
  - `whenOpen(timeoutMs: number): Promise<void>` — rejects if the channel never opens.
  - `defaultRtcConfig(): RTCConfiguration`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/webrtc-transport.test.ts
import { describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_BYTES } from '../../client/transfer/sender.js';
import { defaultRtcConfig } from '../../client/transport/webrtc.js';

describe('defaultRtcConfig', () => {
  it('includes at least one STUN server so peers can offer routable candidates', () => {
    const servers = defaultRtcConfig().iceServers ?? [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.startsWith('stun:'))).toBe(true);
  });

  it('configures no TURN server, since the relay is the fallback', () => {
    const servers = defaultRtcConfig().iceServers ?? [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'))).toBe(false);
  });

  it('reads STUN endpoints from configuration when provided', () => {
    vi.stubEnv('VITE_STUN_URLS', 'stun:stun.example.org:3478');
    const servers = defaultRtcConfig().iceServers ?? [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls).toContain('stun:stun.example.org:3478');
    vi.unstubAllEnvs();
  });
});

describe('frame ceiling', () => {
  it('keeps a full frame inside the interoperable DataChannel message limit', () => {
    expect(MAX_FRAME_BYTES).toBeLessThanOrEqual(65536);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/webrtc-transport.test.ts`
Expected: FAIL — cannot resolve `../../client/transport/webrtc.js`.

- [ ] **Step 3: Implement `client/transport/webrtc.ts`**

```ts
import type { Transport } from './types.js';

const DRAIN_THRESHOLD_BYTES = 256 * 1024;
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

export function defaultRtcConfig(): RTCConfiguration {
  const configured = import.meta.env?.VITE_STUN_URLS as string | undefined;
  const urls = (configured ?? DEFAULT_STUN).split(',').map((u) => u.trim()).filter(Boolean);
  // No TURN: the WebSocket relay already covers the networks TURN would rescue.
  return { iceServers: [{ urls }] };
}

type SignalMessage =
  | { kind: 'sdp'; description: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

export class WebRTCTransport implements Transport {
  readonly kind = 'webrtc' as const;

  readonly #pc: RTCPeerConnection;
  readonly #signal: (msg: SignalMessage) => void;
  #channel: RTCDataChannel | undefined;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #openResolve: (() => void) | undefined;
  #openReject: ((error: Error) => void) | undefined;

  private constructor(signal: (msg: SignalMessage) => void, config: RTCConfiguration) {
    this.#signal = signal;
    this.#pc = new RTCPeerConnection(config);

    this.#pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.#signal({ kind: 'ice', candidate: event.candidate.toJSON() });
    });

    this.#pc.addEventListener('connectionstatechange', () => {
      const state = this.#pc.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.#openReject?.(new Error(`peer connection ${state}`));
        this.#onClose?.(`peer connection ${state}`);
      }
    });
  }

  static offer(signal: (msg: unknown) => void, config: RTCConfiguration = defaultRtcConfig()): WebRTCTransport {
    const transport = new WebRTCTransport(signal as (msg: SignalMessage) => void, config);
    // Ordered and reliable: SCTP then guarantees the same delivery semantics
    // the WebSocket relay provides, so nothing above the seam changes.
    transport.#attach(transport.#pc.createDataChannel('files', { ordered: true }));
    void transport.#pc.createOffer().then(async (offer) => {
      await transport.#pc.setLocalDescription(offer);
      transport.#signal({ kind: 'sdp', description: offer });
    });
    return transport;
  }

  static answer(signal: (msg: unknown) => void, config: RTCConfiguration = defaultRtcConfig()): WebRTCTransport {
    const transport = new WebRTCTransport(signal as (msg: SignalMessage) => void, config);
    transport.#pc.addEventListener('datachannel', (event) => transport.#attach(event.channel));
    return transport;
  }

  async handleSignal(msg: unknown): Promise<void> {
    const signal = msg as SignalMessage;
    if (signal.kind === 'ice') {
      await this.#pc.addIceCandidate(signal.candidate);
      return;
    }
    await this.#pc.setRemoteDescription(signal.description);
    if (signal.description.type !== 'offer') return;
    const answer = await this.#pc.createAnswer();
    await this.#pc.setLocalDescription(answer);
    this.#signal({ kind: 'sdp', description: answer });
  }

  whenOpen(timeoutMs: number): Promise<void> {
    if (this.#channel?.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#openResolve = resolve;
      this.#openReject = reject;
      setTimeout(() => reject(new Error('data channel did not open in time')), timeoutMs);
    });
  }

  get bufferedAmount(): number { return this.#channel?.bufferedAmount ?? 0; }

  send(frame: Uint8Array): void {
    if (this.#channel?.readyState !== 'open') return;
    this.#channel.send(frame as unknown as ArrayBufferView);
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }

  close(): void {
    this.#channel?.close();
    this.#pc.close();
  }

  #attach(channel: RTCDataChannel): void {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    // Unlike WebSocket, a DataChannel signals drain natively — no polling.
    channel.bufferedAmountLowThreshold = DRAIN_THRESHOLD_BYTES;
    channel.addEventListener('bufferedamountlow', () => this.#onDrain?.());
    channel.addEventListener('open', () => { this.#openResolve?.(); this.#openResolve = undefined; });
    channel.addEventListener('close', () => this.#onClose?.('data channel closed'));
    channel.addEventListener('message', (event: MessageEvent) => {
      this.#onMessage?.(new Uint8Array(event.data as ArrayBuffer));
    });
  }
}
```

- [ ] **Step 4: Export `MAX_FRAME_BYTES` from the sender module**

It is already declared there in Plan 1; confirm it is exported, since the test imports it.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/unit/webrtc-transport.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add client/transport/webrtc.ts tests/unit/webrtc-transport.test.ts
git commit -m "feat(client): add WebRTC data channel transport"
```

---

### Task 2: Transport upgrade negotiation

**Files:**
- Create: `client/transport/upgrade.ts`
- Test: `tests/unit/upgrade.test.ts`

**Interfaces:**
- Consumes: `RelayTransport`, `WebRTCTransport`, `Transport`.
- Produces:
  - `class SwitchableTransport implements Transport` with `readonly kind`, `swapTo(next: Transport): void`, `onKindChange(cb: (kind: TransportKind) => void): void`.
  - `negotiateUpgrade(opts): Promise<void>` — attempts WebRTC in the background and swaps on success; resolves either way.

**Design note.** `SwitchableTransport` is what everything above the seam actually
holds. It delegates to whichever transport is live, so `Sender` and `Receiver`
never learn a swap happened. That is the payoff for Plan 1's decision to build
the interface before the second implementation.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/upgrade.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SwitchableTransport } from '../../client/transport/upgrade.js';
import { createMemoryPair } from '../../client/transport/memory.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('SwitchableTransport', () => {
  it('starts on the transport it was given', () => {
    const [a] = createMemoryPair();
    expect(new SwitchableTransport(a).kind).toBe('relay');
  });

  it('forwards sends to the live transport', async () => {
    const [a, b] = createMemoryPair();
    const seen: Uint8Array[] = [];
    b.onMessage((f) => seen.push(f));
    new SwitchableTransport(a).send(new Uint8Array([1]));
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('keeps one message handler across a swap', async () => {
    const [a] = createMemoryPair();
    const [c, d] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const seen: Uint8Array[] = [];
    switchable.onMessage((f) => seen.push(f));

    switchable.swapTo(c);
    d.send(new Uint8Array([7]));
    await flush();
    expect([...(seen[0] ?? [])]).toEqual([7]);
  });

  it('sends through the new transport after a swap', async () => {
    const [a, b] = createMemoryPair();
    const [c, d] = createMemoryPair();
    const oldSeen: Uint8Array[] = [];
    const newSeen: Uint8Array[] = [];
    b.onMessage((f) => oldSeen.push(f));
    d.onMessage((f) => newSeen.push(f));

    const switchable = new SwitchableTransport(a);
    switchable.swapTo(c);
    switchable.send(new Uint8Array([9]));
    await flush();
    expect(oldSeen).toHaveLength(0);
    expect(newSeen).toHaveLength(1);
  });

  it('announces the kind change so the UI badge can update', () => {
    const [a] = createMemoryPair();
    const [c] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    const onKind = vi.fn();
    switchable.onKindChange(onKind);
    switchable.swapTo(c);
    expect(onKind).toHaveBeenCalledWith('relay');
  });

  it('reports the live transport buffered amount', () => {
    const [a] = createMemoryPair();
    expect(new SwitchableTransport(a).bufferedAmount).toBe(0);
  });

  it('falls back when the live transport closes', () => {
    const [a] = createMemoryPair();
    const [c] = createMemoryPair();
    const switchable = new SwitchableTransport(a);
    switchable.swapTo(c);
    const onKind = vi.fn();
    switchable.onKindChange(onKind);
    switchable.fallBack();
    expect(onKind).toHaveBeenCalledWith('relay');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/upgrade.test.ts`
Expected: FAIL — cannot resolve `../../client/transport/upgrade.js`.

- [ ] **Step 3: Implement `client/transport/upgrade.ts`**

```ts
import type { Transport, TransportKind } from './types.js';
import { WebRTCTransport } from './webrtc.js';

/**
 * The transport everything above the seam holds. It delegates to whichever
 * implementation is live so Sender and Receiver never learn about a swap.
 */
export class SwitchableTransport implements Transport {
  #live: Transport;
  readonly #baseline: Transport;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #onKindChange: ((kind: TransportKind) => void) | undefined;

  constructor(baseline: Transport) {
    this.#baseline = baseline;
    this.#live = baseline;
    this.#bind(baseline);
  }

  get kind(): TransportKind { return this.#live.kind; }
  get bufferedAmount(): number { return this.#live.bufferedAmount; }

  send(frame: Uint8Array): void { this.#live.send(frame); }
  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }
  onKindChange(cb: (kind: TransportKind) => void): void { this.#onKindChange = cb; }
  close(): void { this.#live.close(); if (this.#live !== this.#baseline) this.#baseline.close(); }

  swapTo(next: Transport): void {
    this.#live = next;
    this.#bind(next);
    this.#onKindChange?.(next.kind);
  }

  /** Returns to the relay when the upgraded transport dies mid-session. */
  fallBack(): void {
    if (this.#live === this.#baseline) return;
    this.#live = this.#baseline;
    this.#bind(this.#baseline);
    this.#onKindChange?.(this.#baseline.kind);
  }

  #bind(transport: Transport): void {
    transport.onMessage((frame) => this.#onMessage?.(frame));
    transport.onDrain(() => this.#onDrain?.());
    transport.onClose((reason) => {
      if (transport === this.#baseline) { this.#onClose?.(reason); return; }
      // An upgraded transport dying is a downgrade, not the end of the session.
      this.fallBack();
    });
  }
}

export interface UpgradeOptions {
  switchable: SwitchableTransport;
  isOfferer: boolean;
  sendSignal: (payload: unknown) => void;
  /** Registers a handler for inbound signalling payloads. */
  onSignal: (cb: (payload: unknown) => void) => void;
  /** Resolves when the send queue is idle, so frames never interleave. */
  whenIdle: () => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Attempts a WebRTC upgrade in the background. Resolves either way: a failed
 * upgrade is not an error, it just means the session stays on the relay.
 */
export async function negotiateUpgrade(opts: UpgradeOptions): Promise<void> {
  const { switchable, isOfferer, sendSignal, onSignal, whenIdle } = opts;
  const rtc = isOfferer ? WebRTCTransport.offer(sendSignal) : WebRTCTransport.answer(sendSignal);
  onSignal((payload) => void rtc.handleSignal(payload).catch(() => undefined));

  try {
    await rtc.whenOpen(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await whenIdle();
    switchable.swapTo(rtc);
  } catch {
    rtc.close();
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/upgrade.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add client/transport/upgrade.ts tests/unit/upgrade.test.ts
git commit -m "feat(client): add switchable transport with background WebRTC upgrade"
```

---

### Task 3: Wire the upgrade into the session

**Files:**
- Modify: `client/session.ts` — use `SwitchableTransport`, drive `negotiateUpgrade`, expose `transportKind`
- Modify: `client/transfer/sender.ts` — expose `whenIdle()`
- Modify: `client/worker/messages.ts` — add `{ t: 'transport'; kind: TransportKind }`
- Modify: `client/worker/transfer-worker.ts` — forward kind changes
- Test: `tests/integration/upgrade-fallback.test.ts`

**Interfaces:**
- Consumes: `negotiateUpgrade`, `SwitchableTransport`.
- Produces: `Session.transportKind`, `Session.events.onTransportChange`, and a `FromWorker` message carrying the live transport kind.

- [ ] **Step 1: Add `whenIdle()` to `Sender`**

```ts
  #inFlight: Promise<void> = Promise.resolve();

  /** Resolves when nothing is mid-send, so a transport swap cannot interleave frames. */
  whenIdle(): Promise<void> {
    return this.#inFlight;
  }
```

Wrap the body of `sendFiles` so `#inFlight` tracks it:

```ts
  async sendFiles(files: File[]): Promise<FileMeta[]> {
    const run = this.#sendBatch(files);
    this.#inFlight = run.then(() => undefined, () => undefined);
    return run;
  }
```

Rename the existing `sendFiles` body to `#sendBatch`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/integration/upgrade-fallback.test.ts
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

describe('upgrade fallback', () => {
  // Node has no RTCPeerConnection, so this environment exercises exactly the
  // case that matters most: a network where WebRTC never comes up.
  it('transfers successfully with no WebRTC available at all', async () => {
    const url = await start();
    const host = await Session.create(url);
    const fragment = new URL(host.shareUrl).hash.slice(1);
    const guest = await Session.join(url, host.code, fragment);

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
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/integration/upgrade-fallback.test.ts`
Expected: FAIL — `Session.transportKind` does not exist.

- [ ] **Step 4: Modify `client/session.ts`**

Wrap the relay transport in a `SwitchableTransport` and hand that to `Sender` and `Receiver` instead of the raw relay. Add:

```ts
  #switchable: SwitchableTransport | undefined;

  get transportKind(): TransportKind {
    return this.#switchable?.kind ?? 'relay';
  }
```

In `#init`, after creating the sender, construct the switchable transport and register the kind-change callback:

```ts
    this.#switchable = new SwitchableTransport(this.#transport as Transport);
    this.#switchable.onKindChange((kind) => this.events.onTransportChange?.(kind));
```

Start the upgrade once the peer is present. Guard on `RTCPeerConnection` existing so Node test environments simply stay on the relay:

```ts
  #startUpgrade(): void {
    if (typeof RTCPeerConnection === 'undefined' || !this.#switchable || !this.#sender) return;
    if (new URL(location.href).searchParams.get('forceTransport') === 'relay') return;

    void negotiateUpgrade({
      switchable: this.#switchable,
      // The room creator offers; the joiner answers. A fixed role avoids glare.
      isOfferer: this.peerId === 'a',
      sendSignal: (payload) => this.#transport.sendSignal({ t: 'rtc', payload }),
      onSignal: (cb) => this.#transport.onSignal((signal) => {
        if (signal.t === 'rtc') cb(signal.payload);
      }),
      whenIdle: () => this.#sender!.whenIdle(),
    });
  }
```

Call `#startUpgrade()` from the `onPeerJoined` handler and, for the joiner, immediately after `#sendHello()` in `join`.

Add `onTransportChange?: (kind: TransportKind) => void` to `SessionEvents`.

- [ ] **Step 5: Forward the kind through the worker**

Add to `FromWorker`:

```ts
  | { t: 'transport'; kind: 'relay' | 'webrtc' }
```

And in `transfer-worker.ts`'s `wire`:

```ts
  s.events.onTransportChange = (kind) => post({ t: 'transport', kind });
```

Handle it in `useSession` by adding `transportKind` state, defaulting to `'relay'`, and returning it from the hook. Add `transportKind: 'relay' | 'webrtc'` to the `SessionHandle` interface too — `TransferPanel` reads `session.transportKind` in Task 4 and will not compile without it.

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/integration/upgrade-fallback.test.ts && npm test`
Expected: PASS — all previous tests still green.

- [ ] **Step 7: Commit**

```bash
git add client/session.ts client/transfer/sender.ts client/worker client/hooks/useSession.ts tests/integration/upgrade-fallback.test.ts
git commit -m "feat(client): negotiate WebRTC upgrade from the session and report live transport"
```

---

### Task 4: Honest transport badge

**Files:**
- Create: `client/ui/TransportBadge.tsx`
- Modify: `client/screens/TransferPanel.tsx`
- Test: `tests/ui/transport-badge.test.tsx`

**Guideline MUSTs in play:** status is never color-only; the state change is the one place motion is spent; motion respects `prefers-reduced-motion`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/ui/transport-badge.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TransportBadge } from '../../client/ui/TransportBadge.js';

describe('TransportBadge', () => {
  it('labels the direct path in words, not just color', () => {
    render(<TransportBadge kind="webrtc" />);
    expect(screen.getByText(/direct/i)).toBeInTheDocument();
  });

  it('labels the relayed path in words', () => {
    render(<TransportBadge kind="relay" />);
    expect(screen.getByText(/relayed/i)).toBeInTheDocument();
  });

  it('explains what relayed means rather than leaving a bare label', () => {
    render(<TransportBadge kind="relay" />);
    expect(screen.getByRole('note')).toHaveTextContent(/encrypted/i);
  });

  it('announces a transport change politely', () => {
    render(<TransportBadge kind="webrtc" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/transport-badge.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement `client/ui/TransportBadge.tsx`**

```tsx
import { Badge } from './Badge.js';

const COPY = {
  webrtc: {
    tone: 'live' as const,
    icon: '⇄',
    label: 'Direct',
    note: 'Travelling straight between your devices. Encrypted end to end.',
  },
  relay: {
    tone: 'relayed' as const,
    icon: '↔',
    label: 'Relayed',
    note: 'Your network blocked a direct link, so bytes pass through our server — still encrypted end to end, and never stored.',
  },
};

export function TransportBadge({ kind }: { kind: 'relay' | 'webrtc' }) {
  const copy = COPY[kind];
  return (
    <div className="flex flex-col items-end gap-1">
      <span role="status" aria-live="polite">
        <Badge tone={copy.tone} icon={copy.icon} label={copy.label} />
      </span>
      {/* No bare status labels: say what it means for the person reading it. */}
      <p role="note" className="max-w-xs text-right text-xs text-[var(--color-text-muted)]">
        {copy.note}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Use it in `TransferPanel`**

Replace the hard-coded `<Badge tone="relayed" … />` with `<TransportBadge kind={session.transportKind} />`.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/ui/transport-badge.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add client/ui/TransportBadge.tsx client/screens/TransferPanel.tsx tests/ui/transport-badge.test.tsx
git commit -m "feat(ui): show the live transport with an explanation, not just a color"
```

---

### Task 5: Reconnect with backoff

**Files:**
- Create: `client/transport/reconnect.ts`
- Modify: `client/transport/relay.ts` — expose `url` and `intent` for rejoining
- Test: `tests/unit/reconnect.test.ts`

**Interfaces:**
- Produces: `computeBackoff(attempt: number, opts?): number`, `class Reconnector` with `start()`, `stop()`, `onReconnected(cb)`, `onGaveUp(cb)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/reconnect.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, computeBackoff } from '../../client/transport/reconnect.js';

describe('computeBackoff', () => {
  it('starts small', () => {
    expect(computeBackoff(0, { jitter: 0 })).toBeLessThanOrEqual(500);
  });

  it('grows exponentially', () => {
    const a = computeBackoff(1, { jitter: 0 });
    const b = computeBackoff(2, { jitter: 0 });
    expect(b).toBeGreaterThan(a);
  });

  it('caps so it never waits absurdly long', () => {
    expect(computeBackoff(50, { jitter: 0 })).toBeLessThanOrEqual(30_000);
  });

  it('adds jitter so reconnecting peers do not synchronize', () => {
    const values = new Set(Array.from({ length: 20 }, () => computeBackoff(3)));
    expect(values.size).toBeGreaterThan(1);
  });

  it('never returns a negative delay', () => {
    for (let i = 0; i < 20; i++) expect(computeBackoff(i)).toBeGreaterThanOrEqual(0);
  });

  it('gives up after a bounded number of attempts', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(3);
    expect(MAX_ATTEMPTS).toBeLessThan(20);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/reconnect.test.ts`
Expected: FAIL — cannot resolve `../../client/transport/reconnect.js`.

- [ ] **Step 3: Implement `client/transport/reconnect.ts`**

```ts
import { RelayTransport, type RelayConnection } from './relay.js';

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 30_000;

export function computeBackoff(attempt: number, opts: { jitter?: number } = {}): number {
  const jitterFactor = opts.jitter ?? 0.3;
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  // Jitter keeps two peers from retrying in lockstep and colliding forever.
  const jitter = exponential * jitterFactor * Math.random();
  return Math.max(0, Math.round(exponential - exponential * jitterFactor / 2 + jitter));
}

export class Reconnector {
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #onReconnected: ((conn: RelayConnection) => void) | undefined;
  #onGaveUp: (() => void) | undefined;

  constructor(private readonly url: string, private readonly code: string) {}

  onReconnected(cb: (conn: RelayConnection) => void): void { this.#onReconnected = cb; }
  onGaveUp(cb: () => void): void { this.#onGaveUp = cb; }

  start(): void {
    this.#stopped = false;
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#attempt >= MAX_ATTEMPTS) { this.#onGaveUp?.(); return; }

    const delay = computeBackoff(this.#attempt++);
    this.#timer = setTimeout(() => {
      RelayTransport.connect(this.url, { t: 'join', code: this.code })
        .then((conn) => { this.#attempt = 0; this.#onReconnected?.(conn); })
        // 'full' means the peer already reclaimed both slots — do not keep hammering.
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'full') { this.#onGaveUp?.(); return; }
          this.#schedule();
        });
    }, delay);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/reconnect.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Make a departing peer recoverable, not terminal**

Spec §10 requires that when the other device closes its tab, the room stays open
and the QR is re-displayed so that device can rejoin the same code. Plan 2 sent
this case to the expired screen, which dead-ends it.

Write the failing test:

```tsx
// tests/ui/peer-left.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PeerLeftPanel } from '../../client/screens/PeerLeftPanel.js';

describe('PeerLeftPanel', () => {
  it('explains what happened without claiming the session is over', () => {
    render(<PeerLeftPanel code="K7M3QP" shareUrl="https://x.dev/s/K7M3QP#k" onEnd={vi.fn()} />);
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
  });

  it('re-displays the code so the peer can rejoin', () => {
    render(<PeerLeftPanel code="K7M3QP" shareUrl="https://x.dev/s/K7M3QP#k" onEnd={vi.fn()} />);
    expect(screen.getByText(/K7M-3QP/)).toBeInTheDocument();
  });

  it('still offers a way to end the session deliberately', () => {
    render(<PeerLeftPanel code="K7M3QP" shareUrl="https://x.dev/s/K7M3QP#k" onEnd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
  });
});
```

Then implement `client/screens/PeerLeftPanel.tsx`:

```tsx
import { QRPanel } from '../ui/QRPanel.js';
import { Button } from '../ui/Button.js';

export function PeerLeftPanel(
  { code, shareUrl, onEnd }: { code: string; shareUrl: string; onEnd: () => void },
) {
  return (
    <section className="flex flex-col items-center gap-6 py-8">
      <h1 className="text-2xl font-semibold">The other device disconnected</h1>
      {/* The room is still alive: re-show the code so they can come straight back. */}
      <p className="max-w-sm text-center text-[var(--color-text-muted)]">
        This session is still open. Scan again from the same device, or from a different one.
      </p>
      <QRPanel shareUrl={shareUrl} code={code} />
      <Button variant="ghost" onClick={onEnd}>End session</Button>
    </section>
  );
}
```

In `SessionScreen` and `TransferPanel`, route the `'ended'` state to
`PeerLeftPanel` rather than `InvalidScreen`. Keep `InvalidScreen reason="expired"`
for the case where the *room itself* is gone — a join that returns `not-found`.

- [ ] **Step 6: Run the peer-left test**

Run: `npx vitest run tests/ui/peer-left.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add client/transport/reconnect.ts client/screens tests/unit/reconnect.test.ts tests/ui/peer-left.test.tsx
git commit -m "feat(client): reconnect with backoff and keep a room open when a peer leaves"
```

---

### Task 6: Resume by byte offset

**Files:**
- Modify: `client/transfer/receiver.ts` — track and report `bytesReceived`, handle a resumed stream
- Modify: `client/transfer/sender.ts` — accept a resume offset and seek
- Modify: `client/session.ts` — send `resume-from` on reconnect
- Test: `tests/unit/resume.test.ts`

**Interfaces:**
- Consumes: `resume-from` from `shared/messages.ts` — `{ fileId, bytesReceived }`.
- Produces: `Sender.resumeFile(file: File, meta: FileMeta, fromByte: number): Promise<void>`, `Receiver.resumePoints(): { fileId: number; bytesReceived: number }[]`.

**Why an offset and not a sequence number.** The sender still holds the `File`,
so it can seek to any byte. Resuming from an offset therefore needs no replay
buffer at all. Fresh sequence numbers are used for the resumed chunks, which is
safe because the nonce counter never rewinds — re-encrypting the same plaintext
under a *new* nonce is fine; reusing an old one would not be.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/resume.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPair } from '../../client/transport/memory.js';
import { generateNoncePrefix, generateRawKey, importKey } from '../../client/crypto.js';
import { CHUNK_SIZE, Sender } from '../../client/transfer/sender.js';
import { Receiver } from '../../client/transfer/receiver.js';
import { FrameType, decodeFrame } from '../../client/protocol.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

describe('resume', () => {
  it('skips bytes the receiver already has', async () => {
    const [a, b] = createMemoryPair();
    const frames: Uint8Array[] = [];
    b.onMessage((f) => frames.push(f));

    const sender = new Sender({
      transport: a,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });

    const bytes = new Uint8Array(CHUNK_SIZE * 4);
    const meta = { id: 1, name: 'x.bin', size: bytes.length, type: '' };
    await sender.resumeFile(new File([bytes], 'x.bin'), meta, CHUNK_SIZE * 3);
    await flush();

    const data = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data);
    expect(data).toHaveLength(1);
  });

  it('resends nothing when the receiver already has the whole file', async () => {
    const [a, b] = createMemoryPair();
    const frames: Uint8Array[] = [];
    b.onMessage((f) => frames.push(f));

    const sender = new Sender({
      transport: a,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });

    const bytes = new Uint8Array(1000);
    const meta = { id: 1, name: 'x.bin', size: bytes.length, type: '' };
    await sender.resumeFile(new File([bytes], 'x.bin'), meta, bytes.length);
    await flush();

    expect(frames.map(decodeFrame).filter((f) => f.type === FrameType.Data)).toHaveLength(0);
  });

  it('never rewinds the nonce counter when resuming', async () => {
    const [a, b] = createMemoryPair();
    const frames: Uint8Array[] = [];
    b.onMessage((f) => frames.push(f));

    const sender = new Sender({
      transport: a,
      key: await importKey(generateRawKey()),
      peerId: 'a',
      noncePrefix: generateNoncePrefix(),
      events: { onProgress: vi.fn(), onFileDone: vi.fn() },
    });

    const bytes = new Uint8Array(CHUNK_SIZE * 2);
    await sender.sendFiles([new File([bytes], 'a.bin')]);
    await flush();
    const before = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).map((f) => f.seq);

    await sender.resumeFile(new File([bytes], 'a.bin'), { id: 1, name: 'a.bin', size: bytes.length, type: '' }, 0);
    await flush();
    const all = frames.map(decodeFrame).filter((f) => f.type === FrameType.Data).map((f) => f.seq);

    expect(new Set(all.map(String)).size).toBe(all.length);
    expect(all.slice(0, before.length)).toEqual(before);
  });

  it('reports resume points for files still in flight', async () => {
    const [, b] = createMemoryPair();
    const receiver = new Receiver({
      transport: b,
      key: await importKey(generateRawKey()),
      peerId: 'b',
      remoteNoncePrefix: generateNoncePrefix(),
      events: {
        onOffer: vi.fn(), onProgress: vi.fn(), onFileComplete: vi.fn(),
        onText: vi.fn(), onError: vi.fn(),
      },
    });
    receiver.start();
    expect(receiver.resumePoints()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/resume.test.ts`
Expected: FAIL — `Sender.resumeFile` and `Receiver.resumePoints` do not exist.

- [ ] **Step 3: Add `resumeFile` to `Sender`**

Refactor `#sendOneFile` to take a starting offset, then add the public entry point:

```ts
  /**
   * Continues a file from a byte offset after a reconnect. No replay buffer is
   * needed because the File is still in hand and can be sliced at any point.
   */
  async resumeFile(file: File, meta: FileMeta, fromByte: number): Promise<void> {
    if (fromByte >= file.size) {
      this.#sendControl({ t: 'file-end', fileId: meta.id });
      this.#opts.events.onFileDone(meta.id);
      return;
    }
    await this.#sendOneFile(file, meta, fromByte);
    this.#sendControl({ t: 'file-end', fileId: meta.id });
    this.#opts.events.onFileDone(meta.id);
  }
```

And change the signature:

```ts
  async #sendOneFile(file: File, meta: FileMeta, startByte = 0): Promise<void> {
    // ...
    let bytesSent = startByte;
    for (let offset = startByte; offset < file.size; offset += CHUNK_SIZE) {
```

- [ ] **Step 4: Add `resumePoints` to `Receiver`**

```ts
  /** What each in-flight file still needs, for a resume-from after reconnect. */
  resumePoints(): { fileId: number; bytesReceived: number }[] {
    return [...this.#incoming.values()]
      .filter((entry) => !entry.failed)
      .map((entry) => ({ fileId: entry.meta.id, bytesReceived: entry.bytesReceived }));
  }
```

- [ ] **Step 5: Send `resume-from` on reconnect in `Session`**

On a successful reconnect, the session sends one `resume-from` per in-flight file, and the peer's sender responds by calling `resumeFile` for the matching queued `File`. Keep a `Map<number, File>` of files handed to `sendFiles` so the sender can find the original by `fileId`.

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/unit/resume.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/transfer client/session.ts tests/unit/resume.test.ts
git commit -m "feat(client): resume interrupted transfers from the receiver's byte offset"
```

---

### Task 7: Browser end-to-end tests

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/transfer.spec.ts`
- Modify: `package.json` — add `test:e2e`

**Interfaces:**
- Consumes: the built app.
- Produces: a two-context browser test that transfers a real file and compares bytes on disk.

**Why the forced-transport flag matters.** Without it, the relay path only runs on
networks where WebRTC fails — networks a developer rarely has to hand. The flag
makes the fallback deterministically testable, which is what stops it from
rotting silently until a user hits it in a hotel.

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:8787', acceptDownloads: true },
  webServer: {
    command: 'npm run build && NODE_ENV=production node dist/server/index.js',
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 3: Write the end-to-end test**

```ts
// tests/e2e/transfer.spec.ts
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIZE = 3 * 1024 * 1024;

function makeFixture(): { path: string; bytes: Buffer } {
  const bytes = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = (i * 31) % 256;
  const path = join(mkdtempSync(join(tmpdir(), 'soja-')), 'fixture.bin');
  writeFileSync(path, bytes);
  return { path, bytes };
}

for (const forced of ['relay', 'auto'] as const) {
  test(`transfers a file byte-identically over the ${forced} transport`, async ({ browser }) => {
    const query = `?forceTransport=${forced}&forceSave=blob`;
    const fixture = makeFixture();

    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    await host.goto(`/${query}`);
    // The code is rendered grouped as XXX-XXX for legibility; the URL is not.
    const shareUrl = await host.getByRole('button', { name: /copy link/i }).evaluate(() => {
      const code = document.querySelector('[translate="no"]')!.textContent!.replace('-', '');
      return `/s/${code}${location.hash}`;
    });

    await guest.goto(`${shareUrl.split('#')[0]}${query}#${shareUrl.split('#')[1]}`);
    await expect(host.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });

    await host.getByRole('button', { name: /choose files/i }).click();
    await host.locator('input[type="file"]').setInputFiles(fixture.path);

    const download = guest.waitForEvent('download', { timeout: 45_000 });
    await guest.getByRole('link', { name: /save/i }).click();
    const path = await (await download).path();

    expect(Buffer.compare(readFileSync(path!), fixture.bytes)).toBe(0);

    await hostContext.close();
    await guestContext.close();
  });
}

test('a text snippet crosses in both directions', async ({ browser }) => {
  const query = '?forceTransport=relay&forceSave=blob';
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto(`/${query}`);
  const shareUrl = await host.evaluate(() => {
    const code = document.querySelector('[translate="no"]')!.textContent!.replace('-', '');
    return `/s/${code}${location.hash}`;
  });
  await guest.goto(`${shareUrl.split('#')[0]}${query}#${shareUrl.split('#')[1]}`);
  await expect(host.getByText(/connected/i)).toBeVisible({ timeout: 20_000 });

  await guest.getByRole('textbox', { name: /text to send/i }).fill('crossing over');
  await guest.getByRole('textbox', { name: /text to send/i }).press('ControlOrMeta+Enter');
  await expect(host.getByText('crossing over')).toBeVisible({ timeout: 15_000 });

  await hostContext.close();
  await guestContext.close();
});

test('an expired code lands on a recoverable screen, not a 404', async ({ page }) => {
  await page.goto('/s/ZZZZZZ#' + 'a'.repeat(43));
  await expect(page.getByRole('button', { name: /start a new session/i })).toBeVisible();
});
```

- [ ] **Step 4: Honor `forceSave` in the client**

In `useSession`, read `forceSave` from the query string and pass it through instead of `detectSaveCapability()` when present. This makes the download assertion deterministic across browsers.

- [ ] **Step 5: Add the script to `package.json`**

```json
    "test:e2e": "playwright test"
```

- [ ] **Step 6: Run it**

Run: `npm run test:e2e`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts tests/e2e package.json package-lock.json client/hooks/useSession.ts
git commit -m "test(e2e): transfer real files between two browser contexts"
```

---

### Task 8: Production build, HTTPS development, and deployment

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docs/deployment.md`
- Modify: `server/index.ts` — read `PORT` and `HOST` from the environment
- Modify: `package.json` — add `start`
- Test: `tests/integration/production-build.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/production-build.test.ts
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production artifacts', () => {
  it('has a Dockerfile', () => {
    expect(existsSync(new URL('../../Dockerfile', import.meta.url))).toBe(true);
  });

  it('documents deployment', () => {
    expect(existsSync(new URL('../../docs/deployment.md', import.meta.url))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/production-build.test.ts`
Expected: FAIL — neither file exists.

- [ ] **Step 3: Make the server configurable**

Add to the bottom of `server/index.ts`:

```ts
// Started directly (not imported by a test): listen on the configured address.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`soja-share listening on ${host}:${port}`);
}
```

Add `"start": "NODE_ENV=production node dist/server/index.js"` to the scripts.

- [ ] **Step 4: Create the `Dockerfile`**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8787
USER node
CMD ["node", "dist/server/index.js"]
```

And `.dockerignore`:

```
node_modules
dist
.git
tests
docs
```

- [ ] **Step 5: Write `docs/deployment.md`**

Cover, each in a short section:

- **HTTPS is mandatory, not optional.** `getUserMedia` (the QR scanner), `RTCPeerConnection`, and service workers all require a secure context. The app is unusable on plain HTTP anywhere except `localhost`.
- **Local development against a phone.** `localhost` is a secure context but your phone cannot reach it. Use a tunnel, or generate a local certificate with `mkcert` and run Vite with `--https`. Note that a self-signed certificate must be trusted on the phone too.
- **Reverse proxy.** Caddy is the shortest path: it obtains certificates automatically and proxies WebSockets with no extra configuration. Include a four-line `Caddyfile`. For nginx, note the `Upgrade` and `Connection` headers and a `proxy_read_timeout` long enough that an idle paired session is not culled mid-transfer.
- **Environment.** `PORT`, `HOST`, `VITE_STUN_URLS`.
- **Scaling.** Rooms live in one process's memory, so two peers must reach the same instance. Either run a single instance, or enable sticky sessions *and* accept that two peers can still land apart — the durable fix is Redis pub/sub keyed by room code, which is out of scope here and recorded in the spec's deferred list.
- **What is stored.** Nothing. No database, no object storage, no logs of file content. Say this plainly, because it is the product's main claim.

- [ ] **Step 6: Verify the container works**

```bash
docker build -t soja-share .
docker run --rm -p 8787:8787 soja-share
```

Open `http://localhost:8787`, create a session, and complete a transfer between two browser windows.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck && npm run test:e2e`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore docs/deployment.md server/index.ts package.json tests/integration/production-build.test.ts
git commit -m "feat: add production build, container image and deployment guide"
```

---

## Plan 3 done when

- `npm test`, `npm run typecheck`, and `npm run test:e2e` are all green.
- Two devices on the same LAN transfer over WebRTC; the badge says **Direct**.
- Forcing `?forceTransport=relay` still transfers correctly and the badge says **Relayed**.
- Killing the network mid-transfer and restoring it resumes rather than restarting.
- Every failure row in spec §10 has been reproduced by hand and lands on a screen with a way forward.

## Deferred beyond Plan 3

Recorded in the spec's own deferred list, and unchanged by this plan:

- Store-and-forward "park it for later" mode.
- More than two devices per room.
- Local-network device discovery without a QR.
- PWA install and share-target integration.
- A per-session PIN on top of the fragment key.
- Horizontal scaling via Redis pub/sub keyed by room code.

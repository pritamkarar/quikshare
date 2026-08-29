# Transport Realm Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WebRTC data path actually run by moving the `RTCPeerConnection` to the page, so the `Direct` transport badge becomes reachable for the first time.

**Architecture:** `Session` stays in the Web Worker with the key and all AES-GCM work, but stops constructing `RTCPeerConnection` — a class that does not exist in a worker realm. `negotiateUpgrade` gains an injectable transport factory. In the worker that factory returns `ProxyUpgradeTransport`, a `Transport` whose every operation is an RPC to the page; on the page, `PeerHost` owns the real `WebRTCTransport` and answers those RPCs. This mirrors the existing `sink-proxy` / `sink-host` pair exactly, which is the pattern this codebase already uses when the page owns a resource the worker cannot construct.

**Tech Stack:** TypeScript 5.6, React 19, Vite 6, Vitest 3, Playwright, Fastify 5.

**Spec:** [`docs/superpowers/specs/2026-08-27-live-media-and-session-layout-design.md`](../specs/2026-08-27-live-media-and-session-layout-design.md) — this plan implements §5 (Architecture) and §9 phase 1 only.

**Plan 01 of 4.** Later plans cover the session layout restructure, TURN infrastructure, and live media. This one ships alone and first: it touches `session.ts` and `upgrade.ts`, and mixing it with a layout change would make a resume or reconnect regression unattributable.

## Global Constraints

- Node **≥ 22**. On this machine `node` is not on the default `PATH`; prefix commands with `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"`.
- `AGENTS.md` (Vercel Web Interface Guidelines) is binding on all UI work. This plan touches no UI, so its main obligation is not regressing one.
- **No user-visible change.** If the app looks different after this plan, something is wrong. The only visible difference is that the badge can now read `Direct` where it previously always read `Relayed`.
- The relay is an active adversary. Any value arriving from it is whitelisted into a fresh object, never cast. Existing house pattern: `parseSignal` in `client/transport/webrtc.ts`, `parseServerSignal` in `shared/signals.ts`.
- Every AES-GCM operation and the session key stay in the worker. Nothing in this plan moves plaintext or key material to the page beyond what the sink proxy already does.
- Frames crossing the worker boundary travel as transferable `ArrayBuffer`s — a pointer move, not a copy.
- Commit after every task. Conventional commits, matching repo history (`feat:`, `fix:`, `refactor(ui):`, `chore:`, `docs:`).

## File Structure

| File | Responsibility |
| --- | --- |
| `client/transport/upgrade.ts` *(modify)* | Gains `UpgradeTransport` interface and `UpgradeTransportFactory`; `negotiateUpgrade` constructs through the factory instead of naming `WebRTCTransport` directly |
| `client/worker/messages.ts` *(modify)* | The eleven new RPC message variants for the peer proxy, plus `init.webrtcAvailable` |
| `client/worker/peer-proxy.ts` *(create)* | Worker side. `ProxyUpgradeTransport` — a `Transport` backed by RPC, including synchronous `bufferedAmount` accounting |
| `client/worker/peer-host.ts` *(create)* | Page side. Owns the real `WebRTCTransport`, answers RPC, reports events back |
| `client/session.ts` *(modify)* | Guard moves off the realm check onto an injected capability flag; factory threaded to `negotiateUpgrade` |
| `client/worker/transfer-worker.ts` *(modify)* | Builds the proxy factory, routes peer RPC |
| `client/hooks/useSession.ts` *(modify)* | Builds `PeerHost`, detects WebRTC availability on the page, passes it in `init` |
| `tests/unit/peer-proxy.test.ts` *(create)* | `bufferedAmount` accounting, drain, ordering, teardown |
| `tests/unit/peer-host.test.ts` *(create)* | Host answers each RPC and reports each event |
| `tests/integration/peer-proxy-transport.test.ts` *(create)* | Proxy + host end to end across a simulated boundary |
| `tests/e2e/direct-transport.spec.ts` *(create)* | **The test that was missing:** real browser, two contexts, badge reaches `Direct` |

---

### Task 1: Make the upgrade transport injectable

Pure refactor. `negotiateUpgrade` currently names `WebRTCTransport` directly, which hard-codes a Window-only class into code that runs in a worker. Introduce the seam; behaviour is unchanged.

**Files:**
- Modify: `client/transport/upgrade.ts` (`UpgradeOptions` ~line 278, `negotiateUpgrade` ~line 363)
- Test: `tests/unit/upgrade.test.ts` — it already builds `SwitchableTransport` / `TransportSwapGate` directly and calls `negotiateUpgrade`, which is exactly this test's shape. `tests/integration/upgrade-fallback.test.ts` drives whole `Session`s instead and is the wrong home.

**Interfaces:**
- Consumes: `Transport` from `client/transport/types.ts`; `WebRTCTransport` from `client/transport/webrtc.ts`
- Produces:
  ```ts
  export interface UpgradeTransport extends Transport {
    whenOpen(timeoutMs: number): Promise<void>;
    handleSignal(payload: unknown): Promise<void>;
  }
  export type UpgradeTransportFactory =
    (isOfferer: boolean, sendSignal: (msg: unknown) => void) => UpgradeTransport;
  ```
  and `UpgradeOptions.createTransport?: UpgradeTransportFactory`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/upgrade.test.ts`, which already imports everything below:

```ts
it('constructs its transport through the injected factory rather than naming WebRTCTransport', async () => {
  // The whole point of the seam: in a Web Worker there is no
  // RTCPeerConnection, so the realm that runs negotiateUpgrade cannot be the
  // realm that builds the peer connection. Proving the factory is honoured
  // is what makes the worker-side proxy possible at all.
  // createMemoryPair, not `new MemoryTransport()` — the class is deliberately
  // not exported; the pair factory is the whole public surface.
  const [relay] = createMemoryPair();
  const switchable = new SwitchableTransport(relay);
  let builtWith: boolean | undefined;

  const outcome = await negotiateUpgrade({
    switchable,
    isOfferer: true,
    sendSignal: () => undefined,
    onSignal: () => undefined,
    gate: new TransportSwapGate(),
    timeoutMs: 50,
    createTransport: (isOfferer) => {
      builtWith = isOfferer;
      return {
        kind: 'webrtc' as const,
        bufferedAmount: 0,
        send: () => undefined,
        onMessage: () => undefined,
        onDrain: () => undefined,
        onClose: () => undefined,
        close: () => undefined,
        whenOpen: () => Promise.reject(new Error('never opens')),
        handleSignal: () => Promise.resolve(),
      };
    },
  });

  expect(builtWith).toBe(true);
  expect(outcome).toEqual({ ok: false, reason: 'failed' });
  // Never swapped, so the session is still on its relay baseline.
  expect(switchable.kind).toBe('relay');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/upgrade.test.ts -t 'injected factory'
```

Expected: FAIL — TypeScript rejects `createTransport` as an unknown property of `UpgradeOptions`.

- [ ] **Step 3: Add the interface and the factory option**

In `client/transport/upgrade.ts`, above `UpgradeOptions`:

```ts
/**
 * What `negotiateUpgrade` needs from a candidate transport: the `Transport`
 * seam plus the two negotiation-only methods. Extracted as an interface, and
 * built through a factory below, because the realm that RUNS this negotiation
 * is not always the realm that can BUILD the connection — `RTCPeerConnection`
 * is `[Exposed=Window]`, and `Session` lives in a Web Worker. Naming
 * `WebRTCTransport` directly here is what made the upgrade unreachable in
 * production for the entire life of the project.
 */
export interface UpgradeTransport extends Transport {
  whenOpen(timeoutMs: number): Promise<void>;
  handleSignal(payload: unknown): Promise<void>;
}

/**
 * Builds one attempt's transport. `isOfferer` decides which side creates the
 * data channel; `sendSignal` is how the transport emits its own SDP and ICE.
 */
export type UpgradeTransportFactory =
  (isOfferer: boolean, sendSignal: (msg: unknown) => void) => UpgradeTransport;

/**
 * The default: a real `WebRTCTransport` in this realm. Correct on the page,
 * and impossible in a worker — which is exactly why callers in the worker
 * pass their own.
 */
export const createLocalUpgradeTransport: UpgradeTransportFactory = (isOfferer, sendSignal) =>
  isOfferer ? WebRTCTransport.offer(sendSignal) : WebRTCTransport.answer(sendSignal);
```

Add to `UpgradeOptions`:

```ts
  /**
   * How to build this attempt's transport. Defaults to a real
   * `WebRTCTransport` in the calling realm. The transfer worker passes a
   * proxy to the page instead — see client/worker/peer-proxy.ts.
   */
  createTransport?: UpgradeTransportFactory;
```

- [ ] **Step 4: Construct through the factory**

In `negotiateUpgrade`, change the destructure to include the new option and swap the construction line.

Destructure — add `createTransport = createLocalUpgradeTransport,` alongside `onSignalRejected`.

Then replace:

```ts
  let rtc: WebRTCTransport | undefined;
  try {
    rtc = isOfferer ? WebRTCTransport.offer(sendSignal) : WebRTCTransport.answer(sendSignal);
```

with:

```ts
  let rtc: UpgradeTransport | undefined;
  try {
    rtc = createTransport(isOfferer, sendSignal);
```

Everything below is untouched: `transport.handleSignal`, `transport.whenOpen`, `transport.close` and `switchable.swapTo(transport)` are all satisfied by the interface.

- [ ] **Step 5: Run the whole suite**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
```

Expected: PASS, 744+ tests. Every existing upgrade test still passes because the default factory reproduces the old behaviour exactly.

- [ ] **Step 6: Commit**

```bash
git add client/transport/upgrade.ts tests/unit/upgrade.test.ts
git commit -m "refactor(transport): build the upgrade transport through an injectable factory"

negotiateUpgrade named WebRTCTransport directly, hard-coding a Window-only
class into code that runs in a Web Worker. Behaviour is unchanged — the
default factory is the same construction — but the seam is what lets the
worker hand in a proxy to a page-owned connection."
```

---

### Task 2: Move the capability check off the realm

`#startUpgrade` asks whether `RTCPeerConnection` exists *where it is running*. Once the connection is built on the page that is the wrong question, asked in the wrong realm. The page answers it and passes the answer in.

**Files:**
- Modify: `client/session.ts` (`SessionOptions` ~line 95, `#startUpgrade` ~line 1146)
- Test: `tests/unit/session-upgrade-guard.test.ts`
- Test: `tests/integration/upgrade-fallback.test.ts` (see Step 5)

> `client/worker/messages.ts` is deliberately NOT in this list. `init.webrtcAvailable` is added in Task 6, which is the task that actually reads it; nothing in Task 2 needs the wire field.

**Interfaces:**
- Consumes: `UpgradeTransportFactory` from Task 1
- Produces: `SessionOptions.webrtc?: { available: boolean; createTransport: UpgradeTransportFactory }` — a single option so a caller cannot say "available" without supplying the means

- [ ] **Step 1: Write the failing test**

`tests/unit/session-upgrade-guard.test.ts` already has exactly the harness this needs: `fakeRelay()` exposes `triggerPeerJoined()`, which fires the relay callback `Session` really registers, so `#handlePeerJoined` → `#startUpgrade` runs for real. `beforeEach` stubs a global `RTCPeerConnection` and collects every construction into `peers`, so "did a negotiation start?" is `peers.length`.

**Do not** reach for `session.events.onPeerJoined?.()`. That is an *outbound* callback slot the Session invokes to notify its owner; calling it yourself notifies nobody and never reaches `#startUpgrade`.

First, give the existing helper an override — replace `hostSession` with:

```ts
async function hostSession(
  webrtc: SessionOptions['webrtc'] = { available: true, createTransport: createLocalUpgradeTransport },
) {
  const relay = fakeRelay();
  connect.mockResolvedValue({
    transport: relay.transport, code: 'ABC123', peerId: 'a', peerPresent: false,
  } satisfies RelayConnection);
  const session = await Session.create('ws://test/ws', { webrtc });
  return { session, relay };
}
```

Add the imports it needs:

```ts
import type { SessionOptions } from '../../client/session.js';
import { createLocalUpgradeTransport } from '../../client/transport/upgrade.js';
```

Defaulting to `available: true` keeps every existing test in the file passing unchanged — and those tests now do double duty, proving the positive case (a negotiation starts, `peers` grows) that this task's guard must not break.

Then append the negative case:

```ts
it('does not negotiate when the page reports no WebRTC, even though this realm has one', async () => {
  // The exact production shape, inverted. `beforeEach` has stubbed a global
  // RTCPeerConnection, so a realm check would say "yes, go ahead" — and for
  // the whole life of this project the realm check was the ONLY check, asked
  // inside a Web Worker where the answer is always no. Availability is the
  // page's answer now, and it is the only thing that may gate this.
  const { session, relay } = await hostSession({
    available: false,
    createTransport: () => { throw new Error('must not be built'); },
  });

  relay.triggerPeerJoined();
  await flush();

  expect(peers).toHaveLength(0);
  session.close();
});
```

`SessionOptions` must be exported from `client/session.ts` for the helper's type annotation — it already is.

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/session-upgrade-guard.test.ts
```

Expected: FAIL — `webrtc` is not a property of `SessionOptions`.

- [ ] **Step 3: Add the option**

In `client/session.ts`, add to `SessionOptions`:

```ts
  /**
   * How this session reaches a WebRTC data path, and whether it can at all.
   *
   * Both halves in one option on purpose: `available` without a
   * `createTransport` is a promise this class cannot keep, and the two were
   * previously answered by a single `typeof RTCPeerConnection` check in
   * whatever realm happened to be running — which is the bug this whole
   * change exists to fix. `Session` runs in a Web Worker, where that check is
   * ALWAYS false, so the upgrade never once ran in production and every
   * session was permanently relayed.
   *
   * The page answers `available` (it is the realm that would host the
   * connection) and supplies a factory that proxies to it. Omitted entirely,
   * this session never attempts an upgrade — which is the right default for
   * a caller that has not thought about realms, and is what the Node test
   * environment wants.
   */
  webrtc?: { available: boolean; createTransport: UpgradeTransportFactory };
```

Import the type: add `UpgradeTransportFactory` to the existing import from `./transport/upgrade.js`.

Store it on the instance beside `#forceTransport`:

```ts
  readonly #webrtc: SessionOptions['webrtc'];
```

Assign it in the private constructor from a new parameter, threaded from `create`/`join` the same way `forceTransport` already is.

- [ ] **Step 4: Replace the guard**

In `#startUpgrade`, replace:

```ts
    if (typeof RTCPeerConnection === 'undefined' || this.#forceTransport === 'relay') return;
```

with:

```ts
    // Asks the PAGE whether a connection is possible, not this realm. The
    // previous `typeof RTCPeerConnection === 'undefined'` check ran here, in
    // a Web Worker, where that class does not exist — so it was always true
    // and this method always returned on its first line. See
    // SessionOptions.webrtc.
    if (!this.#webrtc?.available || this.#forceTransport === 'relay') return;
```

And pass the factory through to `negotiateUpgrade` in the same method, adding to its options object:

```ts
      createTransport: this.#webrtc.createTransport,
```

- [ ] **Step 5: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
```

Expected: PASS — but only after updating **both** suites that construct a `Session` and expect an upgrade to happen.

A stubbed global `RTCPeerConnection` used to be enough to make `#startUpgrade` proceed. It is not any more: availability is now an option, and a `Session` built without one never negotiates. Every construction that expects a negotiation needs `webrtc: { available: true, createTransport: createLocalUpgradeTransport }`:

- `tests/unit/session-upgrade-guard.test.ts` — handled by the `hostSession` default in Step 1.
- `tests/integration/upgrade-fallback.test.ts` — every `Session.create` / `Session.join` whose test expects a WebRTC upgrade. Leave the deliberately-relay cases (`forceTransport: 'relay'`, and the "no WebRTC available at all" case) without the option, which is now the honest way to express them.

The stub still proves the negotiation algorithm; it just no longer doubles as the availability check.

- [ ] **Step 6: Record why the stub is not enough**

Add to the top of `tests/integration/upgrade-fallback.test.ts`:

```ts
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
```

- [ ] **Step 7: Commit**

```bash
git add client/session.ts tests/unit/session-upgrade-guard.test.ts tests/integration/upgrade-fallback.test.ts
git commit -m "fix(transport): ask the page, not the worker realm, whether WebRTC is available

Session runs in a Web Worker. RTCPeerConnection is [Exposed=Window], so
#startUpgrade's realm check was always true and the upgrade never ran in
production: every session has been permanently relayed and the Direct badge
unreachable. The page now answers the question and supplies the means."
```

---

### Task 3: The peer RPC messages

Eleven variants, mirroring the naming and doc-comment discipline of the existing sink RPC in the same file.

**Files:**
- Modify: `client/worker/messages.ts`
- Test: `tests/unit/worker-messages.test.ts`

**Interfaces:**
- Produces: on `FromWorker` — `peer-open`, `peer-wait-open`, `peer-send`, `peer-signal-in`, `peer-close`; on `ToWorker` — `peer-opened`, `peer-message`, `peer-drain`, `peer-closed`, `peer-signal-out`, `peer-signal-result`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/worker-messages.test.ts`:

```ts
it('carries a peer frame as a transferable ArrayBuffer view, not a copy', () => {
  const frame = new Uint8Array([1, 2, 3]);
  const msg: FromWorker = { t: 'peer-send', id: 1, seq: 7, frame };
  expect(msg.t).toBe('peer-send');
  expect(msg.frame).toBe(frame);
});

it('echoes the last accepted seq alongside the real bufferedAmount', () => {
  const msg: ToWorker = { t: 'peer-drain', id: 1, acceptedSeq: 7, bufferedAmount: 2048 };
  expect(msg.acceptedSeq).toBe(7);
  expect(msg.bufferedAmount).toBe(2048);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/worker-messages.test.ts
```

Expected: FAIL — the variants do not exist.

- [ ] **Step 3: Add the variants**

In `client/worker/messages.ts`, add to `FromWorker`:

```ts
  /*
   * Peer RPC, worker → page. Same shape and the same reason as the sink RPC
   * below: `RTCPeerConnection` is `[Exposed=Window]`, so the connection is
   * built and owned on the page while `Session` — and every AES-GCM
   * operation — stays in this worker. Frames cross as transferable
   * ArrayBuffers, so nothing is copied.
   */
  | { t: 'peer-open'; id: number; isOfferer: boolean }
  /**
   * Separate from `peer-open` on purpose. The proxy builds the connection as
   * soon as it is constructed (so ICE starts gathering at the right moment
   * and with the right role) but only learns the timeout later, when
   * `negotiateUpgrade` calls `whenOpen`. Folding both into one message meant
   * sending `peer-open` twice with a meaningless second `isOfferer`, and a
   * host that mishandled it would build two RTCPeerConnections.
   */
  | { t: 'peer-wait-open'; id: number; timeoutMs: number }
  /**
   * `seq` is a per-connection counter the page echoes back in `peer-drain`
   * and `peer-message`. It is what lets the worker compute a synchronous
   * `bufferedAmount` for a buffer it cannot see — see peer-proxy.ts.
   */
  | { t: 'peer-send'; id: number; seq: number; frame: Uint8Array }
  /** An SDP or ICE payload off the relay, to be applied to the page's connection. */
  | { t: 'peer-signal-in'; id: number; requestId: number; payload: unknown }
  | { t: 'peer-close'; id: number }
```

And to `ToWorker`:

```ts
  /*
   * Peer RPC, page → worker. The page owns the real connection; these report
   * what it did.
   */
  | { t: 'peer-opened'; id: number; ok: true }
  | { t: 'peer-opened'; id: number; ok: false; reason: 'timeout' | 'failed' }
  | { t: 'peer-message'; id: number; frame: Uint8Array }
  /**
   * The page's buffer drained below the high-water mark. `acceptedSeq` is the
   * highest `peer-send` seq the page has handed to the data channel, and
   * `bufferedAmount` is the channel's own reading at that moment — together
   * they let the worker reconstruct a conservative synchronous view.
   */
  | { t: 'peer-drain'; id: number; acceptedSeq: number; bufferedAmount: number }
  | { t: 'peer-closed'; id: number; reason: string }
  /** SDP or ICE the page's connection produced, for the worker to relay. */
  | { t: 'peer-signal-out'; id: number; payload: unknown }
  /** The result of applying one `peer-signal-in`, correlated by `requestId`. */
  | { t: 'peer-signal-result'; id: number; requestId: number; ok: boolean; message?: string }
```

- [ ] **Step 4: Run the test**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/worker-messages.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/worker/messages.ts tests/unit/worker-messages.test.ts
git commit -m "feat(worker): peer RPC message types for a page-owned data connection"
```

---

### Task 4: `ProxyUpgradeTransport` — the worker side

The subtle part is `bufferedAmount`. `Transport` exposes it as a **synchronous** getter, `Sender.#awaitDrain` compares it against `HIGH_WATER_BYTES` on every chunk, and the real value lives in another realm. The proxy keeps a conservative reconstruction: the page's last reported reading, plus every byte sent since the seq that reading covered. Over-estimating makes the sender wait slightly longer than necessary; under-estimating would overrun the buffer. Only one of those is safe.

**Files:**
- Create: `client/worker/peer-proxy.ts`
- Test: `tests/unit/peer-proxy.test.ts`

**Interfaces:**
- Consumes: `UpgradeTransport`, `UpgradeTransportFactory` (Task 1); the message types (Task 3); `PostRequest` from `client/worker/sink-proxy.ts`
- Produces:
  ```ts
  export interface PeerProxy {
    createTransport: UpgradeTransportFactory;
    handle(msg: ToWorker): boolean;   // true if consumed
    closeAll(reason: string): void;
  }
  export function createPeerProxy(post: PostRequest): PeerProxy;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/peer-proxy.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPeerProxy } from '../../client/worker/peer-proxy.js';
import type { FromWorker } from '../../client/worker/messages.js';

function harness() {
  const posted: FromWorker[] = [];
  const proxy = createPeerProxy((msg) => { posted.push(msg); });
  const transport = proxy.createTransport(true, () => undefined);
  const id = (posted.find((m) => m.t === 'peer-open') as { id: number }).id;
  return { posted, proxy, transport, id };
}

describe('ProxyUpgradeTransport bufferedAmount', () => {
  /*
   * The reason this accounting exists at all: Transport.bufferedAmount is a
   * SYNCHRONOUS getter, Sender.#awaitDrain reads it per chunk, and the real
   * buffer lives on the page. Guessing low would overrun it.
   */
  it('counts every byte sent as outstanding until the page reports otherwise', () => {
    const { transport } = harness();
    expect(transport.bufferedAmount).toBe(0);
    transport.send(new Uint8Array(600));
    transport.send(new Uint8Array(400));
    expect(transport.bufferedAmount).toBe(1000);
  });

  it('drops bytes the page has confirmed accepting, keeping later ones outstanding', () => {
    const { proxy, transport, id } = harness();
    transport.send(new Uint8Array(600));   // seq 1
    transport.send(new Uint8Array(400));   // seq 2
    // The page took seq 1 and its channel then read 100 bytes buffered.
    proxy.handle({ t: 'peer-drain', id, acceptedSeq: 1, bufferedAmount: 100 });
    // 100 really buffered + 400 still in flight to the page.
    expect(transport.bufferedAmount).toBe(500);
  });

  it('over-estimates rather than under-estimates when a report is stale', () => {
    const { proxy, transport, id } = harness();
    transport.send(new Uint8Array(1000));
    proxy.handle({ t: 'peer-drain', id, acceptedSeq: 0, bufferedAmount: 0 });
    // The report predates the send, so the bytes must still count.
    expect(transport.bufferedAmount).toBe(1000);
  });

  it('fires onDrain when the page reports a drain', () => {
    const { proxy, transport, id } = harness();
    const drained = vi.fn();
    transport.onDrain(drained);
    proxy.handle({ t: 'peer-drain', id, acceptedSeq: 0, bufferedAmount: 0 });
    expect(drained).toHaveBeenCalledOnce();
  });

  it('delivers inbound frames in arrival order', () => {
    const { proxy, transport, id } = harness();
    const seen: number[] = [];
    transport.onMessage((f) => seen.push(f[0]!));
    proxy.handle({ t: 'peer-message', id, frame: new Uint8Array([1]) });
    proxy.handle({ t: 'peer-message', id, frame: new Uint8Array([2]) });
    expect(seen).toEqual([1, 2]);
  });

  it('reports a close exactly once and stops sending afterwards', () => {
    const { posted, proxy, transport, id } = harness();
    const closed = vi.fn();
    transport.onClose(closed);
    proxy.handle({ t: 'peer-closed', id, reason: 'connection lost' });
    proxy.handle({ t: 'peer-closed', id, reason: 'connection lost' });
    expect(closed).toHaveBeenCalledOnce();
    const before = posted.length;
    transport.send(new Uint8Array(10));
    expect(posted.length).toBe(before);
  });

  it('resolves whenOpen from the page answer and rejects a timeout distinctly', async () => {
    const a = harness();
    const openA = a.transport.whenOpen(50);
    a.proxy.handle({ t: 'peer-opened', id: a.id, ok: true });
    await expect(openA).resolves.toBeUndefined();

    const b = harness();
    const openB = b.transport.whenOpen(50);
    b.proxy.handle({ t: 'peer-opened', id: b.id, ok: false, reason: 'timeout' });
    await expect(openB).rejects.toThrow(/did not open/i);
  });

  it('fails every pending open when the session is torn down', async () => {
    const { proxy, transport } = harness();
    const open = transport.whenOpen(1000);
    proxy.closeAll('the session was closed');
    await expect(open).rejects.toThrow(/session was closed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/peer-proxy.test.ts
```

Expected: FAIL — `client/worker/peer-proxy.ts` does not exist.

- [ ] **Step 3: Implement the proxy**

Create `client/worker/peer-proxy.ts`:

```ts
import type { Transport } from '../transport/types.js';
import { WhenOpenTimeoutError } from '../transport/webrtc.js';
import type { UpgradeTransport, UpgradeTransportFactory } from '../transport/upgrade.js';
import type { FromWorker, ToWorker } from './messages.js';
import type { PostRequest } from './sink-proxy.js';

/**
 * Unique for the worker's whole lifetime, not per proxy — same reasoning as
 * `nextRequestId` in sink-proxy.ts. A worker can outlive one session, and a
 * connection id that restarted at 1 would let a stale `peer-message` from a
 * retired connection be delivered into a live one's Receiver.
 */
let nextConnectionId = 1;
let nextSignalRequestId = 1;

export interface PeerProxy {
  /** Hand this to `Session` as its upgrade transport factory. */
  createTransport: UpgradeTransportFactory;
  /** Routes one page → worker peer message. Returns true if it was consumed. */
  handle(msg: ToWorker): boolean;
  /** Fails everything in flight and closes every connection this proxy owns. */
  closeAll(reason: string): void;
}

/** One outstanding `peer-send`, until the page confirms it took it. */
interface InFlight { seq: number; bytes: number; }

class ProxyUpgradeTransport implements UpgradeTransport {
  readonly kind = 'webrtc' as const;
  readonly id = nextConnectionId++;

  #post: PostRequest;
  #onMessage: ((frame: Uint8Array) => void) | undefined;
  #onDrain: (() => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #openSettle: { resolve: () => void; reject: (e: Error) => void } | undefined;
  #signalPending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  #closed = false;
  #sendSeq = 0;
  /**
   * The page's most recent reading of the real channel buffer, and the seq it
   * was taken at. Everything sent after that seq is still unaccounted for.
   */
  #reportedBytes = 0;
  #reportedSeq = 0;
  /** Sends the page has not yet confirmed. Bounded by frames in flight. */
  readonly #inFlight: InFlight[] = [];

  constructor(post: PostRequest, isOfferer: boolean, readonly sendSignal: (msg: unknown) => void) {
    this.#post = post;
    this.#post({ t: 'peer-open', id: this.id, isOfferer });
  }

  /**
   * A deliberate over-estimate.
   *
   * `Transport.bufferedAmount` is synchronous and `Sender.#awaitDrain` reads
   * it once per chunk, but the buffer it describes lives on the page. What
   * this returns is the page's last reading plus every byte sent since the
   * seq that reading covered — so a byte is only ever forgotten once the page
   * has said it took it. Over-estimating parks the sender a little early;
   * under-estimating would overrun a buffer nobody here can see. Only one of
   * those two errors is safe.
   */
  get bufferedAmount(): number {
    let pending = 0;
    for (const entry of this.#inFlight) pending += entry.bytes;
    return this.#reportedBytes + pending;
  }

  send(frame: Uint8Array): void {
    if (this.#closed) return;
    const seq = ++this.#sendSeq;
    this.#inFlight.push({ seq, bytes: frame.length });
    // Copied into a standalone buffer before transferring: the caller's view
    // may be over a larger pooled buffer, and transferring that would detach
    // the whole pool out from under the Sender.
    const copy = frame.slice();
    this.#post({ t: 'peer-send', id: this.id, seq, frame: copy }, [copy.buffer]);
  }

  whenOpen(timeoutMs: number): Promise<void> {
    // The page runs the real timer against the real connection; this only
    // needs somewhere to park until it answers.
    this.#post({ t: 'peer-wait-open', id: this.id, timeoutMs });
    return new Promise((resolve, reject) => { this.#openSettle = { resolve, reject }; });
  }

  handleSignal(payload: unknown): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const requestId = nextSignalRequestId++;
    return new Promise((resolve, reject) => {
      this.#signalPending.set(requestId, { resolve, reject });
      this.#post({ t: 'peer-signal-in', id: this.id, requestId, payload });
    });
  }

  onMessage(cb: (frame: Uint8Array) => void): void { this.#onMessage = cb; }
  onDrain(cb: () => void): void { this.#onDrain = cb; }
  onClose(cb: (reason: string) => void): void { this.#onClose = cb; }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#post({ t: 'peer-close', id: this.id });
    this.#failPending('the connection was closed');
  }

  /** Called by the proxy for messages addressed to this connection. */
  accept(msg: ToWorker): void {
    switch (msg.t) {
      case 'peer-opened':
        if (msg.ok) this.#openSettle?.resolve();
        else this.#openSettle?.reject(msg.reason === 'timeout'
          ? new WhenOpenTimeoutError()
          : new Error('the data channel could not be established'));
        this.#openSettle = undefined;
        return;
      case 'peer-message':
        this.#onMessage?.(msg.frame);
        return;
      case 'peer-drain':
        this.#reportedBytes = msg.bufferedAmount;
        this.#reportedSeq = Math.max(this.#reportedSeq, msg.acceptedSeq);
        // Everything the page has confirmed taking is now inside
        // `bufferedAmount` above rather than counted twice.
        while (this.#inFlight.length > 0 && this.#inFlight[0]!.seq <= this.#reportedSeq) {
          this.#inFlight.shift();
        }
        this.#onDrain?.();
        return;
      case 'peer-signal-result': {
        const pending = this.#signalPending.get(msg.requestId);
        if (!pending) return;
        this.#signalPending.delete(msg.requestId);
        if (msg.ok) pending.resolve();
        else pending.reject(new Error(msg.message ?? 'the signal could not be applied'));
        return;
      }
      case 'peer-closed':
        if (this.#closed) return;
        this.#closed = true;
        this.#failPending(msg.reason);
        this.#onClose?.(msg.reason);
        return;
      default:
        return;
    }
  }

  /** Fails the open and every outstanding signal, so nothing is left hanging. */
  #failPending(reason: string): void {
    this.#openSettle?.reject(new Error(reason));
    this.#openSettle = undefined;
    for (const pending of this.#signalPending.values()) pending.reject(new Error(reason));
    this.#signalPending.clear();
  }

  /** Teardown from the owning proxy, without posting a close the page cannot answer. */
  abandon(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(reason);
  }
}

export function createPeerProxy(post: PostRequest): PeerProxy {
  const connections = new Map<number, ProxyUpgradeTransport>();

  return {
    createTransport: (isOfferer, sendSignal) => {
      const transport = new ProxyUpgradeTransport(post, isOfferer, sendSignal);
      connections.set(transport.id, transport);
      return transport;
    },

    handle: (msg) => {
      if (!msg.t.startsWith('peer-')) return false;
      const addressed = msg as Extract<ToWorker, { id: number }>;
      const connection = connections.get(addressed.id);
      // An unknown id is a message for a connection already retired — see
      // `nextConnectionId`. Dropped, never routed to whatever is current.
      if (!connection) return true;
      if (msg.t === 'peer-signal-out') { connection.sendSignal(msg.payload); return true; }
      connection.accept(msg);
      return true;
    },

    closeAll: (reason) => {
      for (const connection of connections.values()) connection.abandon(reason);
      connections.clear();
    },
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/peer-proxy.test.ts && npm run typecheck
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add client/worker/peer-proxy.ts tests/unit/peer-proxy.test.ts
git commit -m "feat(worker): ProxyUpgradeTransport, the worker half of a page-owned data connection

bufferedAmount is a synchronous getter over a buffer in another realm, so it
is reconstructed conservatively: the page's last reading plus every byte sent
since the seq that reading covered. Over-estimating parks the sender early;
under-estimating would overrun a buffer this realm cannot see."
```

---

### Task 5: `PeerHost` — the page side

Owns the real `WebRTCTransport` and answers the RPC. Small, because all the hard reasoning is already in `WebRTCTransport`.

**Files:**
- Create: `client/worker/peer-host.ts`
- Test: `tests/unit/peer-host.test.ts`

**Interfaces:**
- Consumes: `WebRTCTransport` / `createLocalUpgradeTransport`; the message types (Task 3)
- Produces:
  ```ts
  export interface PeerHost {
    handle(msg: FromWorker): boolean;
    closeAll(): void;
  }
  export function createPeerHost(opts: {
    post: (msg: ToWorker, transfer?: Transferable[]) => void;
    createTransport?: UpgradeTransportFactory;
  }): PeerHost;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/peer-host.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPeerHost } from '../../client/worker/peer-host.js';
import type { ToWorker } from '../../client/worker/messages.js';
import type { UpgradeTransport } from '../../client/transport/upgrade.js';

function fakeTransport() {
  let onMessage: ((f: Uint8Array) => void) | undefined;
  let onDrain: (() => void) | undefined;
  let onClose: ((r: string) => void) | undefined;
  const sent: Uint8Array[] = [];
  const transport: UpgradeTransport & { fire: (kind: 'message' | 'drain' | 'close', value?: unknown) => void } = {
    kind: 'webrtc', bufferedAmount: 0,
    send: (f) => { sent.push(f); },
    onMessage: (cb) => { onMessage = cb; },
    onDrain: (cb) => { onDrain = cb; },
    onClose: (cb) => { onClose = cb; },
    close: vi.fn(),
    whenOpen: () => Promise.resolve(),
    handleSignal: vi.fn(async () => undefined),
    fire: (...args) => fire(...args),
  };
  function fire(kind: 'message' | 'drain' | 'close', value?: unknown): void {
    if (kind === 'message') onMessage?.(value as Uint8Array);
    if (kind === 'drain') onDrain?.();
    if (kind === 'close') onClose?.(value as string);
  }
  return { transport, sent };
}

describe('PeerHost', () => {
  it('builds a connection on peer-open and reports success', async () => {
    const posted: ToWorker[] = [];
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-wait-open', id: 1, timeoutMs: 100 });
    await vi.waitFor(() => expect(posted.some((m) => m.t === 'peer-opened')).toBe(true));
    expect(posted.find((m) => m.t === 'peer-opened')).toMatchObject({ id: 1, ok: true });
  });

  it('forwards a worker frame onto the real transport', () => {
    const { transport, sent } = fakeTransport();
    const host = createPeerHost({ post: () => undefined, createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-send', id: 1, seq: 1, frame: new Uint8Array([9]) });
    expect(sent).toEqual([new Uint8Array([9])]);
  });

  it('reports inbound frames, and echoes the accepted seq on a drain', () => {
    const posted: ToWorker[] = [];
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });

    transport.fire('message', new Uint8Array([4]));
    expect(posted.some((m) => m.t === 'peer-message')).toBe(true);

    // A frame first, THEN the drain: `acceptedSeq` exists to echo the last
    // seq this side actually took, and asserting it while nothing has been
    // sent would only test its initial value. The echo is the whole reason
    // the worker can reconstruct bufferedAmount at all.
    host.handle({ t: 'peer-send', id: 1, seq: 1, frame: new Uint8Array([9]) });
    transport.fire('drain');

    const drains = posted.filter((m) => m.t === 'peer-drain');
    expect(drains.at(-1)).toMatchObject({ id: 1, acceptedSeq: 1 });
  });

  it('answers a signal request with its outcome rather than swallowing it', async () => {
    const posted: ToWorker[] = [];
    const { transport } = fakeTransport();
    transport.handleSignal = vi.fn(async () => { throw new Error('bad sdp'); });
    const host = createPeerHost({ post: (m) => posted.push(m), createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.handle({ t: 'peer-signal-in', id: 1, requestId: 5, payload: {} });
    await vi.waitFor(() => expect(posted.some((m) => m.t === 'peer-signal-result')).toBe(true));
    expect(posted.find((m) => m.t === 'peer-signal-result')).toMatchObject({ requestId: 5, ok: false });
  });

  it('closes every connection on teardown so no RTCPeerConnection is left gathering', () => {
    const { transport } = fakeTransport();
    const host = createPeerHost({ post: () => undefined, createTransport: () => transport });
    host.handle({ t: 'peer-open', id: 1, isOfferer: true });
    host.closeAll();
    expect(transport.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/peer-host.test.ts
```

Expected: FAIL — `client/worker/peer-host.ts` does not exist.

- [ ] **Step 3: Implement the host**

Create `client/worker/peer-host.ts`:

```ts
import {
  createLocalUpgradeTransport,
  type UpgradeTransport,
  type UpgradeTransportFactory,
} from '../transport/upgrade.js';
import { WhenOpenTimeoutError } from '../transport/webrtc.js';
import type { FromWorker, ToWorker } from './messages.js';

/**
 * The page's half of the peer proxy, and the mirror of `sink-host.ts`.
 *
 * It exists for one reason: `RTCPeerConnection` is `[Exposed=Window]`, so the
 * realm that owns `Session` — a dedicated Web Worker — cannot construct one.
 * This side owns the connection; the worker keeps the key, the frames and
 * every AES-GCM operation, and never learns that its transport is a proxy.
 */
export interface PeerHost {
  /** Routes one worker → page peer message. Returns true if it was consumed. */
  handle(msg: FromWorker): boolean;
  /** Closes every connection. Called when the session is torn down. */
  closeAll(): void;
}

interface Live {
  transport: UpgradeTransport;
  /** The highest `peer-send` seq handed to the real transport. */
  acceptedSeq: number;
  opened: boolean;
}

export function createPeerHost(opts: {
  post: (msg: ToWorker, transfer?: Transferable[]) => void;
  createTransport?: UpgradeTransportFactory;
}): PeerHost {
  const { post, createTransport = createLocalUpgradeTransport } = opts;
  const live = new Map<number, Live>();

  function report(id: number, entry: Live): void {
    post({
      t: 'peer-drain',
      id,
      acceptedSeq: entry.acceptedSeq,
      bufferedAmount: entry.transport.bufferedAmount,
    });
  }

  /** Starts the real open race. Idempotent: a repeated request is ignored. */
  function waitOpen(id: number, timeoutMs: number): void {
    const entry = live.get(id);
    if (!entry || entry.opened) return;
    entry.opened = true;
    entry.transport.whenOpen(timeoutMs).then(
      () => post({ t: 'peer-opened', id, ok: true }),
      (error: unknown) => post({
        t: 'peer-opened', id, ok: false,
        reason: error instanceof WhenOpenTimeoutError ? 'timeout' : 'failed',
      }),
    );
  }

  function open(id: number, isOfferer: boolean): void {
    // Never two connections for one id: an RTCPeerConnection is expensive and
    // an orphaned one keeps gathering ICE for the life of the page.
    if (live.has(id)) return;

    let transport: UpgradeTransport;
    try {
      // Real browser code that can throw synchronously — a malformed
      // VITE_STUN_URLS entry is a SyntaxError in Chrome and Firefox, and
      // Chromium throws once its per-page peer-connection cap is reached.
      transport = createTransport(isOfferer, (payload) => post({ t: 'peer-signal-out', id, payload }));
    } catch {
      post({ t: 'peer-opened', id, ok: false, reason: 'failed' });
      return;
    }

    const entry: Live = { transport, acceptedSeq: 0, opened: false };
    live.set(id, entry);

    transport.onMessage((frame) => {
      // Copied then transferred: the same pooled-buffer hazard the relay
      // transport guards against on its own send path.
      const copy = frame.slice();
      post({ t: 'peer-message', id, frame: copy }, [copy.buffer]);
    });
    transport.onDrain(() => report(id, entry));
    transport.onClose((reason) => {
      live.delete(id);
      post({ t: 'peer-closed', id, reason });
    });
  }

  return {
    handle: (msg) => {
      switch (msg.t) {
        case 'peer-open':
          open(msg.id, msg.isOfferer);
          return true;
        case 'peer-wait-open':
          waitOpen(msg.id, msg.timeoutMs);
          return true;
        case 'peer-send': {
          const entry = live.get(msg.id);
          if (!entry) return true;
          entry.transport.send(msg.frame);
          entry.acceptedSeq = msg.seq;
          // Reported every send, not only on a drain event: the worker's
          // synchronous bufferedAmount is only as fresh as its last report,
          // and Sender consults it once per chunk.
          report(msg.id, entry);
          return true;
        }
        case 'peer-signal-in': {
          const entry = live.get(msg.id);
          if (!entry) return true;
          void entry.transport.handleSignal(msg.payload).then(
            () => post({ t: 'peer-signal-result', id: msg.id, requestId: msg.requestId, ok: true }),
            (error: unknown) => post({
              t: 'peer-signal-result', id: msg.id, requestId: msg.requestId, ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return true;
        }
        case 'peer-close': {
          const entry = live.get(msg.id);
          live.delete(msg.id);
          entry?.transport.close();
          return true;
        }
        default:
          return false;
      }
    },

    closeAll: () => {
      // Closed, not merely dropped: an abandoned RTCPeerConnection keeps
      // gathering ICE for the life of the page.
      for (const entry of live.values()) entry.transport.close();
      live.clear();
    },
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/peer-host.test.ts && npm run typecheck
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/worker/peer-host.ts tests/unit/peer-host.test.ts
git commit -m "feat(worker): PeerHost, the page half that owns the real RTCPeerConnection"
```

---

### Task 6: Wire the two halves together

**Files:**
- Modify: `client/worker/transfer-worker.ts`
- Modify: `client/hooks/useSession.ts`
- Test: `tests/integration/peer-proxy-transport.test.ts`

**Interfaces:**
- Consumes: `createPeerProxy` (Task 4), `createPeerHost` (Task 5), `SessionOptions.webrtc` (Task 2)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/peer-proxy-transport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPeerProxy } from '../../client/worker/peer-proxy.js';
import { createPeerHost } from '../../client/worker/peer-host.js';
import type { UpgradeTransport } from '../../client/transport/upgrade.js';

/**
 * A recording stand-in for the page's real connection. Written here rather
 * than reused from client/transport/memory.ts: `MemoryTransport` is not
 * exported (only `createMemoryPair` is), reports a constant
 * `bufferedAmount` of 0, and has no record of what it sent — and every
 * assertion below is about exactly those two things.
 */
function recordingTransport() {
  const sent: Uint8Array[] = [];
  let buffered = 0;
  let onMessage: ((f: Uint8Array) => void) | undefined;
  const transport: UpgradeTransport = {
    kind: 'webrtc',
    get bufferedAmount() { return buffered; },
    send: (f) => { sent.push(f); },
    onMessage: (cb) => { onMessage = cb; },
    onDrain: () => undefined,
    onClose: () => undefined,
    close: () => undefined,
    whenOpen: () => Promise.resolve(),
    handleSignal: () => Promise.resolve(),
  };
  return {
    transport,
    sent,
    setBuffered: (n: number) => { buffered = n; },
    deliver: (f: Uint8Array) => onMessage?.(f),
  };
}

/**
 * Proxy and host wired to each other through `queueMicrotask`, standing in
 * for postMessage. Async on purpose: a synchronous hop would hide every
 * ordering and staleness bug the real boundary can produce, which is the
 * only reason this test exists rather than a second unit test.
 */
function boundary(real: UpgradeTransport) {
  const proxy = createPeerProxy((msg) => { queueMicrotask(() => host.handle(msg)); });
  const host = createPeerHost({
    post: (msg) => { queueMicrotask(() => proxy.handle(msg)); },
    createTransport: () => real,
  });
  return { proxy, host };
}

describe('peer proxy over a simulated worker boundary', () => {
  it('carries frames to the page in order', async () => {
    const page = recordingTransport();
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    transport.send(new Uint8Array([1]));
    transport.send(new Uint8Array([2]));

    await vi.waitFor(() => { expect(page.sent.length).toBe(2); });
    expect(page.sent.map((f) => f[0])).toEqual([1, 2]);
  });

  it('carries frames back from the page in order', async () => {
    const page = recordingTransport();
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    const received: number[] = [];
    transport.onMessage((f) => received.push(f[0]!));
    // The host only wires its callbacks once the connection is built, and
    // that build is one microtask hop away.
    await vi.waitFor(() => { expect(page.sent).toEqual([]); });

    page.deliver(new Uint8Array([7]));
    page.deliver(new Uint8Array([8]));
    await vi.waitFor(() => { expect(received).toEqual([7, 8]); });
  });

  it('collapses its bufferedAmount estimate to the real reading once the page reports', async () => {
    const page = recordingTransport();
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    transport.send(new Uint8Array(4096));
    // Nothing confirmed yet, so every byte still counts against the sender.
    expect(transport.bufferedAmount).toBe(4096);

    // The page's channel took it and drained; the estimate must follow the
    // truth rather than stay inflated forever, or Sender parks permanently.
    await vi.waitFor(() => { expect(transport.bufferedAmount).toBe(0); });
  });

  it('tracks a page buffer that has NOT drained, so the sender still backs off', async () => {
    const page = recordingTransport();
    page.setBuffered(3000);
    const { proxy } = boundary(page.transport);
    const transport = proxy.createTransport(true, () => undefined);

    transport.send(new Uint8Array(1000));
    await vi.waitFor(() => { expect(transport.bufferedAmount).toBe(3000); });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/integration/peer-proxy-transport.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Wire the worker**

In `client/worker/transfer-worker.ts`:

Add the import and a module-level slot beside `sinks`:

```ts
import { createPeerProxy, type PeerProxy } from './peer-proxy.js';

/** The page-owned data connections this session negotiates through. */
let peers: PeerProxy | undefined;
```

Inside `case 'init'`, next to the sink proxy construction:

```ts
          peers?.closeAll('the session was restarted');
          peers = createPeerProxy(post);
```

and extend the options object handed to `Session.create` / `Session.join`:

```ts
          const options = {
            saveCapability, createSink: sinks.createSink, forceTransport, device,
            // `available` is the PAGE's answer — this realm has no
            // RTCPeerConnection to ask, which is the bug this whole change
            // fixes. See SessionOptions.webrtc.
            webrtc: { available: msg.webrtcAvailable ?? false, createTransport: peers.createTransport },
          };
```

Route peer replies at the top of the message handler, beside the `sink-result` case:

```ts
        // The page answering this worker's peer RPC. Routed before anything
        // else touches it: these never reach the Session.
        default:
          if (peers?.handle(msg)) return;
          return;
```

Place this as the final `default` of the existing switch rather than a new one, so a peer message never falls through to the Session.

In `case 'close'`, alongside `sinks?.rejectAll(...)`:

```ts
          peers?.closeAll('the session was closed');
          peers = undefined;
```

- [ ] **Step 4: Wire the page**

In `client/hooks/useSession.ts`, inside the mount effect beside `createSinkHost`:

```ts
    const peerHost = createPeerHost({ post: (result, transfer) => client.post(result, transfer) });
```

Route it first in the message handler, next to `host.handle(msg)`:

```ts
      // The page's half of the worker's peer proxy — requests, not events.
      if (peerHost.handle(msg)) return;
```

Add `webrtcAvailable` to the `init` post:

```ts
        // Answered here because this is the realm that would actually host
        // the connection. Asking inside the worker — which is what the code
        // used to do — always answers "no": RTCPeerConnection is
        // [Exposed=Window].
        webrtcAvailable: typeof RTCPeerConnection !== 'undefined',
```

Add the matching field to `ToWorker`'s `init` variant in `client/worker/messages.ts`:

```ts
    /**
     * Whether the PAGE can host an RTCPeerConnection. The worker cannot
     * answer this for itself — RTCPeerConnection is [Exposed=Window] — and
     * for the whole life of the project it tried to, which is why the
     * upgrade never ran.
     */
    webrtcAvailable?: boolean;
```

And tear it down in the effect cleanup, before `client.terminate()`:

```ts
      peerHost.closeAll();
```

Verify `WorkerClient.post` accepts a transfer list; if it does not, add the optional second parameter and forward it to `postMessage`.

- [ ] **Step 5: Run everything**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
```

Expected: PASS. `tests/ui/fake-worker.ts` may need `post` to accept a second argument; update the stub to match the real signature.

- [ ] **Step 6: Commit**

```bash
git add client/worker/transfer-worker.ts client/hooks/useSession.ts client/worker/messages.ts tests/integration/peer-proxy-transport.test.ts tests/ui/fake-worker.ts
git commit -m "feat(transport): route the WebRTC data path through a page-owned connection

The worker builds a proxy factory and the page hosts the real
RTCPeerConnection. Session keeps the key and every AES-GCM operation and
never learns its transport is a proxy."
```

---

### Task 7: The test that was missing

Every existing test of this subsystem either stubs `RTCPeerConnection` into a realm that has none, or pins `?forceTransport=relay`. Neither can observe the bug. This one runs a real browser with real realms.

**Files:**
- Create: `tests/e2e/direct-transport.spec.ts`
- Modify: `README.md` (testing section)

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/direct-transport.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { closePair, pair } from './helpers.js';

/*
 * The regression test for the bug that made this whole change necessary.
 *
 * Session runs in a dedicated Web Worker. RTCPeerConnection is
 * [Exposed=Window], so the upgrade guard in client/session.ts was always true
 * and the WebRTC data path never ran once in production — every session was
 * permanently relayed and the Direct badge was unreachable.
 *
 * No unit or integration test could catch that: they stub RTCPeerConnection
 * into a realm that has one, which proves the negotiation algorithm and says
 * nothing about availability. Only a real browser, with a real worker realm
 * and no stubs, can. Both contexts here are on loopback, where a host
 * candidate pair is immediate — if this is ever Relayed, the upgrade is
 * broken again.
 */
test('the data path actually upgrades to a direct connection', async ({ browser }) => {
  // No forceTransport: the whole point is the unpinned, default path.
  const session = await pair(browser);
  try {
    await expect(session.host.page.getByText(/^direct$/i)).toBeVisible({ timeout: 20_000 });
    await expect(session.guest.page.getByText(/^direct$/i)).toBeVisible({ timeout: 20_000 });
  } finally {
    await closePair(session);
  }
});

test('a file crosses byte-identically once the path is Direct', async ({ browser }) => {
  const fixture = makeFixture(3 * 1024 * 1024);
  const session = await pair(browser);
  const { host, guest } = session;

  try {
    // Asserted BEFORE the transfer, not after: this is what separates this
    // test from the existing 'auto' case in transfer.spec.ts, which sends the
    // same bytes but deliberately never checks which transport carried them —
    // and therefore passed happily throughout the entire period WebRTC was
    // dead.
    await expect(host.page.getByText(/^direct$/i)).toBeVisible({ timeout: 20_000 });

    const downloadPromise = guest.page.waitForEvent('download', { timeout: 45_000 });
    await host.page.getByRole('button', { name: /choose files/i }).click();
    await host.page.locator('input[type="file"]').setInputFiles(fixture.path);

    const download = await downloadPromise;
    const savedPath = await download.path();
    expect(savedPath).not.toBeNull();
    expect(Buffer.compare(readFileSync(savedPath!), fixture.bytes)).toBe(0);
  } finally {
    await closePair(session);
  }
});
```

The imports this file needs, matching `tests/e2e/transfer.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { closePair, makeFixture, pair } from './helpers.js';
```

Note what already exists and why it was not enough: `transfer.spec.ts` runs its
transfer twice, once with `forceTransport=relay` and once on `'auto'` — and its
own comment says the assertion "only checks the bytes, never which transport
carried them". That is a defensible choice for a byte-integrity test on an
unknown network, and it is also precisely why the dead upgrade survived. The
tests above add the missing half rather than replacing it.

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx playwright test tests/e2e/direct-transport.spec.ts
```

Expected before Tasks 1–6: FAIL — the badge reads `Relayed` forever. Expected after: PASS.

If it fails *after* the earlier tasks, the upgrade is genuinely not connecting; debug with `?forceTransport=` removed and the browser console open before weakening the assertion. **Do not** relax this test to accept `Relayed` — that is the exact failure it exists to catch.

- [ ] **Step 3: Run the whole e2e suite**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run test:e2e
```

Expected: PASS, 16 tests. The existing accessibility suite pins `forceTransport=relay` and is unaffected. One caveat recorded in `playwright.config.ts`: a fresh browser context occasionally stalls on a loaded machine — re-run once before investigating a single failure.

- [ ] **Step 4: Document it**

In `README.md`, in the testing section, after the sentence describing what the e2e suite covers, add:

```markdown
One of those e2e tests exists for a specific reason: `direct-transport.spec.ts`
asserts the transport badge actually reaches **Direct** on the default path.
`Session` runs in a Web Worker and `RTCPeerConnection` is `[Exposed=Window]`,
so an upgrade guard that asks its own realm silently disables WebRTC
everywhere — which is exactly what the guard did from the moment it was
written, undetected until this test existed. Unit tests stub
`RTCPeerConnection` into a realm that has one, which proves the negotiation
algorithm and nothing about availability. Only a real browser can tell you
the difference.
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/direct-transport.spec.ts README.md
git commit -m "test(e2e): assert the data path actually reaches Direct

The regression test for a bug no unit test could see: stubbing
RTCPeerConnection into a realm that has one proves the negotiation algorithm
and says nothing about whether the realm that runs Session has one. It did
not, so WebRTC never ran. Two loopback contexts, no forceTransport, no stubs."
```

---

## Verification

After Task 7, all of the following must pass from a clean tree:

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck     # clean
npm test              # 760+ passing
npm run test:e2e      # 16 passing, including Direct reachability
npm run build         # clean
```

And one manual check that no automated test covers: open the app in two browser windows, pair them, and confirm the badge reads **Direct** and a file still transfers. If the badge reads Relayed on a machine where both windows are on loopback, this plan has not achieved its goal regardless of what the suite says.

## What this plan deliberately does not do

- No UI change. The session layout restructure is plan 02.
- No TURN. `DataPeer` is STUN-only by design (spec §4 D2), and TURN infrastructure is plan 03.
- No media. `MediaPeer`, `getUserMedia`, `getDisplayMedia` and the live section are plan 04.
- No deletion of `WebRTCTransport` or `upgrade.ts`. Both were correct all along; only the realm they were constructed in was wrong.

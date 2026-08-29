# Live Camera and Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One live video stream per session — camera or screen, either direction — that the other device watches. View-only: nothing is recorded, saved, or added to the transfer record.

**Architecture:** A second, page-owned `RTCPeerConnection` carrying media tracks only, configured with STUN **plus** TURN fetched from `GET /turn`. Its SDP and ICE travel as **sealed control frames** over the existing encrypted channel, not as plaintext relay signals — by the time anyone can press Share, that channel exists, so the relay never learns the media candidates. The file path is untouched: `DataPeer` stays STUN-only and multi-gigabyte transfers never land on metered TURN.

**Tech Stack:** TypeScript 5.6, React 19, Tailwind 4, Vite 6, Vitest 3, Playwright with Chromium's fake media devices.

**Spec:** [`docs/superpowers/specs/2026-08-27-live-media-and-session-layout-design.md`](../specs/2026-08-27-live-media-and-session-layout-design.md) — §5 (media signalling, `MediaPeer`, arbitration), §6 (the Live section and its states), §7 (error handling), §9 phase 4.

**Plan 04 of 4, and the largest.** Plans 01–03 are merged: the WebRTC data path runs, the session screen has a marked slot for the Live section, and the relay mints TURN credentials.

**It splits cleanly at Task 5 if you want two merges.** Tasks 1–5 are plumbing and change nothing a user sees — two peers can establish a media connection with a synthetic track, provable by tests, with no UI at all. Tasks 6–8 are capture and surface. Shipping the first half alone is a coherent, reviewable change; shipping the second half without the first is not.

## Global Constraints

- Node **≥ 22**. On this machine `node` is not on the default `PATH`; prefix commands with `export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"`.
- **Media bytes never enter the worker and never touch the session key.** They are SRTP between two `RTCPeerConnection`s. The worker seals the *signalling*, nothing else.
- **The peer's SDP and ICE are attacker-controlled.** `decodeControl` is an unvalidated `JSON.parse` cast and the peer holds the same key, so every field reaching `setRemoteDescription` or `addIceCandidate` must be whitelisted into a fresh object first. House pattern: `parseSignal` in `client/transport/webrtc.ts`, `parseServerSignal` in `shared/signals.ts`, `parseDeviceInfo` in `shared/device.ts`.
- **Releasing the camera is a privacy obligation, not cleanup.** Every path that ends a share must call `stop()` on every track, or the browser's recording indicator stays lit on a session the user believes is over.
- **The local preview is always muted** (`<video muted>`). Camera carries the microphone, and both devices are usually in one room — an unmuted preview is a feedback loop.
- `AGENTS.md` is binding: honour `prefers-reduced-motion`; hit targets ≥44px on mobile; icon-only controls carry `aria-label`; design empty/error states rather than discovering them; no dead ends.
- **A live-media failure is never a transfer error.** Nothing in this plan writes
  to `session.error` or surfaces through the transfer error path (spec §7). A
  refused camera permission rendering as a red "transfer failed" banner is a
  lie about what happened, and it is the natural thing to fall into because
  `useSession` already has an error channel sitting right there.
- **The file path must not change.** `DataPeer` stays STUN-only (spec §4 D2). If a test in `tests/integration/` or `tests/e2e/transfer.spec.ts` changes behaviour, something is wrong.
- This codebase's commenting standard is unusually high — doc comments explain *why*, at length, including rationale for rejected alternatives.
- Conventional commit messages. Commit after every task.
- Baseline: 842 tests across 67 files, `npm run typecheck` clean, `npm run build` succeeding, e2e 18 passing.

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/media-signal.ts` *(create)* | Media signal wire types and the whitelist parser for peer-supplied SDP/ICE |
| `shared/messages.ts` *(modify)* | Four `ControlMessage` variants carrying media signalling |
| `client/transfer/sender.ts`, `receiver.ts`, `client/session.ts` *(modify)* | Send, receive and surface those frames |
| `client/worker/messages.ts`, `transfer-worker.ts`, `client/hooks/useSession.ts` *(modify)* | Media signalling across the worker boundary, both directions |
| `client/media/ice.ts` *(create)* | Fetch `GET /turn`, merge with the build-time STUN list, fail soft |
| `client/media/media-peer.ts` *(create)* | The page-owned media `RTCPeerConnection`: offer/answer, trickle ICE, tracks |
| `client/media/live-session.ts` *(create)* | The single live slot: who owns it, glare, teardown |
| `client/media/capture.ts` *(create)* | `getUserMedia` / `getDisplayMedia` and track lifetime |
| `client/ui/LiveSection.tsx` *(create)* | The Live region and every state in spec §6 |
| `client/screens/TransferPanel.tsx` *(modify)* | Renders it in the slot already marked for it |
| `tests/e2e/live-media.spec.ts` *(create)* | Two contexts, fake devices, a real track arriving |

---

### Task 1: Media signal wire types and their whitelist parser

**Files:**
- Create: `shared/media-signal.ts`
- Modify: `shared/messages.ts`
- Test: `tests/unit/media-signal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MediaKind = 'camera' | 'screen';
  export interface MediaOffer { sdp: string; kind: MediaKind }
  export interface MediaAnswer { sdp: string }
  export interface MediaIce { candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  export function parseMediaOffer(value: unknown): MediaOffer | undefined;
  export function parseMediaAnswer(value: unknown): MediaAnswer | undefined;
  export function parseMediaIce(value: unknown): MediaIce | undefined;
  ```
  and on `ControlMessage`: `media-offer`, `media-answer`, `media-ice`, `media-stop`,
  plus the narrowed union every later task passes around:
  ```ts
  // In shared/messages.ts, beside the ControlMessage union it selects from.
  export type MediaControl = Extract<ControlMessage, { t: `media-${string}` }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/media-signal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseMediaAnswer, parseMediaIce, parseMediaOffer } from '../../shared/media-signal.js';

const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n';

describe('parseMediaOffer', () => {
  it('keeps a well-formed offer', () => {
    expect(parseMediaOffer({ sdp: SDP, kind: 'camera' })).toEqual({ sdp: SDP, kind: 'camera' });
    expect(parseMediaOffer({ sdp: SDP, kind: 'screen' })?.kind).toBe('screen');
  });

  /*
   * The peer holds the same session key, so a sealed frame proves only that
   * the OTHER BROWSER sent it — not that its contents are sane. Everything
   * here reaches setRemoteDescription, and `decodeControl` is a bare
   * JSON.parse cast with no runtime validation at all.
   */
  it('rejects anything that is not an object with a string sdp', () => {
    for (const bad of [null, undefined, 'sdp', 42, [], {}, { sdp: 42, kind: 'camera' }]) {
      expect(parseMediaOffer(bad)).toBeUndefined();
    }
  });

  it('rejects an unrecognised kind rather than defaulting one', () => {
    // A default would mean a peer could make the UI say "camera" while
    // sending a screen — a small lie, but one the user reads as a fact.
    expect(parseMediaOffer({ sdp: SDP, kind: 'microphone' })).toBeUndefined();
    expect(parseMediaOffer({ sdp: SDP })).toBeUndefined();
  });

  it('drops unexpected fields rather than passing them through', () => {
    const parsed = parseMediaOffer({ sdp: SDP, kind: 'camera', evil: true }) as Record<string, unknown>;
    expect(parsed).toEqual({ sdp: SDP, kind: 'camera' });
    expect('evil' in parsed).toBe(false);
  });

  /*
   * An SDP is bounded in practice by what a browser generates — a few
   * kilobytes. A peer that sends megabytes is not negotiating.
   */
  it('rejects an implausibly large sdp', () => {
    expect(parseMediaOffer({ sdp: 'v=0\r\n'.repeat(100_000), kind: 'camera' })).toBeUndefined();
  });
});

describe('parseMediaIce', () => {
  // usernameFragment is carried through deliberately, not stripped: a
  // browser uses it to bind a candidate to the ICE generation it was
  // gathered for, so keeping it is what lets the receiving side recognise
  // a candidate from an abandoned attempt as stale after glare, rather
  // than misapplying it (see shared/media-signal.ts and
  // tests/unit/media-signal.test.ts's own doc comments for the shipped
  // version of this test).
  it('keeps the four fields addIceCandidate reads', () => {
    const parsed = parseMediaIce({
      candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host',
      sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc123',
    });
    expect(parsed).toEqual({
      candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc123',
    });
  });

  it('tolerates the optional fields being absent', () => {
    expect(parseMediaIce({ candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host' }))
      .toEqual({ candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host' });
  });

  it('rejects a non-string candidate or wrong-typed optionals', () => {
    expect(parseMediaIce({ candidate: 42 })).toBeUndefined();
    expect(parseMediaIce({ candidate: 'c', sdpMid: 42 })).toBeUndefined();
    expect(parseMediaIce({ candidate: 'c', sdpMLineIndex: 'x' })).toBeUndefined();
  });
});

describe('parseMediaAnswer', () => {
  it('keeps a string sdp and nothing else', () => {
    expect(parseMediaAnswer({ sdp: SDP, kind: 'camera' })).toEqual({ sdp: SDP });
  });
  it('rejects a missing or non-string sdp', () => {
    expect(parseMediaAnswer({})).toBeUndefined();
    expect(parseMediaAnswer({ sdp: 42 })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/unit/media-signal.test.ts
```

Expected: FAIL — `shared/media-signal.ts` does not exist.

- [ ] **Step 3: Implement the parser**

Create `shared/media-signal.ts`. Follow `shared/device.ts`'s `parseDeviceInfo` for structure and comment depth — same job, same threat model. Each parser constructs a **fresh** object from known-good fields; none casts.

Cap the SDP at something defensible (say 64 KB) and say why in a comment: a browser-generated SDP is a few kilobytes, and this value is sealed but peer-authored.

- [ ] **Step 4: Add the wire types**

In `shared/messages.ts`, on `ControlMessage`:

```ts
  /*
   * Live media negotiation, sealed like every other control frame.
   *
   * Sealed rather than sent as plaintext `{t:'rtc'}` relay signals — which
   * is how the DATA connection negotiates — for a reason that only applies
   * to media: nobody can press Share before the session is paired, so the
   * encrypted channel always exists first. Sending media SDP through it
   * costs nothing and denies the relay the media candidates entirely. The
   * data channel has no such luxury; it is what is being bootstrapped.
   *
   * Everything in these is attacker-controlled — see shared/media-signal.ts,
   * which is the only sanctioned way to turn one of these payloads into
   * something handed to a peer connection.
   */
  | { t: 'media-offer'; offer: MediaOffer }
  | { t: 'media-answer'; answer: MediaAnswer }
  | { t: 'media-ice'; ice: MediaIce }
  | { t: 'media-stop' }
```

- [ ] **Step 5: Run the suite and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
git add shared/media-signal.ts shared/messages.ts tests/unit/media-signal.test.ts
git commit -m "feat(shared): sealed media signalling types and their whitelist parser"
```

---

### Task 2: Carry media signals through the session and the worker boundary

Pure plumbing: the frames exist, nothing produces or consumes them yet.

**Files:**
- Modify: `client/transfer/sender.ts` (a `sendMediaSignal`, beside `sendDevice`)
- Modify: `client/transfer/receiver.ts` (four cases in `#handleControl`, parsed before they escape)
- Modify: `client/session.ts` (`SessionEvents.onMediaSignal`, and a `sendMediaSignal` method)
- Modify: `client/worker/messages.ts` (`ToWorker` `send-media-signal`, `FromWorker` `media-signal`)
- Modify: `client/worker/transfer-worker.ts`, `client/hooks/useSession.ts`
- Test: `tests/integration/media-signalling.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/media-signalling.test.ts`, modelled on `tests/integration/device-exchange.test.ts` — two real `Session`s over a real relay:

```ts
it('carries a media offer between peers, sealed', async () => {
  const url = await start();
  const host = await Session.create(url);
  const guest = await Session.join(url, host.code, new URL(host.shareUrl).hash.slice(1));

  let seen: unknown;
  guest.events.onMediaSignal = (signal) => { seen = signal; };

  await host.sendMediaSignal({ t: 'media-offer', offer: { sdp: SDP, kind: 'camera' } });
  await waitFor(() => seen !== undefined);
  expect(seen).toEqual({ t: 'media-offer', offer: { sdp: SDP, kind: 'camera' } });

  host.close(); guest.close();
}, 20_000);

/*
 * The claim in shared/messages.ts, tested rather than asserted: media SDP
 * must never appear in the clear on the wire. Same discipline as
 * device-exchange.test.ts, which does this for the device panel.
 */
it('never puts media sdp on the wire in the clear', async () => {
  // Follow device-exchange.test.ts's raw-peer harness: join with a bare
  // socket, capture every binary frame, send a hello so the host proceeds,
  // then assert no frame contains the SDP as plaintext bytes.
});

it('drops a malformed offer instead of surfacing it', async () => {
  // A peer can put anything in a sealed frame. Deliver a media-offer whose
  // sdp is a number and assert onMediaSignal never fires.
});
```

Read `tests/integration/device-exchange.test.ts` and reuse its `start`, `waitFor` and raw-peer helpers rather than writing new ones.

- [ ] **Step 2: Run it, then implement**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npx vitest run tests/integration/media-signalling.test.ts
```

Then wire it through, mirroring how `device` already flows end to end — read that path first; it is the same shape and it works:

- `Sender.sendMediaSignal(msg)` → `#sendControl(msg)`.
- `Receiver`'s `#handleControl` gains the four cases. **Parse before emitting**: `parseMediaOffer` / `parseMediaAnswer` / `parseMediaIce`, and drop silently on failure exactly as the `device` case does. `media-stop` has no payload to validate.
- `SessionEvents.onMediaSignal?: (signal: MediaControl) => void`, wired in `#startReceiver` beside `onPeerDevice`.
- `Session.sendMediaSignal(msg)` awaits the handshake like `sendText` does, then delegates to the Sender.
- Worker: `ToWorker` `{ t: 'send-media-signal'; signal: MediaControl }`, `FromWorker` `{ t: 'media-signal'; signal: MediaControl }`, both routed in `transfer-worker.ts`, and `useSession` exposing `sendMediaSignal` plus an `onMediaSignal` subscription the next tasks consume.

- [ ] **Step 3: Verify the file path is untouched, then commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test && CI=1 npm run test:e2e
git add -A
git commit -m "feat(session): carry sealed media signalling across the worker boundary"
```

The e2e run matters here: this task touches `Sender`, `Receiver` and `Session`, which the file path depends on. If a transfer test changes behaviour, stop.

---

### Task 3: ICE configuration for media

**Files:**
- Create: `client/media/ice.ts`
- Modify: `client/transport/webrtc.ts` (one comment; see below)
- Test: `tests/unit/media-ice.test.ts`

**Interfaces:**
- Produces: `export async function mediaRtcConfig(): Promise<RTCConfiguration>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/media-ice.test.ts` covering:
- a successful `GET /turn` merges the returned `iceServers` **after** the build-time STUN list;
- an empty `{ iceServers: [], ttl: 0 }` (TURN not configured) yields a STUN-only config and **does not throw** — running without TURN is supported;
- a rejected fetch, a non-200, and malformed JSON all degrade to STUN-only rather than failing the share;
- the response is whitelisted, not cast: an entry with a non-string `urls`, or a missing `username`, is dropped.

Stub `fetch` with `vi.stubGlobal`.

- [ ] **Step 2: Implement**

```ts
import { defaultRtcConfig } from '../transport/webrtc.js';

/**
 * ICE servers for the MEDIA connection: the build-time STUN list plus
 * whatever `GET /turn` offers.
 *
 * Fetched lazily, per share attempt, rather than at pairing — an idle
 * session makes no request, and a credential is never older than the click
 * that needed it (they are short-lived by design; see server/turn.ts).
 *
 * Every failure degrades to STUN-only instead of failing the share. A
 * deployment with no TURN configured is supported and common — on a LAN the
 * two devices connect over host candidates without needing either — so an
 * unreachable or unconfigured endpoint must not be the thing that stops
 * someone sharing their screen to the laptop next to them.
 *
 * The response is whitelisted rather than cast, like every other value that
 * crosses a trust boundary here: it reaches `new RTCPeerConnection`, and a
 * malformed entry throws synchronously in Chrome and Firefox.
 */
export async function mediaRtcConfig(): Promise<RTCConfiguration> {
  const base = defaultRtcConfig().iceServers ?? [];
  try {
    const res = await fetch('/turn', { headers: { accept: 'application/json' } });
    if (!res.ok) return { iceServers: base };
    const body = (await res.json()) as unknown;
    return { iceServers: [...base, ...parseIceServers(body)] };
  } catch {
    return { iceServers: base };
  }
}
```

Write `parseIceServers` to accept only entries with a non-empty array of string `urls` plus string `username` and `credential`, and to return `[]` for anything else.

**Also fix a comment that is now half-true.** `defaultRtcConfig` in `client/transport/webrtc.ts` says *"No TURN: the WebSocket relay already covers the networks TURN would rescue."* That is the right call for the **data** path and wrong as a blanket statement now. Amend it to say the data path stays STUN-only deliberately (spec §4 D2 — a multi-gigabyte transfer must not land on metered TURN) and that media builds its own configuration here.

- [ ] **Step 3: Run and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
git add client/media/ice.ts client/transport/webrtc.ts tests/unit/media-ice.test.ts
git commit -m "feat(media): ICE configuration for the media path, STUN-only on failure"
```

---

### Task 4: `MediaPeer`

**Files:**
- Create: `client/media/media-peer.ts`
- Test: `tests/unit/media-peer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MediaPeerEvents {
    onSignal(signal: MediaControl): void;      // to seal and send
    onRemoteStream(stream: MediaStream): void;
    onClosed(reason: string): void;
  }
  export class MediaPeer {
    static async offer(stream: MediaStream, kind: MediaKind, events: MediaPeerEvents): Promise<MediaPeer>;
    static async answer(events: MediaPeerEvents): Promise<MediaPeer>;
    accept(signal: MediaControl): Promise<void>;
    close(): void;
  }
  ```

A media-only connection: tracks, no data channel. It is deliberately **not** built on `client/worker/peer-host.ts`, which exists to hand an `UpgradeTransport` to the worker — media never crosses that boundary.

- [ ] **Step 1: Write the failing test**

`tests/unit/media-peer.test.ts` with a fake `RTCPeerConnection` (the pattern is in `tests/integration/upgrade-fallback.test.ts`), covering:
- `offer()` adds every track from the stream and emits a `media-offer` carrying the local description and the kind;
- an inbound `media-answer` reaches `setRemoteDescription`. **`MediaPeer` does not
  parse.** Task 2 put the whitelist in the `Receiver`, so anything that reaches this
  class is already validated — these tests feed it `MediaControl` values directly.
  One trust boundary, not two: re-validating validated data buys no security, and
  two boundaries is how one drifts out of step with the other;
- trickled `media-ice` both ways: locally-gathered candidates are emitted as signals, inbound ones reach `addIceCandidate`;
- an inbound candidate arriving **before** the remote description does not throw — buffer it or rely on the browser's own queue, but pick one deliberately and say which;
- `close()` closes the connection, stops every local track, and fires `onClosed` exactly once;
- a connection state of `failed` fires `onClosed` with a usable reason.

- [ ] **Step 2: Implement**

Build it on the `MediaPeerEvents` seam above so the whole class is testable without a browser. Points to get right, each deserving a comment:

- **Every local track is stopped in `close()`.** The camera light is the user's only signal that sharing has ended.
- **`onClosed` fires exactly once**, whatever the path — explicit close, ICE failure, remote `media-stop`.
- **The offerer sets `RTCRtpTransceiver` direction to `sendonly`** and the answerer to `recvonly`: this is one-way by design (spec §3), and a `sendrecv` default would quietly negotiate a return stream nobody asked for and no UI shows.

- [ ] **Step 3: Run and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
git add client/media/media-peer.ts tests/unit/media-peer.test.ts
git commit -m "feat(media): MediaPeer, a one-way media-only peer connection"
```

---

### Task 5: The single live slot, and glare

**Files:**
- Create: `client/media/live-session.ts`
- Test: `tests/unit/live-session.test.ts`

A session has exactly one live slot. Both peers can press Share in the same instant and both will believe they own it.

**This is WebRTC's "perfect negotiation" glare problem, and `peerId` already gives us the polite/impolite roles it needs.** `a` is impolite and wins; `b` is polite and yields. A polite peer that receives an offer while its own is outstanding **abandons its own attempt — stopping its local tracks, releasing its camera — and answers the incoming one.** The impolite peer ignores the competing offer and continues. Deterministic, no new state on the wire, and it cannot deadlock.

**Interfaces:**
- Consumes: `MediaPeer` (Task 4), `MediaControl` (Task 1), `captureCamera`/`captureScreen` (Task 6)
- Produces:
  ```ts
  export type Slot =
    | { state: 'idle' }
    | { state: 'offering'; kind: MediaKind; peer: MediaPeer; stream: MediaStream }
    | { state: 'sending'; kind: MediaKind; peer: MediaPeer; stream: MediaStream }
    | { state: 'receiving'; kind: MediaKind; peer: MediaPeer; stream?: MediaStream };

  export interface LiveSessionEvents {
    onSlotChanged(slot: Slot): void;
    onSignal(signal: MediaControl): void;   // seal and send to the peer
    onFailure(failure: CaptureFailure | { reason: 'connect-failed' }): void;
  }

  export class LiveSession {
    constructor(peerId: 'a' | 'b', events: LiveSessionEvents);
    start(kind: MediaKind): Promise<void>;
    stop(): void;
    onMediaSignal(signal: MediaControl): Promise<void>;
    onPeerLeft(): void;
  }
  ```
  `Slot` is what `LiveSection` (Task 7) renders — every state in spec §6 is one
  variant of it, so a state the UI must show and this union cannot express is a
  bug in this task, not that one.

  `receiving.stream` is optional because it arrives asynchronously: we answer the
  offer, and the track shows up later via `MediaPeer`'s `onRemoteStream`. The gap
  between the two IS spec §6's connecting state, which the UI has to render anyway
  — so the optionality is the feature, not a hole to paper over with a placeholder
  stream.

- [ ] **Step 1: Write the failing test**

`tests/unit/live-session.test.ts` covering, with a fake `MediaPeer`:
- starting a share when the slot is free emits an offer and marks the slot owned locally;
- an inbound offer when the slot is free answers it and marks the slot owned remotely;
- **glare as `b`:** own offer outstanding, inbound offer arrives → own attempt abandoned, **local tracks stopped**, incoming offer answered;
- **glare as `a`:** own offer outstanding, inbound offer arrives → incoming ignored, own attempt continues;
- `media-stop` from the peer releases the slot and stops local tracks;
- starting a second share locally replaces the first, stopping its tracks;
- a peer leaving releases the slot.

The stopped-tracks assertions are the ones that matter. Every one of these paths can strand a live camera.

- [ ] **Step 2: Implement**

The whole of glare resolution is the `#offering` branch below. Everything else
is bookkeeping around it.

```ts
// `Slot` is the exported type from the Interfaces block above — one type, not
// a second internal one. It carries `peer`, which LiveSection ignores; a
// separate UI-facing shape would be two states to keep in step instead of one.
export class LiveSession {
  #slot: Slot = { state: 'idle' };

  /*
   * `a` is impolite and `b` is polite — WebRTC's perfect-negotiation roles,
   * assigned from the peerId we already have rather than from anything new
   * on the wire. Both sides compute the same answer with no round trip, so
   * simultaneous Share clicks resolve in one exchange and cannot deadlock.
   */
  readonly #polite: boolean;

  constructor(peerId: 'a' | 'b', /* … */) {
    this.#polite = peerId === 'b';
  }

  async onMediaSignal(signal: MediaControl): Promise<void> {
    if (signal.t !== 'media-offer') { /* answer / ice / stop — route to #slot.peer */ return; }

    if (this.#slot.state === 'offering') {
      /*
       * Glare: both peers claimed the slot in the same instant.
       *
       * The impolite peer ignores the incoming offer entirely and lets its
       * own complete — the polite peer is, at this same moment, giving way.
       * Answering here instead would leave both sides receiving and neither
       * sending.
       */
      if (!this.#polite) return;

      /*
       * The polite peer yields. `close()` stops our local tracks, which is
       * the part that matters beyond protocol correctness: we asked for the
       * camera a moment ago and are no longer going to use it, so the light
       * must go out rather than stay lit on a stream nobody receives.
       */
      this.#slot.peer.close();
      this.#slot = { state: 'idle' };
    } else if (this.#slot.state !== 'idle') {
      // An in-flight stream is replaced by the newcomer, per spec §3: one slot.
      this.#release();
    }

    /*
     * No parsing here. Task 2 put the whitelist in the Receiver, so a signal
     * that reaches this method has already been through it — a malformed one
     * was dropped and never became a MediaControl at all. Re-parsing would
     * suggest this is a second trust boundary; there is only the one.
     */
    const peer = await MediaPeer.answer(this.#events);
    this.#slot = { state: 'receiving', peer, kind: signal.offer.kind };
    await peer.accept(signal);
  }

  /** Every exit from a claimed slot funnels here, so tracks stop exactly once. */
  #release(): void {
    if (this.#slot.state === 'idle') return;
    this.#slot.peer.close();
    this.#slot = { state: 'idle' };
    this.#events.onSlotChanged(this.#slot);
  }
}
```

`start(kind)`, `stop()` and `onPeerLeft()` all route their teardown through
`#release()`. Resist giving any of them its own `close()` call: a second
teardown path is how one of these grows a branch that forgets the tracks.

- [ ] **Step 3: Run and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
git add client/media/live-session.ts tests/unit/live-session.test.ts
git commit -m "feat(media): one live slot, with polite/impolite glare resolution"
```

**This is the seam.** Everything up to here is invisible to a user and independently reviewable. If you are splitting this plan into two merges, stop and merge now.

---

### Task 6: Capture

**Files:**
- Create: `client/media/capture.ts`
- Test: `tests/unit/capture.test.ts`

**Interfaces:**
- Produces: `export async function captureCamera(): Promise<MediaStream>`, `export async function captureScreen(): Promise<MediaStream>`, and a typed failure the UI can render.

- [ ] **Step 1: Write the failing test**

Stub `navigator.mediaDevices`. Cover:
- camera requests **video and audio**; screen requests **video only** (spec §3 — screen audio is Chromium-only, tab-scoped and silently absent elsewhere, so a feature that behaves differently per browser is worse than one that does not exist);
- `NotAllowedError` becomes a typed "permission refused" the UI can phrase, not a raw DOM exception;
- `NotFoundError` (no camera at all) is distinguished from a refusal — the recovery differs;
- **the user ending a screen share from the browser's own chrome** fires `ended` on the video track, and the module surfaces that. This is the miss that leaves a UI claiming to share something the browser already stopped.

- [ ] **Step 2: Implement**

```ts
export type CaptureFailure =
  | { reason: 'denied' }        // the user said no, or policy said no for them
  | { reason: 'no-device' }     // there is no camera to permit
  | { reason: 'unsupported' }   // insecure context, or an older browser
  | { reason: 'failed'; detail: string };

export class CaptureError extends Error {
  constructor(readonly failure: CaptureFailure) { super(failure.reason); }
}

export async function captureCamera(): Promise<MediaStream> {
  // Camera carries the microphone (spec §3): a silent video call is a
  // surprise, and asking for both in one prompt is one interruption, not two.
  return request(() => navigator.mediaDevices.getUserMedia({ video: true, audio: true }));
}

export async function captureScreen(): Promise<MediaStream> {
  /*
   * Video only. Chromium can capture tab audio; Firefox and Safari cannot,
   * and neither can capture system audio on a whole-screen share. Requesting
   * it would mean the feature works on one browser and silently does nothing
   * on the others — worse than not offering it, because the user cannot tell
   * which they are getting.
   */
  return request(() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }));
}

async function request(fn: () => Promise<MediaStream>): Promise<MediaStream> {
  // `navigator.mediaDevices` is undefined outside a secure context — reading
  // through it without this check throws a TypeError that reads like a bug.
  if (!navigator.mediaDevices?.getUserMedia) throw new CaptureError({ reason: 'unsupported' });
  try {
    return await fn();
  } catch (err) {
    throw new CaptureError(classify(err));
  }
}

function classify(err: unknown): CaptureFailure {
  const name = err instanceof DOMException ? err.name : '';
  // NotAllowedError also covers the user dismissing the screen-picker, which
  // is a normal cancellation and must not be phrased as a permission problem.
  if (name === 'NotAllowedError' || name === 'SecurityError') return { reason: 'denied' };
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { reason: 'no-device' };
  return { reason: 'failed', detail: err instanceof Error ? err.message : String(err) };
}

/**
 * Fires when the stream ends without us ending it — overwhelmingly, the user
 * clicking Chrome's own "Stop sharing" bar, which no amount of UI state
 * tracking would otherwise notice. Without this the app keeps claiming to
 * share a screen the browser stopped feeding it.
 */
export function onStreamEnded(stream: MediaStream, cb: () => void): () => void {
  const track = stream.getVideoTracks()[0];
  if (!track) return () => {};
  track.addEventListener('ended', cb);
  return () => track.removeEventListener('ended', cb);
}
```

- [ ] **Step 3: Run and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test
git add client/media/capture.ts tests/unit/capture.test.ts
git commit -m "feat(media): camera and screen capture with typed failures"
```

---

### Task 7: `LiveSection`

**Files:**
- Create: `client/ui/LiveSection.tsx`
- Test: `tests/ui/live-section.test.tsx`, plus cases in `tests/ui/a11y.test.tsx`

Every state in spec §6, all of which must be reachable in the tests: idle (both buttons, one-stream note), sharing (local preview **muted**, mute-mic and stop controls), watching (remote video, volume, fullscreen, and the note that starting your own replaces theirs), connecting (with a Cancel that genuinely tears the attempt down), permission refused (recovery text naming the address bar, not a bare red line), and no-TURN.

**On no-TURN, follow the spec's amended §6, not its §3 summary:** the controls stay **active** with one line of caution, because a phone and a laptop on one wifi connect over host candidates without STUN or TURN, and refusing outright would break the app's most common setup to guard against the hotel-wifi case.

**Mute must reflect reality.** The control reads and writes
`MediaStreamTrack.enabled` on the live audio track — a UI-only mute flag that
drifts from the track is a hot mic the user believes is off:

```tsx
const audio = stream.getAudioTracks()[0];
const muted = audio ? !audio.enabled : true;

function toggleMute() {
  if (!audio) return;
  audio.enabled = !audio.enabled;
  // Track state is the source of truth; React state only mirrors it, because
  // the track can also be ended from outside this component.
  setMuted(!audio.enabled);
}
```

Screen shares have no audio track at all, so the control is absent rather than
disabled — a disabled mute button on a silent stream is a question the user
has to answer for themselves.

**A test must assert the constraint from the global list:** a refused
permission renders inside `LiveSection` and leaves `session.error`
untouched.

- [ ] **Step 1: Write the failing tests, implement, run**

Include `axe` audits for the populated and idle states in `tests/ui/a11y.test.tsx`, following the `DevicePanel` and `TransferRecord` entries already there.

- [ ] **Step 2: Commit**

```bash
git add client/ui/LiveSection.tsx tests/ui/live-section.test.tsx tests/ui/a11y.test.tsx
git commit -m "feat(ui): the Live section and its states"
```

---

### Task 8: Wire it in, and prove it in a browser

**Files:**
- Modify: `client/screens/TransferPanel.tsx`, `client/hooks/useSession.ts`
- Create: `tests/e2e/live-media.spec.ts`

`TransferPanel` already carries a comment marking exactly where the Live section goes — above the two-column grid, below the header — and says the gap was left so this could be inserted without moving anything. Put it there.

Per spec §6, Live is **absent when idle apart from its two buttons, and promotes above the columns while a stream runs**, collapsing back when it stops.

- [ ] **Step 1: The e2e test**

Chromium's fake devices make a real camera stream testable headlessly. Add to the Playwright launch options for this spec:

```
--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream
```

Assert, on two paired contexts:
- the sharer's local preview appears and its `<video>` is `muted`;
- **a real track arrives on the watcher** — assert on `video.readyState`/`videoWidth` becoming non-zero, not merely that an element exists;
- stopping the share removes the remote video on both sides;
- **a file transfer still completes while a stream is live** — the two connections must not interfere, which is the whole reason they are separate.

Screen capture headlessly is harder; if `--auto-select-desktop-capture-source` does not work reliably, cover camera in e2e and screen in unit tests, and **say so in your report** rather than leaving a gap unmentioned.

- [ ] **Step 2: Full verification, then commit**

```bash
export PATH="$HOME/.nvm/versions/node/v26.4.0/bin:$PATH"
npm run typecheck && npm test && npm run build && CI=1 npm run test:e2e
```

---

## Verification

Beyond the suites, two checks no test performs:

1. **Two real browser windows.** Pair, share a camera, confirm the other side sees it, mute and confirm the peer's audio actually stops, stop and confirm **the camera light goes out**. That last one is the privacy obligation and nothing automated proves it.
2. **A screenshot at 900px and 412px** with a stream live, confirming Live promotes above the columns and the layout holds on a phone.

## What this plan deliberately does not do

- **No recording.** Nothing is saved and nothing enters the transfer record (spec §3).
- **No second stream.** One slot; starting another replaces it.
- **No screen audio.** Chromium-only and tab-scoped; a feature that works differently per browser is worse than none.
- **No change to the file path.** `DataPeer` stays STUN-only and the WebSocket relay stays its baseline.

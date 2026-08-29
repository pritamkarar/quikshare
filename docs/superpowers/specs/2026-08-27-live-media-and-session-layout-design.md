# Live media and the session screen — Design Spec

**Date:** 2026-08-27
**Status:** Approved design, pending implementation plan
**Supersedes:** §5 "The transport seam" and §11 "UI / Screens" of
[`2026-08-25-soja-share-design.md`](2026-08-25-soja-share-design.md), which
this document amends rather than replaces.

## 1. Problem

Two problems, discovered together, that turn out to have one cause.

**The session screen has outgrown its layout.** Everything a paired session can
do — drop a file, paste a note, watch a transfer, see which devices are on the
call — is a single vertical run of components in one 672px column. There is no
separation between *starting* something and *reviewing* what has already
happened, so the record of what crossed is interleaved with the controls that
made it cross, and both compete for the same narrow strip.

**Live camera and screen sharing do not exist,** and adding them exposes the
second problem: the WebRTC subsystem this app already ships has never run.

`Session` is constructed inside a dedicated Web Worker. `RTCPeerConnection` is
`[Exposed=Window]` — it does not exist in a worker realm. `client/session.ts`
guards the upgrade on exactly that:

```ts
#startUpgrade(): void {
  if (typeof RTCPeerConnection === 'undefined' || this.#forceTransport === 'relay') return;
```

The guard is always true. `#startUpgrade` returns immediately on every session,
in every browser. **Every production session has been permanently relayed**, the
`Direct` badge is unreachable, and `client/transport/webrtc.ts` and
`client/transport/upgrade.ts` are inert at runtime.

Measured on the app's own origin:

| realm | `RTCPeerConnection` | `MediaStream` |
| --- | --- | --- |
| Window | `function` | `function` |
| dedicated worker | `undefined` | `undefined` |

Corroborated by two browser contexts paired over `127.0.0.1`, where a
host-candidate pair is trivial, still reporting **Relayed**.

**Why the test suite is green.** `tests/integration/upgrade-fallback.test.ts`
stubs a fake `RTCPeerConnection` onto the global, exercising the negotiation in
a realm where one exists — it proves the algorithm, never the availability. The
Playwright suite pairs with `?forceTransport=relay` and so never asserts that
`Direct` is reachable at all. Neither layer was wrong about what it tested; no
layer tested the thing that broke.

`getUserMedia`, `getDisplayMedia` and `RTCPeerConnection` are all Window-only,
so live media must be page-owned regardless. The bug fix and the feature
enabler are the same move, which is why they are one spec.

## 2. Goals

- Restructure the connected session screen into distinct regions: what you
  **start**, what is **live**, what has **crossed**, and what you are **paired
  with**.
- One live video stream per session — camera or screen, either direction —
  viewable but never recorded.
- Make the WebRTC data path actually run, so `Direct` becomes reachable and
  honest.
- Keep multi-gigabyte file transfers off metered TURN.
- Keep every AES-GCM operation and the session key inside the worker.
- Meet every MUST in `AGENTS.md`.

## 3. Non-goals

- Recording, saving or transcoding a live stream. Nothing about it is written
  to disk or enters the transfer record.
- More than one concurrent stream. Starting a second replaces the first.
- Screen-share system audio. Chromium-only, tab-scoped and silently absent
  elsewhere; a feature that works differently per browser is worse than one
  that does not exist.
- More than two peers. Unchanged from the original spec.
- Guaranteeing live video with no TURN deployed. Without TURN it is attempted
  anyway and often succeeds — see §6 — but nothing is promised.

## 4. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Two peer connections, both page-owned | Per-connection ICE policy is the only granularity available; files and video need different policies |
| D2 | `DataPeer` uses STUN only, never TURN | A 4 GB transfer must not become a metered TURN bill; the WebSocket relay already covers those networks |
| D3 | `MediaPeer` uses STUN + TURN | Video has no relay fallback, so it needs TURN to be reliable |
| D4 | Relay WebSocket stays in the worker | It works there; moving it would be churn with no benefit |
| D5 | Media SDP/ICE travel as sealed control frames | The encrypted channel already exists by the time anyone shares; the relay never learns media candidates |
| D6 | Data SDP/ICE stay plaintext relay signals | The data channel cannot bootstrap itself; unchanged from today |
| D7 | TURN credentials minted by the relay, short-lived | A shared secret in a client bundle is a public secret |
| D8 | Camera carries the microphone; screen does not | "Point at this and talk about it" is the camera's use; screen audio is not portable |
| D9 | Notes become rows in the transfer record | A note is something that was sent or received; it belongs where the record is |
| D10 | Transport fix ships before any UI or media work | It touches the most delicately-reasoned code in the repo; a mixed change makes a resume regression unattributable |

### Why two peer connections rather than one

One connection carrying both the data channel and the media tracks is simpler:
one negotiation, one failure mode, less code. It was rejected because
`iceTransportPolicy` and ICE server configuration are properties of the
*connection*, not of a track. A single connection with TURN configured can
relay file bytes through TURN whenever the direct path fails — which is exactly
the network condition TURN exists for, and exactly the case where this app is
most likely to be moving something large.

Two connections cost a second negotiation and a second set of failure states.
They buy a guarantee that is otherwise unavailable: **file bytes never touch
TURN.** On the networks where TURN matters, files fall back to the WebSocket
relay the operator already runs, and only video — bounded, low-rate, and
abandoned the moment the user stops watching — consumes metered bandwidth.

### Why media signalling is sealed and data signalling is not

An SDP offer enumerates the sender's ICE candidates: local addresses, reflexive
addresses, and the ports behind them. Today the relay sees all of that for the
data connection, and must, because the data channel is what is being
bootstrapped — there is no encrypted path yet.

Media is different. Nobody can click "Share camera" before the session is
paired, so the sealed control channel is always available first. Sending media
negotiation through it costs nothing and denies the relay the media candidates
entirely. This is the same reasoning that put device info in a sealed frame
rather than on the plaintext hello.

## 5. Architecture

The forcing constraint: `RTCPeerConnection`, `getUserMedia` and
`getDisplayMedia` are Window-only. Anything touching them lives on the page.
Anything touching plaintext or the key stays in the worker.

```
PAGE (main thread)                          WORKER
─────────────────────────────────────       ────────────────────────────
useSession        ◄── events ──────────     Session
sink host         ◄── sink RPC ────────►      Sender / Receiver (AES-GCM)
                                              RelayTransport (WebSocket)   ← stays
DataPeer   (RTCPeerConnection, STUN)          SwitchableTransport
  └ data channel  ◄── frame RPC ───────►      └ ProxyTransport             ← new
MediaPeer  (RTCPeerConnection, STUN+TURN)
  └ camera / screen tracks — never crosses into the worker
```

**What moves.** Only the WebRTC *data* transport changes realm. The page owns
the real `RTCPeerConnection`; the worker holds `ProxyTransport`, which satisfies
the existing `Transport` interface (`send` / `onMessage` / `onDrain` /
`onClose` / `bufferedAmount` / `close`) and forwards frames across
`postMessage` as transferable `ArrayBuffer`s — a pointer move, not a copy.

**What does not move.** `SwitchableTransport`, `Sender`, `Receiver`, the
reconnect logic and the resume machinery are unchanged. The seam they see is
the same `Transport` interface it has always been. This is the pattern the
codebase already uses for save sinks, where the page owns a resource the worker
cannot construct and answers RPC for it.

**When negotiation starts.** `DataPeer` is attempted automatically once a peer
is present, on the same `peer-joined` trigger `#startUpgrade` uses today — the
trigger is unchanged, only the realm it runs in. `MediaPeer` is built lazily,
on the first share attempt, and torn down when the slot is released.
`?forceTransport=relay` keeps suppressing the data upgrade and, for the first
time, will actually have something to suppress; it does not affect media.

**Signalling paths.**

| Traffic | Path | Visible to relay |
| --- | --- | --- |
| File bytes | Sealed in the worker → WebSocket relay, or the data channel once `DataPeer` connects | Ciphertext only |
| Data SDP / ICE | Plaintext `{t:'rtc'}` relay signals | Yes, unavoidably |
| Media SDP / ICE | Sealed control frames | No |
| Media bytes | Page → page over `MediaPeer`, SRTP | No |

### New wire types

Added to `ControlMessage` in `shared/messages.ts`, sealed like every other
control frame:

```ts
| { t: 'media-offer';  sdp: string }
| { t: 'media-answer'; sdp: string }
| { t: 'media-ice';    candidate: string; sdpMid?: string; sdpMLineIndex?: number }
| { t: 'media-stop' }
```

Every one of these is attacker-controlled — `decodeControl` is an unvalidated
`JSON.parse` cast, and the payload reaches `setRemoteDescription` and
`addIceCandidate`. They are whitelisted into fresh objects by a parser in
`shared/media-signal.ts` following the discipline `parseSignal` in
`client/transport/webrtc.ts` already uses, before anything is handed to the
platform.

### One-slot arbitration

A session has exactly one live slot. Both peers can press Share at the same
instant, and both will believe they own it.

Each `media-offer` carries no explicit sequence; the tie is broken on the
existing peer id, which is already unique and already agreed: **`a` wins.** A
peer that receives an offer while its own offer is outstanding, and whose id is
`b`, abandons its own attempt (stopping its local tracks, releasing the camera)
and accepts the incoming one. `a` ignores the competing offer and continues.
This is deterministic, needs no new state on the wire, and cannot deadlock.

`media-stop` releases the slot explicitly. A peer that leaves releases it
implicitly, via the existing `peer-left` path.

### TURN credentials

`GET /turn` on the relay returns coturn's standard REST credentials:

```
username:   <unix-expiry>:quikshare
credential: base64(HMAC-SHA1(TURN_SECRET, username))
ttl:        600
urls:       from TURN_URLS
```

`TURN_SECRET` never reaches the client. The endpoint is necessarily
unauthenticated, so it gets a token bucket keyed by client IP alongside the
existing `create` / `join` / `rtc` limiters. With `TURN_SECRET` or `TURN_URLS`
unset it returns an empty server list, and `MediaPeer` is built with STUN
alone (§6).

It is fetched lazily, on the first share attempt of a session rather than at
pairing — an idle session makes no request, and a credential is never older
than the click that needed it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TURN_URLS` | unset | Comma-separated TURN URIs. Unset disables live media. |
| `TURN_SECRET` | unset | Shared secret for REST credentials. Never sent to a client. |
| `TURN_TTL_SECONDS` | `600` | Credential lifetime. |

## 6. The session screen

Four regions. Desktop places Share and Transfers side by side; Live and Devices
span the full width. Phone is one column in the same order.

```
┌─ header: logo · Quik Share ······················· GitHub ─┐
├────────────────────────────────────────────────────────────┤
│  Connected                        [End session] [⇄ Direct] │
│                                                            │
│  ┌─ Live ───────────────────────────────────────────────┐  │  ← only while
│  │            their screen — live                       │  │    a stream runs
│  │            [🔇 Mute] [⛶] [Stop sharing]              │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌─ Share ──────────────┐  ┌─ Transfers ───────────────┐   │
│  │ [ drop files ]       │  │ (All)(Sent)(Received)     │   │
│  │ [ paste a note ]     │  │ ↓ clip.mp4        18 MB   │   │
│  │ [◉ Camera][▭ Screen] │  │ ↑ report.pdf  ▓▓▓░ 2 MB   │   │
│  └──────────────────────┘  │ ↓ Note — https://…  Copy  │   │
│                            └───────────────────────────┘   │
│  ┌─ Devices ────────────────────────────────────────────┐  │
│  │ [ This device ]              [ The other device ]    │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**Shell width.** The app is capped at `max-w-2xl` (672px), which two columns
cannot use. The session route widens to `max-w-5xl`; the header's inner
container matches per-route so the bar never sits visibly narrower than the
content beneath it. Landing, create and join keep 672px — their copy is set in
`max-w-md`/`max-w-lg` and reads badly stretched.

**Live** is absent from the DOM when idle apart from its two buttons, and
promotes above the columns the moment a stream starts, collapsing back when it
stops. It is the only time-sensitive thing on the page; everything else
tolerates a scroll.

**Share** loses today's received-notes list and becomes purely a place to start
things: drop zone, note box, camera and screen buttons.

**Transfers** becomes the single home for everything that crossed — files and
notes, newest first, direction on each row. Filter chips are All / Sent /
Received. The list scrolls inside its own card rather than growing the page,
and keeps the `@tanstack/react-virtual` treatment `FileQueue` already has.

**Filter state lives in the URL** as `?filter=sent`, per AGENTS.md. The key is
in the fragment, so a query parameter does not disturb it. It is written with
`replaceState`, not `pushState` — a filter should not stack in history and turn
Back into a filter-undo button.

### States

| State | Presentation |
| --- | --- |
| Live idle | Both buttons active; one line noting only one stream at a time |
| Sharing | Local preview, muted locally to avoid feedback; Mute mic and Stop sharing |
| Watching | Remote video; volume, fullscreen, and a note that starting your own replaces theirs |
| Connecting | Placeholder with a Cancel that actually tears the attempt down |
| Permission refused | Recovery text naming the address bar, not a bare red line |
| No TURN available | Controls stay active with a caution that this network may not allow live video; a failure then surfaces as the row above |
| Record empty | "Nothing yet. Drop a file or paste a note to start." |
| Record dense | Scrolls within the card; the page does not grow |

**Microphone honesty.** The camera carries the mic, and both devices are
usually in one room, so: local preview is always muted locally, the Mute
control reflects real `MediaStreamTrack.enabled` state rather than UI state,
and stopping a share calls `stop()` on every track so the browser's recording
indicator actually goes out.

**No TURN is a caution, not a lock.** An earlier draft disabled the live
controls whenever `/turn` returned nothing. That is wrong for this app's most
common setup: a phone and a laptop on one wifi network connect over host
candidates without STUN, let alone TURN. So a session with no TURN available
still builds `MediaPeer` — from STUN alone — and still lets the user try,
behind one line saying it may not connect here. Refusing outright would break
the LAN case to protect against the hotel-wifi case.

**`TransportBadge` becomes truthful.** With `DataPeer` working, `Direct` is
reachable for the first time. The badge now describes the *file* path only —
media has its own connection and its own visible states.

## 7. Error handling

| Failure | Behaviour |
| --- | --- |
| `DataPeer` never connects | Silent. Files continue on the WebSocket relay; badge reads Relayed. Unchanged from today's behaviour, now for the honest reason. |
| `DataPeer` dies mid-transfer | Existing `SwitchableTransport` fallback to the relay; resume machinery unchanged. |
| `/turn` unreachable or unconfigured | `MediaPeer` is built with STUN alone and the attempt proceeds; a caution is shown first. Files unaffected. |
| `getUserMedia` / `getDisplayMedia` rejected | Per-attempt message with recovery text. Slot is not claimed. |
| `MediaPeer` fails to connect | Attempt torn down, tracks stopped, slot released, message shown. Files unaffected. |
| Malformed media signal from peer | Dropped by the whitelist parser; never reaches `setRemoteDescription`. |
| Peer leaves mid-stream | Slot released, remote video removed, tracks stopped via the existing `peer-left` path. |

Live media failures never surface as transfer errors, and never touch
`session.error` — a failed camera permission must not look like a failed file.

## 8. Testing

**The test that was missing.** Nothing caught the dead upgrade because the only
tests exercising it stub a fake `RTCPeerConnection` into a realm that has none,
and the e2e suite pins `?forceTransport=relay`. The fix is a Playwright test on
two loopback contexts asserting the badge reaches **Direct** with no flag — real
browser, real realms, no stubs. Without it this bug is repeatable; with it, it
is closed.

| Layer | Coverage |
| --- | --- |
| Unit | TURN credential minting: HMAC correctness, expiry arithmetic, unset config → empty, rate limiting |
| Unit | Media signal whitelist parser: malformed, hostile and oversized payloads never reach the platform |
| Unit | One-slot arbitration: simultaneous offers, both id orders, no deadlock, camera released by the loser |
| Unit | Record filtering and URL round-trip, including an unknown `?filter=` value |
| Integration | Page↔worker frame proxy: ordering, transferable handling, `onDrain` backpressure, close semantics |
| UI | New sections at every state in §6; axe on each; tap-target floors |
| E2E | **Direct reachability with no flag**; a real camera stream between two contexts via `--use-fake-device-for-media-stream`; live stream survives a file transfer running concurrently |

The existing `upgrade-fallback.test.ts` keeps its stub — it tests the
negotiation algorithm and does that job well. It gains a comment recording that
it cannot, by construction, prove availability, and naming the e2e test that
does.

## 9. Build order

Four phases, each independently shippable and independently verifiable.

1. **Transport realm fix.** Page-owned `DataPeer`, `ProxyTransport` in the
   worker, and the Direct-reachability e2e test. No UI change whatsoever.
2. **Layout restructure.** Four regions, two columns, record with filters,
   shell width. No new features.
3. **TURN infrastructure.** `GET /turn`, coturn compose service,
   `docs/deployment.md`. Nothing user-visible.
4. **Live media.** `MediaPeer`, sealed signalling, arbitration, every state
   in §6.

Phase 1 ships alone and first, deliberately. It touches `session.ts` and
`upgrade.ts` — the most carefully-reasoned code in the repository — and if it
lands mixed with a layout change, a resume or reconnect regression cannot be
attributed to either.

## 10. Deployment

coturn joins the stack as a compose service: `3478/udp`, plus a relay port
range (`49160-49200/udp`). That range is the operational sharp edge — it is
what gets forgotten in a firewall, and the symptom is video that negotiates
and then never arrives.

`docs/deployment.md` gains a TURN section covering the port range, the shared
secret, and the hardening that matters: `denied-peer-ip` over the RFC1918
ranges, so the TURN server cannot be used as a hop into the operator's own
private network.

## 11. Deferred

- Recording or snapshotting a live stream into the transfer record.
- Simultaneous camera and screen from one device.
- Bidirectional streams — a second slot, one per device.
- Bandwidth or resolution controls for the live stream.
- Screen-share system audio, pending portability.
- Reconsidering whether `DataPeer` should be allowed TURN for small files,
  where the metered cost is negligible.

# soja-share — Design Spec

**Date:** 2026-08-25
**Status:** Approved design, pending implementation plan

## 1. Problem

Moving a file between two devices that have no relationship — your phone and a
borrowed laptop, your machine and a colleague's — is disproportionately annoying.
Email has size caps, chat apps recompress images, cloud drives need accounts on
both ends, and AirDrop only works inside one vendor's fence.

soja-share is a web app with no install and no account. One device opens the app
and gets a short link plus a QR code. The other device scans the QR or types the
code. Both devices are then paired, and files, folders, and text move in either
direction until someone closes the tab.

## 2. Goals

- Zero install, zero account, works in any modern browser on any platform.
- Pairing takes one scan or one six-character code.
- No practical file size limit.
- Files are never stored on the server and never readable by it.
- Works even on networks that block peer-to-peer connections.
- Meets every MUST in `AGENTS.md` (Vercel Web Interface Guidelines).

## 3. Non-goals (v1)

- Offline or store-and-forward delivery. Both devices must be connected at once.
- More than two devices in a session.
- Accounts, history, or any persistence across sessions.
- Native apps.
- Local-network device discovery (PairDrop-style peer lists).

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transfer path | WebRTC first, WebSocket relay fallback | P2P is fast and private; the relay guarantees a working path on hostile networks. |
| Relay behavior | Streaming passthrough, no storage | Removes object storage, TTL cleanup, size caps, malware custody, and abuse surface. Keeps one mental model: a live session. |
| TURN server | None | The streaming relay already covers the networks TURN would rescue. One fewer dependency and bandwidth bill. |
| Runtime | Single Node service (Fastify) | Familiar, one deploy target, trivial local development, no vendor lock-in. |
| Encryption | AES-GCM in-browser, key in URL fragment | The server sees ciphertext on both paths. Fragments are never sent to the server, so the key stays client-side. |
| Transport structure | One `Transport` interface, relay implemented first | Crypto, chunking, and progress are written once. A working transfer exists before WebRTC is attempted. |
| Heavy work | Web Worker | Chunking and per-chunk encryption off the main thread; the UI never re-renders per chunk. |

### Why the key lives in the URL fragment

Browsers do not transmit the fragment portion of a URL to the server. It is
absent from the request line, from server logs, and from the `Referer` header
of outbound links. Encoding the key there means the server can serve the app,
route the room, and forward the bytes without ever being able to read them.

This also decouples security from link length. A six-character code is short
enough to read aloud but small enough to brute force; someone who guesses a
code and joins the room receives only ciphertext, because the key was never
theirs to guess. The link gets to stay short without the entropy being the
thing protecting the file.

**Consequence:** the QR code must be rendered client-side. Requesting a QR
image from a server API would transmit the fragment key in the request and
defeat the entire scheme.

## 5. Architecture

One Node process serves the static SPA, accepts WebSocket upgrades at `/ws`,
and resolves `/s/:code` to the SPA. Rooms live in an in-memory `Map`. There is
no database, no object storage, and no TURN server.

```
soja-share/
├── AGENTS.md                 # binding UI quality bar
├── shared/messages.ts        # wire types, imported by both sides
├── server/
│   ├── index.ts              # Fastify: static assets, WS upgrade, /s/:code
│   ├── rooms.ts              # Map<code, Room>; join/leave/pair; idle sweep
│   ├── codes.ts              # code generation + collision check
│   ├── signaling.ts          # SDP/ICE passthrough between the pair
│   └── relay.ts              # binary frame passthrough + backpressure
└── client/
    ├── transport/
    │   ├── types.ts          # Transport interface — the seam
    │   ├── relay.ts          # RelayTransport  (WebSocket)
    │   ├── webrtc.ts         # WebRTCTransport (DataChannel)
    │   └── upgrade.ts        # background negotiation + hot swap
    ├── protocol.ts           # frame encode/decode
    ├── crypto.ts             # keygen, fragment codec, per-chunk AES-GCM
    ├── worker/transfer.ts    # worker entry: owns Transport, sender, receiver
    ├── transfer/sender.ts    # file queue, chunker, backpressure
    ├── transfer/receiver.ts  # reassembly, dispatch to save strategy
    ├── save/                 # fsaccess.ts | swstream.ts | blob.ts
    ├── sw.ts                 # service worker (streaming download)
    └── ui/                   # React + Vite + Tailwind
```

### The server is deliberately dumb

It knows room codes and which two sockets belong together, and it forwards
opaque byte frames. It does not decrypt, does not inspect payloads, does not
touch disk, and holds no state beyond the lifetime of the two sockets. This is
a small enough surface to audit in one sitting, and it is what makes "your
files are not stored" an honest claim rather than a policy promise.

### The transport seam

```ts
interface Transport {
  send(frame: Uint8Array): void;
  readonly bufferedAmount: number;   // uniform backpressure signal
  readonly kind: 'relay' | 'webrtc';
  onMessage(cb: (frame: Uint8Array) => void): void;
  onDrain(cb: () => void): void;
  onClose(cb: (reason: string) => void): void;
}
```

Both `RTCDataChannel` and `WebSocket` expose `bufferedAmount`, so the sender's
flow control is written once and runs unchanged on either. Everything above
this interface — the file queue, the chunker, AES-GCM, progress accounting,
the streaming save — is transport-agnostic and never branches on `kind`
except to render the badge.

## 6. Pairing flow

1. Device A opens the app. WS `create` returns a six-character room code.
2. A generates a 256-bit AES-GCM key with `crypto.getRandomValues` and builds
   `https://host/s/K7M3QP#<base64url-key>`.
3. A renders that URL as a QR code in-browser and displays the code as text.
4. Device B scans the QR, or types the code manually. B loads the SPA, reads
   the key from `location.hash`, and sends WS `join K7M3QP`.
5. The server pairs the sockets and notifies both with `peer-joined`. A working
   `RelayTransport` now exists on both sides; transfers may begin immediately.
6. In the background, A creates an `RTCPeerConnection` and offers. SDP and ICE
   candidates flow through the same WebSocket. If a DataChannel opens, both
   sides swap `activeTransport` at an idle frame boundary. If it never opens,
   nothing visible changes except throughput.

### Room codes

Six characters from Crockford base32 (excludes `I`, `L`, `O`, `U` — removes
visual ambiguity and reduces accidental words). Roughly 1.07 billion
combinations. Generation retries on collision against the live room map. Codes
are ephemeral: a room exists only while at least one socket is attached.

Creation is rate-limited per IP to prevent room-map exhaustion. Join attempts
are rate-limited per IP to make code-guessing impractical even before the
encryption backstop applies.

### Transport upgrade

The swap happens only at a chunk boundary with the send queue idle, negotiated
with a `switch-transport` control frame acknowledged by the peer. This avoids
interleaving frames from two transports mid-file. If the acknowledgement does
not arrive within a short timeout, the upgrade is abandoned and the session
stays on relay.

## 7. Wire protocol

Binary frames over whichever transport is active:

```
[type: u8][fileId: u32][seq: u64][payload: bytes]
```

Control frames carry JSON payloads:

- `hello` — `{ saveCapability, maxBufferedBytes }`, sent by both peers
  immediately on pairing and again after a transport swap
- `offer-batch` — `{ files: [{ id, name, size, type }] }`
- `accept` / `reject`
- `file-end` — `{ id }`
- `text` — `{ content }`
- `switch-transport` / `switch-ack`
- `resume-from` — `{ fileId, bytesReceived }`

Data frames carry ciphertext.

### Chunking and encryption

Chunk size is derived from the WebRTC message ceiling, not chosen. The
interoperable maximum for a single SCTP DataChannel message is 65,536 bytes, so
the *wire frame* is budgeted to exactly that and the plaintext chunk is whatever
is left after the header and the GCM tag:

```
CHUNK_SIZE = 65536 - 13 (header) - 16 (GCM tag) = 65507 bytes
```

Picking a round 64 KB plaintext instead would produce a 65,565-byte frame, which
overruns the ceiling and would force a fragmentation layer inside the WebRTC
transport purely to undo a cosmetic choice. Deriving the size removes that layer.

Each chunk is sealed individually with AES-GCM. The nonce is 12 bytes:

```
[ peerByte: 1 ][ random: 3 ][ seq: 8 ]     peerByte 0x01 = 'a', 0x02 = 'b'
```

Both peers send under the same session key, so the nonce must be unique across
*both* senders, not just within one. The leading peer byte makes the two nonce
spaces provably disjoint; the 3 random bytes are freshly drawn per session so a
rejoin under the same code cannot replay a previous session's nonces; the
counter never resets within a session.

Nonce reuse under a shared AES-GCM key is the catastrophic failure mode — it
leaks the XOR of the two plaintexts and enables forgery — so this is the single
most important invariant in the design, and the unit tests assert it directly,
including the cross-peer case.

### The relay is an active adversary

The server is not merely curious — it is assumed hostile. It relays every byte,
so it can drop, delay, duplicate, reorder, and rewrite frames at will, and TLS
protects the connection *to* it rather than *from* it. Authenticating each chunk
is therefore necessary but not sufficient: sealed chunks with an unauthenticated
header can be rearranged into a file the sender never sent, and every individual
tag still verifies.

Three properties close that gap, and all three are required:

1. **The frame header is bound to the ciphertext.** The 13-byte
   `[type][fileId][seq]` header is passed as AES-GCM additional authenticated
   data. It is authenticated, not transmitted twice. A relabelled type byte, a
   rewritten `fileId`, or an altered sequence number fails the tag.
2. **Sequence numbers are strictly increasing per file.** AAD alone does not stop
   a genuine frame being replayed in a different position, since it authenticates
   correctly wherever it lands.
3. **A file is complete only at its offered length.** The receiver counts the
   plaintext it has written and refuses to finish a file whose total does not
   equal the `size` in its `offer-batch`. Without this, dropping the final chunk
   yields a truncated file that passes every check.

Per-chunk authentication tags also mean tampering is detected at the chunk rather
than at end-of-file, so a corrupted transfer fails early instead of after a
multi-gigabyte wait.

Encryption also runs on the WebRTC path, where DTLS already provides transport
security. The redundancy is deliberate: one code path is worth more than the
saved cycles, and it is the payoff for the transport abstraction.

## 8. Web Worker boundary

A 4 GB file at 64 KB chunks is roughly 65,000 encrypt operations plus file
slicing and framing. On the main thread this competes with React and the
compositor, and — because the UI and the transfer share a thread — actively
slows the transfer.

`worker/transfer.ts` owns the `Transport`, the sender, and the receiver.
It communicates with the UI over `postMessage` with transferable
`ArrayBuffer`s. Progress is throttled to one message per ~200 ms plus one on
completion, so React sees a handful of updates per second regardless of
transfer speed.

The UI receives only `{ fileId, bytesMoved, bytesPerSecond, transport, state }`.
It has no knowledge of chunks, nonces, or which transport is live beyond the
badge label.

## 9. Streaming save

Resolved once at receiver startup, before a batch is accepted:

1. `window.showSaveFilePicker` exists → **File System Access API**. Chunks are
   written straight to disk through a `FileSystemWritableFileStream`. No memory
   ceiling. Chrome and Edge on desktop.
2. Service Worker supported → **Service Worker streaming download**. The worker
   synthesizes a `Response` whose body is a `ReadableStream` fed by incoming
   chunks; a hidden navigation to a virtual URL makes the browser's native
   downloader consume it and write to disk. Covers iOS Safari and Firefox.
3. Neither → **blob buffer** with a hard cap and an explicit warning shown
   before the transfer starts.

The receiver reports its capability in the `hello` frame, so the sender can warn
about a size that will not survive *before* a large transfer begins rather than
at the moment it fails.

## 10. Error handling

Every failure has a named recovery. Nothing dead-ends.

| Failure | Behavior |
|---|---|
| WebRTC never connects | Silent. Stay on relay; show a "Relayed" badge with icon and text. |
| WebRTC drops mid-transfer | Fall back to relay at the next chunk boundary; transfer continues. Polite `aria-live` notice. |
| Relay socket drops | Reconnect with exponential backoff, rejoin by code, and resume from the byte offset the receiver reports. The sender still holds the `File`, so it seeks rather than buffering a replay window. |
| Peer closes their tab | Both sides show "Other device disconnected". The room stays open and the QR is re-displayed so the peer can rejoin the same code. |
| Room code not found or expired | Dedicated screen: "This link has expired", with a button to start a new session. Never a blank 404. |
| Chunk fails its auth tag | Abort that file and surface tampering explicitly. Never silently retry — a failing GCM tag is not a network hiccup. |
| Frame arrives out of order, duplicated, or for an unoffered file | Abort that file and report it. The header is authenticated, so a rewritten one fails its tag; a replayed genuine frame is caught by the strictly-increasing sequence check. |
| File ends short of its offered size | Abort rather than completing. A truncated file that never failed a tag is exactly the silent corruption the design must not produce. |
| User closes tab mid-transfer | `beforeunload` guard while any transfer is in flight. |
| Third device joins a full room | Rejected with "This session already has two devices." |
| Camera unavailable or denied on Join | Fall back to manual code entry with the input already focused. |

## 11. UI

### Screens

- **Create** — QR code, room code in large type, copy-link button, connection status.
- **Join** — camera scanner with a manual code input beneath it.
- **Session** — drop zone, file queue with per-file progress, transport badge, text snippet box, both directions active.
- **Expired / Error** — explanation plus a route forward.

Each screen specifies its empty, sparse, dense, and error states.

### Guideline compliance notes

These are `AGENTS.md` MUSTs with a specific consequence in this app:

- **Progress bars use `transform: scaleX()`**, never animated `width`. Layout
  properties are never animated.
- **Drag-and-drop is never the only path.** The drop zone is also a button that
  opens a file picker and is reachable and operable by keyboard.
- **File queue virtualizes past 50 rows**, which folder drops reach easily.
- **All numbers use `font-variant-numeric: tabular-nums`.** Transfer speed
  counters jitter unreadably without it.
- **Non-breaking spaces in all units** — `10 MB`, `2.4 MB/s`.
- **Status is never color-only.** The transport badge carries an icon and a
  word, not just a green or amber dot.
- **Manual code input**: `inputmode="text"`, `autocapitalize="characters"`,
  `spellcheck={false}`, font-size ≥ 16 px to prevent iOS zoom, paste allowed
  and normalized (case, whitespace, dashes stripped).
- **Hit targets ≥ 44 px on mobile.** This is a phone-first app.
- **`env(safe-area-inset-*)` respected** on all fixed and bottom-anchored UI.
- **`document.title` carries live progress**, so a backgrounded tab shows it.
- **Progress announced politely and throttled**, not per percentage point.
- **`prefers-reduced-motion` honored**; the only motion is transform and opacity.

### Development constraint

Camera access and WebRTC both require a secure context. Local development on a
real phone therefore needs HTTPS — a local TLS certificate or a tunnel. This is
a day-one setup task, not a late discovery.

## 12. Visual direction

The product is used for thirty seconds at a time, by someone standing up,
often on a borrowed device, to move something they care about. It should read
as a precise instrument: calm, confident, and obviously not sloppy. Sloppiness
here is not merely ugly — it undermines the trust the app is asking for.

**Dark-first, with a real light mode.** Dark suits the context (scanning a
bright QR, often in a dim room) and reads as utility rather than marketing.
Light mode is a first-class implementation, not an afterthought;
`color-scheme` is set on `<html>` and `<meta name="theme-color">` matches the
page background.

**Palette.** A near-black canvas with a slight blue tint (around `#0A0B0D`),
with surfaces stepped in small lightness increments rather than by borders
alone. Borders are semi-transparent white over the canvas and combined with
layered shadows (one ambient, one direct) to keep edges crisp. Per the hue
consistency guideline, borders, shadows, and muted text are tinted toward the
background hue rather than pure grey.

One accent color, used sparingly and only for live or active state. Contrast is
checked with APCA, and every state change increases contrast on hover, active,
and focus.

**Typography.** Inter (or the system UI stack) for interface text; a monospace
face for room codes, filenames, and any byte counts. The room code is the
largest element on the Create screen — set large, letter-spaced, and visually
grouped (`K7M-3QP`) so it can be read aloud across a room without mistakes.
`translate="no"` on the code so auto-translation cannot garble it.

**Layout.** The QR code is the hero of the Create screen: a bright card on a
dark canvas, with enough quiet margin that a camera locks on immediately.
Nested radii are concentric — child radius never exceeds parent.

**Motion.** Almost none. One deliberate moment: when the peer connects, the
status badge transitions with a brief scale-and-fade to mark the state change,
because that is the instant the user is waiting for. Progress bars move
continuously but only via `transform`. Everything is interruptible and
respects `prefers-reduced-motion`.

**Components.** Hand-rolled Tailwind primitives rather than a component
library. The app needs roughly eight components — Button, Card, Badge,
ProgressBar, FileRow, Input, QRPanel, Toast — and a full library is more
surface area and more opinion than the app can use.

## 13. Testing

**Unit (Vitest)**
- Protocol frame codec round-trip, including maximum-size payloads.
- Crypto seal and open; nonce uniqueness across a long sequence; tamper
  detection on a flipped ciphertext bit.
- Chunker boundaries: zero-byte file, file smaller than one chunk, file that is
  an exact multiple of the chunk size.
- Room registry: join, leave, full-room rejection, idle sweep, code collision.

**Integration**
- Two WebSocket clients against a real server instance: pair, relay a file,
  assert byte-identical output.
- Kill one socket mid-transfer; assert reconnect and resume from the correct
  sequence.

**End-to-end (Playwright)**
- Two browser contexts in one test. Transfer a real file and assert the
  downloaded bytes match the source.
- A relay-only flag forces the fallback path so both transports are tested
  deterministically. Without this the fallback rots, because it otherwise only
  runs on networks the developer does not have on hand.

**Accessibility**
- axe pass on every screen.
- A keyboard-only walkthrough of the full flow as an explicit test, not a
  manual habit.

## 14. Build order

Each step ends with something demonstrable.

1. Server skeleton, room registry, code generation, with tests.
2. `Transport` interface and `RelayTransport`. Two tabs exchange text.
3. Protocol and crypto inside the worker. Small-file transfer, blob save.
4. Streaming save: File System Access, then the Service Worker path.
5. Real UI built against `AGENTS.md`.
6. `WebRTCTransport` and the hot upgrade.
7. Reconnect, resume, and the error screens.
8. End-to-end and accessibility passes.

## 15. Deferred

Recorded so they are choices rather than oversights:

- Store-and-forward "park it for later" mode.
- More than two devices per room.
- Local-network device discovery without a QR.
- PWA install and share-target integration.
- Per-session PIN confirmation on top of the fragment key.
- Horizontal scaling, which would require Redis pub/sub so paired sockets on
  different instances can find each other.

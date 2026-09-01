<p align="center">
  <img src="logo-banner.png" alt="Quik Share" width="620" />
</p>

<p align="center">
  <a href="https://quikshare.qd.je"><strong>quikshare.qd.je</strong></a>
</p>

Move a file — or a note, or a live view of your camera or screen — from one
device to another with a link and a QR code. No account, no install, no
upload. The two devices talk directly when the network allows it, and
everything is encrypted before it leaves the browser — the server only ever
sees ciphertext.

<p align="center">
  <img src="docs/diagram.png" alt="Diagram - Quik Share" />
</p>

## How it works

**Pairing.** One device asks the relay for a room and gets a six-character
code (`shared/codes.ts` — Crockford base32, so `I`/`L`/`O` normalise to `1`/`1`/`0`
and cannot be misread aloud). The share link is `/s/K7M3QP` — the code is the
whole of it. The other device scans the QR, types the six characters, or
pastes the link, and the room is full at two peers.

**The key is agreed between the devices, and you check it yourself.** Each
device generates an ephemeral P-256 pair and puts its public key in the hello
frame; both sides run ECDH and HKDF (salted with the room code) to reach the
same 32-byte AES-GCM key, which the relay never sees (`client/crypto.ts`,
`deriveSession`). The relay *can* try to sit in the middle by swapping both
public keys — so the same secret also derives a six-digit number, both screens
show it, and nothing sends until the people at both ends confirm the numbers
match. Under a machine-in-the-middle the two numbers differ, because the
attacker shares a different secret with each device.

This replaced an earlier design that carried the key in the URL fragment. That
kept the key off the wire without anyone having to check anything, but it made
the link the only way in: 43 characters of base64 after a `#`, unreadable
aloud and untypeable, and a chat client that truncated at the `#` produced a
link that could not open the session at all.

**Two transports, one seam.** Every transfer starts on the WebSocket relay,
which always works, then tries to upgrade to a direct WebRTC data channel
(STUN only — no TURN, by design; the relay already covers the networks TURN
would rescue). The badge on the session screen says **Direct** or **Relayed**
so the user knows which one carried their file. `client/transport/upgrade.ts`
swaps the live transport underneath `Sender`/`Receiver`, which never learn it
happened.

**The relay is treated as an active adversary,** not just a passive pipe. It
can reorder, drop, duplicate and splice frames, so:

- Each 13-byte frame header is authenticated as AES-GCM additional data, not
  merely transmitted.
- Data frames additionally bind the chunk's own byte offset
  (`client/transfer/data-aad.ts`), which the receiver *derives* from its
  running byte count rather than reads off the wire. A chunk sealed for one
  offset cannot open at another — contiguity is enforced by the cipher.
- Nonces are `[peerByte][random prefix][sequence]`, and the sequence counter is
  session-wide and never restarts, across reconnects and transport swaps.
  Both peers share one key, so a repeated nonce would leak the authentication
  key itself.

**Files, notes, and whatever is already on the clipboard.** Drop files, type
a note, or press ⌘/Ctrl+V — a screenshot goes straight from the clipboard to
the other device instead of being saved, hunted down in a picker and deleted
again. Everything that crosses the session lands in one record, sent and
received in one ordering, filterable (`?filter=sent` survives a reload),
cancellable per file, and virtualized past the row count a dropped folder
reaches easily. While a transfer is in flight the tab holds a wake lock, the
percentage rides in `document.title` for a tab nobody is looking at, and
leaving the screen asks first — there is no resume, so leaving really does
cancel. One notification fires when the last file of a batch lands, only if
the tab is hidden and the permission was already granted; it is asked for
from the act of sending, which is the first honest sign someone intends to
wait for something.

**Saving, in three tiers,** picked per browser and advertised to the peer in
the handshake so the *sender* can warn about a file that will not fit before a
multi-gigabyte transfer starts: a service-worker stream straight to the
browser's downloader (no size limit, no user gesture), the File System Access
API as a fallback, and an in-memory blob as the floor.

**Chunking and encryption run in a Web Worker,** so the UI never re-renders
per chunk.

**Live camera and screen ride a second connection** (`client/media/`). It is
its own `RTCPeerConnection`, one-way by construction — the offerer's
transceivers `sendonly`, the answerer's `recvonly` — and deliberately kept
out of the worker that owns file transfer, which must never see an
`RTCPeerConnection`. A live failure closes that one connection and says so on
its own card; it is never reported as a transfer error, and files in flight
are untouched.

- Offer, answer and ICE candidates travel as sealed control frames on the
  session that already exists, and every field is whitelisted before it
  reaches `setRemoteDescription`/`addIceCandidate` (`shared/media-signal.ts`).
  The peer holds the same key, so *authenticated* is not *trusted*: an SDP is
  bounded, candidates are counted, and nothing is cast through.
- One slot per session. Starting a stream replaces whatever is running, and
  two peers grabbing it in the same instant is resolved by glare rules rather
  than left to race. Seven paths end a stream and all seven funnel through
  one release, which is what actually stops the local tracks — the step that
  makes the camera light go out.
- A screen share says what to protect when the path narrows: **Text** keeps
  resolution (a soft caption is unreadable, a late slide is merely late),
  **Motion** keeps frame rate, and **Data** is the one preset with hard caps
  (`client/media/share-quality.ts`). All three steer the browser's own
  congestion control rather than running a second controller against it.
- Camera shares get mute, flip and torch — each read off the live *track*
  after every flip rather than remembered from what was asked for, because
  the same phone reports a lamp on one camera and none on the other.
- This is the only path that uses TURN, fetched from `/turn` lazily on the
  first share attempt of a session and never while idle. A deployment with no
  TURN is fully supported: it degrades to STUN and the UI cautions once. There
  is no relay fallback for media — if WebRTC cannot connect, the share does
  not happen.
- Nothing is recorded, anywhere.

The screen-share button is left out entirely where the browser has no
`getDisplayMedia` — every mobile browser, in practice. Receiving the other
device's screen still works there.

**Each side can see what it paired with.** The session header draws the pair
itself — a glyph and an OS per device, with the run between them solid when
the transport is direct and broken around a relay node when it is not, saying
in shape what the badge beside it says in words — so "did I just pair with my
own laptop?" has an answer without scrolling. The two devices swap their
descriptions in a *sealed* control frame, never on the plaintext handshake, so
the relay does not get the pairing handed to it in the clear; the IP address
is the one thing a browser cannot know about itself, so the relay tells each
device its own. What the other side reports is its own claim: it is sanitised
on arrival (`shared/device.ts`) but nothing about it is verified, and nothing
is authorised by it. The fuller per-device card — browser, screen size, a
device id stable for that browser profile, the observed address — is still
`client/ui/DevicePanel.tsx`, no longer mounted on the session screen: it sat
below the transfer record, which is the last place anyone looks during a
transfer, and the header answers the question it was there for.

**The server stores nothing.** In-memory rooms, no database, no object
storage, and the file bytes are never written to disk or logged.

**Installing is optional, and adds one thing.** The app is a PWA, so a
browser will offer to install it. Installed, it joins the OS share sheet:
share a photo or a link from any app and Quik Share opens with it already
staged, sending as soon as both devices have confirmed the number. The share
never touches the network — the service worker takes the files out of the
POST body before the navigation discards them, which is also why a share
made before the app has ever been opened says so rather than failing
silently.

## Requirements

- Node **≥ 22**
- A modern browser. HTTPS is mandatory in any deployment — the QR scanner,
  WebRTC, camera and screen capture, and the streaming save tier all require a
  secure context, and browsers only waive that for `localhost`.

## Development

```bash
npm install

npm run dev:server    # Fastify relay on http://127.0.0.1:8787
npm run dev:client    # Vite on http://localhost:5173, proxying /ws to the relay
```

Open two browser windows on the Vite URL to test a transfer against yourself.

To test against a real phone you need HTTPS — `localhost` is a secure context
but your phone cannot reach it. Use a tunnel, or `mkcert` plus `vite --https`
(the certificate must be trusted on the phone too). See
[`docs/deployment.md`](docs/deployment.md).

**Debug flag:** append `?forceTransport=relay` to suppress the WebRTC upgrade
and pin the relay path deterministically. Without it the fallback only runs on
networks where WebRTC happens to fail — which is how a fallback rots silently
until a user hits it in a hotel.

## Production

```bash
npm run build         # vite build + tsc -p tsconfig.server.json → dist/
npm start             # NODE_ENV=production node dist/server/index.js
```

Or with the included container:

```bash
docker build -t quik-share .
docker run --rm -p 8787:8787 quik-share
```

Put a TLS-terminating reverse proxy in front of it and set `TRUST_PROXY`
correctly, or the per-IP rate limits collapse into one shared bucket.
[`docs/deployment.md`](docs/deployment.md) has the Caddy and nginx configs and
explains the trust model.

| Variable         | Default   | Purpose |
| ---------------- | --------- | ------- |
| `PORT`           | `8787`    | Relay port. Rejects a malformed value at startup rather than binding something random. |
| `HOST`           | `0.0.0.0` | Bind address. |
| `NODE_ENV`       | —         | `production` serves the built client and its SPA fallback. |
| `TRUST_PROXY`    | unset     | Which hop may speak for `X-Forwarded-For`. `true` = a proxy on this host; an IP/CIDR list = a proxy elsewhere (**a container is this case**); unset = trust nobody. A bare hop count is rejected. |
| `VITE_STUN_URLS` | public    | STUN servers, baked in at **build** time. Container builds pass it as `--build-arg`. |
| `TURN_URLS`      | unset     | `turn:` servers for live media's ICE fallback (file transfer never uses TURN). The address the **browser** dials, so it names a host reachable from the public internet, never a container name or `localhost` on a real deployment. Unset is fully supported — `GET /turn` just returns no servers. Must be set together with `TURN_SECRET`. `turns:` is accepted too, but only works against a provider that terminates TLS; the bundled coturn has no certificate. |
| `TURN_USERNAME`  | unset     | With `TURN_CREDENTIAL`, a long-lived pair from a managed TURN provider (Metered and friends), forwarded to the browser as-is. The alternative to `TURN_SECRET`, not a companion to it — setting both is a startup error. |
| `TURN_CREDENTIAL`| unset     | The password half of the pair above. Unlike `TURN_SECRET` this one does leave the process, because the browser is what authenticates with it. Rotate it in the provider's dashboard. |
| `TURN_SECRET`    | unset     | Shared secret with the coturn `static-auth-secret`, which `docker-compose.yml` reads from a `coturn/turnserver.conf` you create rather than passing on coturn's command line (`docs/deployment.md` explains why). Must be set together with `TURN_URLS`; a stray value from an unrelated service will block startup. |
| `TURN_TTL_SECONDS` | `600`   | Lifetime of a minted TURN credential, 1–3600. See `docs/deployment.md` before changing it — `/turn` is unauthenticated and this is one of the bounds on that. |

## Testing

```bash
npm test              # vitest — unit, UI (jsdom), and integration
npm run typecheck     # tsc --noEmit
npm run test:e2e      # Playwright, real Chromium, two browser contexts
```

`npm run test:e2e` needs `npx playwright install chromium` once, and builds the
app before running. It transfers a real 3 MB file between two contexts and
compares the bytes on disk, then runs the accessibility suite — focus-ring
visibility, sticky overlap, a keyboard-only walkthrough, and tap-target floors
at desktop and mobile widths — each with a companion test proving the check is
not vacuous. Four more suites cover what only a browser can answer:
`live-media.spec.ts` negotiates a real camera stream between two contexts (on
its own Chromium instance, because the fake-device flags are launch-time) and
checks the file connection survives it; `session-layout.spec.ts` checks the
grid breakpoint, the record's own scroll, and the filter surviving a reload;
and `share-target.spec.ts` posts the manifest's share form the way Chrome's
share sheet does. The fourth, `direct-transport.spec.ts`, earns the paragraph
below.

Screen capture is not covered end to end and that is an environment gap, not
an untested path: `getDisplayMedia` headlessly needs a desktop to capture, and
a CI runner has none.

It exists for a specific reason: it asserts the transport badge actually
reaches **Direct** on the default path.
`Session` runs in a Web Worker and `RTCPeerConnection` is `[Exposed=Window]`,
so an upgrade guard that asks its own realm silently disables WebRTC
everywhere — which is exactly what the guard did from the moment it was
written, undetected until this test existed. Unit tests stub
`RTCPeerConnection` into a realm that has one, which proves the negotiation
algorithm and nothing about availability. Only a real browser can tell you
the difference.

## Layout

```
shared/          wire types, room codes, signal parsing, device info, media signals
server/
  index.ts       Fastify: static assets, /ws upgrade, /s/:code, /turn, rate limits
  dev.ts         the relay on its own, for `npm run dev:server`
  rooms.ts       Map<code, Room>; pairing and idle sweep
  rate-limit.ts  token buckets keyed by client IP
  turn.ts        TURN config validation and REST credential minting
client/
  crypto.ts      AES-GCM primitives, nonce construction, base64url
  device.ts      what this browser can say about itself
  protocol.ts    13-byte frame header, encode/decode
  session.ts     pairing, reconnect, transport upgrade, resume
  routing.ts     the routes, the navigation guard, the record's filter param
  transfer/      Sender, Receiver, and the data-frame AAD both share
  transport/     relay, webrtc, the switchable seam, memory (tests)
  media/         live camera and screen: capture, its own peer, ICE, quality, stats
  save/          the three save tiers and the capability probe
  share/         the OS share sheet's inbox
  worker/        the Web Worker boundary, its sink proxy and its peer proxy
  hooks/         useSession, the QR scanner, the in-flight transfer guards
  screens/ ui/   React screens and hand-rolled Tailwind primitives
  sw.ts          service worker: streaming downloads, and the share target
  public/        icons, manifest, robots and sitemap, emitted to the origin root
scripts/
  make-icons.py  draws the PNG app icons from the mark's own geometry
docs/
  deployment.md  what an operator needs
  diagram.png    the diagram at the top of this file
docker-compose.yml  relay + a hardened coturn, for deployments that want TURN
```

The mark is two QR finder patterns offset along the diagonal, and it exists in
three files that must agree: `client/ui/Logo.tsx` (the header, inline SVG in
theme tokens), `client/public/favicon.svg` (the tab), and the PNG fallbacks
that `python3 scripts/make-icons.py` draws from the same proportions. Change
the geometry in the script's constants, run it, and mirror the change in the
two SVGs.

The banner at the top of this file is still the older raster artwork
(`logo.png`); it is not used anywhere in the app.

## Limits

Deliberate, and worth stating rather than discovering:

- **Both devices must be online at once.** No store-and-forward.
- **Two devices per room.** A third gets `full`.
- **Rooms live in one process's memory,** so both peers must reach the same
  instance. Sticky sessions reduce mismatches but do not eliminate them; the
  durable fix is Redis pub/sub keyed by room code.
- **One live stream per session,** and starting one replaces whatever is
  running.
- **Live media needs WebRTC.** The file path falls back to the relay when a
  direct connection fails; a camera or screen share does not, and says so.
- **Screen sharing is desktop-only,** because `getDisplayMedia` is. Watching
  someone else's screen works everywhere.
- **No accounts, no history, nothing persists** past the session. That is the
  product, not a missing feature.

## License

[MIT](LICENSE) © Pritam Karar

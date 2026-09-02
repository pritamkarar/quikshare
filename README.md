# Quik Share

<p align="center">
  <img src="logo-banner.png" alt="Quik Share" width="620" />
</p>

<p align="center">
  <strong>Private device-to-device sharing, right from your browser.</strong>
</p>

<p align="center">
  Transfer files, notes, screenshots, camera and screen between devices.<br>
  No account. No installation. No cloud upload.
</p>

<p align="center">
  <a href="https://quikshare.qd.je"><strong>🚀 Try Quik Share</strong></a>
  &nbsp; · &nbsp;
  <a href="#self-hosting"><strong>Self-host</strong></a>
  &nbsp; · &nbsp;
  <a href="#security"><strong>Security</strong></a>
</p>

<p align="center">

![License](https://img.shields.io/github/license/pritamkarar/quikshare)
![GitHub stars](https://img.shields.io/github/stars/pritamkarar/quikshare)
![GitHub issues](https://img.shields.io/github/issues/pritamkarar/quikshare)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933)
![WebRTC](https://img.shields.io/badge/WebRTC-supported-blue)

</p>

---

## What is Quik Share?

**Quik Share is an open-source, privacy-focused alternative to cloud-based file sharing.**

Open Quik Share on two devices, pair them with a QR code or short code, and start sharing.

When possible, data travels **directly between the two devices using WebRTC**. If a direct connection cannot be established, Quik Share can fall back to an encrypted WebSocket relay.

The relay does not receive your plaintext files.

```text
                 ┌─────────────────────┐
                 │     Quik Share      │
                 │   encrypted relay   │
                 └──────────┬──────────┘
                            │
                  signaling / fallback
                            │
             ┌──────────────┴──────────────┐
             │                             │
        ┌────▼────┐                   ┌────▼────┐
        │ Device A│◄──── WebRTC ─────►│ Device B│
        └─────────┘      when possible └─────────┘
```

### No account

Just open the website.

### No installation

Everything works in a modern browser. Installing the PWA is optional.

### No cloud storage

Files are not uploaded to object storage or saved by the relay.

### End-to-end encrypted

Content is encrypted in the browser before it leaves the device.

### Works across devices

Use it between phones, laptops, tablets and desktops without requiring the same operating system.

### Open source

Inspect the code, self-host the service, or contribute improvements.

---

## 🚀 Try it

**[Open Quik Share →](https://quikshare.qd.je)**

1. Open Quik Share on both devices.
2. One device creates a sharing session.
3. Scan the QR code, type the short code, or open the sharing link.
4. Confirm that both devices display the same verification number.
5. Start sharing.

That's it.

---

## What can you share?

| Feature               | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| 📁 **Files**          | Transfer files and folders between devices                      |
| 📝 **Notes**          | Send text without another messaging service                     |
| 📋 **Clipboard**      | Paste screenshots or clipboard content directly into a session  |
| 📷 **Camera**         | Share a live camera stream                                      |
| 🖥️ **Screen**        | Share your screen with another device                           |
| 📱 **PWA**            | Optionally install Quik Share and use the OS share sheet        |
| 🔐 **Encryption**     | Content is encrypted before leaving the browser                 |
| 🌐 **WebRTC**         | Direct peer-to-peer transport when available                    |
| 🔄 **Relay fallback** | Encrypted WebSocket transport when direct WebRTC cannot connect |

---

# Why Quik Share?

Traditional file-sharing services often require you to:

* upload your file to a server
* wait for the upload
* generate a link
* share the link
* download the file again
* trust a third party with your data

Quik Share takes a different approach.

```text
Traditional

Phone
  │
  ▼
Cloud upload
  │
  ▼
Server
  │
  ▼
Download
  │
  ▼
Laptop


Quik Share

Phone
  │
  ├──────────── encrypted ────────────┐
  │                                   │
  ▼                                   ▼
Device A  ◄────── WebRTC ───────►  Device B
```

When direct WebRTC is available, the relay is not carrying the file data at all.

When direct connectivity is unavailable, Quik Share can use its encrypted relay path so that transfers can still work.

---

# 🔐 Security

Security is part of the design rather than something added after the fact.

## End-to-end encryption

Each device generates an ephemeral **P-256** key pair.

The public keys are exchanged through the authenticated session and both devices derive the same session key using:

* ECDH
* HKDF
* AES-256-GCM

The relay never receives the derived encryption key.

Content is encrypted in the browser before it is transmitted.

---

## Man-in-the-middle verification

A relay could theoretically attempt to replace public keys during pairing.

To address this, Quik Share derives a **six-digit verification number** from the shared secret.

Both devices display the number.

```text
Device A                         Device B

   482913   ◄────────────────►   482913

              ✓ Match
```

If an attacker establishes different secrets with the two devices, the numbers will not match.

The users should only continue when the displayed numbers agree.

---

## The relay is treated as an adversary

The protocol does not assume that the relay is a trusted transport.

Frames are authenticated using AES-GCM.

Frame headers are authenticated as additional authenticated data, and transfer data binds its byte offset into the authenticated data.

This means an intermediary cannot simply modify, reorder, duplicate or splice encrypted frames without detection.

---

## No file storage

The server is designed as a **stateless relay**.

It does not use:

* a database
* object storage
* permanent file storage

File bytes are not intentionally written to disk or logged by the relay.

Rooms exist in memory and disappear when the session ends or expires.

---

# 🌐 Transport architecture

Quik Share uses two transport layers for file transfer.

### 1. WebSocket relay

The initial connection uses the WebSocket relay.

This provides a reliable baseline even when direct peer-to-peer connectivity is unavailable.

### 2. WebRTC

After pairing, Quik Share attempts to upgrade the file connection to a direct WebRTC data channel.

```text
                 Pair
                  │
                  ▼
             WebSocket
                  │
                  ▼
          Try WebRTC upgrade
             /          \
            /            \
       Success           Failure
          │                 │
          ▼                 ▼
       Direct            Relayed
       WebRTC           WebSocket
```

The UI explicitly shows whether the current transfer is **Direct** or **Relayed**.

The file-transfer layer does not need to know which transport is currently underneath it.

---

# 📷 Camera & screen sharing

Live media uses a separate WebRTC connection from file transfer.

This keeps media failures isolated from file transfers already in progress.

### Camera

Depending on browser capabilities, camera sharing supports:

* mute
* camera switching
* torch control where available

### Screen

Screen sharing supports different quality priorities:

* **Text** — prioritize readable content
* **Motion** — prioritize frame rate
* **Data** — prioritize bandwidth efficiency

Nothing is recorded.

Live media exists only for the duration of the session.

> Browser support for camera and screen capture varies by platform. HTTPS is required.

---

# 📦 Large file transfers

Quik Share is designed to handle files beyond the size where creating a giant in-memory Blob is practical.

Transfers are:

* chunked
* encrypted
* processed in a Web Worker
* streamed to the browser's available saving mechanism

The application selects an appropriate saving strategy based on browser capabilities.

This allows large transfers without forcing the entire file through the UI thread.

---

# 📋 Clipboard sharing

Have a screenshot on your clipboard?

Just press:

```text
Ctrl + V
```

or:

```text
⌘ + V
```

Quik Share can send clipboard content directly through the active session.

No need to:

1. save the screenshot
2. find the file
3. open a file picker
4. upload it
5. delete it afterwards

---

# 📱 Progressive Web App

Quik Share is a PWA.

Installation is optional.

On supported platforms, installing Quik Share also allows it to participate in the operating system's share sheet.

For example:

```text
Gallery
   │
   │ Share
   ▼
Quik Share
   │
   ▼
Choose paired device
   │
   ▼
Transfer
```

---

# 🛠️ Self-hosting

Quik Share is designed to be self-hostable.

The server is a small stateless relay with a static client bundle.

## Requirements

* Node.js **22+**
* A modern browser
* HTTPS in production

HTTPS is required because browser APIs used by Quik Share—including camera access, screen capture, WebRTC and service workers—require a secure context.

---

## Quick start

Clone the repository:

```bash
git clone https://github.com/pritamkarar/quikshare.git
cd quikshare
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev:server
```

In another terminal:

```bash
npm run dev:client
```

Then open the Vite URL in two browser windows.

---

# 🐳 Docker

Build the image:

```bash
docker build -t quik-share .
```

Run it:

```bash
docker run --rm -p 8787:8787 quik-share
```

For a complete production deployment—including reverse proxy and optional TURN configuration—see:

**[`docs/deployment.md`](docs/deployment.md)**

---

# 🧪 Testing

Quik Share includes unit, UI, integration and end-to-end tests.

Run the test suite:

```bash
npm test
```

Type-check:

```bash
npm run typecheck
```

Run browser end-to-end tests:

```bash
npm run test:e2e
```

The browser tests cover real two-peer scenarios including file transfer and WebRTC transport behavior.

The project also includes accessibility testing for keyboard navigation, focus visibility, mobile layouts and other UI behavior.

---

# 🏗️ Architecture

```text
shared/
├── wire types
├── room codes
├── signal parsing
├── device information
└── media signals

server/
├── Fastify server
├── WebSocket relay
├── room management
├── rate limiting
└── TURN credential handling

client/
├── crypto/
├── session/
├── transfer/
├── transport/
│   ├── relay
│   └── WebRTC
├── media/
├── save/
├── share/
├── worker/
├── hooks/
├── UI
└── service worker
```

The important architectural boundary is:

```text
             ┌──────────────────────┐
             │    Transfer layer    │
             └──────────┬───────────┘
                        │
                 transport seam
                        │
              ┌─────────┴─────────┐
              │                   │
         WebSocket             WebRTC
           relay                direct
```

The transfer implementation does not need to care whether its encrypted frames are currently travelling through WebSocket or WebRTC.

---

# 🔍 Debugging transport

To force the relay transport during development:

```text
?forceTransport=relay
```

For example:

```text
http://localhost:5173/s/K7M3QP?forceTransport=relay
```

This is useful for testing the fallback path deterministically.

---

# ⚙️ Configuration

Important production variables include:

| Variable           | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `PORT`             | Server listening port                               |
| `HOST`             | Server bind address                                 |
| `NODE_ENV`         | Production/development mode                         |
| `TRUST_PROXY`      | Trusted proxy configuration for client IP detection |
| `VITE_STUN_URLS`   | STUN servers baked into the client at build time    |
| `TURN_URLS`        | TURN servers for live media                         |
| `TURN_USERNAME`    | Managed TURN credential username                    |
| `TURN_CREDENTIAL`  | Managed TURN credential password                    |
| `TURN_SECRET`      | Shared secret for self-hosted coturn                |
| `TURN_TTL_SECONDS` | Lifetime of generated TURN credentials              |

See **[`docs/deployment.md`](docs/deployment.md)** for the complete configuration and deployment model.

---

# 🤝 Contributing

Contributions are welcome.

If you find a bug, have an idea, or want to improve the implementation:

1. Fork the repository.
2. Create a branch.
3. Make your change.
4. Run the tests.
5. Open a pull request.

Before submitting:

```bash
npm test
npm run typecheck
npm run test:e2e
```

If you're planning a larger change, opening an issue first is encouraged.

---

# 🗺️ Roadmap

The roadmap is intentionally driven by real-world use rather than adding features for the sake of features.

Areas of interest include:

* [ ] Improved mobile browser support
* [ ] More browser compatibility testing
* [ ] Better transfer recovery/resume behavior
* [ ] Additional deployment examples
* [ ] More self-hosting documentation
* [ ] Improved discovery and pairing UX
* [ ] More accessibility improvements
* [ ] Community-contributed integrations

Have an idea?

**[Open an issue →](https://github.com/pritamkarar/quikshare/issues)**

---

# 📜 License

Quik Share is released under the **MIT License**.

See [`LICENSE`](LICENSE).

---

# ⭐ Support the project

If Quik Share is useful to you:

* ⭐ **Star the repository**
* 🐛 Report bugs
* 💡 Suggest improvements
* 🧑‍💻 Contribute code
* 📖 Improve the documentation
* 🗣️ Tell someone who might use it

**[⭐ Star Quik Share on GitHub](https://github.com/pritamkarar/quikshare)**

---

<p align="center">
  <strong>Share directly. Keep control.</strong>
</p>

<p align="center">
  <a href="https://quikshare.qd.je">quikshare.qd.je</a>
</p>

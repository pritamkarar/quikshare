# Deployment

Quik Share is a tiny stateless relay plus a static client bundle. This
document is what an operator needs to run it.

## HTTPS is mandatory, not optional

`getUserMedia` (the QR scanner), `RTCPeerConnection` (the WebRTC transport),
and the service worker (streamed downloads) all require a secure context.
Browsers only waive that requirement for `localhost`. Serve the app over
plain HTTP anywhere else and those three features simply do not work — the
app is not "degraded," it is unusable. Terminate TLS in front of it; see
**Reverse proxy** below.

## Local development against a phone

`localhost` is a secure context, but your phone cannot reach your laptop's
`localhost`. Two ways to test on a real device during development:

- **Tunnel** the dev server (e.g. a `ngrok http 5173`-style tool) and open
  the HTTPS URL it gives you on the phone.
- **Local certificate**: generate one with [`mkcert`](https://github.com/FiloSottile/mkcert)
  and run Vite with `--https`, pointing it at the generated cert and key.
  A self-signed certificate must also be installed and trusted on the phone
  itself, or its browser will refuse the same secure-context APIs.

## Reverse proxy

Put a reverse proxy in front of the Node process for TLS termination and to
proxy the `/ws` WebSocket upgrade.

**Caddy** is the shortest path — it obtains and renews certificates
automatically and proxies WebSockets with no extra configuration:

```
share.example.com {
    reverse_proxy localhost:8787
}
```

`reverse_proxy` already appends the connecting address to `X-Forwarded-For`
and proxies WebSockets, so nothing else is needed for the rate limits to
work — set `TRUST_PROXY=true` (see below) and Caddy's own header handling
does the rest.

**nginx** needs three things spelled out explicitly that Caddy does for
free: the `Upgrade`/`Connection` headers that turn the request into a
WebSocket upgrade, the forwarded-address headers (nginx sends **no**
`X-Forwarded-For` at all unless told to, so without these `TRUST_PROXY` has
nothing to read and every client still shares one bucket), and a
`proxy_read_timeout` generous enough that an idle-but-paired session (both
peers connected, waiting on a QR scan or a large file to keep streaming)
isn't culled mid-transfer by nginx's default 60-second read timeout.

```
location /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
}
```

**`TRUST_PROXY` — set this correctly or the per-IP rate limits stop meaning
anything.** The relay's `create`/`join`/`rtc` rate limits are keyed by the
connecting client's IP address. That address means different things
depending on your setup, and getting this wrong breaks the limits in one
direction or the other:

- **Behind a reverse proxy on this same host** (the Caddy and nginx examples
  above both proxy to `localhost`): set `TRUST_PROXY=true`. Without it, every
  client's connection appears to come from the proxy's own address, so all of
  them share one rate-limit bucket — one abusive client can lock out everyone
  else.
- **Behind a proxy somewhere else** (a container network, a load balancer on
  another node): set `TRUST_PROXY` to that proxy's address or subnet instead —
  an IP, a CIDR, or a comma-separated list of them (e.g.
  `TRUST_PROXY=10.0.0.0/8`). `true` vouches for the loopback interface only,
  so with the proxy elsewhere it would (safely, but unhelpfully) ignore the
  header and merge every client into one bucket. **A relay in a container is
  this case**, not the first one: it sees the bridge gateway (`172.17.0.1` and
  similar), not loopback. The startup log line says which of the two you
  actually got — check it once after deploying.
- **Exposed directly**, with no reverse proxy in front of it: leave
  `TRUST_PROXY` unset.

`TRUST_PROXY` names *which hop you trust*, never "trust the header". The
address it resolves to is the only one allowed to speak for the chain: the
server walks `X-Forwarded-For` from the right and stops at the first entry
that hop cannot vouch for. That matters because both Caddy's `reverse_proxy`
and nginx's `$proxy_add_x_forwarded_for` **append** rather than overwrite —
anything the client itself sent stays in front of the address the proxy
actually saw — so a setting that trusted the whole chain would read the
client's own invention and hand out a fresh budget per connection. Walking
from the right lands on the address the proxy observed under both the
appending and the overwriting (`$remote_addr`) styles, and ignores the header
entirely on a connection that did not come from the trusted proxy at all.

`true`/`false` are read case-insensitively and ignore surrounding whitespace.
A bare number is rejected outright: every other framework's equivalent
setting takes a *hop count*, and this one does not — `TRUST_PROXY=1` would
otherwise be read as the address `0.0.0.1`, trust nobody, and merge every
client into one bucket silently. Any other unparseable value fails at startup
too, with a message naming the variable, rather than quietly falling back to
a weaker setting.

One limit worth stating plainly: address trust vouches for an *address*, not
for a process. `TRUST_PROXY=true` trusts **every** client connecting from
loopback, not only your proxy — so any other process on that host (or in a
container sharing its network namespace) can set `X-Forwarded-For` freely and
mint unlimited rate-limit identities. That is inherent to how forwarded
addresses work and is the safe direction of the trade — the alternative is
trusting the header from everyone — but do not read it as "only the proxy can
do this".

## Environment

| Variable          | Read by       | Purpose                                                                                     |
| ----------------- | ------------- | --------------------------------------------------------------------------------------------- |
| `PORT`            | server        | TCP port the relay listens on. Defaults to `8787`. Must be an integer from 1 to 65535 — an empty or malformed value fails at startup rather than silently binding a random ephemeral port. |
| `HOST`            | server        | Address the relay binds to. Defaults to `0.0.0.0` (all interfaces) so it's reachable through a reverse proxy or container port mapping. |
| `NODE_ENV`        | server        | Set to `production` to serve the built client (`dist/client`) and its SPA fallback. Unset (or anything else) assumes Vite is serving the client separately, as in local development. |
| `TRUST_PROXY`     | server        | Which hop may speak for `X-Forwarded-For` when attributing a client IP for rate limiting (see above). `true` = a proxy on this host (loopback); an IP/CIDR list = a proxy at those addresses; unset = trust nobody and use the raw socket address. |
| `VITE_STUN_URLS`  | client, build time | Comma-separated STUN server URLs baked into the client bundle at build time (`vite build`), used to gather WebRTC ICE candidates. Empty or unset falls back to a public default. Changing it requires rebuilding the client — it cannot be set at container-run time; for a container build pass it as `docker build --build-arg VITE_STUN_URLS=...`. |
| `TURN_URLS`       | server        | Comma-separated `turn:`/`turns:` URLs handed to the client as ICE servers, for live media (see **TURN** below). Unset means TURN is not offered — a fully supported deployment. Setting this *without* `TURN_SECRET` (or vice versa) fails at startup rather than silently minting credentials nothing can verify. A `stun:` or other scheme in the list also fails at startup: STUN needs no credential and is a build-time client setting (`VITE_STUN_URLS`), not a server one, so one here is almost always a copy-paste mistake. A value that is only commas and whitespace fails too, rather than quietly behaving like "unset" — that would mask a broken variable as a working absence of one. `docker-compose.yml` goes further and *requires* this variable rather than defaulting it, for the reason given under **TURN** below. A `turns:` URL is accepted by the relay, but only points somewhere real against a provider that terminates TLS — the bundled `coturn` service is configured with no certificate (see **TURN**). |
| `TURN_SECRET`     | server        | The `static-auth-secret` coturn was started with (`docker-compose.yml`'s `coturn` service reads it from `coturn/turnserver.conf`). The relay never puts it in a response or a log line — only its *effect*, an HMAC over a username, leaves this process. That is a statement about the relay, not about the deployment: see **Where the secret is readable** under **TURN** for the copies that exist outside it. Must be byte-identical to coturn's own secret or every minted credential is silently rejected at the relay; there is no way to detect that mismatch from this process, so if TURN "isn't working" after a deploy, this is the first thing to diff. Required together with `TURN_URLS` (see above). **A stray value blocks startup:** the name is generic enough that a shared PaaS environment may already carry a `TURN_SECRET` for something else, and the relay now validates TURN configuration on every boot — so a half-set pair refuses to start rather than starting misconfigured. That is deliberate; if you hit it on a deployment that has nothing to do with TURN, unset the variable rather than inventing a `TURN_URLS` to satisfy it. |
| `TURN_TTL_SECONDS`| server        | Lifetime, in seconds, of a minted TURN credential. Defaults to `600` (ten minutes) — long enough for one share attempt, short enough that a leaked response stops being useful quickly. Must be an integer from 1 to 3600; the ceiling exists because `/turn` is unauthenticated, so raising the TTL directly raises how long a leaked response stays a working credential against your relay. Do not "fix" a perceived flakiness by raising this — see **TURN** below for what actually bounds abuse of the endpoint. |

## TURN

**Live media has shipped, and this is the setting that decides whether it
works for anyone who is not on your LAN.** `client/media/ice.ts` fetches
`GET /turn` once per share attempt and merges whatever it returns into the
media `RTCPeerConnection`'s ICE servers. With nothing configured the app says
so in the UI — the Live card carries a line about having no relay — and then
tries anyway, which succeeds far more often than it sounds like it should and
fails exactly where a relay is the only answer.

TURN exists for one thing: live camera/screen media (`RTCPeerConnection`) has
no fallback the way file transfer does. A file transfer that cannot open a
direct WebRTC data channel falls back to the WebSocket relay and keeps
working — that path is the product's always-works baseline, and TURN changes
nothing about it. Live media has no such baseline. On a network that blocks
peer-to-peer traffic outright (a symmetric NAT, a corporate firewall that
drops UDP), a live connection with no TURN server simply cannot connect, full
stop — there is nothing else to fall back to. `docker-compose.yml` includes a
`coturn` service for exactly this reason; pointing `TURN_URLS` at a managed
provider (Cloudflare, Twilio, Metered all speak the same REST convention) is
an equally valid deployment choice.

### Two credential styles, and picking one

A TURN server accepts one of two things, and which one is a fact about the
server rather than a preference:

- **`TURN_SECRET`** — coturn's `use-auth-secret` convention. This process signs
  a short-lived credential (`base64(HMAC-SHA1(secret, "<expiry>:quikshare"))`)
  and coturn recomputes the same thing to verify it. The secret never leaves
  the process. This is the shape for a coturn you run yourself.
- **`TURN_USERNAME` + `TURN_CREDENTIAL`** — a long-lived pair issued by a
  managed provider's dashboard, which `GET /turn` forwards unchanged. The
  password half *does* reach the browser, because the browser is what
  authenticates with it; it is a password to one provider account, not a key
  that mints unlimited credentials the way `TURN_SECRET` is. Rotate it in the
  provider's dashboard.

Setting both is a startup error. They describe two different servers, and
choosing one for you would leave half the configuration silently inert. The
startup line names which style is live: `600s signed credentials` or
`provider credentials (fixed pair)`.

### A managed provider (Metered)

The zero-infrastructure path, and the one to start on: no VM, no firewall
rules, no ports to forget. [Metered](https://dashboard.metered.ca) is free for
500 MB of relayed traffic a month with no card, or 20 GB with one.

Budget that in minutes rather than megabytes, because it is smaller than it
looks: a relayed camera stream runs roughly 1 Mbit/s, so 500 MB is about an
hour of *relayed* video a month and 20 GB is about forty. Only sessions that
cannot find a direct path spend any of it — two devices on one wifi network
never touch TURN at all.

1. Sign up, open **TURN Server**, and click **Add Credential**. Dashboard
   credentials do not expire; there is a separate REST flow for expiring ones
   that this app has no use for.
2. Open **Show ICE Servers Array** and copy the username, the password, and
   the URLs.
3. Set three variables on the service, and leave `TURN_SECRET` **unset**:

   ```
   TURN_URLS       = turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp
   TURN_USERNAME   = <from the dashboard>
   TURN_CREDENTIAL = <from the dashboard>
   ```

**Do not paste the `stun:` entry into `TURN_URLS`.** Metered's array leads
with `stun:stun.relay.metered.ca:80`, and this relay refuses a `stun:` URL at
startup rather than accepting it: STUN needs no credential, so an entry there
would be handed to the browser carrying a username and password that mean
nothing. STUN is a build-time client setting (`VITE_STUN_URLS`), and the
default list already carries three.

Keep all four `turn:`/`turns:` entries rather than trimming to the first. They
are the same server reached four ways, and the reason to carry the list is the
last one: `turns:` on 443 over TCP is indistinguishable from ordinary HTTPS to
a network that drops everything else, which is precisely the network where a
relay is the only thing that will work.

### Render, with coturn on its own host

Render is worth spelling out because it is the case where the obvious move is
impossible: **a Render web service cannot host TURN, at any plan.** It gives
you one HTTP port behind Render's load balancer, and TURN needs UDP 3478 plus
a whole relay port range reachable directly by the browser. So the relay and
coturn end up on different machines — which costs nothing, because the relay
never dials coturn. It only computes `base64(HMAC-SHA1(secret, username))`
(`server/turn.ts`); coturn independently recomputes the same thing and
compares. The only thing crossing between the two machines is a secret that
has to be byte-identical on both, and it crosses by you pasting it twice.

`render.yaml` already declares `TURN_URLS` and `TURN_SECRET` as `sync: false`,
so Render prompts for both on first apply and stores them on the service
rather than in the repo.

**One thing that surprises people: plain `turn:` is fine from an HTTPS page.**
ICE is not subject to mixed-content rules the way `fetch` and WebSocket are, so
a `turn:` URL over UDP works from a page served over TLS and needs no
certificate. `turns:` on 443 buys you one thing — getting through networks that
block UDP outright — and costs you a certificate coturn has to load. Start
without it.

**On the TURN host** (any VM with a public IP: Hetzner, DigitalOcean, Oracle's
free tier, a spare box). Clone this repo for the hardened `coturn` service in
`docker-compose.yml`, write the secret into the file coturn reads, and start
that service alone:

```bash
export TURN_SECRET=$(openssl rand -hex 32)
export TURN_URLS=turn:turn.example.com:3478   # only for compose interpolation here
mkdir -p coturn
( umask 077; printf 'static-auth-secret=%s\n' "$TURN_SECRET" > coturn/turnserver.conf )
docker compose up -d coturn
```

Naming only `coturn` is what keeps the relay out of it — the service has no
`depends_on`, so nothing else starts. `TURN_URLS` is exported only because
Compose interpolates the whole file before deciding what to run; coturn itself
never reads it.

**Open the ports, and remember the range.** UDP 3478 for the control channel,
and UDP 49160-49200 for the relay allocations themselves (`--min-port` /
`--max-port` in the compose file). Opening 3478 and forgetting the range is the
classic failure, and its symptom is the confusing one: ICE negotiates, a relay
candidate appears, and then no media ever arrives — which reads as an app bug.
On a cloud provider this means the security group *and* any host firewall.
Adding TCP 3478 is cheap and helps on networks that filter UDP.

**If the VM is behind 1:1 NAT, coturn needs to be told its own public
address.** AWS, GCP, Azure and Oracle all give the instance a private address
on its interface and map a public one to it; coturn, seeing only the private
address, will hand out relay candidates pointing at `10.x` or `172.31.x` and
nothing will ever connect to them. Hetzner and DigitalOcean put the public
address on the interface directly and need none of this. Where it applies, add
one line to the same file that holds the secret:

```
external-ip=203.0.113.10/10.0.0.5
```

**On Render**, set the two variables on the service (the blueprint prompts on
first apply; afterwards it is Dashboard → the service → Environment):

```
TURN_URLS   = turn:turn.example.com:3478
TURN_SECRET = <the same value you put in coturn/turnserver.conf>
```

`TURN_URLS` is the address the **browser** dials, so it is a public hostname or
IP — never a container name, never `localhost`. Render restarts the service on
save; the startup log then reads `TURN: 1 server(s), 600s credentials` instead
of `TURN: not configured`.

**Then prove it, because every layer above will look healthy while broken.**
`curl https://your-host/turn` returning a populated `iceServers` proves only
that the relay is minting — it says nothing about whether coturn accepts what
was minted, and a mismatched secret is invisible to both processes. Paste the
`urls`, `username` and `credential` from that response into
<https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/> and
look for a candidate whose type is **relay**. That line appearing is the whole
proof: the credential verified, the ports are open, and the allocation
succeeded.

**Both TURN variables are required by `docker-compose.yml`, on purpose.**
Neither `TURN_URLS` nor `TURN_SECRET` has a default there — compose refuses to
start if either is missing. For `TURN_SECRET` that is obvious. For `TURN_URLS`
it is worth explaining, because a default *looks* friendlier: the value is the
address the **browser** dials, so the only value that could serve as a default
is `turn:localhost:3478`, which is correct on a developer's own laptop and
silently wrong on every other deployment. The relay would start, log `TURN: 1
server(s)`, answer `/turn` with a well-formed credential, and hand every
browser an ICE server pointing at *that browser's own* loopback — healthy logs,
valid responses, no relay. The server code throws in four separate places to
prevent exactly that state; a compose default would reintroduce it one layer
up, where the code cannot see it. Put both in a `.env` file next to
`docker-compose.yml` (it is gitignored), using `turn:localhost:3478` for a dev
machine and a publicly reachable `host:port` for anything else.

**The shared secret is written to a file, not passed on coturn's command
line.** `docker-compose.yml` bind-mounts `coturn/turnserver.conf` into the
coturn container and starts it with `-c /etc/coturn/turnserver.conf`. You have
to create that file — it is not in the repo, because it holds a secret. With
the same value you put in `.env` exported in your shell (or pasted in place of
the expansion):

```bash
mkdir -p coturn
( umask 077; printf 'static-auth-secret=%s\n' "$TURN_SECRET" > coturn/turnserver.conf )
```

The `umask` is not decoration. `> file` creates it at the default umask
first — usually world-readable — so a `chmod 600` on the following line leaves
a window, however short, in which the secret is readable by anyone on the box.
Setting the mask in a subshell means the file is never created any other way.

Two things to know about it. First, if the file does not exist when you bring
the stack up, Docker creates a *directory* at that path and coturn fails
reading its configuration — that, not a permissions error, is the symptom of
forgetting this step. Second, `0600` assumes the container's coturn process
runs as the file's owner; if coturn instead exits complaining it cannot read
the configuration, that is a uid mismatch, and the fix is to widen the mode to
`0640` with a group coturn belongs to, or to pin `user:` on the service. *We
have not been able to exercise either case against a live daemon, so treat the
mode as a starting point to verify on first `up`, not as a tested value.*

This costs you one more file to manage and keeps two copies of the same secret
in sync (`.env` for the relay, `coturn/turnserver.conf` for coturn) — the
`printf` above derives the second from the first for that reason. A mismatch
between them is the failure mode described in the `TURN_SECRET` row above:
undetectable from either process, visible only as TURN never working.

**Where the secret is readable.** Worth being exact about, because "the secret
never leaves the process" is easy to over-generalise and it is not true of a
deployment as a whole:

- **Closed by the config file:** coturn's `/proc/<pid>/cmdline`, which is
  readable by any local user unless `/proc` is mounted with `hidepid`, and
  `docker inspect coturn`'s command/args. A flag value is visible to
  *everyone* on the box; that is the exposure that actually mattered, and it
  is the one moving the value into the file removes.
- **Still open, by design:** the relay receives `TURN_SECRET` as an environment
  variable, so it is in `docker inspect relay`'s config and in the output of
  `docker compose config` — compose interpolates variables when it renders the
  file, so anything it substitutes is echoed regardless of how the container
  ultimately consumes it. Do not paste `docker compose config` output into an
  issue tracker or a CI log.
- **Still open, and normal:** `.env` and `coturn/turnserver.conf` on disk, and
  anything with access to the Docker socket (which is root-equivalent anyway).
  `/proc/<pid>/environ` for the relay process is *not* in this list: unlike
  argv, it is readable only by the owning uid.
- **Closed by `.dockerignore`, and worth knowing about:** the relay's
  `Dockerfile` build stage is `COPY . .`, so anything left in the build context
  is baked into that stage's layer — reachable through `docker build --target
  build`, an exported build cache, or `docker history` on that stage, even
  though the runtime image copies only `dist`. `.env*` and `coturn/` are
  excluded for that reason. If you keep the secret in some other file in the
  repo root, exclude that too.

**`turns:` does not work against the bundled coturn.** The relay accepts a
`turns:` URL in `TURN_URLS`, and it is the right choice against a managed
provider — but the `coturn` service in `docker-compose.yml` is started with no
`--cert` and no `--pkey`, so it has no TLS material and its TLS listener will
not serve. The `--no-tlsv1`/`--no-tlsv1_1` flags there bound what TLS *would*
be if you added a certificate; they do not imply one is configured. Advertise
`turn:` for this service.

**The relay port range is the thing that gets forgotten.** coturn allocates a
fresh UDP port per relayed session out of a range you configure
(`--min-port`/`--max-port` in `docker-compose.yml`, `49160`–`49200` by
default) — TURN's control channel runs over port 3478, but the actual media
never touches it. Whatever range you set must be open as **UDP**, end to end,
on every firewall between the internet and the coturn host. Get this wrong
and the symptom is not an obvious network error: ICE negotiation completes,
both sides believe they are connected, and media simply never arrives. That
reads like a bug in the app or in WebRTC, not like a dropped UDP range, and it
is the single most likely thing to cost you a debugging session after this
deploys. If you run coturn behind Docker's default bridge networking instead
of `network_mode: host`, you additionally need to publish the *entire* port
range, not just 3478 — the compose file uses host networking specifically to
avoid that, because Docker's userland proxy does not forward a UDP range
reliably.

**The other way to get the same symptom is 1:1 NAT.** If coturn runs behind a
one-to-one NAT — EC2 with an Elastic IP, GCP, most VPS-with-floating-IP
setups — it sees only its private address on the interface and advertises
*that* as its relay candidate. ICE completes against an address the client
cannot route to, and again media never arrives. coturn's answer is
`--external-ip=<public-address>/<private-address>`, which makes it advertise
the public side while binding the private one. `docker-compose.yml` does not
set it, because the correct value is per-host and there is no sensible default;
add it to the `coturn` command if your host is in this shape. We have not
exercised this configuration here, so treat it as the pointer it is.

**`GET /turn` is unauthenticated, on purpose, and four separate bounds
constrain what that buys an attacker.** The client needs ICE servers before a
room exists, so there is nothing yet to authenticate the request against —
anyone who can reach the relay can call this endpoint and receive a working
TURN credential. Four independent things bound what that credential can do,
and each bounds a *different* axis, so none of them substitutes for another:

1. **A short credential lifetime** (`TURN_TTL_SECONDS`, default 600s / 10
   minutes, capped at 3600s). A leaked or intercepted credential stops
   working quickly. Raising this "to be safe" does the opposite — it directly
   extends how long a single leaked response stays usable.
2. **A tight per-IP rate limit on the endpoint itself** — far tighter than
   the pairing limits, because the honest use case calls it once per share
   attempt, not in the bursts that WebRTC signalling produces. There is no
   legitimate reason to fetch it ten times a minute. Dropping or loosening
   this budget is the "helpful" change most likely to look harmless and
   isn't.
3. **coturn's own `denied-peer-ip` restrictions** (below), which bound *where*
   a valid credential can relay to even after it is minted.
4. **coturn's volume bounds** — `--max-bps` (per session, in bytes per second;
   `1000000` ≈ 8 Mbit/s), `--total-quota` and `--user-quota` (concurrent
   allocations, server-wide and per credential). These bound *how much* a
   credential can move, which none of the first three do.

Do not raise the TTL, loosen the rate limit, or drop the deny rules or quotas
to chase down an unrelated problem — none of them are where a real
connectivity issue tends to live, and all four exist specifically to keep this
endpoint safe to leave unauthenticated.

**What these four bounds do *not* do is close the relay.** With every one of
them in place, anyone who can reach the URL can still mint a credential and
relay traffic — rate-limited, time-limited, quota-limited traffic — to
arbitrary **public** peers. That is inherent to running an unauthenticated TURN
endpoint at all, and no combination of these settings changes it; what they
change is the ceiling on the bill and the blast radius. The claim worth
defending precisely is the narrower one: the deny list is what stops a
credential being used as a hop into the operator's **private** network. That is
a genuine and important protection, and it is not the same thing as "not an
open relay". If you need the endpoint closed rather than bounded, the answer is
authentication in front of it, which this design deliberately does not have
(the client has nothing to authenticate with at the time it needs ICE servers).

Note also what `--user-quota` can and cannot key on here, because it explains
why the value is loose. The REST convention makes each username
`<expiry-timestamp>:quikshare`, so the "user" is the expiry **second**: every
client minting within the same second shares one quota, and a client that waits
a second gets a fresh one. Neither direction rewards a small number. An
attacker just mints again — so the bounds that actually constrain them are the
rate limit and `--total-quota`. Honest traffic, meanwhile, pays immediately:
Chrome opens one relay allocation per local interface, so a multi-homed laptop
(Wi-Fi + Ethernet + VPN) spends three or four by itself, and a handful of
clients starting in the same second would collide and receive
`486 Allocation Quota Reached` — a failure with no visible cause, on real
users, from a control the abuser routes around. `30` therefore tolerates a
same-second cohort of roughly seven multi-homed browsers while still stopping
one credential taking more than a third of the server. If you do see `486` in a
coturn log, this and `--total-quota` are the two settings that produce it.

And `--total-quota` is a
server-wide ceiling, so it is a trade rather than a free win: an abuser who
fills those allocations denies service to everyone else. That is the better of
the two failures, but the number is a capacity decision worth revisiting for
your deployment rather than a default to leave unexamined.

**`denied-peer-ip` is not optional hardening — it is the difference between a
TURN server and an open door into your private network.** A TURN relay, by
design, forwards UDP packets to whatever peer address the client asks it to.
Without a deny list, anyone who obtains a credential (see above — that's
anyone who can reach `/turn`) can ask coturn to relay traffic to
`10.0.0.1`, `169.254.169.254` (cloud metadata endpoints), or any other
address on the host's private network, using the TURN server itself as the
hop in. `docker-compose.yml`'s `coturn` command denies the standard private,
loopback, link-local, and multicast ranges for exactly this reason.

**`100.64.0.0/10` belongs on that list and is easy to leave off.** RFC 6598
shared address space is not a documentation range: it is CGNAT space, several
managed cloud networks use it for internal addressing, and it is the entire
Tailscale range. A host that has joined a tailnet and is running an
unprotected relay exposes the whole tailnet to anyone holding a credential —
the same hop these rules exist to close, reached through an address block that
does not look private at a glance. `docker-compose.yml` denies it; so should
any configuration you write yourself.

Two ranges that need **no** rule, so that a list without them does not look
incomplete: `224.0.0.0/4` and `240.0.0.0/4` (including the `255.255.255.255`
broadcast address) are already covered by `--no-multicast-peers`, because
coturn treats any IPv4 first octet above 223 as multicast. The remaining
entries on the usual hardening lists — `192.0.0.0/24`, `192.0.2.0/24`,
`198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24` — are documentation and
benchmarking ranges with no reachability story on a real host.

The one part of this that is easy to get wrong if you write your own coturn
config, or "clean up" what looks like a redundant list: **`--denied-peer-ip`
is address-family-specific.** Each rule matches only IPv4 addresses or only
IPv6 addresses — there is no single rule that denies a range for both
stacks — and coturn, with no `--listening-ip` set, binds *every* IPv4 and
IPv6 address on the host by default. That combination means an IPv4-only deny
list (the familiar `10/8`, `172.16/12`, `192.168/16`-shaped ranges) is not
merely incomplete on a dual-stack host, it leaves the entire IPv6 private
address space reachable through the relay unfiltered — and dual-stack is the
common case on a cloud VM, not an edge case. `docker-compose.yml` therefore
carries IPv6 rules for the private, loopback, link-local and site-local cases
alongside the IPv4 ones: `::1`, `fe80::/10`, `fc00::/7`, and deprecated
site-local `fec0::/10` (RFC 3879 — rarely assigned now, but nothing filters it
otherwise). Not every IPv4 rule has an IPv6 counterpart, and does not need
one: `0.0.0.0/8` has none because coturn rejects the unspecified address
natively rather than by range, and `100.64.0.0/10` has none because RFC 6598 is
an IPv4-only allocation — the IPv6 addressing of the tooling that uses it
(Tailscale's `fd7a:115c:a1e0::/48`, for one) sits inside `fc00::/7` and is
already covered.

Four further rules deny the IPv4-in-IPv6 encodings —
`::ffff:0.0.0.0-::ffff:255.255.255.255` (IPv4-mapped), `2002::/16` (6to4),
`64:ff9b::/96` (NAT64) and `::/96` (IPv4-compatible, deprecated by RFC 4291
§2.5.5.1). An address like `::ffff:10.0.0.1` is the *same* wire
address as `10.0.0.1` under a *different* address family, and re-encoding a
target this way has been usable elsewhere to walk straight past an IPv4-only
deny list (coturn advisory GHSA-j8mm-mpf8-gvjg / CVE-2026-27624). For the exact
image this file pins, that bypass is already closed upstream — coturn's
`ioa_addr_in_range()` canonicalizes all four encodings to their embedded IPv4
before any deny rule runs, so none of these four lines is closing an open hole
today. They earn their place as insurance against a floating tag:
`docker-compose.yml` pins `coturn/coturn:latest`, and these are the lines
standing between the IPv4 deny list and that bypass if a future build regresses
or an operator points the image at an older tag. All four encodings are named
by the same helper in the same branch chain upstream, which is why all four are
insured rather than only the mapped one — the argument for keeping any of them
is the argument for keeping all four. Note that 6to4, NAT64 and
IPv4-compatible are denied as whole prefixes rather than only their
private-IPv4 slices, so a public peer addressed through any of them is refused
too: acceptable collateral, since 6to4 and IPv4-compatible are both deprecated
(RFC 7526, RFC 4291), NAT64 is a translation prefix, and a dual-stack host
reaches public IPv4 peers natively without any of them. `::/96` spans `::` and
`::1`, which are refused already — denying them twice costs nothing and keeps
the range expressible as one rule.

If you maintain your own coturn configuration instead of the one in this repo,
carry the native IPv6 rules — dropping those *does* silently reopen the hole
this file exists to close, since nothing canonicalizes them away — and keep the
four encoding lines too, for the same floating-tag reason this file does.

**Verifying after deploying:**

```bash
curl https://your-host/turn
```

With `TURN_URLS` and `TURN_SECRET` set, this returns **`200`** with a
populated `iceServers` array — a `urls` list, a `username` shaped like
`<unix-timestamp>:quikshare`, and a `credential` — plus a nonzero `ttl`. With
neither set, it is still **`200`**, with `{"iceServers":[],"ttl":0}` — that is
success, not a failure to reach for here. The one other response you may see
is **`429`** with `{"error":"rate-limited"}`: the endpoint's per-IP budget is
deliberately tight (see above), so hitting it a handful of times in quick
succession while testing is expected, not a sign anything is broken — wait a
few seconds and retry. The startup log line also says so directly: it prints
either `TURN: <N> server(s), <ttl>s credentials` or `TURN: not configured
(live video will rely on a direct path)`, so a misconfiguration is visible
the moment the process starts rather than only when a client fails to
connect later. Note that a `200` here only confirms the relay is minting
credentials coturn *should* accept — `TURN_SECRET` mismatches between the
relay and coturn are not detectable from either process alone (see the
`TURN_SECRET` row above); confirming the full path requires a client behind a
network that forces the TURN relay, which is outside what either service can
self-check. Two ways to prove it end to end: paste the `urls`, `username` and
`credential` this endpoint returns into
<https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/> and
check that a candidate of type **relay** appears — nothing else proves coturn
accepted the credential — or point `turnutils_uclient` from the coturn package
at the same values.

**Running without TURN is fully supported.** Leave `TURN_URLS` and
`TURN_SECRET` unset and the relay answers `GET /turn` with
`{"iceServers":[],"ttl":0}` — not an error, not a degraded mode. Live media is
still attempted with STUN alone and often succeeds, particularly on a LAN or
behind NATs that allow simple hole-punching; it just has no relay fallback for
the networks that block peer-to-peer outright, and no second chance when STUN
itself fails to answer. File transfer is entirely unaffected either way,
because it never uses TURN in the first place — it stays on the WebSocket
relay as its own baseline (spec §4 D2).

One wrinkle if you deploy with the compose file: **`docker-compose.yml` is the
*with*-TURN deployment**, and both TURN variables are required there, so it
cannot be brought up in the no-TURN shape described in this paragraph. Running
without TURN means running the relay without that compose file — directly, or
from your own compose/manifest with the two variables omitted.

## Scaling

Rooms live in one process's memory — there is no shared store. Two peers
must land on the *same* instance to find each other, so:

- Run a single instance, or
- Enable sticky sessions on the load balancer, **and accept that this only
  reduces the chance of a mismatch, not eliminates it** — a peer can still
  reconnect and land on a different instance than the one holding its room.

The durable fix is Redis pub/sub keyed by room code, so any instance can
forward signals for any room. That's out of scope here and is recorded in
the design spec's deferred list, not an oversight.

## What is stored

Nothing. There is no database and no object storage. File contents are
end-to-end encrypted and pass through the relay only as ciphertext, which is
never written to disk or logged — the server forwards bytes between two open
WebSocket connections and keeps nothing once both peers disconnect. This is
the product's main claim: Quik Share never has a copy of what it moves.

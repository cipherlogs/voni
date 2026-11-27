# The Tuxler exit protocol, as the shipped client implements it

This document is a reading of Tuxler's own client source, not a guess. Every claim
below cites the file and the line it came from. It exists because the protocol is
undocumented and four rounds of probing were spent guessing at framing that the
source spells out.

## Provenance

| What | Where | Version | Read on |
|---|---|---|---|
| Chrome App (owns the tunnelling) | `~/Downloads/tux/____Originals/TuxlerApp` | 1.0.x, Aug 2019 | 2026-11-27 |
| Chrome extension (2019 shell) | `~/Downloads/tux/____Originals/TuxlerExt` | 1.0.5 | 2026-11-27 |
| Chrome extension (current) | `jpgljfpmoofbmlieejglhonfofmahini`, CRX3, unpacked in `/tmp/opencode/tux-latest/ext` | 3.1.26, MV3 | 2026-11-27 |

The current extension no longer contains any tunnelling code: it opens
`ws://127.0.0.1:<port>/tuxler` to a **native app** on the machine and hands it the
proxy setting (`js/background.js`, `_initPorts` builds the port sweep, skipping
12347, 23320 and 23321). The 2019 Chrome App is therefore the last readable copy
of the tunnel implementation, and the native app is the only place the live
protocol now exists. Anything below that the native app contradicts is the native
app's version.

## Two ports, not one

The relay hands the client **two adjacent ports per session**, and they carry
opposite directions of the same tunnel.

```
MAKE_SECOND_CONNECTION <p>
    TuxlerPort1 = p        the client connects its *second socket* here
    TuxlerPort2 = p + 1    every browser connection opens a fresh socket here
```

`ServerConnectionInstance.js:441-443`, and the second socket is dialled there too
(`:445`). Then the change-IP reply overrides port 2:

```js
function IPchanged(json, limit){
  if(json.status === "OK" && !limit)
    window.TuxlerPort2 = parseInt(json.port);
```

`ServerMessages.js:238-246`. So the port in `IP_CHANGED_SUCCESSFULLY` is **the
per-connection tunnel port**, and it is the port this repo already dials.

## Port 2: the client drives (this is the exit tunnel)

For **every** browser connection, `SocksConnection` opens a **new** TCP socket to
`CurrentServer:TuxlerPort2`, then writes the destination header, then the payload:

```js
if(window.redirect_tuxler){
  this_.redirected_tuxler = true;
  port_ = window.TuxlerPort2;
  host_ = window.CurrentServer;
}
...
this_.stage = STAGE.DEST_CONNECTED;
if(this_.redirected_tuxler)
  this_.sendServer(str2ab("<h>" + this_.host + "<p>" + this_.port + "</p></h>"), this_);
```

`SocksConnection.js:354-397`. `sendServer` masks outbound bytes, header included:

```js
for(var i = 0; i < bytes.length; i++) bytes[i] = bytes[i] ^= 0x73;
```

`SocksConnection.js:88-98`. Inbound (`sendBrowser`) is never masked. So the wire
format per connection is exactly: **`xor73("<h>host<p>port</p></h>")` followed by
`xor73(payload)`, replies raw**.

Consequences that matter for this repo:

- **One socket per browser connection.** Not one per exit, not one per click.
  Chrome opens several connections per page; each gets its own socket dialled to
  the same port. A socket is a single tunnel and is never multiplexed.
- **The session's second socket is not the tunnel.** It is a notification channel
  (below), which is why writing a tunnel header into it neither worked nor
  errored: the relay simply ignored the bytes and kept the socket open.
- The client refuses to tunnel to a banned range of its own accord
  (`Tunnel.js:186-196`, `SocksConnection.js:283-300`), and refuses `localhost`.
  We should keep an equivalent guard rather than trusting the relay.
- `window.SSL` is `false` in `config.js:6` and `SSLSOCKS` only applies when SSL is
  on, so the tunnel port is plaintext TCP. No TLS on the tunnel leg.

## Port 1: the relay drives (a notification channel)

The second socket never carries destination traffic. It carries counts:

```js
while ((idx1 = buf.indexOf("</C>")) !== -1 && (idx_ = buf.indexOf("<C>")) !== -1) {
  var num = buf.substr(idx_ + 3, idx1 - idx_ - 3);
  for (var i__ = 0; i__ < parseInt(num); i__++)
    window.tunnel_connection.newTunnel(window.CurrentServer, window.TuxlerPort1);
}
```

`ServerConnectionInstance.js:551-567`. Each `<C>N</C>` means "open N tunnels to
port 1 now". On each of those, the **relay** answers with the destination —

```js
var rgx = /<h>([\s\S]*?)(<p>)([\s\S]*?)(<\/p>)<\/h>/gm;
this_.h = matches[1];
this_.p = parseInt(matches[3]);
```

`Tunnel.js:186-190` — and the client then dials that destination and pipes both
ways (`Tunnel.js:196-240`). This is the reverse direction: the relay tells the
client where to go. It is not needed for an outbound click, but it explains the
`<h>`/`<p>` grammar appearing on both legs and it explains the socket we were
holding open in vain.

## Control channel essentials

Re-read from `ServerConnectionInstance.js` and matching what this repo already
does:

- Control: `serverN.ipsharkk.com:29990`, plaintext, UTF-16LE from the server,
  latin-1 to it, frames end at `</message>`.
- Handshake order: `CONNECT_LIST` (redirect, one entry consumed per connect) →
  conformance probes → `TEST_END` + `VERSION3` → 50 KB echo answered with
  `OK^^^…` → `MAKE_SECOND_CONNECTION` → `LOGIN{email;password;VERSION:6}` →
  `LOGIN_FINISHED` → `CONNECTED`.
- Keepalive: `I_AM_ALIVE` every `timeval - 10` seconds, `timeval` default 60 and
  adjustable by a `TIMEVAL` frame; the server may also send `I_AM_ALIVE`.
  `ServerConnectionInstance.js:16, 260-283`.
- `CurrentServer` is `server<N>.ipsharkk.com` where `<N>` comes from
  `CONNECT_LIST` and increments per reconnect (`ServerConnection.js:79-124`). A
  tunnel connection must therefore go to the **current** host, not a remembered
  one.

## Measured, on the live relay (2026-11-27)

Source reading predicts the framing; these runs proved it. All from a single home
egress with one session and one change per probe.

**The tunnel carries traffic.** Masked header on the port the change reply named,
then a real request:

```
no-header                port=32620  open-no-bytes in 9001ms
masked-header-only       port=32620  open-no-bytes in 8172ms
plain-header-only        port=32620  open-no-bytes in 9008ms
masked-header+http       port=32620  REPLIED in 1679ms bytes=931
    HTTP/1.1 200 OK | Server: cloudflare | CF-RAY: a60ff095c967
plain-header+http        port=32620  open-no-bytes in 8195ms
masked-header+http       port=32621  open-no-bytes in 8168ms   (change port + 1)
```

Three things settled at once:

1. **Silence is the protocol.** The relay never speaks until the payload arrives,
   and the payload only flows once the SOCKS request is granted. A client that
   waits for a byte before granting is deadlocked against itself. This is what
   refused four probe runs with `ERR_SOCKS_CONNECTION_FAILED` while the port was
   open and correct the whole time.
2. **The XOR-0x73 mask is required**, not decorative: the plain header is ignored.
3. **The change reply's port is the tunnel port**, and `port + 1` is not.

**One session, one live exit.** A newer change kills the older exit's port:

```
pool of 3 on one session:
  exit ...:30272  tunnel open → relay closed, no reply
  exit ...:31196  tunnel open → relay closed, no reply
  exit ...:30476  tunnel open → TLS hello → 200 OK      ← the newest change
two changes back to back:
  newest port=32404 → REPLIED 928 bytes
  older  port=32436 → ECONNRESET in 277ms
```

So a pool of five is not a pool: four of five exits are dead on arrival, and a
click that draws one fails. Rotation therefore has to spend a change per exit —
`POOL_LIVE_EXITS` is 1, and a release retires the exit instead of returning it to
a queue.

**End to end through the real client's SOCKS listener:**

```
socks5h://127.0.0.1:40463  https://example.com/      → 200 in 1.33s
                           https://api.ipify.org     → 104.49.96.125
pooled exit                                     was   104.49.96.125:30476
```

The address the world saw was the pooled exit's address, so the connection
really left through that US residential host — no direct fallback.

## What is still unknown

- Whether the relay tolerates **two sessions** from one machine holding two live
  exits at once. If it does, a real pool is possible as one session per exit, and
  the per-click change cost drops. Not tested: it needs a second login and a fresh
  bucket.
- Whether a child bucket (a second session tunneled through a parent exit) sees a
  different egress at the relay, and therefore its own change allowance. That is
  what `TUXLER_POOL_DEPTH` was built for and it has never been proved.
- `<C>N</C>` on port 1 is documented here from source but never exercised: nothing
  we do needs the relay to initiate.


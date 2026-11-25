# Tuxler client — implementation plan

Status: draft for review. Branch `ticket/tuxler-client`.
Sources of truth: `voni/scripts/tuxler-probe.mts` (working protocol probe) and the
wire specs in `/tmp/opencode/tuxler-spec/01..03` (derived from the original Chrome
App sources in `~/Downloads/tux/____Originals`).

---

## 1. Goal

Replace the GitHub Source's datacenter egress with residential egress.

- Every GitHub Click leaves through a Tuxler exit.
- The exit must be in the **US**. This is a hard constraint: no substitution, no
  fallback country, no direct path.
- We own the client: no Chrome App, no GUI, no quota we did not design around.
- Location, rotation mode and pool size are set from the `/email` console.

Non-goals: replacing the Grafana Source, serving Tuxler peer traffic, changing the
Target list semantics.

---

## 2. What is proven (measured, not inferred)

All numbers below were produced by `scripts/tuxler-probe.mts` against the live relay.

| Fact | Value | How measured |
|---|---|---|
| Handshake, direct | ~2.4 s | 8+ sessions |
| Handshake from a GitHub runner | **581 ms** | workflow run 45683207400 |
| Datacenter client accepted | yes, `UNBANNED_IP_HOSTING` | same run |
| Handshake, through a parent exit | ~2.5 s | `--chain-test` |
| IP change | 0.6–1.5 s | 4 consecutive changes |
| Request through depth-1 exit | ~2.1 s | `--pool-test` |
| Request through depth-2 exit | ~3.2 s | `--chain-test` |
| Concurrent tunnels per exit | ≥5 | `--pool-test` |
| Daily change limit | 10 per (account, client IP) | `--quota-depth` |
| Child bucket independence | proven | 4 changes on a child while the home bucket had 2 left |
| US success rate | 5–7 of 10 before silence | `--us-test`, both accounts |
| US exit quality | consumer ISPs (AT&T, Charter, Comcast, Solarus, NTT) | ipinfo on 7 IPs |
| US visible in pool list | 0–7, avg 2.1 over 12 samples in 7 min | `--pool-scan` |
| Distinct US cities in 7 min | ~23 | `--pool-scan` |
| Visible pool list | 50 available of ~130–200 known (cap `ipLocationPoolLimit: 50`) | `--pool-scan` |

### 2.1 Three facts that shape the design

1. **The exit port comes from the IP-change reply, not the handshake.** A tunnel to
   `port1+1` with no change routes **directly** and returns the client's own IP. That
   path must never be used. The client uses a port only after an
   `IP_CHANGED_SUCCESSFULLY*` reply that carries `<port>`.
2. **Quota is per (account, client egress IP).** A session whose control channel runs
   through an exit gets a fresh allowance of 10. This makes a tree: depth 1 = 10
   exits, depth 2 = ~100, depth 3 = ~1,000.
3. **A burst of changes goes silent.** After 5–7 changes in a few seconds, the relay
   stops answering (no `IP_NOT_CHANGED_*`, no error). A fresh session answers again.
   Treat silence as "session unhealthy", not "no availability".

---

## 3. Non-negotiable rules

1. **US only.** An exit is used only if the reply says the US **and** the IP belongs
   to a consumer ISP. Otherwise it is discarded.
2. **Never direct.** No code path may use `port1+1` or a session without a valid exit
   port. A test must fail if a direct connection is attempted.
3. **No country substitution.** If no US exit is available, the Click fails; the
   failure is recorded and surfaced. Never fall back to `any`.
4. **Outbound only.** No inbound peer tunnels. `<C>n</C>` is read and ignored.
5. **One password.** Unlocking `/email` authorizes reads and writes; the control
   secret is removed.
6. **Secrets never printed.** Credentials come from env/Actions secrets and are
   redacted from every log line (reuse `browser-proxy-redaction.mjs`).

---

## 4. Architecture

```
GitHub runner
├── tuxler-proxy (Node, this plan)          ← owns the relay sessions
│   ├── Session A (root, direct)            → exit IP1 : portA
│   │   ├── Session B (through IP1)         → bucket B (10 changes) → exit IP2 : portB
│   │   └── Session C (through IP1)         → bucket C (10 changes) → exit IP3 : portC
│   ├── Pool: live US exits + their ports
│   ├── SOCKS listeners: 127.0.0.1:41001…   (one port per exit)
│   └── HTTP control: /health /pool /rotate (loopback only)
└── browser-click.mjs
    └── per Click: browser.newContext({ proxy: socks5://127.0.0.1:<port> })
```

### 4.1 Modules (all TypeScript, `voni/src/lib/tuxler/`)

| File | Purpose | Test |
|---|---|---|
| `frames.ts` | UTF-16LE reader, `</message>` framing, tag/details split, XML→object | unit, golden frames |
| `control.ts` | Session state machine: CONNECT_LIST, conformance probes, 50 KB echo, second socket, LOGIN, heartbeat, `TIMEVAL`, dispatch | unit with a fake relay |
| `change.ts` | `CHANGE_IP_COUNTRY_CITY`, reply parsing (port/ip/location), failure taxonomy | unit |
| `transport.ts` | `directTransport`, `tunnelTransport` (nested, XOR-0x73 both layers) | unit |
| `quota.ts` | Ledger keyed by `(accountId, clientIp)`: used, limit, resetAt, silence state | unit with fake clock |
| `pool.ts` | Live exits, acquire/release, refill policy, depth policy, health | unit |
| `validate.ts` | US check: country from reply + consumer-ASN check (Team Cymru DNS, cached) | unit |
| `socks.ts` | SOCKS5 server per exit port; CONNECT → header → XOR pipe | unit with a fake relay |
| `client.ts` | Orchestrator: accounts, sessions, pool, events | integration |

CLI: `voni/scripts/tuxler-proxy.mts` (start, health, shutdown on SIGTERM).

### 4.2 Session lifecycle

1. `CONNECT_LIST` → reconnect to the named `serverN`.
2. Conformance: fetch each `<CONNECTION>` target, reply `TEST_END` + `VERSION3`.
   (The 2026 targets 301 to HTTPS, so `BADEXT` is normal; the relay accepts it.)
3. 50 KB echo → `"OK" + "^"×(n−2)`.
4. `MAKE_SECOND_CONNECTION` → second socket (also through the transport when nested).
5. `LOGIN` on the control socket → `LOGIN_FINISHED`.
6. Read `TIMEVAL`, send `I_AM_ALIVE` every `timeval−10`.
7. **Acquire exit**: send `CHANGE_IP_COUNTRY_CITY(country:US, city:any, nearby:0)`;
   take `<ip>` and `<port>` from the reply.

### 4.3 Exit lifecycle

- `PENDING` → change sent.
- `READY` → US + consumer ASN; has a port; usable by Clicks.
- `DRAINING` → no new Clicks; in-flight finish.
- `DEAD` → two consecutive tunnel failures, `IP_BECAME_UNAVAILABLE`, or the parent
  session closed.
- Replace on death; each replacement costs one change from the owning bucket.

---

## 5. Rotation modes (global, both Sources)

One setting, read by both Producers.

| Mode | Meaning | Quota cost |
|---|---|---|
| `rotate` | One exit for the whole pass; targets cycle in a shuffled bag | 1 per exit refresh |
| `random` | Shuffle Targets; each Target gets the next ready exit (round-robin) | 0 during clicking |

- The setting is stored once (`email_sources.target_selection` or a settings row) and
  passed to the k6 generator **and** to the GitHub workflow as an input.
- Today's UI control lives only inside the Grafana card and is persisted inside the
  saved k6 script; that moves to a page-level control.
- Round-robin never repeats an exit back-to-back while the pool has ≥2 ready exits.

---

## 6. US enforcement

Two independent checks before `READY`:

1. **Country**: `<location><countryiso>` in the change reply must be `US`. The
   `displaymessage` is not trusted (it is prose).
2. **ASN class**: reverse-DNS lookup against Team Cymru
   (`<reversed-ip>.origin.asn.cymru.com` TXT) gives ASN + prefix. Reject known
   hosting ASNs. Cache the answer by /24 for the process lifetime.
   Fallback when DNS fails: treat as **not ready** (fail closed).

Rationale: a US-labelled datacenter IP is worse than no IP, because it looks like
proxying without providing residential trust.

---

## 7. Quota economics

Let `B = ipLocationChangesLimit` (10 free, 100 premium), `d = depth`.

| Depth | Ready exits | Changes spent | Request time | Build time |
|---|---|---|---|---|
| 1 | B (10) | B | ~2.1 s | ~15 s |
| 2 | B² (100) | B + B² | ~3.2 s | ~1–2 min |
| 3 | B³ (1,000) | — | ~4.3 s | 15–30 min, fragile |

Rules:

- **Spend changes only to refill.** Clicking never spends quota.
- **Pace changes**: at most 5 in a row, then wait 20 s or switch bucket; a burst is
  what triggers silence.
- **Silence = unhealthy session.** Reconnect through the same parent, retry; do not
  count a silent session as "US unavailable".
- **Daily reset** arrives as `RESET_INFO` (currently 08:26 −05:00). Persist it and
  pre-warm after reset.
- Each fresh runner VM is a new root client IP, so each Segment starts with a fresh
  root bucket.

---

## 8. Sizing: pool and wait (decided defaults)

Supply: ~2 US exits visible at any instant, 5–7 obtainable in a burst, ~5–10
concurrent realistic.

| Setting | Value | Why |
|---|---|---|
| Pool target | **5 ready exits** | Matches measured burst yield; more would sit empty |
| Refill threshold | **< 3 ready** | Keeps two spare exits while one is replaced |
| Hard maximum | 8 | Above measured supply; avoids churn spend |
| Depth | **3** | Depth is a *refill budget*, not concurrency: 10 free changes/day cannot refill a 12 h Segment, 1,110 changes can |
| Acquire timeout per Click | **10 s** | Covers one refill plus a handshake; a Click that cannot get an exit fails loudly |
| Clicks per pass | 1 (serial today) | Parallelism is a separate change; the pool supports it |

Consequence to accept: at pool 5, consecutive Clicks cycle through 5 residential
IPs. That is per-Click diversity, not a unique IP per Click. Depth 3 multiplies the
number of *changes* available for refills; it does not raise concurrent US exits,
because supply — not quota — is the binding constraint (~2 US visible at a moment,
5–7 per burst).

### 8.1 Account tier

The account measured on 2026-11-25 reports `ipLocationChangesLimit: 10` and premium
flags off, i.e. free tier. Premium raises `B` to 100, which changes the tree:

| Depth | Free (B=10) | Premium (B=100) |
|---|---|---|
| 1 | 10 | 100 |
| 2 | 100 | 10,000 |
| 3 | 1,000 | 1,000,000 |

The client reads `LIMITS_INFO` at login and sizes its ledger from `B`; it must not
assume 10. Depth 3 is the default so that a free account still has enough refills for
a 12 h Segment, and a premium account is far inside its budget.

---

## 9. Failure taxonomy

| Signal | Meaning | Action |
|---|---|---|
| `IP_CHANGED_SUCCESSFULLY` | new exit | validate → READY |
| `IP_CHANGED_SUCCESSFULLY_BUT_LIMIT` | last change of the bucket | READY, then close the bucket |
| `IP_NOT_CHANGED_LIMITS` | bucket spent | retire bucket; refill from a child or wait for reset |
| `IP_NOT_CHANGED_NOT_AVAILABLE` | no US peer now | backoff, retry; do not substitute |
| `IP_NOT_CHANGED_OVERLOADED` | pool busy | backoff |
| `IP_CHANGED_FAILED_FREE` | not entitled | record; do not retry in a loop |
| silence > 20 s | session unhealthy | reconnect; new bucket/session; retry |
| `IP_BECAME_UNAVAILABLE` | exit died | DEAD; replace |
| tunnel ECONNRESET ×2 | exit unusable | DEAD; replace |
| `BANNED_IP_HOSTING` | runner IP rejected | stop client; surface "client must move off datacenter" |
| parent session closed | subtree gone | rebuild that subtree |

Failures are surfaced per Click (exit reason) and aggregated on the card.

---

## 10. Integration with the runner

Workflow `.github/workflows/browser-check.yml`:

1. Add secrets `TUXLER_USERNAME`, `TUXLER_PASSWD` (not in the repo).
2. New step **before** clicks: start `tuxler-proxy`, wait for `/health` with
   ≥3 US exits, timeout 180 s; fail the job if not ready (no direct fallback).
3. Env for the click script: `TUXLER_CONTROL_URL=http://127.0.0.1:41000`,
   `TUXLER_COUNTRY=US`, `TUXLER_MODE=<from input>`.
4. Artifacts: pool report (exit IPs, ASN, cities, failures), plus screenshots
   (existing).

`browser-click.mjs`:

- Replace launch-level `proxy` with `browser.newContext({ proxy })` per Click, using
  `GET /acquire` → `{ server: "socks5://127.0.0.1:4100N", exitId }` → `POST /release`.
- Leak prevention launch args: `--disable-quic`,
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. QUIC and WebRTC can
  bypass a proxy; without this the exit is not the only egress.
- Keep `BROWSER_PROXY_*` as an emergency override only; it must be empty when the
  Tuxler pool is used.

Attribution (migration): add to `affiliate_clicks`:
`exit_ip`, `exit_country`, `exit_asn`, `proxy_kind` (`tuxler` | `none` | `manual`).
Every Click then proves which exit produced it.

---

## 11. `/email` console

New **Proxy** card (or a section on the GitHub card):

- Provider: `tuxler` (only), status: pool N, refills today, last error.
- Country: country select; **US enforced** (other values are rejected server-side).
- Pool target: 3–8, default 5.
- Mode: `rotate` / `random` — page level, shared with Grafana.
- Restart: cancel the running Segment for that OS, then dispatch.
- Every action uses the toast-only feedback contract.

Also:
- Remove the control secret (`EMAIL_CONTROL_SECRET`); page unlock = write.
- Move target selection out of the Grafana card to the page.

**Built (ticket 10).** The card is `voni/src/components/proxy-card.tsx`. Its
settings are `email_settings.proxy_country` (`US`, written from the constant) and
`email_settings.proxy_pool_target` (3–8, default 5); the rules are in
`voni/src/lib/email/proxy-policy.ts`, the boundary in `proxy-settings.ts`. There is
no country select: the form posts US and the action refuses anything else before
writing. The live pool is a read-only `GET /health` on `TUXLER_CONTROL_URL`
(`proxy-health.ts`), and the card distinguishes client-down, short-of-exits and
out-of-quota, naming failures as `no US exit`, `quota spent` and `relay silent`.
Attribution is rendered by `voni/src/lib/email/click-exit.ts`; ticket 07 stores the
columns it reads (`affiliate_clicks.exit_ip`, `exit_country`, `exit_asn`,
`proxy_kind`, plus the failure `reason`, migration `0022_heavy_warbird`), so new
rows name their exit and older rows read **No proxy**.

---

## 12. Data model

| Table | Columns | Notes |
|---|---|---|
| `email_sources` | `target_selection`, `proxy_provider`, `proxy_country`, `proxy_pool_target` | one row per producer; proxy settings shared |
| `tuxler_ledger` | `account_hash`, `client_ip`, `window_start`, `used`, `limit`, `last_silence_at` | survives restarts; avoids wasting quota |
| `tuxler_exits` | `id`, `ip`, `port`, `country`, `asn`, `parent_id`, `state`, `acquired_at`, `dies_at` | telemetry + churn estimate |
| `affiliate_clicks` | `+ exit_ip, exit_country, exit_asn, proxy_kind` | attribution |

Credentials stay in Actions secrets. `TUXLER_USERNAME` is hashed for the ledger key.

---

## 13. Observability

- `/health`: `{ ok, ready, pool: [...], buckets: [...], lastError }`.
- `/metrics`: refills, failures by reason, silence events, mean exit lifetime.
- Card shows: ready exits, US cities, refills today, quota left per bucket.
- Per-Click log line: `passId target exitIp asn country latency`.
- Never log credentials or proxy URLs with userinfo.

---

## 14. Testing

1. **Unit** (node:test, no network): framing, XML, change parsing, quota ledger,
   pool policy, SOCKS handshake, redaction.
2. **Fake relay**: a local TCP server that scripts CONNECT_LIST → challenge → echo →
   `MAKE_SECOND_CONNECTION` → `LOGIN_FINISHED` → `IP_CHANGED_*`. Proves the full
   state machine without quota.
3. **Live probe** (`tuxler-probe`): opt-in, budgeted (max 10 changes), not in CI.
4. **CI smoke**: pool must reach 3 US exits; one Click to one Target; artifact with
   the exit IP. Runs once per deploy, not on a schedule.
5. **Leak test**: with the pool active, request `https://api.ipify.org` from inside
   the browser context and assert the IP equals the assigned exit. Fails the build
   on a direct leak.

---

## 15. Phases and acceptance

| Phase | Work | Done when |
|---|---|---|
| 0 | Protocol core + pool + SOCKS + fake-relay tests | probe reaches 5 US exits; 5 clicks via 5 ports; no direct path |
| 1 | Runner integration + attribution columns | one CI run writes Clicks with US `exit_ip`; leak test passes |
| 2 | Panel: proxy card, US constraint, global mode, single password, restart | operator can set country/mode/pool and restart from `/email` |
| 3 | Hardening: pacing, cooldown, lifetime, dashboards | 12 h Segment keeps ≥3 US exits without manual help |

Phase 0 ships behind an env flag (`TUXLER_ENABLED`), default off.

---

## 16. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Runner IP is datacenter → `BANNED_IP_HOSTING` | no exits | probe step; if it happens, move the client to the operator's machine and tunnel (Cloudflare Tunnel/Tailscale) |
| US supply thin (avg 2.1 visible) | Clicks fail | pool 5, refill, fail loudly, prefer US peak hours |
| Burst silence | stalls | pacing (≤5), reconnect, cooldown |
| Exit churn | pool drains | two-strike death, background refill, lifetime metrics |
| QUIC/WebRTC bypass proxy | direct leak | launch flags + leak test in CI |
| Account ban / ToS | loss of source | operator decision; keep a commercial provider path |
| Credentials in logs | security | redaction + test |

---

## 17. Decisions (resolved 2026-11-25)

1. Pool target **5**, refill below **3**, max **8** — agreed.
2. Click wait **10 s**, then fail loudly — agreed.
3. Depth **3** — agreed. Depth is a refill budget (§8); concurrent US exits stay at
   the supply ceiling.
4. Exit IP is shown **per Click in the console and in logs** — agreed.
5. **One account**, premium when purchased. The client reads its tier from
   `LIMITS_INFO` and sizes the ledger from `ipLocationChangesLimit`.
6. Datacenter ban (`BANNED_IP_HOSTING`) is tested on a real runner before phase 1
   proceeds (§19).

---

## 19. Datacenter ban test (gate for phase 1)

The relay answers `BANNED_IP_HOSTING` when the client's own address is a hosted
service. Tuxler exists to share residential connections, so an Azure runner is the
exact case it can reject. The test is cheap and decides the client's placement:

1. `scripts/tuxler-probe.mts --ban-check` logs in, waits 15 s, and prints every
   frame that matters (`BANNED_IP_HOSTING`, `UNBANNED_IP_HOSTING`, `IP_SHARING_STATE`).
   It exits `3` if banned, `0` if not.
2. A `workflow_dispatch` workflow (`tuxler-probe.yml`) runs it on `ubuntu-latest`
   with the same secrets, and uploads the log as an artifact.
3. Outcome:
   - **not banned** → the client runs in the runner (plan as written);
   - **banned** → the client moves to the operator's machine (or a residential
     tunnel endpoint) and the runner reaches it over a tunnel; only §10's transport
     changes, pool/rotation/console stay the same.

The test spends **no IP changes** — it is a login only.

### 19.1 Result (2026-11-25, run 45683207400)

`ubuntu-latest`, runner egress `54.211.170.155`:

```
client public IP: 54.211.170.155
login ok, handshake 581 ms (no IP change spent)
<= UNBANNED_IP_HOSTING
RESULT: UNBANNED_IP_HOSTING - the relay explicitly unbanned this address
```

**Not banned.** The relay accepts a GitHub-hosted runner as a client, and the
handshake from the datacenter is ~4x faster than from the operator's home
connection (581 ms vs 2.3 s). Phase 1 proceeds with the client inside the runner;
the tunnel fallback stays documented but is not required.

## 20. Appendix — protocol essentials

- Control: `serverN.ipsharkk.com:29990`, plaintext TCP, UTF-16LE from server,
  latin-1 to server, frames end at `</message>`.
- `CONNECT_LIST` → redirect to `serverN`; consumes one entry per connect.
- Conformance: `MAKE_TEST_*` → `TEST_END` + `VERSION3`; 50 KB echo → `OK^^^…`.
- `MAKE_SECOND_CONNECTION <port1>` → second socket to the same host.
- `LOGIN{email;password;VERSION:6}` → `LOGIN_FINISHED`.
- `CHANGE_IP_COUNTRY_CITY(next_nearby;country;city)` → `IP_CHANGED_*` with
  `<status>OK</status><ip>…</ip><location>…</location><port>N</port>`.
- Tunnel: connect to `serverN:<port>`, send `<h>host<p>port</p></h>` + payload, all
  XOR-0x73 outbound, inbound raw.
- `I_AM_ALIVE` every `TIMEVAL−10`; drop after `TIMEVAL` of silence.

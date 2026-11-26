# Tuxler client — implementation plan

Status: implemented; ready to turn on. Branches `ticket/tuxler-01` … `ticket/tuxler-12`
on `feat/tuxler-proxy`. The switch, the failure runbook and the measured
baseline live in `docs/agents/tuxler-exit-pool.md` and
`docs/agents/tuxler-exit-baseline.md`.
Sources of truth: the code in `voni/src/lib/tuxler/` and `voni/scripts/`
(`tuxler-proxy.mts`, `browser-pool-gate.mjs`, `browser-click.mjs`); the wire
specs in `/tmp/opencode/tuxler-spec/01..03` remain protocol history, and
`voni/scripts/tuxler-probe.mts` is a diagnostic, not the client.

---

## 1. Goal

Replace the GitHub Source's datacenter egress with residential egress.

- Every GitHub Click leaves through a Tuxler exit.
- The exit must be in the **US**. This is a hard constraint: no substitution, no
  fallback country, no direct path.
- We own the client: no Chrome App, no GUI, no quota we did not design around.
- Rotation mode is a console setting, shared with Grafana. Country is fixed to
  US: the console has no country picker and the client refuses anything else.

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
   through an exit gets a fresh allowance of 10. This makes a tree of *changes*
   (not concurrent exits): depth 1 = 10 changes, depth 2 = ~100, depth 3 = ~1,000.
   The pool's eight-exit ceiling still bounds how many exits exist at once.
3. **A burst of changes goes silent.** After 5–7 changes in a few seconds, the relay
   stops answering (no `IP_NOT_CHANGED_*`, no error). A fresh session answers again.
   Treat silence as "session unhealthy", not "no availability".

---

## 3. Non-negotiable rules

1. **US only.** An exit is used only if the reply says the US **and** the IP is
   not in a known hosting ASN. Otherwise it is discarded.
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
├── tuxler-proxy (Node, this client)        ← owns the relay sessions
│   ├── Session A (root, direct)            → exit IP1 : portA
│   │   ├── Session B (through IP1)         → bucket B (10 changes) → exit IP2 : portB
│   │   └── Session C (through IP1)         → bucket C (10 changes) → exit IP3 : portC
│   ├── Pool: live US exits + their ports
│   ├── SOCKS listeners: 127.0.0.1:41001…   (one port per exit)
│   └── HTTP control: /health /acquire /release (loopback only)
└── browser-click.mjs
    └── per Click: browser.newContext({ proxy: socks5://127.0.0.1:<port> })
```

### 4.1 Modules (all TypeScript, `voni/src/lib/tuxler/`)

| File | Purpose | Test |
|---|---|---|
| `frames.ts` | UTF-16LE reader, `</message>` framing, tag/details split, XML→object | unit, golden frames |
| `control.ts` | Session state machine: CONNECT_LIST, conformance probes, 50 KB echo, second socket, LOGIN, heartbeat, `TIMEVAL`, dispatch | unit with a fake relay |
| `transport.ts` | `directTransport`, `tunneledTransport` (nested, XOR-0x73 both layers) | unit |
| `account.ts` | Parses `RECEIVED_ACCOUNT_INFO`, `ACCOUNT_INFO`, `LIMITS_INFO`, `RESET_INFO`; the limit is never assumed | unit |
| `change.ts` | `CHANGE_IP_COUNTRY_CITY`, reply parsing (port/ip/location), failure taxonomy | unit |
| `validate.ts` | US check: country from reply + known-hosting-ASN denial (Team Cymru DNS, cached by /24); lookup failure fails closed | unit |
| `socks.ts` | SOCKS5 server per exit port; CONNECT → header → XOR pipe; loopback only | unit with a fake relay |
| `exit.ts` | One exit: change → validate → bind the reply's port; no derived-port or direct path | unit with a fake relay |
| `pool.ts` | Five ready exits, refill policy, leasing, two-strike death, child buckets, pacing, silence recovery; health is read-only | unit with a fake relay |
| `health.ts` | Loopback `/health` and `/acquire` + `/release`; buckets and exits | unit |
| `client.ts` | Orchestrator: account session, pool, health server, reconnect | integration with a fake relay |
| `fake-relay.ts` | The scripted relay every test drives; no test-only branch in the client | shared test fixture |

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
- `READY` → US + not a known hosting ASN; has the reply's port and a loopback
  SOCKS listener; usable by Clicks.
- `LEASED` → one Click holds it. It is out of the ready list but still counted
  in the pool's total; a good release returns it to `READY`.
- `DEAD` → a second failed release, `IP_BECAME_UNAVAILABLE`, or the parent
  session closed. Replace on death; each replacement costs one change from the
  owning bucket.
- A child bucket's exits are dialled through a parent exit. If a parent exit is
  killed by two strikes, its child subtree is **not** rebuilt yet; the pool
  replaces the parent, and new children can be opened through it. This is an
  accepted risk (§18.1), not a hidden behaviour.

---

## 5. Rotation modes (global, both Sources)

One setting, read by both Producers.

| Mode | Meaning | Quota cost |
|---|---|---|
| `rotate` | One exit for the whole pass; targets cycle in a shuffled bag | 1 per exit refresh |
| `random` | Shuffle Targets; each Target gets the next ready exit (round-robin) | 0 during clicking |

- The setting is stored once, in `email_settings.target_selection` (one row, no
  seed), and passed to the k6 generator **and** to the GitHub workflow as an
  input. The stored value wins; only while it is `NULL` does a saved Grafana
  script's own marker answer.
- The page-level **Target rotation** card is the console control (ticket 02).
  It used to live only inside the Grafana card and be persisted in the saved k6
  script.
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

| Depth | Cumulative change budget (free) | Concurrent exits | Measured request time |
|---|---|---|---|
| 1 | B = 10 | ≤ 8 | ~2.1 s |
| 2 | B + B² = 110 | ≤ 8 | ~3.2 s |
| 3 | B + B² + B³ = 1,110 | ≤ 8 | not measured |

Depth is a *change budget*, not concurrency: a bucket spends its changes to
create exits over time, and the pool still owns at most eight of them at once
(`POOL_MAX`). Supply is the binding constraint on how many are ready.

Rules:

- **Spend changes only to refill.** Clicking never spends quota.
- **Pace changes**: at most 5 in a row, then wait 20 s or switch bucket; a burst is
  what triggers silence. A 5-exit fill fits inside one burst.
- **Silence = unhealthy session.** Reconnect through the same parent, retry; do not
  count a silent session as "US unavailable". Three failed reconnects in a row
  hard-park the pool rather than loop.
- **Daily reset** arrives as `RESET_INFO` (measured at 08:26 −05:00). The limit
  and `resetAt` are reported in `/health`; the pool watches for the reset and
  re-arms spent buckets, rather than guessing from elapsed time.
- Each fresh runner VM is a new root client IP, so each Segment starts with a
  fresh root bucket. Three OSes are three runners, three clients and three root
  buckets; quota is not shared between them.

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
| Clicks per pass | Every active target, one browser context at a time | Serial today; the pool supports parallelism as a separate change |

Consequence to accept: at pool 5, consecutive Clicks cycle through 5 residential
IPs. That is per-Click diversity, not a unique IP per Click. Depth 3 multiplies the
number of *changes* available for refills; it does not raise concurrent US exits,
because supply — not quota — is the binding constraint (~2 US visible at a moment,
5–7 per burst).

### 8.1 Account tier

The account measured on 2026-11-25 reports `ipLocationChangesLimit: 10` and premium
flags off, i.e. free tier. Premium raises `B` to 100, which changes the tree:

| Depth | Free (B=10), deepest level | Premium (B=100), deepest level |
|---|---|---|
| 1 | 10 | 100 |
| 2 | 100 | 10,000 |
| 3 | 1,000 | 1,000,000 |

The cumulative budgets are `B + B² + B³`: 1,110 free and 1,010,100 premium.

The client reads `LIMITS_INFO` at login and reports its ledger from `B`; it must
not assume 10. `/health` reports each bucket's `used`, `limit` and `remaining`
separately, root first, so a child at a different count is visible. Depth 3 is
the default so that a free account still has enough refills for a 12 h Segment,
and a premium account is far inside its budget.

Per-bucket arithmetic with the implemented constants:

- A fresh pool spends **5** changes to reach the target of five, leaving
  `B − 5` (five on the free tier).
- Clicking spends nothing. Each death or refill spends one. With refills gated
  below three ready exits, the root's five spare changes absorb five
  replacements.
- The next needed replacement cannot come from the root: the client opens a
  **child bucket** through a ready exit, and the relay meters that exit's
  address afresh. That is when a second bucket is needed — automatically, not
  by an operator action.
- The theoretical tree budget is `B + B² + B³`: **1,110** changes on free and
  **1,010,100** on premium. The eight-exit ceiling and actual US supply bound
  how many buckets can exist at once; each bucket's `remaining` is the live
  truth.
- A second *account* would only be needed by a Segment that would spend more
  than roughly 1,110 changes (more than 1,105 refills). Premium is the cheaper
  answer; that spend rate is a churn problem first.

What is unmeasured is the actual spend per Segment. Clicks are free, so the
question is churn, and no live Segment has been run. The baseline record exists
to answer it; see §18.1.

---

## 9. Failure taxonomy

The relay reply becomes a client reason; the reason is what a click row, the
health report and the card carry. The runbook has the operator action for each.

| Relay reply / signal | Client reason | Meaning | Action |
|---|---|---|---|
| `IP_CHANGED_SUCCESSFULLY` | — | new exit | validate → READY |
| `IP_CHANGED_SUCCESSFULLY_BUT_LIMIT` | — | last change of the bucket | READY, then mark the bucket exhausted |
| `IP_NOT_CHANGED_LIMITS` | `limit` | bucket spent | retire the bucket; open a child or wait for reset |
| `IP_NOT_CHANGED_NOT_AVAILABLE` | `not-available` | no US peer now | backoff, retry; do not substitute |
| `IP_NOT_CHANGED_OVERLOADED` | `overloaded` | pool busy | backoff |
| `IP_CHANGED_FAILED_FREE` | `not-entitled` | account not entitled | record; do not retry in a loop |
| reply says another country | `not-us` | not US | discard; never serve |
| address in a known hosting ASN | `hosting` | not residential | discard; never serve |
| ASN lookup failed | `lookup-failed` | cannot classify | discard (fail closed) |
| no port in the reply | `incomplete` | unusable reply | discard |
| reply not understood | `unrecognised` | protocol drift | discard |
| listener cannot bind | `listener-failed` | local failure | discard; report |
| silence > 20 s | `relay-silent` | session unhealthy | reconnect through the same parent; report `reconnects` |
| session closed | `session-closed` | control socket gone | reconnect |
| `IP_BECAME_UNAVAILABLE` | `exit-unavailable` | exit died | DEAD; replace |
| two failed releases | `exit-unavailable` | exit unusable | DEAD; replace |
| `BANNED_IP_HOSTING` | (probe only) | runner IP rejected | the client has no ban-specific reason yet; `--ban-check` is the honest test (accepted risk) |
| parent session closed | — | subtree gone | the parent is replaced; its child subtree is not rebuilt yet (accepted risk) |

The four pool/`/acquire` reasons are `no-us-exit`, `quota-spent`,
`relay-silent` and `not-ready`. A click row may also carry `exit-unavailable`,
which is the click-only fifth. The gate adds `short-of-exits`,
`control-unreachable`, `client-not-ready` and `bad-control-url`. Keep this
vocabulary closed: a new wording is a new reason, not a log line.

Failures are surfaced per Click (exit reason) and aggregated on the card.

---

## 10. Integration with the runner

Workflow `.github/workflows/browser-check.yml`:

1. Repository **variable** `TUXLER_ENABLED` (exact `true`; unset is off) and
   Actions **secrets** `TUXLER_USERNAME`, `TUXLER_PASSWD`. The credentials are
   scoped to the start step; the click step never sees them.
2. Steps, in order: **Start the exit pool** (background `tuxler-proxy.mts`,
   PID file and log), **Wait for the exit pool** (`browser-pool-gate.mjs`, at
   least 3 ready US exits, 180 s), **Click every target**, **Final pool report**
   (`always()`), **Stop the exit pool** (`always()`), **Pool report** artifact
   `browser-pool-report-<os>` from `voni/pool-report.json`. A failed gate skips
   the clicks, so it writes no click row and uploads its reason.
3. Env for the click script: `TUXLER_ENABLED` (the same flag),
   `TUXLER_CONTROL_URL=http://127.0.0.1:41000`, and
   `BROWSER_CHECK_SELECTION` (the shared rotation setting). There is no
   country env: US is the client's constant.
4. Artifacts: `browser-pool-report-<os>` (gate and final halves: exits, ASN,
   cities, refills, reconnects, failure) plus the existing screenshots.

`browser-click.mjs`:

- `GET /acquire?waitMs=10000` → `{ server: "socks5://127.0.0.1:4100N", exitId }`
  → `browser.newContext({ proxy })` per Click → `POST /release` with
  `good` or `failed`. `rotate` holds one exit for the whole pass; `random`
  acquires per target.
- A failed acquire records `status: null` and the pool's reason, and opens no
  browser context. There is no direct path.
- Leak prevention launch args: `--disable-quic`,
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. QUIC and WebRTC can
  bypass a proxy; without this the exit is not the only egress.
- `BROWSER_PROXY_*` is an emergency override only, used with the flag off; it is
  refused alongside the pool rather than silently preferred.

Attribution: `affiliate_clicks` stores `exit_ip`, `exit_country`, `exit_asn`,
`proxy_kind` (`pool` | `manual` | `none`) and `failure_reason`. Older rows read
`none`; every new pooled Click proves which exit produced it.

---

## 11. `/email` console

The **Proxy exits** card is built (ticket 10); **Restart** is built (ticket 11);
the one password and the page-level rotation control are tickets 01 and 02.

- Provider: `tuxler` (only), status: pool N, exits and cities, bucket lines,
  last failure in operator words.
- Country: **US, no picker.** The form posts US and the action refuses anything
  else before writing; a hand-edited row still reads US.
- Pool target: 3–8, default 5. The number is stored; a dispatch does not yet
  carry it to the runner, so the live size is the client's default of five
  (§18.1).
- Mode: `rotate` / `random` — page level, shared with Grafana.
- Restart per OS: cancel every active Segment for that OS, observe the stop,
  then dispatch exactly one replacement; a cancel that does not stop in 60 s
  dispatches nothing and says so.
- Every action uses the toast-only feedback contract.

**Settings and attribution.** The card is `voni/src/components/proxy-card.tsx`.
Its settings are `email_settings.proxy_country` (`US`, written from the
constant) and `email_settings.proxy_pool_target` (3–8, default 5); the rules are
in `voni/src/lib/email/proxy-policy.ts`, the boundary in `proxy-settings.ts`.
The live pool is a read-only `GET /health` on `TUXLER_CONTROL_URL`
(`proxy-health.ts`), and the card distinguishes client-down, short-of-exits and
out-of-quota, naming failures as `no US exit`, `quota spent` and `relay silent`.
Reading it spends no change and moves no exit. Attribution is rendered by
`voni/src/lib/email/click-exit.ts`; ticket 07 stores the columns it reads
(`affiliate_clicks.exit_ip`, `exit_country`, `exit_asn`, `proxy_kind`, plus the
failure `reason`, migration `0022_heavy_warbird`), so new rows name their exit,
a failed row names why, and older rows read **No proxy**.

---

## 12. Data model

There is no `tuxler_ledger` and no `tuxler_exits` table. The relay is the ledger:
`ACCOUNT_INFO`, `LIMITS_INFO` and `RESET_INFO` give `used`, `limit` and
`resetAt`, which the client reports in `/health` and never assumes. A restarted
client re-reads them, so a restart does not waste quota; a restart does forget
the in-process `refills`/`reconnects` counters.

| Where | Columns | Notes |
|---|---|---|
| `email_settings` | `target_selection`, `proxy_country`, `proxy_pool_target` | one console row; country is always US, target 3–8 |
| `email_sources` | schedule fields (`interval`, `window`, `start_hour`, enabled) | one row per producer; no proxy columns |
| `affiliate_clicks` | `+ exit_ip, exit_country, exit_asn, proxy_kind, failure_reason, pass_id` | append-only attribution; older rows read `none` |
| client `/health` | `buckets[]` (`used`, `limit`, `remaining`, `resetAt`, `depth`, `parentId`) | per (account, client IP), root first |
| run artifact | `pool-report.json` (`gate`, `final`) | durable per-Segment exits, refills, reconnects, failure |

Credentials stay in Actions secrets. The ledger key is a hash of
(account, client egress IP); the account and address are never written to a
health response or an artifact.

---

## 13. Observability

- `/health` (loopback only, read-only): `{ ok, ready, pool: [{ exitId, ip,
  country, asn, city, state }], buckets: [{ clientIpHash, depth, parentId, used,
  limit, remaining, resetAt }], refills, reconnects, lastError, account: { tier,
  premium, clientIp }, session: { state, controlHost, handshakeMs,
  heartbeatSeconds, silentForMs, frames } }`.
- There is **no `/metrics`** endpoint and no durable exit table. The per-Segment
  artifact (`pool-report.json`) is the durable telemetry; the card is a live
  read. A mean exit lifetime is not computed. This is an accepted risk (§18.1).
- Card shows: ready exits, US cities, each bucket's used/limit/remaining and
  reset, and the last failure in operator words.
- Per-Click log line: `pass N <url>` followed by
  `ok|failed <status> <ms> exit=<ip> asn=<asn> country=<cc> [reason=<reason>]`.
- Never log credentials or proxy URLs with userinfo; the artifact's redaction
  covers both.

---

## 14. Testing

1. **Unit** (node:test, no network): framing, XML, change parsing, account and
   limit parsing, pool policy, child buckets, SOCKS handshake, redaction, gate
   verdicts.
2. **Fake relay**: a local TCP server that scripts CONNECT_LIST → challenge →
   echo → `MAKE_SECOND_CONNECTION` → `LOGIN_FINISHED` → `IP_CHANGED_*`. It
   proves the full state machine, child buckets, exhaustion, depth, silence and
   reset without quota. The client has no test-only branch.
3. **Live probe** (`tuxler-probe`): opt-in, budgeted (hard cap 10 changes for a
   live check), never in CI. It is a diagnostic, not the acceptance test.
4. **CI smoke is not implemented.** No CI job starts the real client or clicks a
   real target: that needs account credentials, spends changes, and is an
   operator action. The gate, runner contract and leak path are covered with a
   fake relay or a local control server. This is an accepted risk (§18.1).
5. **Leak test**: `tuxler-exit-leak.mjs` drives a real browser and the runner's
   own launch flags and per-context proxy, but a **fake** exit on loopback. The
   page reports the address that reached it, and it must equal the exit's exact
   address; a direct context, derived port, wrong exit or dead listener exits 1.
   CI runs it on every PR. It proves the proxy path, not the Tuxler relay.

---

## 15. Phases and acceptance

| Phase | Work | Status |
|---|---|---|
| 0 | Protocol core + pool + SOCKS + fake-relay tests | Built and tested against the fake relay. The live 5-exit / 5-click proof is the baseline Segment, not yet run. |
| 1 | Runner integration + attribution columns | Built; a real dispatched Segment has not been exercised. |
| 2 | Panel: proxy card, US constraint, global mode, single password, restart | Built. The saved pool target is carried on every dispatch to the client (§18.1, risk 4). |
| 3 | Hardening: pacing, cooldown, reconnect | Built. A 12 h Segment keeping ≥3 US exits is unproven; no dashboards or lifetime metric exist. |

Phase 0 ships behind the repository variable `TUXLER_ENABLED`, default off.

---

## 16. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Runner IP is datacenter → `BANNED_IP_HOSTING` | no exits | `--ban-check` (no changes); if banned, move the client to a residential endpoint and tunnel (Cloudflare Tunnel/Tailscale). The 2026-11-25 runner was unbanned. |
| US supply thin (avg 2.1 visible) | Clicks fail | pool 5, refill, fail loudly, prefer US peak hours; supply is the binding constraint |
| Burst silence | stalls | pacing (≤5 changes, 20 s cooldown), reconnect through the same parent |
| Exit churn | pool drains | two-strike death, background refill; no lifetime metric yet |
| Parent exit dies by two strikes | its child subtree is orphaned | accepted risk; the parent is replaced but the children are not rebuilt yet |
| QUIC/WebRTC bypass proxy | direct leak | launch flags + the loopback leak test in CI (not a live exit) |
| Account ban / ToS | loss of source | operator decision; keep a commercial provider path |
| Credentials in logs | security | scoped to the start step, redaction + test |
| No live Segment yet | quota headroom is a budget, not a measurement | the baseline record; one operator-run Segment |
| Pool target only read at client start | a save does not resize a running Segment | accepted risk; the next Segment fills to the saved value |

---

## 17. Decisions (resolved through turn-on)

1. Pool target **5**, refill below **3**, max **8** — agreed.
2. Click wait **10 s**, then fail loudly — agreed.
3. Depth **3** — agreed. Depth is a refill budget (§8); concurrent US exits stay at
   the supply ceiling.
4. Exit IP is shown **per Click in the console and in logs** — agreed.
5. **One account**, premium when purchased. The client reads its tier from
   `LIMITS_INFO` and reports the ledger from `ipLocationChangesLimit`.
6. Datacenter ban (`BANNED_IP_HOSTING`) was tested on a real runner before phase 1
   (§19.1): not banned.
7. The switch is the repository **variable** `TUXLER_ENABLED` (exact `true`),
   default off. It is deliberately not a dispatch input, so a dispatch cannot
   turn spending on.
8. Country is **US and not a choice**: the form posts US, the action refuses
   anything else, and the client refuses a non-US exit.
9. The manual proxy (`BROWSER_PROXY_*`) is an **emergency override only** and is
   refused alongside the pool rather than silently preferred.
10. The saved pool target (3–8) is carried end to end: the dispatch reads the
    saved row, sends `poolTarget`, the workflow maps it to `TUXLER_POOL_TARGET`,
    and the CLI refuses a value outside 3–8 rather than clamping. It is read at
    client start, so it resizes the next Segment. Depth is a separate,
    CLI-read setting (`TUXLER_POOL_DEPTH`, 0–3, default 3).

---

## 18. Turning it on

The operator switch, the failure runbook and the baseline are separate
documents so they can be read without this plan:

- **Switch and runbook:** [`docs/agents/tuxler-exit-pool.md`](agents/tuxler-exit-pool.md).
  `TUXLER_ENABLED=true` as a repository variable; `TUXLER_USERNAME` and
  `TUXLER_PASSWD` as Actions secrets; the three `BROWSER_PROXY_*` secrets empty.
  With the variable off, a Segment behaves exactly as before the pool.
- **Baseline record:** [`docs/agents/tuxler-exit-baseline.md`](agents/tuxler-exit-baseline.md).
  Every measured cell is blank on purpose until one real Segment is run.
- **Console contract:** [`docs/agents/email-pool.md`](agents/email-pool.md).

The probe remains at `voni/scripts/tuxler-probe.mts` and as the manual
`Tuxler probe` workflow. `--ban-check` and `--pool-scan` spend no changes; every
other mode does, and none is a CI step.

### 18.1 Accepted risks

These are known, recorded and not hidden. None is a reason to describe the work
as pending; each is a limit of what has been proved.

1. **No live run.** No live relay session, real click, real GitHub dispatch or
   real (Tuxler) leak check has been exercised. Every behavioural claim is the
   code plus the fake relay; the leak test uses a fake loopback exit.
2. **The baseline is unmeasured.** Ready exits over time, changes spent and
   failures by reason are blank until an operator runs one Segment. Quota
   headroom is an implemented budget, not a measured per-Segment spend.
3. **A killed parent does not rebuild its child subtree.** Two strikes kill the
   parent exit; the parent is replaced and new children can be opened, but the
   existing children dialled through the dead parent are not re-parented.
4. **The pool target has no live setter.** The saved 3–8 value is carried on
   every dispatch and the client fills to it, but it converges only on the next
   client start: the control API has no live target setter, so changing the card
   does not resize a Segment that is already clicking.
5. **The artifact records two samples, not a series.** Ready exits are read at
   the gate and at the end; there is no per-minute ready count and no bucket
   snapshot in `pool-report.json`. Exact quota is read from the live `/health`.
6. **No durable exit telemetry.** There is no `/metrics` endpoint, no
   `tuxler_exits` table and no mean exit lifetime. Churn is inferred from
   `refills`, `reconnects` and click rows.
7. **`BANNED_IP_HOSTING` has no client-specific reason.** The client does not
   classify that tag; `--ban-check` is the honest test. A future runner IP could
   be rejected even though the 2026-11-25 one was not.
8. **Supply, not quota, is the ceiling.** Five ready exits means five addresses
   in rotation, not a unique address per Click; a thin US pool still fails
   loudly rather than substituting.
9. **Restart has not talked to GitHub.** The cancel/observe/dispatch order is
   tested against an injected client; no real cancel or dispatch was exercised.
10. **Restart holds a server action for up to ~70 s.** The cancel is observed for
    up to 60 s before the replacement is dispatched. That is bounded and
    interactive by design — a dispatch that raced the run it replaces would put
    two browsers on the same target — but it is longer than the durable-job rule
    in `voni/AGENTS.md` normally tolerates. It stays inline, deliberately.
11. **The console cannot read a runner's loopback pool.** `TUXLER_CONTROL_URL` is
    `127.0.0.1:41000`, which exists only inside the job. The card shows *Client
    down* for a live Segment unless the operator opens a tunnel to that port for
    the read; `pool-report.json` is the durable record.
12. **Failure reasons are defined in five modules.** The pool's published reasons,
    the control API's 503 set, the exit layer's `ExitFailureReason`, the intake's
    `CLICK_FAILURE_REASONS` / DB enum, and the runner's own emits. They agree by
    convention and by review, not by one shared type; a reason added in one place
    must be added in the others (see `docs/agents/tuxler-exit-pool.md`).

---

## 19. Datacenter ban test (phase-1 gate, resolved)

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

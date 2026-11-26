# The Tuxler exit pool: operator runbook

The GitHub Source can leave through Tuxler residential exits instead of the
runner's Azure address. This is the document an operator reads before turning
that on, while a Segment runs, and when one fails.

The contract is: every GitHub Click leaves from a **US** exit the client
validated, or it does not leave at all. There is no direct fallback, no country
substitution, and no silent preference of the manual proxy. The implementation
is `voni/src/lib/tuxler/`; the runner half is `voni/scripts/browser-click.mjs`,
`browser-pool-gate.mjs` and `browser-exit-pool.mjs`.

Companion records: [the baseline](tuxler-exit-baseline.md) and
[the implementation plan](../tuxler-client-plan.md). The `/email` console itself
is documented in [email-pool.md](email-pool.md).

## The switch

There is exactly one switch, and it is a repository **variable**, not a secret
and not a dispatch input:

| Where | Name | Value that turns it on |
| --- | --- | --- |
| GitHub → Settings → Secrets and variables → Actions → **Variables** | `TUXLER_ENABLED` | the exact string `true` |

Anything else is off. An unset variable is an empty string; `false`, `0`, `yes`
and `TRUE` are either off (`false`) or a refusal (`yes`, `TRUE`). The workflow
maps it with `vars.TUXLER_ENABLED`, and `browser-pool-gate.mjs` refuses to gate a
pooled run unless the value is exactly `true`. It is deliberately not a
`workflow_dispatch` input: a dispatch cannot turn spending on.

Two repository **secrets** carry the account:

| Secret | Used by |
| --- | --- |
| `TUXLER_USERNAME` | the client's login (`TUXLER_EMAIL` is the fallback name in the CLI) |
| `TUXLER_PASSWD` | the client's password (`TUXLER_PASSWORD` is the fallback name) |

Only the **Start the exit pool** step sees them. They are not passed to the
click step, not written to the pool report, and the report's redaction pass
scrubs them from every string it writes. `TUXLER_CONTROL_URL` is fixed in the
workflow at `http://127.0.0.1:41000`; it is not an operator setting.

Two **sizes** reach the client without a secret and without touching the code:

| Where | Name | Meaning |
| --- | --- | --- |
| `/email` → Proxy exits → Pool target | `proxy_pool_target` | Exits to fill to, 3–8. The dispatch carries the saved value as the `poolTarget` input, the workflow maps it to `TUXLER_POOL_TARGET`, and the CLI refuses a value outside 3–8 rather than clamping. |
| GitHub → Variables | `TUXLER_POOL_DEPTH` | How many child buckets deep the refill tree may grow, 0–3, default 3 (`0` = no children). An empty variable is the default three. |

Both are read when the client **starts**: changing the pool target does not
resize a client that is already running, it resizes the next Segment.

### What "on" changes

With `TUXLER_ENABLED=true`, a dispatched Segment runs these steps in order:

1. **Start the exit pool** — `node --import tsx scripts/tuxler-proxy.mts`,
   backgrounded, its PID in `tuxler-client.pid` and its output in
   `tuxler-client.log`. The client logs in from the two secrets and fills a pool
   of five US exits (one change per exit).
2. **Wait for the exit pool** — `browser-pool-gate.mjs` polls
   `GET /health` every two seconds for up to **180 seconds** and requires
   **three ready US exits**. If they do not arrive, the step fails. A failed
   step skips the click step, so the Segment writes **zero click rows** and the
   artifact says why.
3. **Click every target** — each Click asks `GET /acquire?waitMs=10000` for an
   exit, opens its browser context through that exit's loopback SOCKS port, and
   releases it as `good` or `failed`. A Click that gets no exit in ten seconds
   is stored with `status: null` and the pool's reason; no browser context is
   opened for it.
4. **Final pool report** — one read of `/health` after the clicks, merged into
   the same `pool-report.json` (`always()`; it never changes the run's verdict).
5. **Stop the exit pool** — `SIGTERM` to the PID (`always()`).
6. **Pool report** — uploads `voni/pool-report.json` as
   `browser-pool-report-<os>` (7-day retention).

With the variable off, every added step is skipped, no client starts, and the
Segment behaves exactly as it did before the pool existed. The click step still
runs and uses the launch-level `BROWSER_PROXY_*` override if one is configured.

Two exclusivity rules are enforced before Chrome starts:

- A pooled run **refuses** `BROWSER_PROXY_SERVER` / `BROWSER_PROXY_USERNAME` /
  `BROWSER_PROXY_PASSWORD`. Two ways to choose an address is no way to know
  which one a Click used. The manual override is for the bypass below, when the
  pool is off.
- Country is US in the client and in the console. There is no picker, and a
  non-US request is refused server-side before it is stored.

## Before the first run

- [ ] One Tuxler account, and its two Actions secrets set. Do not reuse the
      click-report secret or the dispatch token for them.
- [ ] `TUXLER_ENABLED` set to `true` as a **variable**.
- [ ] The three `BROWSER_PROXY_*` secrets empty. A pooled run refuses them.
- [ ] `/email` unlocked; the GitHub card enabled; at least one active target;
      the **Proxy exits** card readable.
- [ ] The account has enough changes for **one** pool build: five on the free
      tier, against the bucket line on the card.
- [ ] One OS only for the first check (Ubuntu). Each OS is a separate runner
      with its own egress IP and therefore its own root bucket; three at once is
      three pool builds, not one.
- [ ] The operator's live-check budget is understood. The pool build spends
      five changes. Clicking spends none. Refills and deaths spend the rest.
      When the root bucket is spent, a child bucket opens and spending continues
      under a fresh allowance — stop the run if you are enforcing a cap.

## The first live Segment

1. Set the variable. Nothing else in the repository changes.
2. On `/email`, GitHub, Ubuntu, press **Dispatch now**. Outside the active
   window this still dispatches a full Segment, so the path can be proved
   without enabling continuous running.
3. Watch the steps, not the console alone. A passing gate logs:

   ```
   browser-pool-gate: <N> ready exit(s) after <ms> ms, <N> refill(s); the segment may click
   ```

   The values are that run's measurement, not a promise.
4. A passing run leaves click rows whose **Exit** column names an address, `US`
   and an ASN, and whose proxy kind is `pool`; the **Proxy exits** card names
   the same exits and their buckets. A failing gate leaves no click row at all.

To end a Segment early without starting a replacement, cancel the run in the
GitHub UI (or `gh run cancel`). **Restart** is not a stop: it cancels and then
dispatches exactly one replacement.

## Reading a run

The durable record is the `browser-pool-report-<os>` artifact:
`voni/pool-report.json`. It has two halves.

| Field | Meaning |
| --- | --- |
| `enabled`, `minReady` | the run was pooled, and the gate required three exits |
| `gate.ok` | whether the pool reached three ready US exits before any Click |
| `gate.reason`, `gate.detail` | the refusal, when it failed |
| `gate.attempts`, `gate.waitedMs`, `gate.checkedAt` | how long the gate waited and when it last read |
| `gate.ready` | ready exits at the gate |
| `gate.exits[]` | `exitId`, `ip`, `country`, `asn`, `city`, `state` |
| `gate.refills` | change **attempts** the pool made, including refused attempts |
| `gate.reconnects` | sessions replaced after silence or a close |
| `gate.lastError` | the client's own last failure (`reason`, `message`) |
| `gate.clientLog` | tail of `tuxler-client.log`, only when the control port never opened |
| `final.*` | the same fields, read after the clicks and before the client stops |

`refills` is an upper bound on quota spent, not an exact debit: a refused change
also increments it. Exact `used` / `limit` / `remaining` per bucket are in
`GET /health` and on the card; the artifact does not copy them.

The artifact records **two samples** (gate and final), not a continuous series.
A five-hour Segment therefore reports the exits it started and ended with, and
the refills and reconnects in between. It does not report a per-minute ready
count. That limitation is recorded in the plan's accepted risks.

Click rows are the other half. The **Exit** column names the pooled exit, the
manual override, or **No proxy**; a row that never opened a page appends its
failure reason. In Postgres, one Segment's failures grouped by reason:

```sql
select failure_reason, count(*)
from affiliate_clicks
where producer = 'github'
  and runner_os = 'ubuntu'
  and ran_at between :segment_start and :segment_end
group by 1
order by 2 desc;
```

The same window's promoted clicks (a page answered) and misses:

```sql
select
  count(*) filter (where status is not null) as answered,
  count(*) filter (where status is null) as not_answered,
  count(*) filter (where proxy_kind = 'pool') as pooled,
  count(distinct exit_ip) as distinct_exits
from affiliate_clicks
where producer = 'github'
  and runner_os = 'ubuntu'
  and ran_at between :segment_start and :segment_end;
```

## Failure reasons

Each reason has one meaning. The **where** column says whether it can appear on
a click row, in the gate/artifact, on the card, or in the client's own
`lastError`.

### The four pool reasons and the click-only fifth

| Where | Reason | Meaning | Likely cause | Next action |
| --- | --- | --- | --- | --- |
| Click row, `/acquire`, artifact `lastError` | `no-us-exit` | The pool could not obtain a US exit. | Every change reply was non-US, in a hosting ASN, or its ASN lookup failed; or US supply was empty. | Do not weaken the US rule. Wait for US peak hours and retry. Run `--pool-scan` (no changes) to see visible US supply; run `--ban-check` (no changes) if every attempt fails. |
| Click row, `/acquire`, artifact | `quota-spent` | The bucket has nothing left, and the tree is at its depth. | Churn spent the root and every child; a 12 h Segment outlived its budget; or the account hit its tier. | Read `resetAt` on the card and wait for the reset, or raise the tier. Inspect `refills`/`reconnects` — a high churn rate is the real fault, not the quota. |
| Click row, `/acquire`, artifact | `relay-silent` | The relay stopped answering for 20 seconds. | A burst of changes, a relay incident, or a dropped socket. | The client closes and reconnects through the same parent (up to three in a row) and reports `reconnects`. If it hard-parks, restart the Segment. `--ban-check` separates a relay problem from a runner-address problem. |
| Click row, `/acquire`, artifact | `not-ready` | The client is starting, closed, or has no live session. | The gate was read too early, the client crashed, or the login never settled. | Read `gate.clientLog` in the artifact. Check the two secrets and the client's first lines. Rerun the Segment; do not click without a ready exit. |
| Click row only | `exit-unavailable` | The exit died between acquire and the page, or a `rotate` pass lost its one exit. | Exit death, a closed listener, or a context that could not be opened through it. | The release is marked failed; the second strike kills the exit and the pool replaces it. The next Click takes another exit. Investigate if it repeats every pass. |
| Click row only | `bad-exit` | The control port answered 200 with something that is not a US loopback SOCKS lease. | A client bug, or a second thing listening on the control port. | The row is stored and the Click is a miss. Stop and inspect the client; never accept the offered lease. |
| Client `lastError` / `no-us-exit` detail | `name-lookup-failed` | The address's ASN resolved, but its AS name did not answer, so the address cannot be shown to be a consumer ISP. | A DNS failure at Team Cymru, or an ASN with no name record. | Fail closed is the rule: the exit is refused, not assumed residential. Retry; if it persists for one ASN, that ASN is unusable. |

The click-row enum is closed: `no-us-exit`, `quota-spent`, `relay-silent`,
`not-ready`, `exit-unavailable`, `bad-exit`. A browser's own navigation error is
`status: null` with no failure reason, which is a target result, not an exit
result. The same vocabulary is deliberately spelled in five modules (the pool's
published reasons, the control API, the exit layer, the click report and the
runner); nothing here is one enum, and a reason added in one place must be added
in the others.

### A rejection that another change cannot fix parks the pool

Thin US supply is a reason to retry; a broken classifier, a listener that will not
bind, or a reply shape the client cannot read is not. `lookup-failed`,
`name-lookup-failed`, `listener-failed` and an unreadable reply therefore **park
the pool immediately**, publish the reason as `lastError`, and spend nothing
further until the client is restarted. Without that rule a live run on 2026-11-26
spent eight of ten daily changes in ninety seconds because a failing ASN lookup
retried like thin supply — see `tuxler-exit-baseline.md`. If the card shows one of
those four reasons, fix the cause (DNS reachability for `origin.asn.cymru.com` is
the usual one) and restart the Segment; a restart resumes refilling.

### Gate-only refusals

| Where | Reason | Meaning | Next action |
| --- | --- | --- | --- |
| Artifact `gate` | `short-of-exits` | Fewer than three exits after 180 s; the pool may still be filling. | Retry. Check `--pool-scan` for actual US supply. Do not lower the gate. |
| Artifact `gate` | `no-us-exit` | The client offered something that was not a US loopback lease. | This is a client bug or a mistyped control address; stop and inspect `gate.exits`. Never accept the offered exit. |
| Artifact `gate` | `control-unreachable` | Nothing answered on `127.0.0.1:41000`. | `gate.clientLog` is the only witness. Missing secrets, a login failure, or a crash. Fix and rerun. |
| Artifact `gate` | `bad-control-url` | `TUXLER_CONTROL_URL` is malformed. | Workflow/configuration mistake. The address is fixed; restore it, do not bypass. |
| Artifact `gate` | `client-not-ready` | The session failed and no exit can arrive. | Read the client's `lastError`; usually a credential or relay problem. |

### The card's three states

| Card status | Meaning | Next action |
| --- | --- | --- |
| **Client down** | No control address, unreachable, or the relay session is `starting`/stopped. | The card only reads; it cannot start a client. Start the Segment (the workflow starts one), or fix the client host. |
| **Short of exits** | A live client below the target (5). A refill starts below three. | Wait for the refill while supply allows. If it persists, check US supply with `--pool-scan`; the ceiling is supply, not the target. |
| **Out of quota** | Every bucket's remaining changes are zero, or the last failure was `quota-spent`. Ready exits keep serving; the pool cannot replace them. | Wait for `resetAt` or raise the tier. Do not restart in a loop — a restart does not create quota. |

### Session and login failures

These reach the artifact as `gate.lastError.reason` or `gate.clientLog`:

| Reason | Likely cause | Next action |
| --- | --- | --- |
| `credential-missing` | One of the two secrets is unset. | Set both, from the account, not from a log or a chat. |
| `login-rejected` | Wrong password, disabled account, or a relay refusal. | Verify the credentials against the Tuxler account; rotate both together. |
| `connect-failed` | The relay host/port is unreachable from the runner. | Check the relay's status; `--ban-check` also proves reachability. |
| `redirect-failed` | `CONNECT_LIST` did not redirect to a session host. | Relay-side; retry. If persistent, run `--ban-check`. |
| `conformance-failed` | A probe target or the `TEST_END`/`VERSION3` exchange failed. | Relay-side or a network middlebox; retry on a fresh runner. |
| `echo-failed` | The 50 KB echo did not return intact. | Relay-side; retry. Do not treat it as thin supply. |
| `second-connection-failed` | The relay's second socket did not open. | Relay-side; retry. |
| `socket-closed` | The relay closed the control session. | The client reconnects; if it hard-parks, restart the Segment. |

### A banned runner address

`BANNED_IP_HOSTING` is the relay rejecting a hosted client address. The client
has no ban-specific failure reason of its own, so the honest test is the probe:

```
node --import tsx scripts/tuxler-probe.mts --ban-check
```

It logs in and waits 15 seconds, **spends no IP change**, and exits `3` on
`BANNED_IP_HOSTING`, `0` otherwise. If banned, the pool cannot work from a
GitHub runner; move the client to a residential endpoint or a tunnel and point
the runner at it. The 2026-11-25 check found `UNBANNED_IP_HOSTING` for
`54.211.170.155` (plan §19.1), but a future runner IP can differ.

## Emergency manual-proxy bypass

When the pool is broken and clicks must continue, leave the pool entirely:

1. Set repository **secrets** `BROWSER_PROXY_SERVER` (and, if the proxy needs
   them, `BROWSER_PROXY_USERNAME` and `BROWSER_PROXY_PASSWORD`) to a proxy you
   trust.
2. Set `TUXLER_ENABLED` to `false` (or delete the variable).
3. Dispatch or Restart. The client, gate, final report and stop steps are
   skipped; Chrome uses the launch-level proxy. Rows read `manual` instead of
   `pool` and carry no Tuxler exit.
4. This spends no Tuxler changes and opens no relay session. It also gives up
   the pool's guarantees: the manual proxy must be US residential if the
   residential claim is the point, and the loopback leak test does not cover it.
5. To return: clear the three `BROWSER_PROXY_*` secrets, set the variable to
   `true`, and dispatch again. A pooled run with the secrets still set refuses
   before Chrome starts.

The bypass is exclusive on purpose. Setting both is a refusal, not a
preference, because a row that claims `pool` must have left through the pool.

## Quota headroom

The limit is the account's own `ipLocationChangesLimit` from `LIMITS_INFO`,
never an assumed ten. The measured free tier is **10 per bucket**; premium is
100. A **bucket** is one `(account, client egress IP)` pair, so the root bucket
is the runner's own address, and a child bucket is a relay session dialled
through a ready exit, which the relay meters against that exit's address.

| Constant | Value | What it does |
| --- | --- | --- |
| `POOL_TARGET` | 5 | ready exits the pool fills to |
| `POOL_REFILL_BELOW` | 3 | a refill starts below this many ready exits |
| `POOL_MAX` | 8 | hard ceiling, leased exits included |
| `POOL_PACE_BURST` | 5 | changes one session sends before a cooldown or switch |
| `POOL_PACE_COOLDOWN_MS` | 20 s | the pause after that burst |
| `POOL_DEPTH` | 3 | how many child levels the budget may grow |
| `POOL_ACQUIRE_WAIT_MS` | 10 s | a Click's bounded wait for an exit |

The arithmetic for the current free tier:

- A fresh pool spends **5** changes to build five exits, leaving **5** in the
  root bucket.
- Clicking spends **0**. A death or a refill spends **1**. With the refill gate
  at three ready exits, the root's five spare changes absorb five replacements.
- The sixth needed replacement cannot come from the root. The client opens a
  **child bucket** through a ready exit; the relay sees that exit's address and
  meters a fresh ten. That is the point at which the second bucket is needed,
  and it is automatic.
- Depth 3 allows the tree to keep doing this. The theoretical change budget is
  `B + B² + B³`: **1,110** on the free tier (10 + 100 + 1,000) and **1,010,100**
  on premium. The pool's eight-exit ceiling and the actual US supply bound how
  many of those buckets can exist at once; the live truth is each bucket's
  `remaining` on the card.
- A **second account** would only be needed by a Segment that would spend more
  than roughly 1,110 changes — more than 1,105 refills. That is a churn problem
  before it is an account problem, and premium is the cheaper answer.

What is not known: how many changes one real Segment actually spends. Clicks
cost nothing, so the answer is churn, and churn has never been measured live.
That is the baseline's job; see [the baseline record](tuxler-exit-baseline.md).
The headroom above is an implemented budget, not a measured per-Segment spend.

## Diagnostics: the probe is not the client

`voni/scripts/tuxler-probe.mts` is the protocol probe that proved the relay and
the wire format. It is a diagnostic, not the shipped path. The client is
`tuxler-proxy.mts` and `src/lib/tuxler/`.

| Mode | Changes spent | Use it for |
| --- | --- | --- |
| `--ban-check` | 0 | Is this runner address rejected as hosted? |
| `--pool-scan` | 0 | How many US exits are visible, and in which cities? |
| `--us-test`, `--pool-test`, `--chain-test`, `--quota-depth`, `--ip-quota`, `--rotations N` | one or more | Protocol and supply research only. Budget them; never run them in CI. |

The `Tuxler probe` workflow is manual (`workflow_dispatch`) and has two modes,
`ban-check` and `pool-scan`. Neither spends an IP change. A live diagnostic is
an operator action with a hard cap; it is never a build step.

**The console reads a runner's loopback address through the operator's browser
or not at all.** `TUXLER_CONTROL_URL` is `127.0.0.1:41000`, and on a GitHub
runner that loopback exists only inside the job. A local console sees *Client
down* for every live Segment unless the operator opens a tunnel to that port for
the duration of the read; the card is not an exception to this, and the pool
report artifact is the durable record.

**Restart holds a server action for up to ~70 seconds** (a 60 s bounded wait for
an observed cancel, plus the dispatch). That is deliberate: the alternative is
a dispatch that races the run it is meant to replace. It is the one interactive
action this long; a longer operation belongs in the durable job center
(`voni/AGENTS.md`).

## What this runbook does not claim

No real Segment has been run from this repository state: no live relay session,
no real click, no real dispatch and no live leak check. Every statement above
about what the client *does* is the code's contract and the fake-relay tests;
the measured baseline is deliberately empty until an operator runs one Segment.

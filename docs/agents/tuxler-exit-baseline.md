# Tuxler exit-pool baseline

The measured record of one real Segment: ready exits over time, changes spent,
and failures grouped by reason. This is the evidence the headroom arithmetic in
[the runbook](tuxler-exit-pool.md#quota-headroom) is checked against.

> **The table below is deliberately blank.** Capturing it requires one real
> Segment against the live relay, with the account's two Actions secrets and
> `TUXLER_ENABLED=true`. The values must not be filled from the probe, a fake
> relay, CI, or an estimate. One live *client* observation was made on
> 2026-11-26 and is recorded verbatim at the end; it is not a Segment and does
> not fill the table.

## The method

1. Run **one** Segment: GitHub card → Ubuntu → **Dispatch now**, with the pool
   on. One OS keeps the first check inside one root bucket. Use a short window
   if you are learning; the gate plus the first passes are enough to prove the
   path, and clicking itself spends no change.
2. Keep the run's URL and the start/end instants. Every later read is bounded by
   them.
3. Download the artifact **`browser-pool-report-ubuntu`** (retention 7 days) and
   read `voni/pool-report.json`. The `gate` half is the pool before any Click;
   the `final` half is the pool after the clicks and before the client stops.
4. Read the **Tuxler exits** card while the client is alive for the exact bucket
   figures (`used`, `limit`, `remaining`, `resetAt`). The card is the only place
   those are reported; the artifact carries `refills` (change attempts), not
   bucket debits.
5. Group the Segment's click rows by `failure_reason` with the query below.
6. Fill the tables. Do not round a gate measurement up, and do not count a
   refused change as a spent one: `refills` is an upper bound, the bucket's
   `used` is the debit.

### Where each number comes from

| Number | Source | Field |
| --- | --- | --- |
| Ready exits at the gate | artifact | `gate.ready`, `gate.checkedAt` |
| Ready exits at the end | artifact | `final.ready`, `final.checkedAt` |
| Change attempts | artifact | `gate.refills`, `final.refills` |
| Sessions replaced | artifact | `gate.reconnects`, `final.reconnects` |
| Exit identities and cities | artifact | `gate.exits[]`, `final.exits[]` |
| Last client failure | artifact | `gate.lastError`, `final.lastError` |
| Gate refusal | artifact | `gate.ok`, `gate.reason`, `gate.detail` |
| Bucket debits and headroom | `/email` card (live) | each bucket's `used`, `limit`, `remaining` |
| Failures by reason | `affiliate_clicks` | `failure_reason` |
| Promoted clicks | `affiliate_clicks` | rows with a non-null `status` |

## Segment identity

| Field | Value |
| --- | --- |
| Date and time (UTC) | |
| Workflow run URL | |
| Runner OS | |
| Window length | |
| Interval | |
| Active targets | |
| Rotation mode | |
| Pool target (live client) | 5 |
| Account tier / limit from `LIMITS_INFO` | |

## Ready exits over time

The artifact records two points. A denser series is not produced by the current
workflow; if a future run samples `/health` during the Segment, add rows here and
say so.

| Point | Checked at | Ready | Exits (address / city / ASN) |
| --- | --- | --- | --- |
| Gate (before any Click) | | | |
| Final (after clicks) | | | |

Distinct exits seen across both points: **\_\_\_**

## Changes spent

| Field | Gate | Final | Segment total |
| --- | --- | --- | --- |
| `refills` (change attempts, upper bound) | | | |
| Root bucket `used` / `limit` / `remaining` | | | |
| Child bucket 1 `used` / `limit` / `remaining` | | | |
| Child bucket 2 `used` / `limit` / `remaining` | | | |
| `reconnects` | | | |

Was a child bucket opened? **\_\_\_**

If yes, at which `refills` count and what was the root's `remaining` then?
**\_\_\_**

## Failures grouped by reason

Click rows in the Segment window:

```sql
select coalesce(failure_reason::text, '(none)') as reason, count(*)
from affiliate_clicks
where producer = 'github'
  and runner_os = 'ubuntu'
  and status is null
  and ran_at between :segment_start and :segment_end
group by 1
order by 2 desc;
```

| `failure_reason` | Count | Interpretation |
| --- | --- | --- |
| `no-us-exit` | | |
| `quota-spent` | | |
| `relay-silent` | | |
| `not-ready` | | |
| `exit-unavailable` | | |
| `(none)` | | a page was attempted and failed without an exit reason (target failure) |

Gate refusal, if any: `reason` **\_\_\_**, `detail` **\_\_\_**

Client `lastError`: `reason` **\_\_\_**, `message` **\_\_\_**

## Promoted clicks and exit quality

| Field | Value |
| --- | --- |
| Answered rows (`status` non-null) | |
| Not answered (`status` null) | |
| Pooled rows (`proxy_kind = 'pool'`) | |
| Distinct `exit_ip` | |
| Distinct `exit_asn` | |
| Distinct cities | |
| Rows with a non-US exit | should be zero |

```sql
select
  count(*) filter (where status is not null) as answered,
  count(*) filter (where status is null) as not_answered,
  count(*) filter (where proxy_kind = 'pool') as pooled,
  count(distinct exit_ip) as distinct_exits,
  count(distinct exit_asn) as distinct_asns
from affiliate_clicks
where producer = 'github'
  and runner_os = 'ubuntu'
  and ran_at between :segment_start and :segment_end;
```

## Verdict after the run

| Question | Answer |
| --- | --- |
| Did the gate pass with at least three ready US exits? | |
| Did every promoted click leave from a pooled US exit? | |
| Did the root bucket's five spare changes cover the Segment's churn? | |
| Was a second bucket needed? | |
| Did `refills` stay under the free tier's 1,110-change depth budget? | |
| Does the headroom statement in the runbook hold for this Segment? | |
| What is the observed per-Segment spend, in changes? | |

An honest "no" is a result. If the Segment needed a child bucket, record the
`refills` count at which it opened; that is the number that tells the next
operator whether the free tier's five spare refills are enough for a full window.

## Live client observation, 2026-11-26 (not a Segment)

Run from the operator's line against the live relay after the first deploy, with
`TUXLER_POOL_TARGET=3` and `TUXLER_POOL_DEPTH=0`. No click was made and no
Segment was dispatched, so this fills no cell above; it is recorded because it
found two defects and one environment limit that the fake relay could not.

| Observed | Value |
| --- | --- |
| Login | ok, handshake ~2.1 s, redirected to `server13` |
| Account frame | 10 changes, premium 0, reset `2026-11-26T13:26:11Z` |
| One change reply | `IP_CHANGED_SUCCESSFULLY`, port assigned, `ip 102.69.220.138`, country **Morocco (MA)** although the request asked `country:US` |
| ASN lookup for that address | **failed**, `ESERVFAIL`, from the build environment's resolver |
| Pool outcome | 0 ready exits; 8 of 10 changes spent in ~90 s before the parking fix |
| Clicks / leak check | none — the gate was never satisfied, so nothing clicked |

What it proves, in the operator's terms:

1. **A US request can be answered with another country.** That is why the country
   check reads `countryiso` and refuses rather than trusting the request, and why
   a non-US reply must never be a Click.
2. **The ASN classifier's DNS is a hard dependency.** When `origin.asn.cymru.com`
   cannot be answered, the client correctly fails closed and can serve no exit at
   all. Before the parking fix it also retried, which is what drained the bucket.
3. **Neither defect was reachable through the fake relay**, which resolves by
   construction. A live client run is part of the gate, not a formality.

### Second live client run, after the parking fix

Same settings (`TUXLER_POOL_TARGET=3`, depth `0`). The drain was gone — four refill
attempts, three changes, then the pool stopped on its own instead of looping —
but it stopped with a **null `lastError`**, which reads as "nothing wrong". That
is why `parked` and `parkedFor` now appear in `/health`, and why `lastError` is
only cleared once the pool is actually at its target.

The relay also reported `used: 12` against a stated `limit: 10`, so the stated
daily limit is not a hard cap this client may trust: it is a hint for pacing, and
the only safe rule is the one implemented — spend on refills, pace them, and park
when a rejection cannot be fixed by another change.

### Resolver failure, and why the pool can now classify exits

The ASN classifier asks Team Cymru over DNS. On the operator's machine the host
resolver returned `ESERVFAIL` for `origin.asn.cymru.com` one minute and a normal
answer the next, so the failure is **intermittent**, not a permanently broken
zone. A pool that classifies on Monday and parks with `lookup-failed` on Tuesday
is exactly the silent failure this subsystem is built to avoid.

`cymruLookup` now resolves in order: the system resolver, then DNS-over-HTTPS
(Cloudflare, then Google) when the system resolver throws. Both providers answer
authoritatively for the zone; they differ in formatting only — Cloudflare quotes
TXT values, Google does not — and the parser handles both.

Verified locally with the system resolver forced to throw (as it did during the
incident):

```
102.69.220.138 -> AS328494 GH | consumer | 3D WIRELESS PLUS LIMITED
73.162.14.9    -> AS7922  US | consumer | COMCAST-7922
8.8.8.8        -> AS15169 US | hosting  | GOOGLE
```

So classification no longer depends on one resolver, and the fail-closed rule is
unchanged: when every resolver fails, the exit is rejected with `lookup-failed`
and the pool parks rather than clicking direct.

### The Short Segment of 2026-11-26 22:29Z, and what it proved

One dispatch, `ubuntu`, one non-affiliate target (`https://example.com/`), window
300 s, pool target 3. Nothing else was touched: no affiliate target was enabled
or removed.

```
browser-pool-gate: FAILED short-of-exits after 180002 ms: only 0 of 3 exits are ready
```
```json
"gate": { "ready": 0, "exits": [], "refills": 35, "reconnects": 0, "lastError": null }
```

Two facts came out of it.

**The account is out of changes.** A local reproduction with the same settings
reported `used: 11` against a stated `limit: 10` (`resetAt` 2026-11-27T13:27Z),
and a subsequent login was refused with `connect-failed`. No exit can be
produced before the reset, whatever the code does.

**The pool spent 35 changes and published nothing.** `ready: 0, parked: false,
lastError: null` reads as "nothing is wrong" and is exactly the silent stall
this subsystem is meant not to have. The pool had no logging at all, and the
gate attached the client log only when the control port never opened, so the
artifact could not say why. Both are now fixed: one line per refill decision on
stderr, a stall rule that parks after `POOL_NO_PROGRESS_REFILLS` refusals with no
accepted exit (and when every bucket is spent while no exit is owned), and the
client log attached to every failed gate — character-bounded, because the report
parser refuses a long field and one oversized quote would lose the whole record.

The next run after the reset is the real test: three accepted US exits, a pushed
report, and a card that says so.

### Run 45912731476: the pool works, the exit tunnel does not

Same dispatch (ubuntu, one non-affiliate target, window 240 s, pool target 3).
This time the gate **passed**:

```
browser-pool-gate: 0 ready exit(s) after 4036 ms, 3 refill(s); the segment may click
```

and the clicks ran against real US residential exits:

```
pass 6 exit=24.90.211.117  asn=12271 country=US
pass 7 exit=24.183.169.43  asn=20115 country=US
```

Every click then failed in ~95 ms with `net::ERR_SOCKS_CONNECTION_FAILED`: the
exit is acquired and validated, but the local SOCKS listener refuses because its
tunnel to `relayHost:exitPort` closes before the destination answers. The tunnel
header (`<h>host<p>port</p></h>`) and the XOR mask have only ever been exercised
against our fake relay, so this is the first real test of that wire format — and
the client logged nothing about it.

Two smaller things the same run exposed:

- `exit 24.183.169.43:32516 was not released (HTTP 400 {"error":"bad-release"})`
  — a lease that cannot be returned leaves the pool a strike behind.
- `report not stored ... HTTP 400 {"ok":false,"reason":"bad_final_url"}` for
  `example.com` — the intake refuses the click row because the final URL does not
  match the target once the rotation query is appended. Worth checking against a
  real Target before assuming it is only a test-target artefact.

The pool's own gate line reads `0 ready exit(s) ... the segment may click`, which
is contradictory and should be reconciled: the gate said yes with `ready: 0`
because it counted three usable leases, while the summary interpolates the
client's `ready` field.

### Run 45918797868: the header was not the variable

The tunnel probe tried four framings against the live relay, every one closed
with zero bytes:

```
exit server119.ipsharkk.com:30160 variant=masked-header closed with no bytes; trying plain-header
exit server119.ipsharkk.com:30160 variant=plain-header closed with no bytes; trying plain
exit server119.ipsharkk.com:30160 variant=plain closed with no bytes; trying connect
exit server119.ipsharkk.com:30160 variant=connect closed with no bytes
```

A connection that is accepted and dropped before any reply is not a framing
disagreement — it is the relay refusing the connection itself. Two variables had
never been varied: **which host** accepts an exit port (we always dial the
session's redirected host), and **which socket** carries the tunnel (the relay
makes the client open a second, authenticated connection at login and we never
write to it). The next probe varies both.

Also proven in this run: the release fix works (no more `bad-release` lines) and
failed clicks now reach the intake (`1/1 reported`) instead of being discarded as
`bad_final_url`.

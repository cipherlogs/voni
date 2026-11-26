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
4. Read the **Proxy exits** card while the client is alive for the exact bucket
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

# `/email`, the affiliate click check, and the retired edge-worker pool

`voni.cc/email` is a password-gated control page. It is not a redirect, and it
no longer fetches anything when it loads. The affiliate clicks the campaign
depends on are sent by Grafana Synthetic Monitoring check
`voni-affiliate-click-us`: a scripted k6 check whose script is
`voni/scripts/affiliate-click-check.k6.js`, running from its selected probes
(the four US probes by default). The
page reads the rows that check produced from `affiliate_clicks`, and it can
change the check's interval, probe set and enabled state through Grafana's
Synthetic Monitoring API.

The one exception is the panel's "Run one click now" button. `runOneOffClick`
in `src/app/email/actions.ts` performs a single click from voni's own server
with the same identity pool, target bag and header shape, so a target and its
attribution can be verified without waiting for Grafana's next run. Its result
always says it ran from voni rather than Grafana, because everywhere else in
the table a row means "the check sent this".

## The live click path

```
check voni-affiliate-click-us (Grafana, scripted k6)
  → GET <target with utm>            http.get, redirects: 10
  → POST /api/email/clicks/report    x-voni-click-secret: REPORT_SECRET (constant in the uploaded script)
      { target, source, finalUrl, status, ms, userAgent, device, browser, ranAt }
  → affiliate_clicks                 one append-only row

/email → "Run one click now"
  → simulateOneClick()               bounded, host-allowlisted redirect chain
  → affiliate_clicks                 one append-only row
```

Both producers write one row per click and nothing updates a row afterwards.
`affiliate_clicks` is the record of what was sent and where it landed; it is not
a cache of the target's current state.

Report intake rules, all in `parseClickReport`
(`src/lib/email/click-report.ts`):

| Field | Accepted |
| --- | --- |
| `target` | absolute `http(s)` URL with a host, ≤ 2048 chars |
| `source` | ≤ 80 chars, or absent/empty for "not observed" |
| `finalUrl` | absolute `http(s)` URL, or null |
| `status` | integer 100–599, or null |
| `ms` | integer 0–120 000, or null |
| `device` | `desktop`, `mobile`, `tablet`, or null (case-folded) |
| `userAgent` / `browser` | ≤ 400 / ≤ 40 chars, or null |
| `ranAt` | ISO timestamp no older than 24 h and no more than 5 min ahead; absent means now |

The body is capped at 4 KiB, unknown keys are ignored so a newer script still
works against an older route, and a rejection answers `400` with a machine
reason rather than echoing the body. A missing or wrong secret is one `401`
(`503` when `EMAIL_CLICK_REPORT_SECRET` is unset), and a failed insert is `502`.
No response quotes the payload: a body can contain an arbitrary URL.

`status: null` is the row's "the visit never produced a response" case, not an
error code. k6 reports `0` when the transport failed, and the generated script
converts that to null — `0` is below the accepted minimum, so sending it raw
would make a failed click impossible to record. For the same reason the script
sends `target` as the stamped URL it actually visited, not the bare bag entry,
which is what the one-off click stores. One column, one meaning.

## Target selection

One target and one source per click, drawn without replacement from shuffle
bags in `voni/src/lib/email/pool.ts`. Each entry in
`voni/src/lib/email/targets.json` is an absolute `https://` URL, and the bag
mixes voni-hosted pages with affiliate links that redirect off-site:

```
https://cipherlogs.github.io/print/
https://voni.cc/test
https://www.glizzitrium.com/BCMPW39K/J345SSD/?creative_id=691100
```

`cipherlogs.github.io/print` keeps its trailing slash because that is the URL a
visitor opens; GitHub Pages 301s the slashless form and the redirect is
followed. An entry's own query survives — the utm keys are `set`, never
appended, so `?creative_id=` is still there afterwards.

Three params are stamped on every target:

| Param | Value |
| --- | --- |
| `utm_source` | the provider bag (`EMAIL_PROVIDERS`) |
| `utm_medium` | `email` |
| `utm_campaign` | `voni-email` |

The app stamps them with `resolveTarget()`; the k6 script stamps the same three
with `withUtm()`. The k6 script is **generated** from the app's own modules —
profile matrix, targets, providers, referers — by
`npm run affiliate:check`, so the two producers cannot drift. Never edit
`scripts/affiliate-click-check.k6.js`; edit its sources and regenerate. The
generator is deterministic: the same sources produce byte-identical output, so
a diff after regenerating means a source file changed.

`targets.json` now has a second job: it is the approved-host list for redirect
hops in the app's one-off click. Adding a target is still a one-file edit, but
it also approves that host as a redirect destination.

A consequence worth knowing: because the bag has no local origin, running
either producer fetches the production URLs, not your dev server. The check is
live traffic; one run fires once on every selected probe, so clicks/day is
`runs per day × probes` (`src/lib/email/volume.ts` computes it for the panel).

## Locks

Three separate credentials, with three different jobs. They must never be the
same value.

| Lock | Env var | Carried by | Lifetime | Protects |
| --- | --- | --- | --- | --- |
| Page password | `EMAIL_PAGE_PASSWORD` | cookie `voni_email_view`, value `sha256("voni:email-page:" + password)` in hex | 12 h; `path=/email`, `httpOnly`, `SameSite=Lax`, `Secure` in production | Whether the page renders at all. Until it is satisfied the response carries the gate screen and nothing else — no check, no probes, no click history. |
| Control secret | `EMAIL_CONTROL_SECRET` | cookie `voni_email_control`, value `sha256(secret)` in hex | 12 h; `path=/email`, `httpOnly`, `SameSite=Lax`, `Secure` in production | The mutations: save interval/probes, pause/resume the check, run one click now. A locked panel still renders its data; it is read-only. |
| Click-report secret | `EMAIL_CLICK_REPORT_SECRET` | request header `x-voni-click-secret` on `POST /api/email/clicks/report` | per request; no cookie | One append to `affiliate_clicks`, and nothing else. |
| Unlock throttle | (none — no secret to send) | Postgres bucket per hashed IP plus one deployment-wide bucket, via `bumpRateBucket` | fixed 15-minute window | Both password forms: 10 attempts per IP per window and 300 per deployment per window, spent **before** the comparison. Per-IP is bumped first and alone decides whether the attempt may spend global budget, so one anonymous address can burn only its own ten and never the ceiling the operator needs. Fail-closed: if Postgres cannot answer the form refuses with `Could not check attempts right now. Try again in a moment.` instead of rejecting the action, so a database outage is visible and never reads as a wrong password. An unresolved client IP (`"unknown"`) spends the global bucket only. The policy lives in `voni/src/lib/email/unlock-throttle.ts`. |

Two controls mirror the first two rows: **Lock panel** drops only the control
cookie (the panel stays visible, read-only), and **Lock page** — `lockPage` —
drops both and returns to the gate screen. A page lock that kept the control
cookie would still accept writes from anyone who re-entered the page password,
so the two are never dropped separately.

`EMAIL_CLICK_CHECK_ID` is *not* a lock: it names the Grafana check the panel
edits and defaults to `68584` through `resolveCheckId()`, so an unset value
edits the default check rather than refusing.

The page digest is domain-separated (`voni:email-page:` prefix) so it can never
equal the control digest: a control cookie cannot open the page gate, and a page
cookie cannot unlock a mutation. Both cookies carry a digest rather than the
secret, and both comparisons are constant-time over fixed-length SHA-256
buffers, so neither a short nor a malformed cookie can throw or leak length.

Every lock is closed when its variable is unset. The page answers "This page is
not configured" without naming the variable, the control panel stays locked, and
the report route answers `503 not_configured`. A wrong password and a missing
one are deliberately indistinguishable to the caller.

The report secret is **low privilege by design**. It is stored inside the
Grafana check script, where any operator who can read the check can read it, so
it may only append one click row — no read, no update, no other table. The
endpoint itself is unauthenticated-but-secret-gated: anyone can POST to it, and
the only thing standing between the internet and an append is the shared
secret. It never updates or deletes a row.

Getting the secret into the script is a build step, not an edit:

1. `scripts/generate-affiliate-k6.mts` writes the committed script with
   `const REPORT_SECRET = "__REPORT_SECRET__";`, so the repository never holds
   the real value.
2. `npm run affiliate:upload` reads `.env.local`, replaces that placeholder with
   `EMAIL_CLICK_REPORT_SECRET` **in memory**, base64s the result, posts the
   whole check body back, then re-reads the check and compares the script hash
   and every other setting before reporting success. It refuses a script that
   has no placeholder — that refusal is what keeps an already-injected script
   from being committed or re-uploaded blindly — and it refuses four other
   things before writing: a secret outside the URL-safe alphabet (a quote or a
   backslash would break the stored string literal or silently `401` every
   report), an `EMAIL_CLICK_CHECK_ID` that is set but not a positive integer, a
   fetched check whose `job`/`target` is not the affiliate click check, and a
   check whose `enabled` flag is missing or not boolean (Grafana reads an absent
   flag as on). A failed write or read-back gets one more read, and the abort
   text says whether the stored hash matches and that re-running is safe.
3. The stored script now carries the real secret; the file in git still does
   not.

Rotation is therefore: set the new value in the deployment environment (the
Worker secret), deploy, change `.env.local` to match, and run
`npm run affiliate:upload` again. Re-running upload after a rotation is the
whole update path — there is no separate "edit the script" procedure. Rotate
both sides together, or every report answers `401`. Never reuse it for anything
else, and never put a Grafana token in the script — `GRAFANA_SM_URL` /
`GRAFANA_SM_TOKEN` can read and modify the check, which is a much larger grant.

Reporting failures never fail a click: the POST is wrapped, `report_failed` and
`report_ok` are counters in the k6 run, and a click whose report fails still
happens and still logs its JSON line. The run's verdict is separate and
stricter: `export const options` carries
`thresholds: { report_failed: ["count==0"] }`, so one failed report fails the
run. That threshold is what makes a rotated secret visible — without it, a run
where every report answered `401` still finished green. A run with reporting
disabled never increments the counter, so it stays green. The same `options`
pins `dns: { policy: "onlyIPv4" }`: k6 would otherwise take whichever address
the agent's resolver returns first, so one target could be IPv4 in one run and
IPv6 in the next and the two numbers would describe different servers.

The report POST follows no redirects (`redirects: 0`) and times out at 2 s. A
3xx counts as a failed report instead of re-sending the body and
`x-voni-click-secret` to a host nobody reviewed, and a slow endpoint costs one
lost row instead of turning a healthy click red. `ranAt` is stamped when the
click completes, not after the report, so the row describes the visit. The
committed script carries the placeholder, which is why a local run reports
nothing at all — it logs one line saying so.

## Safety rules

- The check runs from Grafana's network, not voni's. k6 follows redirects to any
  host and reports the final URL it observed; that row is a measurement of the
  target, not a request voni made.
- The app runtime has no platform-level SSRF defence. The Cloudflare Worker this
  path replaced could rely on the platform refusing private, loopback and
  link-local destinations; Next on Workers has no such control, so
  `simulateOneClick` follows redirects itself: `redirect: "manual"`, at most 10
  hops, each `Location` resolved against the URL that sent it, and a hop is
  accepted only when its host is one already in `targets.json`. Non-`http(s)`
  schemes and IP literals in private/loopback/link-local ranges are refused as
  well, as defence in depth.
- A refused hop ends the visit as a failure: `status` is the last response
  received, `finalUrl` is the last URL accepted, and the message says the chain
  left the approved hosts. The refused URL is never returned or stored — it is
  exactly the address that should not become a row.
- The browser never supplies a URL: both producers draw the target from the bag
  server-side or in-script, which is what keeps this from being an open proxy.
- The app's whole redirect chain shares one 8 s budget, and every response body
  is cancelled unread, so no page is buffered in memory.

## Retired path: the Cloudflare edge-worker pool

The Workers in `workers/email-pool/` are still deployed and still answer the
contract below, but they are **no longer in the click path**. `/email` does not
call them, `POST /api/email-pool` has been removed, and nothing on the page fans
out to a Worker. The sections stay because they record how the pool behaves and
what its region probe measured; do not read any of it as the current contract.

### Worker contract (retired)

Worker endpoint, one per pool member:

```
POST {WORKER_URL}/click
  x-pool-secret: <POOL_SECRET>
  { "url": "https://voni.cc/test?utm_source=gmail.com", "visitId": "abc" }

200 { "worker": "email-pool-01", "colo": "IAD", "region": "enam", "ok": true,
      "status": 200, "ms": 187, "target": "<url>",
      "finalUrl": "<url the chain ended on>", "redirected": false,
      "reason": null }
401 { "ok": false, "reason": "unauthorized" }
400 { "ok": false, "reason": "bad_target", "detail": "..." }
502 { "ok": false, "reason": "fetch_failed", "detail": "..." }

GET {WORKER_URL}/health
200 { "worker": "email-pool-01", "colo": "FRA", "redirects": "follow",
      "targets": "any absolute http(s) URL" }
```

The fetch ran inside a Durable Object pinned by `region`, so `region` was the
placement hint we asked for and `colo` is the object's own colo when the
runtime reports one — `null` is normal, never a stand-in for the caller's colo.

`ok` was the verdict on the **final** status, so 2xx and 3xx passed. A chain
that ended on a 404 was `ok: false` with `reason: "http_error"`, and
`finalUrl`/`status` still described where it ended. The Worker answered HTTP
**200** for that observation on purpose, so the caller still learned the status
instead of deriving the verdict from the transport.

Worker → target request:

```
GET <url>  (redirect: "follow")
  user-agent:       POOL_USER_AGENT (Chrome desktop default)
  referer:          https://voni.cc/email
  accept:           text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
  accept-language:  en-US,en;q=0.9
  x-pool-worker:    email-pool-01
```

The body was cancelled as soon as the final response arrived, never buffered:
the Worker reported status, timing, colo and final URL, not page content.

The old voni route shaped that fan-out as:

```
POST /api/email-pool        (no body trusted from the browser)
200 { "ok": true, "visitId": "...", "target": "...", "source": "gmail.com",
      "workers": [ <worker 200 shape> | { "worker": "...", "ok": false,
                   "reason": "timeout" | "fetch_failed" | "unauthorized" } ] }
503 { "ok": false, "reason": "not_configured", "message": "..." }
```

### Why the Workers had no host allowlist (retired)

By operator decision the Worker accepted any absolute `http(s)` URL and
followed redirect chains to any host, so it could observe where an affiliate
link actually lands. The accepted cost was that anyone holding `POOL_SECRET`,
or anyone who could edit `targets.json`, could make a Worker fetch any public
URL. What bounded the blast radius was the platform: Cloudflare refuses
private, loopback and link-local addresses at the edge. The app runtime has no
equivalent, which is why the live path carries the host allowlist described
under "Safety rules" instead of inheriting this decision.

### Region: where the pool actually ran (retired)

`colo` in a report is the data center that **received the request**, not one
the deploy picked. Workers run in the colo nearest the requester, and voni
called every pool instance from its own colo, so all N instances answered from
the same place — three deployments bought three URLs and three independent
fetches, never three regions. Checking `/health` on each instance was the fast
way to see it.

What the platform does and does not let you choose
([placement][placement], [egress][egress], [fetch][fetch]):

| Want | Available |
| --- | --- |
| Pin a Worker to a named colo | **No.** Placement is proximity-based: Smart Placement (all plans, optimises toward a backend) or Placement Hints (`placement.region`/`host`, best effort, still "nearest colo"). |
| Guaranteed in-region processing | Regional Services / Data Localization Suite, **Enterprise**, configured per hostname. |
| Stable egress IP | Dedicated CDN Egress IPs (Smart Shield Advanced), **Enterprise**. Default egress is Cloudflare's shared pool. |
| Force IPv4 vs IPv6 | **No.** The destination's A/AAAA records decide, and a subrequest must be a URL, not an IP literal. |

#### The `locationHint` probe

`GET /probe-region?hint=enam` on any pool Worker (secret-gated, same
`x-pool-secret` as `/click`) asks a Durable Object created with that
`locationHint` to fetch two endpoints: `cloudflare.com/cdn-cgi/trace` (which
colo handled the request) and `ipinfo.io/json` (the egress IP and its
geography). It answers "would a pool member in this region see a different IP
than Madrid does?" — the only in-Cloudflare lever that can plausibly move the
vantage point.

Read it with the CLI, which probes every URL in `POOL_WORKER_URLS`:

```bash
npm run probe:region            # in workers/email-pool, needs POOL_SECRET
```

`locationHint` is a **hint, best effort, decided at first `get()`** — objects
never relocate, and `sam`, `afr`, `me` currently spawn nothing (they land in a
neighbouring region). The target also sees a Cloudflare datacenter IP either
way, which is the distortion that matters most for affiliate pages with bot
filtering.

#### What the probe measured

Run on 2026-11-17 against the three production instances, all with `hint=enam`,
each invoked from Madrid:

| instance | invoking colo | object colo | egress | verdict |
| --- | --- | --- | --- | --- |
| `email-pool-01` | MAD | IAD | 104.23.209.78 · Ashburn, Virginia, US · AS13335 | US |
| `email-pool-02` | MAD | ATL | 104.22.1.46 · Atlanta, Georgia, US · AS13335 | US |
| `email-pool-03` | MAD | EWR | 104.23.187.4 · Newark, New Jersey, US · AS13335 | US |

Three things this settles: the hint does move execution out of the caller's
colo; the egress follows the object; and it is a **hint**, not a pin — one hint
produced three different colos. It also shows the limit: the egress is still a
Cloudflare address (`AS13335`), so geography moved and IP reputation did not.

#### Which region each instance used

`/click` ran its fetch inside an object created with the instance's hint, so
the region was deployment config, not code:

```
EMAIL_POOL_REGION_HINTS=enam,wnam,weur   # default; cycled across instances
```

Instance *i* got `hints[i % hints.length]`. Changing the mapping was an env
change plus a redeploy; `deploy.mjs` logs what each instance received. An
invalid hint failed the deploy by name rather than silently falling back.

One throughput note: a Durable Object is single-threaded, and every instance
reused one object per hint, so concurrent clicks to the same instance queued
behind each other. That was fine for a QA draw; it was never a load-testing
architecture — which is part of why the click path moved to Grafana.

[placement]: https://developers.cloudflare.com/workers/configuration/placement/
[egress]: https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/
[fetch]: https://developers.cloudflare.com/workers/runtime-apis/fetch/

## Layout

Live:

- `voni/src/app/email/page.tsx` — page gate, panel shell, and the four reads
  (check, probes, 24 h stats, recent clicks). Nothing on load sends a click.
- `voni/src/app/email/actions.ts` — page unlock, page lock (`lockPage`, drops
  both cookies), control unlock/lock, `saveVolume`, `toggleCheck`,
  `runOneOffClick`. Every exported action authorises inside its own body; the
  client's locked rendering is never a gate. The unlock throttle's policy lives
  in `voni/src/lib/email/unlock-throttle.ts`.
- `voni/src/app/api/email/clicks/report/route.ts` — machine intake for the
  check. One shared secret, append-only.
- `voni/src/lib/email/click-simulator.ts` — one click's request shape and its
  bounded, host-allowlisted redirect chain.
- `voni/src/lib/email/user-agents.ts` — the profile matrix, client hints, and
  the webmail Referer map. One source for both producers.
- `voni/src/lib/email/click-report.ts` — wire shape, parse rules, constant-time
  secret check.
- `voni/src/lib/email/clicks.ts` — `recordAffiliateClick` plus the reads the
  panel renders; schema in `src/lib/db/schema`.
- `voni/src/lib/email/page-gate.ts`, `control.ts` — the two cookies and their
  comparisons.
- `voni/src/lib/email/unlock-throttle.ts` — the attempt budget both password
  forms spend: per-IP first, then the global ceiling, 15-minute fixed window,
  fail-closed with a message the form can render.
- `voni/src/lib/email/pool.ts` — target/source bags, `resolveTarget()` utm
  stamping, and the `targets.json` guard.
- `voni/src/lib/email/targets.json` — **the editable target list**, and the
  approved-host list for redirect hops. Data, not code.
- `voni/src/lib/email/volume.ts` — accepted intervals, probe ids, clicks/day.
- `voni/src/lib/grafana/synthetic.ts` — Synthetic Monitoring client: read a
  check, list probes, change enabled/frequency/probes.
- `voni/scripts/generate-affiliate-k6.mts` →
  `voni/scripts/affiliate-click-check.k6.js` — the generated check script.
- `voni/scripts/upload-affiliate-check.mts` — `npm run affiliate:upload`:
  injects `EMAIL_CLICK_REPORT_SECRET` into the script in memory, posts it to
  the check, reads it back and verifies the hash and every untouched field.
  Helpers in `voni/scripts/lib/affiliate-check.ts`; tested by
  `voni/scripts/upload-affiliate-check.test.ts`.

Retired but still deployed:

- `workers/email-pool/` — standalone Worker project (own `package.json`,
  `wrangler.jsonc`, tests). One source file deployed N times by
  `scripts/deploy.mjs`; `scripts/dev.mjs` runs N `wrangler dev` ports.
- `.github/workflows/deploy-pool.yml` — deploys all N pool Workers on a push
  that touches `workers/email-pool/**`. Secrets stay on the Workers; the
  workflow only carries the Cloudflare token.
- Env: `POOL_SECRET`, `POOL_WORKER_URLS` (comma-separated). Locally they belong
  in `voni/.dev.vars`, never `.env.local` (that file is baked into local builds).

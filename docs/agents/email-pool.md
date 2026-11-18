# `/email` and the affiliate click check

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
bags. The providers are a constant in `voni/src/lib/email/pool.ts`; the targets
are rows in `affiliate_targets`, managed from the `/email` panel's **Targets**
card. The bag mixes voni-hosted pages with affiliate links that redirect
off-site:

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
with `withUtm()`. The k6 script is **generated** from the app's own modules — profile matrix,
targets, providers, referers — by `src/lib/email/check-script.ts`, which both
`npm run affiliate:check` and the panel's save call. Never edit
`scripts/affiliate-click-check.k6.js`; edit its sources and regenerate. The
builder is deterministic: the same sources produce byte-identical output, so a
diff after regenerating means a source file changed (`check-script.test.ts`
asserts the committed file is exactly a fresh one-click build).

`voni/src/lib/email/targets.json` is only the **seed**. The first read of an
empty `affiliate_targets` writes those URLs once; from then on the panel owns
the list, and a deploy never overwrites an operator's pause or removal. The file
stays because a generator or test run with no database needs a list, and because
a seed reviewable in git makes the first page load predictable.

## Managing targets from the panel

The Targets card lists every row with Active/Paused, a pause/resume button and a
remove button, plus one add field. Four rules make it safe to use against live
traffic:

- **The check is rebuilt and re-uploaded on every change.** The target list is
  inlined in the script Grafana runs, so writing `affiliate_targets` alone would
  leave the probes clicking the old set. `pushTargetsToCheck()` in
  `src/app/email/actions.ts` uploads the rebuilt script *before* the row
  changes: a Grafana refusal leaves both unchanged and says so, instead of
  showing a change that never reached the probes.
- **Pause is not delete.** A paused row stays in the table and is not drawn by
  either producer — the lever for investigating one creative while the rest keep
  clicking. The last active target cannot be paused, and the last row cannot be
  removed: a check with no targets runs green and clicks nothing.
- **History keeps its URL.** `affiliate_clicks` stores the URL each visit used,
  so removing a target never rewrites what was sent.
- **The add rule is one function.** `targetUrlProblem()` in
  `voni/src/lib/email/target-url.ts` requires an absolute `https://` URL on port
  443 with a public hostname, no credentials, no private/loopback/link-local IP
  literal, at most 2048 characters. `addTarget` re-runs it server-side (a server
  action is a public endpoint), the builder re-runs it before upload, and
  `pool.assertEmailTargets` applies it to the seed at module load — a hand edit
  cannot be looser than the panel.

A burst dispatched from the card carries the active list as the workflow's
`targets` input, and `burst.yml` proves each URL reached the generated script.
The **manual** fallback (`k6 cloud run scripts/affiliate-click-check.k6.js`)
runs the committed script, so it clicks the seed list rather than the panel's —
the one place the two can differ.

`allTargetUrls()` — every row, paused included — is the approved-host list for
redirect hops in the app's one-off click. Pausing the tracker must not stop a
sibling target's chain at its first hop; adding a target is what approves its
host as a redirect destination.

A consequence worth knowing: because the bag has no local origin, running
either producer fetches the production URLs, not your dev server. The check is
live traffic; one run fires once on every selected probe and sends
clicks-per-run clicks there, so clicks/day is
`runs per day × probes × clicks per run` (`src/lib/email/volume.ts` computes it
for the panel). The panel's interval floor is one minute and its clicks-per-run
ceiling is ten; both are enforced by `validateVolume` and by the builder.

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
   and every other setting before reporting success. The panel's save does the
   same thing from the app: it rebuilds the script at the clicks-per-run in the
   form, uploads it through `uploadCheckScript` (which re-reads and confirms the
   script hash, the job and the frequency), and only then sets the interval and
   probes. With `EMAIL_CLICK_REPORT_SECRET` unset it refuses and names the
   variable — it never falls back to the placeholder, because that would upload
   a script that clicks silently and reports nothing.
   The upload command refuses a script that
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
- The app runtime has no platform-level SSRF defence, so `simulateOneClick`
  follows redirects itself: `redirect: "manual"`, at most 10 hops, each
  `Location` resolved against the URL that sent it, and a hop is accepted only
  when its host is one named by a target row (`allTargetUrls()`, paused
  included). Non-`http(s)` schemes, a non-default port and IP literals in
  private/loopback/link-local ranges are refused as well, as defence in depth.
- A refused hop ends the visit as a failure: `status` is the last response
  received, `finalUrl` is the last URL accepted, and the message says the chain
  left the approved hosts. The refused URL is never returned or stored — it is
  exactly the address that should not become a row.
- The browser never supplies a URL: both producers draw the target from the bag
  server-side or in-script, which is what keeps this from being an open proxy.
- The app's whole redirect chain shares one 8 s budget, and every response body
  is cancelled unread, so no page is buffered in memory.

## Layout

- `voni/src/app/email/page.tsx` — page gate, panel shell, and the four reads
  (check, probes, 24 h stats, recent clicks). Nothing on load sends a click.
- `voni/src/app/email/actions.ts` — page unlock, page lock (`lockPage`, drops
  both cookies), control unlock/lock, `saveVolume`, `toggleCheck`,
  `addTarget`, `toggleTarget`, `removeTarget`, `runOneOffClick`, `runBurst`. Every exported action authorises inside its own body; the
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
- `voni/src/lib/email/pool.ts` — the provider bag, `resolveTarget()` utm
  stamping, and the seed guard.
- `voni/src/lib/email/targets.ts` — the live target list: seed-on-empty,
  `activeTargetUrls()`, `allTargetUrls()`, and the add/pause/remove writes.
- `voni/src/lib/email/target-url.ts` — the one rule for what a target may be,
  plus the private-address helpers the redirect guard shares.
- `voni/src/lib/email/targets.json` — the **seed** list, written once into an
  empty table. Data, not code; editing it after the first read changes nothing.
- `voni/src/components/targets-card.tsx` — the panel card that calls the three
  target actions.
- `voni/src/lib/email/volume.ts` — accepted intervals (1–60 min), probe ids,
  clicks/day and executions/month.
- `voni/src/lib/email/check-script.ts` — the one builder for
  `scripts/affiliate-click-check.k6.js`; imported by the generator and by
  `saveVolume`.
- `voni/src/lib/grafana/synthetic.ts` — Synthetic Monitoring client: read a
  check, list probes, upload a check's script, change enabled/frequency/probes.
- `voni/scripts/generate-affiliate-k6.mts` →
  `voni/scripts/affiliate-click-check.k6.js` — the generated check script
  (the writer; the template lives in `check-script.ts`).
- `voni/scripts/upload-affiliate-check.mts` — `npm run affiliate:upload`:
  injects `EMAIL_CLICK_REPORT_SECRET` into the script in memory, posts it to
  the check, reads it back and verifies the hash and every untouched field.
  Helpers in `voni/scripts/lib/affiliate-check.ts`; tested by
  `voni/scripts/upload-affiliate-check.test.ts`.

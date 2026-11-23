# `/email` and the affiliate click sources

`voni.cc/email` is a password-gated console of **sources** that send affiliate
clicks. It has one shared target list at the top and one collapsible card per
source below. Three sources exist today:

- **Grafana** Synthetic Monitoring check `voni-affiliate-click-us`: a scripted
  k6 check whose script is `voni/scripts/affiliate-click-check.k6.js`, running
  from its selected probes (the four US probes by default).
- **GitHub**: real Chrome on GitHub Actions, one runner on Ubuntu, Windows and
  macOS, clicking every shared target once per interval.
- **Burst**: one on-demand k6 Cloud run of the same generated script.

Targets are shared because every producer already reads the same list. Sources
are independent because each answers a different question: Grafana proves a
target accepts the click over HTTP, and GitHub proves the click survives a real
browser. Neither proves a human clicked.

The page reads the rows those sources produced from `affiliate_clicks`. It can
change the Grafana check's interval, probe set, target-selection mode and
enabled state through Grafana's API, and it can change the GitHub source's
schedule and enabled state in `email_sources`.

One control is not a source card: `runOneOffClick` in
`src/app/email/actions.ts` performs a single click from voni's own server with
the same identity pool and header shape, using the targets ticked inside the
Grafana card (all active targets by default). Its rows are stored with producer
`oneoff`, so a target and its attribution can be verified without waiting for
another source. The page never sends a click on load.

## The console

The page renders, in order:

1. The shared **Targets** card: every target row once, with add, pause, resume
   and remove. Its aggregate line states total clicks per day across every
   enabled source, with **Pause all** beside it.
2. A **Sources** heading, then one card each for Grafana, GitHub and Burst.
3. The shared click history table, with source chips.

A source card is a `SourceCard` (`src/components/source-card.tsx`) whose header
sits outside the collapsible body. Collapsing a card hides its controls, never
its enabled state, its clicks per day or its worst health. Cards are additive,
not exclusive: enabling a second source adds to the same targets, which is why
the aggregate exists.

**Total volume** adds Grafana's live volume and GitHub's saved schedule. A
disabled source contributes zero. A Grafana check that could not be read makes
the total `Unavailable`, never zero, because "we could not see the check" and
"the check is off" are different facts. Burst is on demand, so it adds no daily
volume.

**Pause all** pauses the Grafana check and disables the GitHub source in two
independent writes. One failure does not stop the other, and neither is reported
as success if it failed. It leaves the target list alone and does not cancel a
GitHub segment that is already queued or running. Burst has nothing to pause.

**Source chips** on the click table are links: `?source=all`, `?source=grafana`,
`?source=github`, `?source=oneoff`. The value resolves inside the request-time
boundary, so a copied URL opens the table the sender saw. `?source=` selects a
**producer**, not the click row's `source` column; that column is the claimed
`utm_source` (the email provider), and its meaning is unchanged.

## Sources and producers

The three words are different on purpose:

- A **source** is a mechanism that produces clicks and gets a card.
- A **producer** is the closed enum stored on each click row that says which
  mechanism produced it.
- A **target** is one row in the shared list. It is neither a source nor a
  producer.

| Source | Card | Stored producer | What it proves | Cadence |
| --- | --- | --- | --- | --- |
| Grafana | Grafana | `grafana` | The target accepts a click over HTTP from Grafana's probes. | Its interval, probes and clicks-per-run live in Grafana. |
| GitHub | GitHub | `github` + `runner_os` | The click survives real Chrome: page JavaScript, cookies, third-party scripts and the affiliate's bot checks. | Interval from 15 s to 60 min inside an 8, 12 or 24 h window. |
| Burst | Burst | `grafana` | The same HTTP claim as Grafana, at burst scale, from k6 Cloud's US zones. | On demand only. |
| One-off button | Inside the Grafana card | `oneoff` | One click from voni's own server, now. | Manual. |

Burst writes `grafana` rows because it runs the same generated script, and the
intake treats an absent producer as Grafana's. The one-off button is the only
writer that names `oneoff`; it is a control inside the Grafana card, not a fourth
card.

The `affiliate_clicks` row carries:

```ts
producer:  enum("grafana" | "github" | "oneoff")  default "grafana"
runnerOs:  "ubuntu" | "windows" | "macos" | null // null for grafana/oneoff
```

The `grafana` default **is** the backfill: every row written before the column
existed was Grafana's, so history keeps its meaning without a data rewrite. The
intake accepts both fields, treats an absent producer as `grafana`, refuses an
unknown producer (`bad_producer`), and refuses an OS outside the allowlist
(`bad_runner_os`). `runner_os` is nullable text because the allowlist lives in
the intake parser, which is the only way a value can be written. An index on
`(producer, ran_at desc)` serves both the card stats and the liveness query.

`utm_source` is untouched. It still names the claimed email provider, not the
source that produced the click.

## The live click path

```
Grafana check voni-affiliate-click-us (scripted k6)
  → GET <target with utm>            http.get, redirects: 10
  → POST /api/email/clicks/report    x-voni-click-secret: REPORT_SECRET
      { target, source, finalUrl, status, ms, userAgent, device, browser, ranAt }
  → affiliate_clicks                 producer "grafana"

Burst (k6 Cloud, same generated script)
  → the same two steps               producer "grafana"

GitHub browser check (real Chrome, one runner per OS)
  → page.goto(<target with utm>)     fresh browser context per click
  → POST /api/email/clicks/report    { ..., producer: "github", runnerOs }
  → affiliate_clicks                 producer "github", runner_os set

/email → "Run one click now"
  → simulateOneClick()               bounded, host-allowlisted redirect chain
  → affiliate_clicks                 producer "oneoff"
```

Every producer writes one row per click and nothing updates a row afterwards.
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
| `producer` | `grafana`, `github` or `oneoff`; absent means `grafana` |
| `runnerOs` | `ubuntu`, `windows` or `macos`, or null |
| `ranAt` | ISO timestamp no older than 24 h and no more than 5 min ahead; absent means now |

The body is capped at 4 KiB, unknown keys are ignored so a newer producer still
works against an older route, and a rejection answers `400` with a machine
reason rather than echoing the body. A missing or wrong secret is one `401`
(`503` when `EMAIL_CLICK_REPORT_SECRET` is unset), and a failed insert is `502`.
No response quotes the payload: a body can contain an arbitrary URL.

`status: null` is the row's "the visit never produced a response" case, not an
error code. k6 reports `0` when the transport failed, and the generated script
converts that to null — `0` is below the accepted minimum, so sending it raw
would make a failed click impossible to record. For the same reason the Grafana
script sends `target` as the stamped URL it actually visited, not the bare bag
entry, which is what the one-off click stores. One column, one meaning.

## Target selection

One target and one claimed email provider per click. The provider always rotates
through a no-repeat bag; the target is chosen by the mode saved with the Grafana
check:

| Mode | What a click does |
| --- | --- |
| `random` (what a new script is built with) | uniform draw with replacement: any active target, equal odds, so one target can repeat and another may wait |
| `rotate` | every active target once per shuffled pass, then the bag refills — the behaviour every script built before the mode existed had |

The mode is a line in the check's stored script — `const TARGET_SELECTION =
"random";` — emitted by `buildCheckScript` together with the draw itself and
read back by the panel (`readStoredTargetSelection` / `readTargetSelection` in
`voni/src/lib/email/target-selection.ts`). It is not a database column, so the
panel can only show a mode that was actually saved. A script with no marker
predates the setting — "no choice yet", not "rotate": the switch opens on the
new default (`random`) and the copy says the live script is still rotating. The
first Save, or any target change (which also rebuilds the script), applies
`random` unless the operator turns the switch off. The one-off click does not
rebuild, so it follows what the live script is doing — `rotate` until that first
save. `rotate` is per k6 VU: each VU owns its bag, so a burst (up to 500 VUs)
runs up to 500 independent passes. `random` keeps no per-VU state at all.

The GitHub runner does not use this mode. Every pass shuffles the whole
dispatched list and clicks all of it, so its coverage is a property of the loop
rather than a draw.

The providers are a constant in `voni/src/lib/email/pool.ts`; the targets are
rows in `affiliate_targets`, managed from the console's **Targets** card. The
list mixes voni-hosted pages with affiliate links that redirect off-site:

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
`src/lib/email/check-script.ts`, which both `npm run affiliate:check` and the
panel's save call use. Never edit `scripts/affiliate-click-check.k6.js`; edit
its sources and regenerate. The builder is deterministic: the same sources
produce byte-identical output, so a diff after regenerating means a source file
changed (`check-script.test.ts` asserts the committed file is exactly a fresh
one-click build).

`voni/src/lib/email/targets.json` is only the **seed**. The first read of an
empty `affiliate_targets` writes those URLs once; from then on the panel owns
the list, and a deploy never overwrites an operator's pause or removal. The file
stays because a generator or test run with no database needs a list, and because
a seed reviewable in git makes the first page load predictable.

## Managing targets from the panel

The Targets card lists every row with Active/Paused, a pause/resume button and a
remove button, plus one add field. The rules that make it safe to use against
live traffic:

- **A Grafana target change rebuilds and re-uploads the script immediately.** The
  Grafana target list is inlined in the script Grafana runs, so writing
  `affiliate_targets` alone would leave the probes clicking the old set.
  `applyTargetChange()` in `src/app/email/actions.ts` uploads the rebuilt script
  *before* the row changes; a Grafana refusal leaves both unchanged and says so.
  If the row write fails after a successful upload, the previous list is pushed
  back, so the probes never keep clicking a URL the table no longer has.
  `saveVolume()` rebuilds through the same path and reads the live list too — a
  volume save must not resurrect a paused target by falling back to the seed. A
  target change preserves the mode as well: `pushTargetsToCheck()` reads
  `targetSelection` back from the stored script, so pausing one URL never
  resets the operator's Random/Rotate choice.
- **The GitHub source reads the list at dispatch time.** The ticker and
  `dispatchGithubNow` call `activeTargetUrls()` when they dispatch, so a pause or
  removal applies to the next segment with no upload and no rebuild. A segment
  already running keeps the list it was given.
- **Pause is not delete.** A paused row stays in the table and is not drawn by
  any source — the lever for investigating one creative while the rest keep
  clicking. The last active target cannot be paused, and the last row cannot be
  removed: a Grafana check with no targets would run green and click nothing, and
  a GitHub dispatch would refuse.
- **History keeps its URL.** `affiliate_clicks` stores the URL each visit used,
  so removing a target never rewrites what was sent.
- **The add rule is one function.** `targetUrlProblem()` in
  `voni/src/lib/email/target-url.ts` requires an absolute `https://` URL on port
  443 with a public domain name, no credentials, no IP literal (private or
  public), at most 2048 characters. `addTarget` re-runs it server-side (a server
  action is a public endpoint), the builder re-runs it before upload, and
  `pool.assertEmailTargets` applies it to the seed at module load — a hand edit
  cannot be looser than the panel. The stored value is the canonical URL
  (`canonicalTargetUrl`), so `https://x.com` and `https://x.com/` are one row,
  not two entries competing in the bag.

A burst dispatched from the card carries the active list as the workflow's
`targets` input and the check's mode as its `selection` input (the job reads it
as `AFFILIATE_TARGET_SELECTION` and `burst.yml` proves the marker reached the
generated script). The **manual** fallback (`k6 cloud run
scripts/affiliate-click-check.k6.js`) runs the committed script, so it clicks
the seed list in the committed mode (`random`) rather than the panel's — the one
place the two can differ.

`allTargetUrls()` — every row, paused included — is the approved-host list for
redirect hops in the app's one-off click. Pausing the tracker must not stop a
sibling target's chain at its first hop; adding a target is what approves its
host as a redirect destination.

A consequence worth knowing: because the target list points at production URLs,
running any source fetches production, not your dev server. The Grafana check is
live traffic; one run fires once on every selected probe and sends
clicks-per-run clicks there, so clicks/day is `runs per day × probes × clicks per
run` (`src/lib/email/volume.ts` computes it for the panel). The Grafana panel's
interval floor is one minute and its clicks-per-run ceiling is ten; both are
enforced by `validateVolume` and by the builder.

## The GitHub source

The GitHub card runs real Chrome (`channel: "chrome"`, headless) on
`ubuntu-latest`, `windows-latest` and `macos-latest`. It is the only source that
claims a browser click: the Grafana check cannot exercise page JavaScript,
cookies, third-party scripts or bot detection.

### Schedule

| Setting | Values | Default |
| --- | --- | --- |
| Interval | 15, 30, 60, 120, 300, 600, 900, 1800 or 3600 seconds | 60 s |
| Active window | 8, 12 or 24 hours | 12 h |
| Start hour | 0–23, UTC | 07:00 UTC |

A window opens at `HH:00` UTC and is half-open: the start is inside and the end
is outside. A 12 h window opening at 20:00 therefore runs to 08:00 the next
morning.

The card offers only values the runner can honour. One parser per field
(`parseInterval`, `parseWindowSeconds`, `parseWindowStartHour` in
`voni/src/lib/email/sources.ts`) gates the save action, and the card offers
exactly those values. The ticker reads the saved row and trusts this as the only
write path, so an unsupported value can only arrive through a hand-written row.
An interval outside the set is refused with the sentence that names the legal
values, so what is saved is always something the loop can pace.
The preview beside the selects shows the clicks per day the draft would command
before it is saved: one pass every interval for the window, clicking every
shared target from every OS. The header changes only after the save lands.

At four targets, three OSes and 60 s over 12 h, the source commands **8,640
clicks per day**. At the 15 s floor it commands **34,560**. A 24 h window at 60 s
commands **17,280**. `clicksPerDay()` is the one formula the card, the aggregate
line and tests use.

The migration seeds the source **disabled**. A migration may create the row,
but nothing clicks from GitHub until an operator enables the card.

### What the card shows

All GitHub status is derived from click rows, never from a GitHub API call. A
dispatch answers `204` with no body, so there is no run id to read; the stable
link is the workflow page.

The header states the enabled state, clicks per day and the worst OS health
(`Not configured`, `Disabled`, `Outside active hours`, `Never run`, `Stale` or
`Live`). An enabled source outside its own window is a stated state, not a
destructive "Stale". The body adds:

- one row per OS with its last run, conclusion and coverage (`targets 4/4`) for
  the **most recent pass**, and a link to the workflow page;
- `Dispatch now` per OS;
- this source's own clicks for the basis window, split by OS and by target.

A failed run leaves screenshots on the workflow page as the
`browser-check-screenshots-<os>` artifact (7-day retention).

The click statistics use **since last dispatch**, or the last 24 hours when the
source has never dispatched. Coverage is not a rolling window: it is the OS's
newest `pass_id`, counted as distinct active shared targets with a row in that
pass whose status is not null — a no-response row is a miss. The conclusion is
`Complete` (hits equal the active target count), `Partial`, `Failed` or
`Never run` (no pass). The denominator is the active target list, so pausing a
target lowers both the volume and the denominator.

### The runner

`voni/scripts/browser-click.mjs` launches Chrome once per segment. Every click
gets a fresh browser context, so cookies, storage and cache never leak from one
target to the next. Per pass it:

1. shuffles the dispatched target list and clicks all of it;
2. records final URL, status and duration, and posts the report with
   `producer: "github"` and `runnerOs`;
3. waits out the rest of the interval, drift-corrected, so a slow pass does not
   push every later pass later.

Every report of one pass carries the same generated `passId`, including a
failed navigation (`status: null`). Each pass tracks its own misses; a later
pass that recovers a target does not erase the earlier miss. At the end the
runner names the **final pass's** misses and every report that was not stored,
and exits non-zero if any remains. Coverage is therefore a property of the
loop, not an assertion about intent.

The workflow (`.github/workflows/browser-check.yml`) is workflow-dispatch only,
with `contents: read`, a per-OS concurrency group that queues rather than
cancels, and a 350-minute timeout under GitHub's 6-hour ceiling. The k6 script
generator is not modified; its byte-identical output is the Grafana contract.

### Chained segments

A 12 h or 24 h window exceeds GitHub's hard 6-hour job ceiling, so a window is
realised as chained segments. The ticker asks for at most 20,000 seconds
(about 5.6 h) per dispatch; the workflow accepts up to 20000 seconds. When a
segment's clicks stop, the next tick sees the OS as dead and dispatches the rest
of the open window as a new segment. The card shows one window and one interval;
chaining is invisible to the operator.

### Dispatch now

`Dispatch now` on one OS row reads the live target list and the saved schedule,
never the form, and dispatches one segment. Outside the window it takes a full
segment rather than refusing, so an operator can prove the path before turning
continuous running on. A missing dispatch token is a manual outcome, not an
error: the card shows the exact `gh workflow run` command to run instead.

## The ticker: clicks are the heartbeat

The Cloudflare cron runs every minute (`wrangler.jsonc`). The worker's
scheduled handler sweeps durable jobs first, then calls
`POST /api/internal/sources/tick` with `JOB_WORKER_SECRET`. The source ticker is
subordinate: a GitHub outage, a missing row or a failed dispatch logs and does
not fail the cron.

The ticker reads the GitHub source's `email_sources` row and does nothing when:

- the row is missing — the source is not configured;
- the source is disabled;
- the current instant is outside its active window;
- every OS has clicked recently;
- a recent dispatch is still inside its 600-second anti-thrash window.

An OS is dead once its newest click is at least `max(600 s, 2 × interval)` old,
or when it has never clicked. Clicks are the heartbeat: there is no health flag
that could disagree with the rows. For each dead OS the ticker dispatches one
segment and records `last_dispatched_at`. A repeat dispatch within 600 seconds
is suppressed, so a persistent failure cannot respawn dispatches every minute.
After a job finishes, the next segment is started by the same liveness rule.

Each OS dispatches inside its own try/catch, so one OS failure costs that OS its
segment, not the sweep. A dispatch that fell back to manual mode started no run,
so it is not recorded — recording it would throttle a retry for work that never
happened.

The route accepts `{ "dryRun": true }` in its body. A dry run returns the same
decision and per-OS summary, with each due OS reported as `skipped: dry_run`,
and performs no dispatch and no `last_dispatched_at` write. The worker always
sends `{}`, so a dry run is an operator pressing the route by hand.

There is no durable job kind for a dispatch. The job system is session- and
creator-scoped, `/email` authorises with a control cookie and no session, and a
dispatch is one bounded HTTP call. The durable part is the runner, and its
durability is GitHub's; the app's obligation is to notice when it stops.

## Dispatch token and secrets

Four credentials matter here. They must never share a value.

| Credential | Env var | Carried by | Protects |
| --- | --- | --- | --- |
| Dispatch token | `GITHUB_BURST_TOKEN` | `Authorization: Bearer` on the GitHub dispatch request; a Worker secret | Starts one workflow run on `cipherlogs/voni`. One token dispatches both Burst and the browser check. Never sent to a browser, never logged, redacted from every returned string. |
| Click-report secret | `EMAIL_CLICK_REPORT_SECRET` | `x-voni-click-secret` on `POST /api/email/clicks/report`; in the Grafana check script and in the repository's Actions secrets | One append to `affiliate_clicks`, and nothing else. |
| Worker secret | `JOB_WORKER_SECRET` | `x-voni-worker-secret` from the Cloudflare scheduled handler | The worker-only internal routes, including the source ticker. A missing or wrong value answers `403`. |
| Control secret | `EMAIL_CONTROL_SECRET` | cookie `voni_email_control` | The console's mutations. See **Locks**. |

### The token is scoped to this repository

`GITHUB_BURST_TOKEN` must be a fine-grained PAT whose **only** repository is
`cipherlogs/voni`, with **Actions write** permission (the permission that allows
a workflow dispatch). Nothing broader is needed or acceptable.

A token scoped to "all public repositories" is a silent break. The day
`cipherlogs/voni` changes visibility, that token can no longer see it, and every
dispatch starts failing with a `401`/`403`/`404` that reads like a missing
workflow rather than a token-scope problem. A classic PAT with `repo` scope is
also too broad: it grants read and write access to every repository the account
can reach. Do not use either.

The token is optional on purpose. With no token the dispatch returns
`mode: "manual"` and the command a human would run; it is not an error and no
dispatch is recorded. A token that is present but wrong is an error, with the
`401`, `403` and `404` cases split into different sentences. The request is one
POST with a 10-second timeout, a required `User-Agent`, and token redaction on
every string the dispatcher returns.

## Locks

Two credentials gate the page itself. Two more are machine credentials: the
report secret and the worker token above. None of them may share a value.

| Lock | Env var | Carried by | Lifetime | Protects |
| --- | --- | --- | --- | --- |
| Page password | `EMAIL_PAGE_PASSWORD` | cookie `voni_email_view`, value `sha256("voni:email-page:" + password)` in hex | 12 h; `path=/email`, `httpOnly`, `SameSite=Lax`, `Secure` in production | Whether the page renders at all. Until it is satisfied the response carries the gate screen and nothing else — no check, no probes, no click history. |
| Control secret | `EMAIL_CONTROL_SECRET` | cookie `voni_email_control`, value `sha256(secret)` in hex | 12 h; `path=/email`, `httpOnly`, `SameSite=Lax`, `Secure` in production | The mutations: save the Grafana interval/probes/clicks, pause/resume the check, add/pause/remove a target, run one click now, run a burst, enable/disable GitHub, save the GitHub schedule, dispatch one OS, and Pause all. A locked console still renders its data; it is read-only. |
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
Grafana check script, where any operator who can read the check can read it, and
in the repository's Actions secrets for the browser runner. It may only append
one click row — no read, no update, no other table. The endpoint itself is
unauthenticated-but-secret-gated: anyone can POST to it, and the only thing
standing between the internet and an append is the shared secret. It never
updates or deletes a row.

Getting the secret into the Grafana script is a build step, not an edit:

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

The browser runner gets the same secret from the repository's Actions secret,
which the workflow maps to `EMAIL_CLICK_REPORT_SECRET` and
`browser-click.mjs` sends only as a header.

Rotation is therefore: set the new value in the deployment environment (the
Worker secret), deploy, change `.env.local` to match, update the repository
Actions secret, and run `npm run affiliate:upload` again. Re-running upload after
a rotation is the Grafana update path; the Actions secret is the runner's. Rotate
both sides together, or every report answers `401`. Never reuse the report
secret for anything else, and never put a Grafana token in the script —
`GRAFANA_SM_URL` / `GRAFANA_SM_TOKEN` can read and modify the check, which is a
much larger grant.

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

- The Grafana check runs from Grafana's network, not voni's. k6 follows
  redirects to any host and reports the final URL it observed; that row is a
  measurement of the target, not a request voni made.
- The browser check runs from GitHub's runners. It clicks only the target list
  the app dispatches and never a URL supplied by a browser. The click's final
  URL is whatever the page navigated to, which is the thing a browser proves.
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
- The browser never supplies a URL: every producer draws the target from the
  shared list server-side or in-script, which is what keeps this from being an
  open proxy. The one-off form may name a *subset* of target rows — ids, never
  URLs, with every active row ticked by default — so an operator can pin one
  creative. The server re-checks each id against the live enabled list and still
  chooses the URL itself. In `rotate` mode that press takes the ticked target
  with the oldest recorded visit (any producer's click counts, folded by
  `baseTargetUrl`), so repeated presses walk the subset; in `random` mode it is
  a uniform draw. A failed Grafana read only costs the mode and falls back to
  `random` — the click still runs.
- The app's whole redirect chain shares one 8 s budget, and every response body
  is cancelled unread, so no page is buffered in memory.

## Layout

- `voni/src/app/email/page.tsx` — page gate, console shell, shared targets,
  the three source cards, and the reads (check, probes, targets, 24 h stats,
  recent clicks, GitHub config, newest click per OS, GitHub click samples).
  Nothing on load sends a click.
- `voni/src/app/email/actions.ts` — page unlock, page lock (`lockPage`, drops
  both cookies), control unlock/lock, `saveVolume`, `toggleCheck`,
  `addTarget`, `toggleTarget`, `removeTarget`, `runOneOffClick`, `runBurst`,
  `setGithubSourceEnabled`, `saveGithubSchedule`, `dispatchGithubNow`,
  `pauseAllSources`. Every exported action authorises inside its own body; the
  client's locked rendering is never a gate. The unlock throttle's policy lives
  in `voni/src/lib/email/unlock-throttle.ts`.
- `voni/src/app/api/email/clicks/report/route.ts` — machine intake for every
  producer. One shared secret, append-only.
- `voni/src/app/api/internal/sources/tick/route.ts` — worker-only ticker that
  decides which GitHub OSes are due and dispatches one segment each.
- `voni/worker.ts` — the scheduled handler: job sweep first, then the source
  tick.
- `voni/src/components/targets-card.tsx` — the shared target list, aggregate
  volume and `Pause all`.
- `voni/src/components/source-card.tsx` — the collapsible shell every source
  card uses; its header carries state, volume and worst health outside the
  collapsed body.
- `voni/src/components/affiliate-control-panel.tsx` — the Grafana card and its
  one-off click controls. `voni/src/components/github-source-card.tsx` — the
  GitHub card. `voni/src/components/burst-card.tsx` — the Burst card.
- `voni/src/lib/email/sources.ts` — the runner schedule domain: accepted
  intervals and windows, `clicksPerDay`, `deadAfterSeconds`, `insideWindow`,
  `windowRemainingSeconds`, `planSegments` and `decideDue`. Pure, no database.
- `voni/src/lib/email/source-config.ts` — the `email_sources` boundary: read
  config, newest click per OS, enable/disable, save schedule, record dispatch.
- `voni/src/lib/email/click-simulator.ts` — one click's request shape and its
  bounded, host-allowlisted redirect chain.
- `voni/src/lib/email/user-agents.ts` — the profile matrix, client hints, and
  the webmail Referer map. One source for every producer.
- `voni/src/lib/email/click-report.ts` — wire shape, producer and OS
  allowlists, parse rules, constant-time secret check.
- `voni/src/lib/email/clicks.ts` — `recordAffiliateClick`, the reads and stats
  the console renders, the source chips, and `summariseRunnerClicks`; schema in
  `src/lib/db/schema`.
- `voni/src/lib/email/page-gate.ts`, `control.ts` — the two cookies and their
  comparisons.
- `voni/src/lib/email/unlock-throttle.ts` — the attempt budget both password
  forms spend: per-IP first, then the global ceiling, 15-minute fixed window,
  fail-closed with a message the form can render.
- `voni/src/lib/email/pool.ts` — the provider bag, `resolveTarget()` utm
  stamping, `baseTargetUrl()` (a stamped click folded back to its target), and
  the seed guard.
- `voni/src/lib/email/target-selection.ts` — the two modes, the script marker's
  read-back (`readTargetSelection`), and `pickTarget()` for the one-off click.
- `voni/src/lib/email/targets.ts` — the live target list: seed-on-empty,
  `activeTargetUrls()`, `allTargetUrls()`, and the add/pause/remove writes.
- `voni/src/lib/email/target-url.ts` — the one rule for what a target may be,
  plus the private-address helpers the redirect guard shares.
- `voni/src/lib/email/targets.json` — the **seed** list, written once into an
  empty table. Data, not code; editing it after the first read changes nothing.
- `voni/src/lib/email/volume.ts` — Grafana's accepted intervals (1–60 min),
  probe ids, clicks/day and executions/month.
- `voni/src/lib/email/check-script.ts` — the one builder for
  `scripts/affiliate-click-check.k6.js`; imported by the generator and by
  `saveVolume`.
- `voni/src/lib/github/dispatch.ts` — the shared workflow dispatcher: the token
  read, manual fallback, 10 s timeout, required User-Agent, status sentences,
  redaction, and `dispatchBrowserCheck` with the workflow's input names.
- `.github/workflows/browser-check.yml` — the real-Chrome workflow.
  `voni/scripts/browser-click.mjs` — the runner loop.
  `voni/scripts/browser-source-wiring.test.ts` — reads the workflow as text and
  fails when its inputs, timeout, concurrency or permissions drift from the
  dispatcher.
- `voni/src/lib/grafana/synthetic.ts` — Synthetic Monitoring client: read a
  check, list probes, upload a check's script, change enabled/frequency/probes.
  Every write is read → merge → `POST /check/{id}` with the whole body back, so
  what it reads must round-trip: `labels` is `[{name, value}]` on the wire, and
  a map (the natural guess) is a `400` that rejects the entire request — which
  reads to the operator as "Could not update targets" / "Could not complete" on
  every panel action at once. The module header lists the rest of the quirks
  (`/probe` singular, `POST` only, base64 script).
- `voni/scripts/generate-affiliate-k6.mts` →
  `voni/scripts/affiliate-click-check.k6.js` — the generated Grafana check
  script (the writer; the template lives in `check-script.ts`).
- `voni/scripts/upload-affiliate-check.mts` — `npm run affiliate:upload`:
  injects `EMAIL_CLICK_REPORT_SECRET` into the script in memory, posts it to
  the check, reads it back and verifies the hash and every untouched field.
  Helpers in `voni/scripts/lib/affiliate-check.ts`; tested by
  `voni/scripts/upload-affiliate-check.test.ts`.

Related records: [ADR-0015](../adr/0015-browser-sources-over-one-target-list.md)
records why sources are independent and targets are shared, and why the
edge-worker pool was retired. [Load-testing `/email`](load-testing.md) says what
each source proves and what a load test cannot.

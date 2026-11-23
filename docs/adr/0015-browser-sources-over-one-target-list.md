# Browser sources sit over one shared target list

**Status: accepted. Decided 2026-11-23.**

The `/email` console had one source and one measurement. A single Grafana
Synthetic Monitoring check sent HTTP clicks from its probes, and every target
lived under that check's card, as if the targets belonged to Grafana. They did
not: every producer already read the same `affiliate_targets` rows. There was
also only one kind of click — a k6 HTTP client with a browser-shaped
User-Agent — so no one could tell whether a click survives a real browser, and
no row said which producer made it. Adding a second producer would have produced
two sets of numbers nobody could separate.

This record fixes the model the console now implements: **sources are
independent and targets are shared.** Each source gets a card, its own cadence,
its own health and its own numbers. Every source draws from the one target list
at the top of the page, so a target is added, paused or removed once. The model
and its console are described in `docs/agents/email-pool.md`.

## The decisions this record fixes

- **Targets are one list, above the sources.** The Targets card owns add, pause,
  resume and remove. An aggregate line states total clicks per day across every
  enabled source, with **Pause all** beside it. Sources are additive: enabling a
  second source adds traffic to the same targets, which is why the aggregate is
  part of the design rather than a later nicety.
- **A source is a card, not a page.** Grafana, GitHub and Burst each have a
  collapsible card. A collapsed header still states the enabled state, the
  clicks per day and the worst health, so collapsing can never hide volume or
  failure. A fourth source costs a card, a config row and a workflow, not a page
  rewrite.
- **Every click is attributable.** `affiliate_clicks.producer` is a closed enum
  (`grafana`, `github`, `oneoff`) with default `grafana`; `runner_os` is nullable
  and allows only `ubuntu`, `windows` or `macos`. The default *is* the backfill:
  rows written before the column existed keep their meaning without an update
  statement. The intake treats an absent producer as Grafana's, refuses an
  unknown producer, and refuses an OS outside the allowlist. `utm_source` is
  untouched and keeps naming the claimed email provider.
- **Each source proves a different claim.** Grafana proves a target accepts the
  click over HTTP. GitHub proves the click survives real Chrome: page
  JavaScript, cookies, third-party scripts and the affiliate's bot checks.
  Neither proves a human clicked, and neither proves the affiliate accepted or
  paid for it. Disagreement between the two is signal.
- **Only config this app executes lives in `email_sources`.** The row holds the
  GitHub producer, enabled state, interval, window, start hour and last dispatch
  time. Grafana's interval, probes, clicks-per-run and enabled state stay in
  Grafana and are read over its API: copying them here would create a second,
  silently stale source of truth for a remote executor. The source is seeded
  disabled, so a migration may create the row but nothing clicks until an
  operator enables it.
- **Clicks are the heartbeat.** The one-minute Cloudflare ticker calls a
  worker-only route that reads the config and the newest click per OS. An OS is
  dead once its newest click is at least `max(600 s, 2 × interval)` old, or when
  it has never clicked. A dead OS gets one dispatch, recorded in
  `last_dispatched_at`; a repeat within 600 seconds is suppressed. There is no
  health flag to disagree with the rows, and a finished segment hands over to the
  next one by the same rule.
- **One dispatcher, one token scope.** Burst and the browser check share
  `dispatchWorkflow`: the token read, manual fallback, bounded timeout, required
  User-Agent, status-specific sentences and redaction exist once. The token is a
  fine-grained PAT on this repository only, with Actions write. It is never
  scoped to all public repositories, because that token silently stops seeing
  this repository the day its visibility changes.

## Why the edge-worker pool was retired

A dedicated Cloudflare edge-worker pool for `/email` was built and retired in the
same week. It is recorded here because the reasoning otherwise exists only in
commit messages, and the next person with the same idea would rebuild it.

- **The fan-out multiplied traffic back onto the origin it was measuring.** One
  page load asked every Worker in the pool to fetch a target, so a single visit
  became N outbound requests to the target. The instrument changed the thing it
  was measuring.
- **It was public with no rate limit.** The page that triggered the fan-out was
  reachable without authentication, so repeated loads, or anyone who found the
  page, could multiply clicks on a third-party target.
- **It left Workers deployed holding secrets.** Retiring the click path did not
  retire the deployments; the Workers stayed up with their credentials attached
  until a later change removed the code, CI, docs and env rows.

Nothing in the current design needs an edge-worker split. GitHub is the
executor, the app only makes one bounded dispatch request, and its only
obligation is to notice when clicks stop arriving.

## Consequences

- **Volume is multiplicative and explicit.** At four targets, three OSes and
  60 seconds over a 12 h window, the GitHub source commands 8,640 clicks per day.
  At the 15-second floor it commands 34,560; over a 24 h window at 60 seconds,
  17,280. Grafana's ceiling is higher still. The aggregate line and each card's
  number are the guardrails, which is why they are part of the design.
- **A private repository changes the bill.** Runner minutes are free on a public
  repository. On a private one, macOS bills at ten times: one 12-hour window
  holds 720 runner-minutes and bills 7,200, which is 3.6 times the entire monthly
  allowance. The interval stays per source so a per-OS split would be a config
  change rather than a migration.
- **The token can break on a visibility change.** A token scoped to all public
  repositories cannot see a private repository. Dispatch then answers `401`,
  `403` or `404`, which reads like a missing workflow. Scope the token to
  `cipherlogs/voni` with Actions write, and the break cannot happen.
- **Two sources can disagree, and that is the point.** A green Grafana check and
  a failing browser pass describe different failures; the console shows both
  rather than averaging them into one number.
- **Coverage is a property of the loop.** The GitHub runner clicks every
  dispatched target on every pass, in a fresh browser context. A partial pass
  exits non-zero and reads as `3/4` on the card, never as a green run.

## Considered options

- **Keep one Grafana check and add a second check for browsers.** Rejected: the
  targets would still be duplicated per check, and no page could state total
  traffic across both.
- **Put a target list under each source.** Rejected: it implies a hierarchy that
  does not exist, and the lists would drift the first time someone paused a
  target in one place.
- **Store a healthy flag or last-run state per OS.** Rejected: a flag can
  disagree with the clicks it claims to describe, and a finished job would have
  to write state the next job must trust. Clicks are already the evidence.
- **Make a dispatch a durable job.** Rejected: the job system is session- and
  creator-scoped, `/email` authorises with a control cookie and no session, and a
  dispatch is one bounded HTTP call. The durable part is the runner, and its
  durability is GitHub's.
- **Rebuild the edge-worker pool.** Rejected for the three reasons above. A
  second Cloudflare Worker would repeat the fan-out, the public trigger and the
  deployed-secrets problem.
- **Use k6 Cloud for the browser path.** Rejected: k6 Cloud is burst-only. It is
  an HTTP load generator, so it cannot make the claim the browser source exists
  to make.
- **Self-hosted runners.** Rejected: the repository is public, and a self-hosted
  runner attached to a public repository executes fork-PR code on the operator's
  machine.

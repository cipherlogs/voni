# Load-testing `/email`

`voni.cc/email` is a **page**, not a redirect. It draws nothing when it loads:
the sources it controls draw one target and one `utm_source` from the bags in
`voni/src/lib/email/pool.ts`, and a one-off click runs from voni's own server.
The visitor never leaves `/email`; the report is rendered in place. Contract:
`docs/agents/email-pool.md`.

The old 307 to `www.glizzitrium.com` is gone. Anything that measured that hop
measures nothing now.

## `scripts/loadtest-email.js` is stale

`scripts/loadtest-email.js` (repo root, not `voni/scripts/`) still encodes the
redirect contract. Do not read a run of it as a pass or a failure of the current
page. Specifically:

| Part of the script | Why it is stale |
| --- | --- |
| `GET <TARGET_URL>` must return **307** | `/email` returns 200 HTML now. Every iteration fails the first check and `return`s. |
| `EXPECT_HOST=www.glizzitrium.com` and `utm_source` on the `Location` | There is no `Location`, no affiliate host, and the source now rides on a URL the click fetches, not on a redirect header. |
| Hop 2: fetch the `Location`, require a `uniqueClick_*` / `transaction_id` cookie | The tracker is no longer the destination, so there is no click cookie to find. |
| `FOLLOW_DEEPER`, the cookie-jar clearing | Same reason: no tracker chain, no growing cookie. |
| `email_edge_ok` / `email_click_ok` counters | They measure the redirect and the affiliate click. Both are meaningless here. |

The script was left in place rather than deleted because its loader.io
explanation is still the correct one (below). Treat its thresholds as history.

## loader.io cannot see the click path

loader.io follows a redirect **only when the target host is verified in your
loader.io account** — a `loaderio-<token>` file at the host root, or a
`loaderio=<token>` TXT record ([Test Results][results], [Verifying a Target
Host][verify]). That mattered when the destination was a third-party tracker.

It matters differently now: `/email` does not redirect at all and sends no click
on load. Clicks come from the Grafana check, the GitHub workflow, or a one-off
server action behind the control cookie. loader.io can run none of them, so a
run only measures the static HTML shell — it can tell you the page is served,
never that a click was sent.

Decisive check: on a loader.io result for `/email`, `Redirects / Invalid > 0` can
only come from a stale run against the old contract, not from the page.

## What each source proves

The console has two continuous sources, and they make different claims. A load
test can repeat either one; it cannot upgrade one claim into the other.

| Source | Executor | Claim | Evidence it leaves |
| --- | --- | --- | --- |
| Grafana | Synthetic Monitoring, scripted k6 over HTTP | The target **accepts** the click: DNS, TLS, redirect chain, a response status. | `affiliate_clicks` rows with producer `grafana`, plus the check's own run history. |
| GitHub | GitHub Actions, real Chrome on Ubuntu, Windows and macOS | The click **survives a browser**: page JavaScript, cookies, third-party scripts and the affiliate's bot checks. | Rows with producer `github` and a runner OS, one pass per interval, `targets x/x` per OS. |

Neither source proves a human clicked, and neither proves the affiliate counted
or paid for the click. Grafana can be green while a browser-only check fails, and
the browser can load a page whose tracking script never fires. Two sources
disagreeing is information; it is not a bug to average away.

**What a load test adds.** It can repeat one source's path at a higher rate and
show where that path breaks: Grafana probes failing together, a rate limit, a
target timing out under concurrency, or a browser runner's pass taking longer
than its interval. That is capacity evidence for the path under test.

**What a load test cannot prove.**

- That the affiliate accepted, attributed or paid for a click. Acceptance is a
  third-party fact, visible only in their reporting.
- That a real visitor would click. Every request comes from Grafana's probes or
  k6 Cloud's load zones, a GitHub runner, or voni's server. The claimed
  `utm_source` is still only a query string.
- That a browser would keep the page. A synthetic browser run proves one load,
  not a session, and not a mobile device: the GitHub source covers desktop
  Chrome on three desktop OSes, not iOS Safari or Android Chrome.
- That the volume is safe for the target. A load test measures what the target
  does under load; it does not decide how much traffic the campaign should
  command.
- Anything about `/email` itself beyond "the shell is served". The page sends no
  click on load, so load-testing the page exercises HTML rendering only.

## What a valid check looks like

What is still worth measuring, and what is not.

**The page itself** — `GET /email` must be 200 HTML, no `Location`, `noindex`,
and it must not be cached as a redirect. A small k6 or `curl` loop is enough:

```bash
curl -sS -D - -o /dev/null https://voni.cc/email | head -20
# expect: HTTP/2 200, content-type: text/html, no location
```

**Grafana is the HTTP source.** The check `voni-affiliate-click-us` sends the
clicks over HTTP; the panel's `Interval`, `Probes` and `Clicks per run` controls
change its rate, and the aggregate line states the resulting clicks per day
before the change is saved.

**GitHub is the browser source.** Enable the card, or press `Dispatch now` on
one OS, to start real Chrome against the shared target list. Its interval runs
from 15 s to 60 minutes inside an 8, 12 or 24 h window, and its card states the
clicks per day the schedule commands. The workflow is dispatch-only; GitHub's
own scheduler never starts a segment.

**There is no public click entry point to load-test.** Grafana's check, the
GitHub workflow and the one-off button are the only ways a click is produced.
The one-off button is authenticated by the control cookie; the workflow is
started by the app with a repository-scoped token, or by hand with the command
the card prints. A load test of a target URL
measures the target's edge, not this page. Anything that puts clicks under
load has to come through one of those sources, and should still be ramped
gently.

**Two sources, one list.** Adding the GitHub source does not change the target
list; it adds traffic to it. Check the aggregate line before enabling a second
source, and use **Pause all** to stop both continuous sources at once.

## Caveats

- The `utm_source` is a query key only. The live path sends the drawn profile's
  user agent and client hints, and a Referer only when the drawn provider maps
  to one (`refererForProvider` in `user-agents.ts`) — otherwise no Referer
  header at all. The claimed source is still just the query string.
- Every request to a target comes from Grafana's probes, k6 Cloud's load zones,
  a GitHub runner, or voni's server for a one-off click. None of them is "a human
  from gmail.com", and none should be reported as one.
- The GitHub window is chained: a 12 h or 24 h window runs as segments of at
  most 20,000 seconds because GitHub cancels a job at six hours. A load test of
  one segment measures one segment, not the whole window.
- The one-off click shares one 8 s budget across its whole redirect chain
  (`CLICK_SIMULATOR_TIMEOUT_MS`); a chain that runs past it fails as a timeout,
  not as a slow page.

[results]: https://support.loader.io/article/19-test-results
[verify]: https://support.loader.io/article/20-verifying-an-app

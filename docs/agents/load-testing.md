# Load-testing `/email` and its edge-worker pool

`voni.cc/email` is a **page**, not a redirect. It draws one voni.cc path and one
`utm_source` from the bags in `voni/src/lib/email/pool.ts`, and a one-off click
runs from voni's own server. The visitor never leaves `/email`; the report is
rendered in place. Contract: `docs/agents/email-pool.md`.

The old 307 to `www.glizzitrium.com` is gone. Anything that measured that hop
measures nothing now.

## `scripts/loadtest-email.js` is stale

`scripts/loadtest-email.js` (repo root, not `voni/scripts/`) still encodes the
redirect contract. Do not read a run of it as a pass or a failure of the current
page. Specifically:

| Part of the script | Why it is stale |
| --- | --- |
| `GET <TARGET_URL>` must return **307** | `/email` returns 200 HTML now. Every iteration fails the first check and `return`s. |
| `EXPECT_HOST=www.glizzitrium.com` and `utm_source` on the `Location` | There is no `Location`, no affiliate host, and the source now rides on a URL the Workers fetch, not on a redirect header. |
| Hop 2: fetch the `Location`, require a `uniqueClick_*` / `transaction_id` cookie | The tracker is no longer the destination, so there is no click cookie to find. |
| `FOLLOW_DEEPER`, the cookie-jar clearing | Same reason: no tracker chain, no growing cookie. |
| `email_edge_ok` / `email_click_ok` counters | They measure the redirect and the affiliate click. Both are meaningless here. |

The script was left in place rather than deleted because its loader.io
explanation is still the correct one (below). Treat its thresholds as history.

## loader.io cannot see a pool fan-out

loader.io follows a redirect **only when the target host is verified in your
loader.io account** — a `loaderio-<token>` file at the host root, or a
`loaderio=<token>` TXT record ([Test Results][results], [Verifying a Target
Host][verify]). That mattered when the destination was a third-party tracker.

It matters differently now: `/email` does not redirect at all, and its only
click is a one-off server action behind the control cookie. loader.io runs
neither, so a run only measures the static HTML shell — it can tell you the page
is served, never that the pool answered.

Decisive check: on a loader.io result for `/email`, `Redirects / Invalid > 0` can
only come from a stale run against the old contract, not from the page.

## What a valid check looks like

What is still worth measuring, and what is not.

**The page itself** — `GET /email` must be 200 HTML, no `Location`, `noindex`,
and it must not be cached as a redirect. A small k6 or `curl` loop is enough:

```bash
curl -sS -D - -o /dev/null https://voni.cc/email | head -20
# expect: HTTP/2 200, content-type: text/html, no location
```

**The pool fan-out is not a public route any more.** `POST /api/email-pool` was
retired: it had no caller left once the old panel was deleted, and an
unauthenticated request to it drew a target and fired it from every pool Worker,
so anyone could generate production affiliate clicks. The pool is exercised by
the Grafana check job `voni-affiliate-click-us` instead — run that, and do not
re-expose the route.

Volume: there is no public fan-out entry point left to load-test. Anything that
puts the pool under load has to come through the Grafana check (job
`voni-affiliate-click-us`) or the authenticated panel, and should still be
ramped gently.

## Caveats

- The `utm_source` is a query key only. The live path sends the drawn profile's
  user agent and client hints, and a Referer only when the drawn provider maps
  to one (`refererForProvider` in `user-agents.ts`) — otherwise no Referer
  header at all. The claimed source is still just the query string.
- Every request to a target comes from the Worker's egress, not the visitor's.
  That is the point of the pool; it is not "a human from gmail.com" and should
  not be reported as one.
- Latency per worker is bounded by the Worker's 8s abort. A pool member that
  answers slower shows up as `reason: "timeout"`, not as a slow page.

[results]: https://support.loader.io/article/19-test-results
[verify]: https://support.loader.io/article/20-verifying-an-app

# Load-testing `/email` and its edge-worker pool

`voni.cc/email` is a **page**, not a redirect. It draws one voni.cc path and one
`utm_source` from the bags in `voni/src/lib/email/pool.ts`, `POST`s
`/api/email-pool`, and that route asks every Worker in the pool to fetch the
target with a real outbound `fetch()`. The visitor never leaves `/email`; the
report is rendered in place. Contract: `docs/agents/email-pool.md`.

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

It matters differently now: `/email` does not redirect at all, and the fan-out
happens in a `POST` issued by client JS after hydration. loader.io does not run
that JS, so a run only measures the static HTML shell — it can tell you the page
is served, never that the pool answered.

Decisive check: on a loader.io result for `/email`, `Redirects / Invalid > 0` can
only come from a stale run against the old contract, not from the page.

## What a valid check looks like

Two things worth measuring, with different tools.

**The page itself** — `GET /email` must be 200 HTML, no `Location`, `noindex`,
and it must not be cached as a redirect. A small k6 or `curl` loop is enough:

```bash
curl -sS -D - -o /dev/null https://voni.cc/email | head -20
# expect: HTTP/2 200, content-type: text/html, no location
```

**The fan-out** — `POST /api/email-pool` is the real work, and it is reachable
without a browser:

```bash
curl -sS -X POST -H 'accept: application/json' https://voni.cc/api/email-pool | jq
# { ok: true, visitId,
#   target: "https://cipherlogs.github.io/print/?utm_source=<provider>&utm_medium=email&utm_campaign=voni-email",
#   source: "<provider>", workers: [ { worker, ok, status, ms, colo, ... } ] }
#
# with the env vars missing:
# HTTP 503 { ok: false, reason: "not_configured", message: "...POOL_SECRET..." }
```

A check that means something asserts, per response:

1. `ok` is `true`, and `target` is one of the two bag URLs
   (`https://cipherlogs.github.io/print/`, `https://voni.cc/test`) with the
   three params appended — never an affiliate host.
2. `source` is one of `EMAIL_PROVIDERS` and matches the target's
   `utm_source`.
3. `workers.length` equals the pool size (`POOL_WORKER_URLS` entries), and every
   entry is either `ok: true` with a numeric `status` / `ms`, or `ok: false`
   with a `reason` — a single dead Worker must not shrink the array.
4. A mixed result (`ok: true` with some failed workers) is a *successful* route
   response: the page is supposed to show partial reach, not fail.

Volume: one `POST` is `N` Worker invocations **plus `N` requests back to
voni.cc itself**. A load test of `/api/email-pool` therefore multiplies traffic
onto the same origin it is measuring, and the route is public with no rate limit
of its own. Keep runs small and ramp gently (`VUS=5`, short duration) until a
limit exists, and never run one against production during a demo or a billing
window.

## Caveats

- The `utm_source` is a query key only. A Worker sets its own `x-pool-worker`
  header, `referer: https://voni.cc/email`, and user agent — see the contract —
  but the claimed source is still just the query string.
- Every request to a target comes from the Worker's egress, not the visitor's.
  That is the point of the pool; it is not "a human from gmail.com" and should
  not be reported as one.
- Latency per worker is bounded by the route's 8s abort. A pool member that
  answers slower shows up as `reason: "timeout"`, not as a slow page.

[results]: https://support.loader.io/article/19-test-results
[verify]: https://support.loader.io/article/20-verifying-an-app

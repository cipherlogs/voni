# `/email` and the Cloudflare edge-worker pool

`voni.cc/email` is a **page**, not a redirect. It draws one target URL and one
source, asks every Worker in a pool to fetch that target with a real outbound
`fetch()`, follows any redirect chain to its end, and renders what each Worker
saw. The visitor never leaves `/email`.

This replaced the old 307-to-affiliate redirect (`emailRedirect()` in
`voni/src/proxy.ts`). Do not reintroduce a redirect here.

## Contract (the one thing both halves must agree on)

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

The fetch itself runs inside a Durable Object pinned by `region`, so `region` is
the placement hint we asked for and `colo` is the object's own colo when the
runtime reports one — `null` is normal, never a stand-in for the caller's colo.

`ok` is the verdict on the **final** status, so 2xx and 3xx are a pass. A chain
that ends on a 404 is `ok: false` with `reason: "http_error"`, and
`finalUrl`/`status` still describe where it ended.

Worker → target request:

```
GET <url>  (redirect: "follow")
  user-agent:       POOL_USER_AGENT (Chrome desktop default)
  referer:          https://voni.cc/email
  accept:           text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
  accept-language:  en-US,en;q=0.9
  x-pool-worker:    email-pool-01
```

The body is cancelled as soon as the final response arrives, never buffered: the
Worker reports status, timing, colo and final URL, not page content.

voni route:

```
POST /api/email-pool        (no body trusted from the browser)
200 { "ok": true, "visitId": "...", "target": "...", "source": "gmail.com",
      "workers": [ <worker 200 shape> | { "worker": "...", "ok": false,
                   "reason": "timeout" | "fetch_failed" | "unauthorized" } ] }
503 { "ok": false, "reason": "not_configured", "message": "..." }
```

## Target selection

One target and one source per visit, drawn without replacement from shuffle
bags in `voni/src/lib/email/pool.ts` (moved out of `proxy.ts`). Every entry is
an **absolute URL**; the bag is whatever `targets.json` holds, and it now mixes
voni-hosted pages with affiliate links that redirect off-site:

```
https://cipherlogs.github.io/print/
https://voni.cc/test
https://www.glizzitrium.com/BCMPW39K/J345SSD/?creative_id=691100
```

The bag is data, not an invariant: the tests assert its shape (absolute, https,
non-empty) rather than a snapshot of its entries, so adding a target is a
one-file edit. `/demo` and the other voni paths used to be here; they were
removed on request. `cipherlogs.github.io/print` keeps its trailing slash
because that is the URL a visitor opens — GitHub Pages 301s the slashless form,
and the Worker now follows that hop anyway.

Absolute targets keep whatever query they ship with; the pool only *adds* keys
(`URLSearchParams.set`), so an existing `?creative_id=` survives. Three params
are appended to every target:

| Param | Value |
| --- | --- |
| `utm_source` | the provider bag (`EMAIL_PROVIDERS`) |
| `utm_medium` | `email` |
| `utm_campaign` | `voni-email` |

The worker identity never rides in the URL: it travels as the `x-pool-worker`
request header, which is the contract's separator between pool and human
traffic.

A consequence worth knowing: because the bag has no local origin, running the
fan-out in local dev fetches the production URLs, not your dev server.

## Safety rules

- The endpoint is a fetch proxy gated by `POOL_SECRET`. Every `/click` without
  the matching secret is a `401`, which is what keeps the Worker from being a
  public fetcher.
- **There is no host allowlist.** By operator decision any absolute `http(s)`
  URL is accepted and redirect chains are followed to any host, so a Worker can
  observe where an affiliate link actually lands. The accepted cost: anyone
  holding `POOL_SECRET`, or anyone who can edit `targets.json`, can make a
  Worker fetch any public URL.
- What still bounds the blast radius: the browser never supplies the URL
  (`/api/email-pool` takes no request body and draws server-side); Cloudflare
  refuses private, loopback and link-local addresses at the platform level; the
  response body is cancelled without buffering, so no page is held in memory;
  the object gives up after 8 s and the caller at 10 s, so the object's verdict
  always wins over the caller's abort.
- Every pool request to a target carries `x-pool-worker`, so analytics can tell
  pool traffic from a human.

## Region: where the pool actually runs

`colo` in a report is the data center that **received the request**, not one the
deploy picked. Workers run in the colo nearest the requester, and voni calls
every pool instance from its own colo, so all N instances answer from the same
place — three deployments buy three URLs and three independent fetches, never
three regions. Checking `/health` on each instance is the fast way to see it.

What the platform does and does not let you choose
([placement][placement], [egress][egress], [fetch][fetch]):

| Want | Available |
| --- | --- |
| Pin a Worker to a named colo | **No.** Placement is proximity-based: Smart Placement (all plans, optimises toward a backend) or Placement Hints (`placement.region`/`host`, best effort, still "nearest colo"). |
| Guaranteed in-region processing | Regional Services / Data Localization Suite, **Enterprise**, configured per hostname. |
| Stable egress IP | Dedicated CDN Egress IPs (Smart Shield Advanced), **Enterprise**. Default egress is Cloudflare's shared pool. |
| Force IPv4 vs IPv6 | **No.** The destination's A/AAAA records decide, and a subrequest must be a URL, not an IP literal. |

### The `locationHint` probe

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
neighbouring region). The target also sees a Cloudflare datacenter IP either way,
which is the distortion that matters most for affiliate pages with bot
filtering.

### What the probe measured

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

### Which region each instance uses

`/click` runs its fetch inside an object created with the instance's hint, so
the region is deployment config, not code:

```
EMAIL_POOL_REGION_HINTS=enam,wnam,weur   # default; cycled across instances
```

Instance *i* gets `hints[i % hints.length]`. Changing the mapping is an env
change plus a redeploy; `deploy.mjs` logs what each instance received. An
invalid hint fails the deploy by name rather than silently falling back.

One throughput note: a Durable Object is single-threaded, and every instance
reuses one object per hint, so concurrent clicks to the same instance queue
behind each other. That is fine for a QA draw; it is not a load-testing
architecture.

[placement]: https://developers.cloudflare.com/workers/configuration/placement/
[egress]: https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/
[fetch]: https://developers.cloudflare.com/workers/runtime-apis/fetch/

## Layout

- `workers/email-pool/` — standalone Worker project (own `package.json`,
  `wrangler.jsonc`, tests). One source file deployed N times by
  `scripts/deploy.mjs`; `scripts/dev.mjs` runs N `wrangler dev` ports.
- `voni/src/app/email/page.tsx` + panel component — UI in the `/test` shape
  (logo header, badge, h1, description, card, alert on failure).
- `voni/src/app/api/email-pool/route.ts` — fans out to all workers in parallel
  with a timeout, shapes failures per worker.
- `voni/src/lib/email/pool.ts` — target/source bags, worker URL parsing, fan-out
  with injectable `fetch`.
- `voni/src/lib/email/targets.json` — **the editable target list.** Data, not
  code: add or remove URLs here. `pool.ts` imports it and throws on a
  non-absolute `https://` entry, so a bad edit fails the suite before a deploy.
  Nothing else derives from this file: the Worker validates URL shape only, so
  a new host needs no Worker redeploy — the `Deploy` workflow ships the bag
  because `targets.json` lives under `voni/`.
- `.github/workflows/deploy-pool.yml` — deploys all N pool Workers on a push
  that touches `workers/email-pool/**`. Secrets stay on the Workers; the
  workflow only carries the Cloudflare token.
- Env: `POOL_SECRET`, `POOL_WORKER_URLS` (comma-separated). Locally they belong
  in `voni/.dev.vars`, never `.env.local` (that file is baked into local builds).

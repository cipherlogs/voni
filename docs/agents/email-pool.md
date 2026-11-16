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

200 { "worker": "email-pool-01", "colo": "FRA", "ok": true,
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
  the 8 s timeout bounds the whole chain.
- Every pool request to a target carries `x-pool-worker`, so analytics can tell
  pool traffic from a human.

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

# `/email` and the Cloudflare edge-worker pool

`voni.cc/email` is a **page**, not a redirect. It picks one target path on
voni.cc and one source, asks every Worker in a pool to fetch that target with a
real outbound `fetch()`, and renders what each Worker saw. The visitor never
leaves `/email`.

This replaced the old 307-to-affiliate redirect (`emailRedirect()` in
`voni/src/proxy.ts`). Do not reintroduce a redirect here.

## Contract (the one thing both halves must agree on)

Worker endpoint, one per pool member:

```
POST {WORKER_URL}/click
  x-pool-secret: <POOL_SECRET>
  { "url": "https://voni.cc/test?utm_source=gmail.com", "visitId": "abc" }

200 { "worker": "email-pool-01", "colo": "FRA", "ok": true,
      "status": 200, "ms": 187, "target": "<url>", "location": null,
      "reason": null }
401 { "ok": false, "reason": "unauthorized" }
400 { "ok": false, "reason": "bad_target", "detail": "..." }
502 { "ok": false, "reason": "fetch_failed", "detail": "..." }

GET {WORKER_URL}/health
200 { "worker": "email-pool-01", "colo": "FRA",
      "allowlist": ["voni.cc", "www.voni.cc"] }
```

Worker → target request:

```
GET <url>  (redirect: "manual")
  user-agent:       POOL_USER_AGENT (Chrome desktop default)
  referer:          https://voni.cc/email
  accept:           text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
  accept-language:  en-US,en;q=0.9
  x-pool-worker:    email-pool-01
```

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
an **absolute URL** — there is no path/origin indirection:

```
https://cipherlogs.github.io/print/
https://voni.cc/test
```

`cipherlogs.github.io/print` without the trailing slash is not in the bag:
GitHub Pages 301s it to `/print/`, and the pool fetches with
`redirect: "manual"`, so a Worker would report the redirect instead of the
page. `/demo` and the other voni paths used to be here; they were removed on
request, so this bag is only the two URLs.

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
fan-out in local dev fetches the two production URLs, not your dev server.

## Safety rules

- The endpoint is a fetch proxy. It MUST require `POOL_SECRET` and MUST reject
  any target outside `ALLOWED_TARGET_HOSTS` (host **and** port), with
  `redirect: "manual"` so a redirect cannot leave the allowlist.
- `ALLOWED_TARGET_HOSTS` is `voni.cc,www.voni.cc,cipherlogs.github.io`. Dev adds
  `localhost:3000,127.0.0.1:3000`.
- Private/loopback IP literals are rejected unless `ALLOW_PRIVATE_TARGETS=true`
  (dev only).
- Every pool request to a target carries `x-pool-worker`, so analytics can tell
  pool traffic from a human.
- The browser never supplies the URL: `/api/email-pool` chooses it server-side,
  so this cannot be used as an open proxy.

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
  A URL on a host the pool already allows is a one-file change. A **new host**
  also needs adding to `ALLOWED_TARGET_HOSTS` in
  `workers/email-pool/wrangler.jsonc` — that is the fetch allowlist, and the
  pool answers `400 bad_target` for anything outside it.
- `.github/workflows/deploy-pool.yml` — deploys all N pool Workers on a push
  that touches `workers/email-pool/**`. Secrets stay on the Workers; the
  workflow only carries the Cloudflare token.
- Env: `POOL_SECRET`, `POOL_WORKER_URLS` (comma-separated). Locally they belong
  in `voni/.dev.vars`, never `.env.local` (that file is baked into local builds).

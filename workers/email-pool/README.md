# email-pool — Cloudflare Worker pool for voni `/email`

A standalone Cloudflare Worker, deployed N times, that fetches a voni.cc target
with a real outbound `fetch()` and reports what it saw. `voni.cc/email` fans
out to every instance; the browser never leaves the page.

The shared contract lives in
[`docs/agents/email-pool.md`](../../docs/agents/email-pool.md). This directory
is the worker half of it.

```
GET  /health   -> { worker, colo, redirects, targets }              (public)
POST /click    -> { worker, colo, ok, status, ms, target, finalUrl,
                    redirected, reason }
                  requires x-pool-secret: $POOL_SECRET
GET  /probe-region -> { worker, colo, hint, durableObject }          requires x-pool-secret
```

The pool follows redirect chains: `status` and `finalUrl` describe where the
click landed, not hop one.

## Layout

```
src/index.ts    fetch handler: routes, auth, JSON shapes
src/target.ts   pure validateTarget(url): absolute http(s) only, no host policy
src/click.ts    buildTargetHeaders + runClick (follows redirects, 8s timeout)
src/auth.ts     constant-time secret compare
src/region-probe.ts  RegionProbe Durable Object + pure probeRegion
scripts/        dev.mjs / deploy.mjs / probe-region.mjs / wrangler-bin.mjs
test/           node:test suites
wrangler.jsonc  base config; deploy and dev generate per-instance copies
```

## Local dev

Requires Node >= 22.18 (tests run TypeScript through Node's built-in type
stripping; no `tsx` needed).

```sh
cd workers/email-pool
npm install            # typescript, @cloudflare/workers-types, wrangler
npm run dev            # 3 wrangler dev instances on 8787, 8788, 8789
```

`EMAIL_POOL_SIZE` sets the count, `EMAIL_POOL_PORT` the base port. `wrangler` is
resolved from `node_modules/.bin` if present, otherwise from
`../../voni/node_modules/.bin/wrangler` (legacy fallback; CI installs the local
copy). The dev script prints each instance's
URL and the local secret (`dev-pool-secret` unless `EMAIL_POOL_SECRET` is set).

Dev and deploy both inject nothing but `POOL_INDEX` (and the dev secret): the
worker accepts any absolute http(s) URL, so a dev instance can be pointed at
`http://localhost:3000/...` just as easily as at `https://voni.cc/...`.

```sh
# health
curl -s http://localhost:8787/health

# click a production target (no local voni needed)
curl -s -X POST http://localhost:8788/click \
  -H 'content-type: application/json' \
  -H 'x-pool-secret: dev-pool-secret' \
  -d '{"url":"https://voni.cc/test?utm_source=gmail.com","visitId":"abc"}'

# click the GitHub Pages target
curl -s -X POST http://localhost:8788/click \
  -H 'content-type: application/json' \
  -H 'x-pool-secret: dev-pool-secret' \
  -d '{"url":"https://cipherlogs.github.io/print/","visitId":"abc"}'

# click the local voni dev server (run `npm run dev` in voni/ first)
curl -s -X POST http://localhost:8787/click \
  -H 'content-type: application/json' \
  -H 'x-pool-secret: dev-pool-secret' \
  -d '{"url":"http://localhost:3000/test","visitId":"abc"}'
```

### Tests

```sh
npm test          # node --test test/*.test.ts
npm run typecheck # tsc --noEmit over src/
```

## Deploy

Needs a Cloudflare account, a registered `workers.dev` subdomain (dashboard →
Workers & Pages), and either `wrangler login` or a `CLOUDFLARE_API_TOKEN`
(+ `CLOUDFLARE_ACCOUNT_ID`).

```sh
cd workers/email-pool
EMAIL_POOL_SIZE=3 npm run deploy     # deploy email-pool-01, -02, -03
EMAIL_POOL_SIZE=3 npm run deploy -- --dry-run   # bundle only, no upload
```

`scripts/deploy.mjs` copies `wrangler.jsonc` into
`.wrangler/deploy-config/email-pool-NN.json` (gitignored), overriding `name` and
`POOL_INDEX`, then runs `wrangler deploy --config <file>` per instance.

There is no target list to configure: any absolute http(s) URL is fair game, so
adding a target is a voni-only change.

Naming scheme: `email-pool-01`, `email-pool-02`, …, `email-pool-NN`, where the
worker id is derived from `POOL_INDEX` (`0` → `01`). Each instance answers at:

```
https://email-pool-01.<your-subdomain>.workers.dev
```

Set the shared secret on every instance (secrets are per-worker, not in vars):

```sh
# Run from workers/email-pool after `npm install` (local wrangler).
for n in 01 02 03; do
  printf '%s' "$POOL_SECRET" | \
    ./node_modules/.bin/wrangler secret put POOL_SECRET \
      --config ".wrangler/deploy-config/email-pool-$n.json"
done
```

Then point voni at the pool:

```
POOL_SECRET=<same secret>
POOL_WORKER_URLS=https://email-pool-01.<sub>.workers.dev,https://email-pool-02.<sub>.workers.dev,...
EMAIL_TARGET_ORIGIN=https://voni.cc
```

## Environment variables

| Name | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `POOL_SECRET` | secret | — | Required. Unset means every `/click` is `401`. |
| `POOL_USER_AGENT` | var | Chrome 131 desktop UA | Outbound `user-agent`. |
| `POOL_INDEX` | var | `0` | Instance index; determines `worker` / logs (`0` → `email-pool-01`). |
| `POOL_WORKER_ID` | var | unset | Optional explicit `worker` label override. |

`wrangler.jsonc` deliberately does **not** set `global_fetch_strictly_public`,
so dev can reach `localhost:3000`.

## Region probe — where the object runs, and where it egresses

`GET /probe-region` (secret-gated, same `x-pool-secret` as `/click`) asks the
`RegionProbe` Durable Object two questions and reports the answers:

1. `https://www.cloudflare.com/cdn-cgi/trace` — the `colo` that handled the
   request from inside the object. That is our best evidence of where the
   object itself ran (`durableObject.trace.colo`).
2. `https://ipinfo.io/json` — the egress IP and its city / region / country /
   org, i.e. what a normal site sees when this object fetches it
   (`durableObject.egress`).

```sh
curl -s "https://email-pool-01.<sub>.workers.dev/probe-region?hint=enam" \
  -H "x-pool-secret: $POOL_SECRET"
```

```json
{
  "worker": "email-pool-01",
  "colo": "FRA",
  "hint": "enam",
  "durableObject": {
    "ok": true,
    "trace": { "colo": "IAD", "ip": "203.0.113.7" },
    "egress": {
      "ip": "198.51.100.24",
      "city": "Ashburn",
      "region": "Virginia",
      "country": "US",
      "org": "AS14618 Amazon.com, Inc."
    },
    "ms": 412,
    "errors": {}
  }
}
```

`hint` is one of `wnam`, `enam`, `sam`, `apac`, `weur`, `eeur`, `oc`, `afr`, `me`
(default `enam`); anything else is `400 bad_hint`. Each hint gets its own object
id (`region-probe-<hint>`), because a location hint only applies when the object
is first created — a shared id would let an existing object answer for a
different hint.

**`locationHint` is a best-effort hint, not a guarantee.** Read the result, not
the request: `colo` at the top level is the worker instance that served the
call, `durableObject.trace.colo` is where the object ran, and
`durableObject.egress` is where its outbound traffic appeared from. If those
disagree, the hint did not do what you asked.

A single source failing degrades to `null` plus a named error code
(`durableObject.errors.trace` / `.egress`: `timeout`, `fetch_failed`,
`unreadable_body`, `parse_failed`, `http_<status>`) and still returns 200 with
the other observation. Both failing is `502` with
`durableObject.reason: "both_sources_failed"`. Without the binding (local dev
before the migration) the route is `503 probe_not_configured`.

### One-shot check across the pool

```sh
cd workers/email-pool
POOL_SECRET=... POOL_WORKER_URLS=https://email-pool-01.<sub>.workers.dev,... \
  npm run probe:region -- --hint enam
```

Odds and ends: the script probes every URL in `POOL_WORKER_URLS` (or each
`--url`), prints one block per worker with the invoking colo, the hint, the DO
trace colo, the egress place, `ms` and a verdict — `US` when the egress country
is US, `NOT US (<cc>)` otherwise, `UNKNOWN` when the probe degraded — and never
prints the secret. It exits 0 only when every worker returned at least one of
the two observations. `node scripts/probe-region.mjs --help` lists the flags.

## Safety rules (restated)

- Endpoint is a fetch proxy: it requires `POOL_SECRET`, and that secret is the
  only gate. Any absolute http(s) URL is accepted, including loopback and
  private addresses.
- `redirect: "follow"` — the chain is followed and the report describes the
  landing response (`status`, `finalUrl`, `redirected`). The landed body is
  cancelled, never buffered.
- `GET /probe-region` is gated by the same secret and fetches exactly two fixed
  URLs (`cdn-cgi/trace`, `ipinfo.io/json`); it accepts no caller-supplied
  target.
- Embedded credentials (`https://user:pass@…`) are rejected.
- Every target request carries `x-pool-worker`, so analytics can separate pool
  traffic from humans.
- The browser never supplies the URL; voni chooses it server-side.

## Notes

- `wrangler --var` splits values on commas, so per-instance config is generated
  as JSON and passed with `--config` instead.
- Beyond the contract's failure reasons, the worker reports `http_error` (an
  observed 4xx/5xx status, returned in the 200 shape) and `bad_request`
  (unparseable JSON body). `detail` appears only on failures.
- `/probe-region` adds its own wrapper failures: `bad_hint` (400),
  `probe_not_configured` (503, missing binding), `probe_unavailable` (502, the
  stub threw) and `probe_bad_response` (502, the stub's body was not JSON).

# email-pool — Cloudflare Worker pool for voni `/email`

A standalone Cloudflare Worker, deployed N times, that fetches a voni.cc target
with a real outbound `fetch()` and reports what it saw. `voni.cc/email` fans
out to every instance; the browser never leaves the page.

The shared contract lives in
[`docs/agents/email-pool.md`](../../docs/agents/email-pool.md). This directory
is the worker half of it.

```
GET  /health   -> { worker, colo, allowlist }                       (public)
POST /click    -> { worker, colo, ok, status, ms, target, location, reason }
                  requires x-pool-secret: $POOL_SECRET
```

## Layout

```
src/index.ts    fetch handler: routes, auth, JSON shapes
src/target.ts   pure validateTarget(url, { allowedHosts, allowPrivate })
src/click.ts    buildTargetHeaders + runClick (manual redirect, 8s timeout)
src/auth.ts     constant-time secret compare
scripts/        dev.mjs / deploy.mjs / wrangler-bin.mjs
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

Dev config allows `localhost:3000` and `127.0.0.1:3000` and sets
`ALLOW_PRIVATE_TARGETS=true`; production config does neither.

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
`.wrangler/deploy-config/email-pool-NN.json` (gitignored), overriding `name`
and `POOL_INDEX`, then runs `wrangler deploy --config <file>` per instance.

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
| `ALLOWED_TARGET_HOSTS` | var | `voni.cc,www.voni.cc,cipherlogs.github.io` | Exact `hostname[:port]` allowlist, comma-separated. |
| `POOL_USER_AGENT` | var | Chrome 131 desktop UA | Outbound `user-agent`. |
| `POOL_INDEX` | var | `0` | Instance index; determines `worker` / logs (`0` → `email-pool-01`). |
| `ALLOW_PRIVATE_TARGETS` | var | unset | Dev only. `true` allows loopback/private IP literals. |
| `POOL_WORKER_ID` | var | unset | Optional explicit `worker` label override. |

`wrangler.jsonc` deliberately does **not** set `global_fetch_strictly_public`,
so dev can reach `localhost:3000`.

## Safety rules (restated)

- Endpoint is a fetch proxy: it requires `POOL_SECRET` and rejects any target
  whose `host:port` is outside `ALLOWED_TARGET_HOSTS`.
- `redirect: "manual"` — a 3xx can never carry the fetch off the allowlist; the
  `location` is reported back, not followed.
- Private/loopback IP literals (and `localhost`) are rejected unless
  `ALLOW_PRIVATE_TARGETS=true`.
- `https` is required except for loopback dev hosts on the allowlist.
- Embedded credentials (`https://user:pass@…`) are rejected.
- Every target request carries `x-pool-worker`, so analytics can separate pool
  traffic from humans.
- The browser never supplies the URL; voni chooses it server-side, so this is
  not an open proxy.

## Notes

- `wrangler --var` splits values on commas, so per-instance config is generated
  as JSON and passed with `--config` instead.
- Beyond the contract's failure reasons, the worker reports `http_error` (an
  observed 4xx/5xx status, returned in the 200 shape) and `bad_request`
  (unparseable JSON body). `detail` appears only on failures.

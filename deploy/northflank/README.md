# Cascade on Northflank Sandbox

The committed descriptor is [`service.json`](service.json); this file is the
setup path a human follows to create the resources it names, and
[`docs/deploy/README.md`](../../docs/deploy/README.md) is the deployment record.
The interactive companion is [`scripts/wizard-northflank.sh`](../../scripts/wizard-northflank.sh),
which prompts for the store DSN and the public URL, flips routing to `demo`, and
sets the app-side Worker secrets.

## Why this host

- Free Sandbox: always-on, **no sleeping**, no card, 2 services + 1 database.
- The cascade holds three vendor WebSockets per call; Northflank's public
  `HTTP` (HTTP/1.1) ports carry WebSockets (its own networking docs say so).
  The port must **not** be `HTTP/2`: `server.py` is uvicorn on h11, so an
  HTTP/2 ingress port answers every request with a 502 protocol error.
- `voice-pipeline/Dockerfile` already builds the service and `EXPOSE 8766`, so
  the image needs no changes.
- `server.py` fails `/readyz` closed without `DATABASE_URL`, so the deployment
  needs Postgres. Sandbox includes one database.

## What you create

| resource | name | shape |
|---|---|---|
| Project | `voni` | one region in the US (`us-east-1`) |
| Combined service | `voice-pipeline` | build from GitHub `cipherlogs/voni`, `main` |
| Postgres addon | `voni-store` | smallest plan, same region |
| Volume | `voice-events` | 1 GB, single read/write, `/var/lib/voni` |

A **combined service** builds and deploys in one resource, so the Sandbox's
two-service limit covers the cascade and leaves one spare. The Postgres addon
and the volume are addons, not services.

## Service settings

**Build**

- Source: GitHub `cipherlogs/voni`
- Build type: Dockerfile
- Dockerfile path: `/voice-pipeline/Dockerfile`
- Build context: `/` (the Dockerfile copies from the repo root)
- Branch: `main`
- Build engine: BuildKit, disk cache on

**Deploy**

- Plan: `nf-compute-50` (0.5 vCPU / 1 GB) — the size that fits the free `$20`
- Instances: `1`
- Public port: `8766`, protocol `HTTP` (HTTP/1.1), public
- Health check: liveness, HTTP `GET /healthz`, port `8766`
  - initial delay `20`, period `15`, timeout `3`, failure threshold `3`
- Grace period: `30` seconds (equals `deploy.drain_max_wait_ms`)

The health check is **liveness only**. `/readyz` is deliberately not the
platform probe: a draining instance must stay reachable to finish live calls.

**Volume**

- Mount `/var/lib/voni` (the image already creates it for uid 10001).
- Single read/write means one instance. That is the shape, not a temporary
  compromise: the token registry and the delivered-body channel are in-process,
  so a second instance would break single use and hold return. A deploy refuses
  new calls for up to the 30-second drain bound; a live call finishes.

## Environment

Non-secret, set on the service (the same names the descriptor carries):

```
VOICE_PIPELINE_PORT=8766
VOICE_PIPELINE_EVENTS_DIR=/var/lib/voni/events
VOICE_PIPELINE_TOOL_BASE_URL=https://app.voni.cc
META_REASONING_EFFORT=minimal
```

Secrets, in a secret group linked to the service:

```
META_API_KEY
META_IDENTIFIER_SALT
ASSEMBLYAI_API_KEY
AI_GATEWAY_API_KEY
VONI_TOOL_SECRET
VOICE_PIPELINE_ENVELOPE_SECRET
DATABASE_URL            # the addon's connection string
```

`META_REASONING_EFFORT` is a required **setting**, not a secret
(`deploy/topology.py`, `deploy/voice-pipeline.env.example`): it is the measured
M03 value (`minimal`), has no default, and the default rung refuses to construct
without it. `VONI_TOOL_SECRET` must equal the app's existing Worker value; the
Worker secret cannot be read back, so use the copy from the secret manager or
rotate it on both sides deliberately.

There is **exactly one envelope secret**, `VOICE_PIPELINE_ENVELOPE_SECRET`:
the app signs the call body and call token with it and the service verifies
with it, one value on both sides. The app's own secret set lives on its own
deploy and is never shared with this service.

## After the first deploy

1. Open `https://<port>--voice-pipeline--<id>.code.run/healthz`; expect
   `{"status":"ok","service":"voice-pipeline","protocolVersion":1}`.
2. Open `/readyz`; it must report the store readable. If it does not, the
   `DATABASE_URL` secret is wrong or the addon is not linked.
3. **Flip the routing switch to `demo`.** A never-written switch reads as `off`
   (fail-safe), so a fresh store refuses every demo call with zero vendor
   sessions. Read it, then set it with the audited operator CLI
   (`docs/deploy/cutover-runbook.md`):

   ```sh
   cd voice-pipeline
   python scripts/routing_switch.py show --json --database-url "$DATABASE_URL"
   python scripts/routing_switch.py set --mode demo \
     --operator "you@voni" \
     --reason "demo cutover: routing=demo is production (ADR-0012)" \
     --database-url "$DATABASE_URL"
   ```

4. Set the app's two cascade secrets on the Worker (they are server-side
   runtime values, not build-time public variables). A redeploy is not needed:
   `wrangler secret put` publishes a new Worker version.

   ```sh
   cd voni
   npx wrangler secret put VOICE_PIPELINE_URL --name voni            # https://<that host>
   npx wrangler secret put VOICE_PIPELINE_ENVELOPE_SECRET --name voni # the same value as the service
   ```

   `VOICE_PIPELINE_URL` is the `https` base; the app derives
   `wss://<that host>/v1/browser-call` itself. Without both secrets the demo
   mint returns the visitor's unavailable state.
5. Make one real call and confirm the artifact lands under
   `/var/lib/voni/events` on the volume. Then run `parity:check` and a
   non-skipped `check:real-legs` from `voni/` (cutover runbook).

## What is not free

- 0.5 vCPU / 1 GB is `$12` of the `$20` monthly resource allowance.
- Egress is `$0.06/GB` and a 3-minute call is ~10–12 MB outbound, so a few
  thousand calls stay inside the allowance.
- A 1 vCPU / 2 GB service is `$24`, which exceeds the free allowance.

## Fallback

Oracle Cloud Always Free (2 OCPU / 12 GB ARM, ~10 TB egress, a VM with admin)
is the named fallback. The trade is more work, less convenience.

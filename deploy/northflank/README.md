# Cascade on Northflank Sandbox (2026-10-30)

The host record is [`docs/deploy/meta-cascade-host.md`](../../docs/deploy/meta-cascade-host.md);
this file is the setup path. The Fly configs in `deploy/` are historical.

## Why this host

- Free Sandbox: always-on, **no sleeping**, no card, 2 services + 1 database.
- The cascade holds three vendor WebSockets per call; Northflank's public
  `HTTP/2` ports carry WebSockets (its own networking docs say so).
- `voice-pipeline/Dockerfile` already builds the service and `EXPOSE 8766`, so
  the image needs no changes.
- `server.py` fails `/readyz` closed without `DATABASE_URL`, so the deployment
  needs Postgres. Sandbox includes one database.

## What you create

| resource | name | shape |
|---|---|---|
| Project | `voni` | one region in the US (`iad`-equivalent) |
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
- Public port: `8766`, protocol `HTTP/2`, public
- Health check: liveness, HTTP `GET /healthz`, port `8766`
  - initial delay `20`, period `15`, timeout `3`, failure threshold `3`
- Grace period: `30` seconds (equals `deploy.drain_max_wait_ms`)

The health check is **liveness only**. `/readyz` is deliberately not the
platform probe: a draining instance must stay reachable to finish live calls.

**Volume**

- Mount `/var/lib/voni` (the image already creates it for uid 10001).
- Single read/write means one instance. That is the MVP shape; two instances
  and rolling deploys are deferred (ticket 140).

## Environment

Non-secret, set on the service:

```
VOICE_PIPELINE_PORT=8766
VOICE_PIPELINE_STT_PROVIDER=assemblyai
VOICE_PIPELINE_STT_MODE=balanced
VOICE_PIPELINE_LLM_MODEL=muse-spark-1.3
VOICE_PIPELINE_TTS_MODEL=assemblyai-tts-1
VOICE_PIPELINE_EVENTS_DIR=/var/lib/voni/events
VOICE_PIPELINE_TOOL_BASE_URL=https://<your Workers app host>
```

Secrets, in a secret group linked to the service:

```
META_API_KEY
META_IDENTIFIER_SALT
META_REASONING_EFFORT
ASSEMBLYAI_API_KEY
AI_GATEWAY_API_KEY
VONI_TOOL_SECRET
VOICE_PIPELINE_ENVELOPE_SECRET
DATABASE_URL            # the addon's connection string
```

`META_REASONING_EFFORT` must be set to the measured value from M03; it has no
default and the default rung refuses to construct without it.

## After the first deploy

1. Open `https://<port>--voice-pipeline--<id>.code.run/healthz`; expect
   `{"status":"ok","service":"voice-pipeline","protocolVersion":1}`.
2. Open `/readyz`; it must report the store readable. If it does not, the
   `DATABASE_URL` secret is wrong or the addon is not linked.
3. Set the app's pipeline URL to `wss://<that host>/v1/browser-call`
   (`NEXT_PUBLIC_VOICE_PIPELINE_URL` locally and in the Workers environment).
4. Make one real call and confirm the artifact lands under
   `/var/lib/voni/events` on the volume.

## What is not free

- 0.5 vCPU / 1 GB is `$12` of the `$20` monthly resource allowance.
- Egress is `$0.06/GB` and a 3-minute call is ~10–12 MB outbound, so a few
  thousand calls stay inside the allowance.
- A 1 vCPU / 2 GB service is `$24`, which exceeds the free allowance.

## Fallback

Oracle Cloud Always Free (2 OCPU / 12 GB ARM, ~10 TB egress, a VM with admin)
is the named fallback. The trade is more work, less convenience.

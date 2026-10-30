# Container host decision (ticket 04)

> **Superseded 2026-10-30 (owner): Northflank Sandbox.** The cascade service
> deploys as one combined service from `voice-pipeline/Dockerfile` on
> Northflank's free Sandbox: always-on, no card, WebSockets on its HTTP/2
> public port, one Postgres addon for the durable store. The Fly.io decision
> below is kept as history, not as the current host. Setup steps live in
> [`deploy/northflank/README.md`](../../deploy/northflank/README.md).
> Oracle Always Free is the named fallback if the Sandbox changes.

**Decision (2026-10-30, owner):** deploy the cascade service and the app on
**Fly.io**, two instances per service, rolling deploys. Physically one region
to start (`iad`), with the browser and the service in the same region.

## Why Fly.io

- Long-lived WebSocket connections to Meta ASR, Meta Chat Completions and
  AssemblyAI TTS survive normal request lifetimes; the platform does not force
  a short request cap.
- Rolling deploys with health checks: a new machine becomes healthy before an
  old one is drained, which is what the deploy-drain rule needs.
- A normal container, so the Python service keeps its own process, socket
  handling and `SqliteStore`/future Postgres adapter without a runtime rewrite.
- Secrets are injectable per app (`fly secrets`), and two machines share the
  same app-level configuration.

## Explicitly excluded: Cloudflare Workers

Cloudflare Workers is the current `voni` deploy target and is **not** the
cascade host:

- Workers are request/response oriented; a long-lived vendor WebSocket per
  call is not a supported execution model.
- CPU-time and connection limits make a 60-minute STT session and a
  3,600-second TTS session unsafe.
- There is no persistent process for a probe scheduler, a drain supervisor or a
  shared breaker store; a Durable Object would be a second runtime, not the
  same service.

Vercel remains only the AI Gateway URL for the managed path; it is not the
cascade host.

## Topology

- `voni` app: two Fly machines, rolling.
- `voice-pipeline` service: two Fly machines, rolling, WebSocket-aware.
- Shared durable state (breaker, routing switch, daily counter) is a Fly
  Postgres attachment or a Fly volume with the documented single-host
  `SqliteStore`; ticket 135 picks the concrete adapter and ticket 139 proves
  readiness against it.
- A deploy drains connections for at most 30 s
  (`deploy.drain_max_wait_ms`), then the old machine is removed; a live call is
  never killed by the drain.

This record satisfies ticket 04's host AC; ticket 135 implements the config
from it.

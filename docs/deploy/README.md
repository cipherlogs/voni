# Cascade deployment record (M17)

The record for the container host and the two-instance topology. The host
decision itself is in [`meta-cascade-host.md`](meta-cascade-host.md) (ticket
04); this file records what the committed config implements and how to check
it. Ticket 135 owns the config; tickets 136–141 own the token, the protocol
version, the health endpoints, the drain supervisor and the version report.

## Host: Fly.io, and not Cloudflare Workers

The cascade service runs on **Fly.io** as one container per machine. Fly holds a
long-lived WebSocket for the length of a call, a rolling deploy brings a new
machine up before an old one goes away, and a normal container keeps the Python
process, the socket loop and the durable-store adapter unchanged.

**Cloudflare Workers is excluded** for the cascade service, and the reason is
recorded rather than implied: Workers is request/response oriented and cannot
hold a three-minute vendor WebSocket per call, its CPU and connection limits
make a 60-minute STT session and a 3,600-second TTS session unsafe, and it has
no persistent process for a drain supervisor. The `voni` app's existing
Workers deploy is a different question; this record does not move it.

Vercel is the AI Gateway URL for the managed path, never a cascade host.

## Topology

Two machines per app, physically one region (`iad`) to start.

| | Fly app | Image | Config |
|---|---|---|---|
| Cascade voice service | `voni-voice-pipeline` | `voice-pipeline/Dockerfile` (built here) | `deploy/fly.voice-pipeline.toml` |
| App | `voni-app` | built and pushed by the app's own pipeline | `deploy/fly.voni.toml` |

- The app and the service deploy separately, with separate configs, images,
  ports and secret sets. A protocol version mismatch is a deploy error; the
  health endpoints make it visible before a call.
- **Two machines minimum.** `min_machines_running = 2` on both apps: a rolling
  deploy must never remove the last machine while a call is live on it. Any
  machine may accept a new call; a live call stays on its machine until it ends.
- **No sticky sessions.** One call per socket means there is nothing to pin: the
  proxy may place a new socket on either machine.
- **WebSocket-aware.** Concurrency is counted in `connections`, not requests;
  `auto_stop_machines = false` so a machine is never stopped under a live call;
  the image runs one uvicorn worker (a second worker in the same container would
  split a call's socket and its state).
- **Rolling, with health checks.** `[deploy] strategy = "rolling"`; the platform
  probe is `GET /healthz` (liveness, no vendor touched). Readiness (`/readyz`,
  ticket 139) is deliberately not the platform probe: a draining machine must
  stay reachable while it finishes live calls.
- **Liveness vs readiness.** `/healthz` answers only "the process is up" and
  touches no store, vendor or key, so a store outage never restarts a machine
  serving live calls. `/readyz` answers "this instance may take a new call" and
  reports `protocolVersion`, the drain state, and one check each for the
  durable store, the daily counter and the breaker record. Any unreadable
  dependency returns 503 and names the reason; a missing breaker record is a
  fresh deploy, not an outage. Readiness never opens a vendor socket. A
  draining instance returns 503 on `/readyz` and refuses new calls (the socket
  gets `{"type":"error","code":"draining"}`), while calls already running finish.
- **Drain seam.** `kill_signal = "SIGTERM"`, `kill_timeout = 30`, which equals
  the recorded `deploy.drain_max_wait_ms` (30 000 ms) in
  `voice-pipeline/cascade/thresholds.json`. On SIGTERM the drain supervisor
  (`voice-pipeline/cascade/drain.py`, ticket 140) flips the `DrainState` the
  routes read — `/readyz` 503, new sockets refused with
  `{"type":"error","code":"draining"}`, the call-body route 503 — then waits
  for the calls this process accepted, bounded by that recorded value, and only
  then asks uvicorn to exit. It never cancels a call task: reaching the bound is
  logged as an operational-policy event (`deploy.drain_max_wait_ms reached; N
  live call(s) still running`) and the process exits; the platform's
  `kill_timeout` is the same bound. A call held open across a rolling deploy
  completes because the old machine keeps serving it while the proxy sends new
  calls to the healthy machine.
- **Shared state.** Only the durable breaker, routing switch and daily counter
  are shared, and they are read through the store protocol in
  `voice-pipeline/cascade/store.py`. The concrete deployment choice is a **Fly
  Postgres** attachment injecting `DATABASE_URL` into both machines; the
  single-host `SqliteStore` stays a local/test adapter. The asyncpg adapter is
  `voice-pipeline/cascade/pg_store.py` (ticket 139) and implements the same
  `DurableStore` protocol; readiness proves it is readable on every probe
  without touching a vendor.
- **One container for the Python service.** `voice-pipeline/Dockerfile` copies
  `voice-pipeline/` and the one bridge module it imports
  (`telephony-bot/voice_judge.py`), installs `voice-pipeline/requirements.txt`,
  and copies nothing of the app except the frozen
  `voni/src/lib/demo/scoreboard-budgets.json`. That one record is required:
  `cascade.thresholds` resolves it at import and refuses to start without it, so
  the image sets `VONI_SCOREBOARD_BUDGETS_JSON=/srv/scoreboard-budgets.json`.
  The budgets stay single-source; the app tree does not enter the image. The
  image builds from the repository root (the context is set in
  `.dockerignore`), runs as a non-root user and holds one uvicorn worker.

## Protocol version

The app and the service speak exactly one protocol version: `PROTOCOL_VERSION`
in `voice-pipeline/cascade/token.py` and `CASCADE_PROTOCOL_VERSION` in
`voni/src/lib/voice/cascade-session.ts`. `voice-pipeline/cascade/test_protocol_version.py`
reads the app's export and fails when the two drift, so a half-deployed pair
cannot silently run two versions.

The browser's one config frame carries `protocolVersion`. A missing or unknown
version is refused before the body is claimed or any vendor socket opens, with
an error frame carrying `code: "protocol_version"` and a message naming both
versions. The client surfaces that named error and tears the socket down, so a
mismatch fails loudly instead of leaving the UI hanging. The end message also
reports `protocolVersion`, and the client checks it on a call that did open.

## Secrets

Names only, set on the app with `fly secrets set`; `deploy/voice-pipeline.env.example`
is the list and carries no values. The service reads `META_API_KEY`,
`META_IDENTIFIER_SALT`, `ASSEMBLYAI_API_KEY`, `AI_GATEWAY_API_KEY`,
`VONI_TOOL_SECRET`, `VOICE_PIPELINE_ENVELOPE_SECRET` and `DATABASE_URL`. The app
has its own set on its own app; the two are never shared. The repository secret
scan is ticket 141.

Log redaction is ticket 137. `voice-pipeline/cascade/log_redaction.py` is the
one gate: it is installed by `create_app` and scrubs every record through a log
record factory (so handlers configured later, such as uvicorn's, are covered)
plus a filter on the root and uvicorn loggers. The browser's call token (socket
query string or config frame), the vendor keys, the tool secret, the signing
secret and `DATABASE_URL` are replaced before any handler writes; the vendor
handshake body is replaced whole, because the Meta key travels inside it.
`cascade/test_log_redaction.py` opens the real Meta backend over a scripted
socket, sends the handshake and scans every emitted record.

## Checking the topology

```sh
python deploy/topology.py            # exits non-zero and names every violation
cd voice-pipeline && python -m unittest test_deploy_topology -v
```

The validator is the same file a reviewer reads: it fails by name when the
instance count drops to one, when the `/healthz` probe is removed, when the
deploy stops being rolling, when the drain timeout is shorter than the recorded
bound, when a secret value appears in a committed file, and when the app and the
service stop being separate deploys.

## Rehearsal

`deploy/docker-compose.yml` reproduces the shape locally: two service replicas,
a `/healthz` health check, `SIGTERM` with a 30 s grace period, and the app as a
separate container. Rehearse a rolling deploy there before trusting one:

```sh
docker compose -f deploy/docker-compose.yml up --build --scale voice-pipeline=2
```

A call held open across `docker compose up --scale voice-pipeline=2 --no-deps`
(or a `fly deploy --strategy rolling`) is the ticket 135 acceptance evidence; the
drain supervisor that makes the wait a policy is ticket 140.

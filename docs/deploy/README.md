# Cascade deployment record (ticket 19)

The record for the container host and the one-instance topology. The host
decision itself is in [`meta-cascade-host.md`](meta-cascade-host.md); the setup
path is [`deploy/northflank/README.md`](../../deploy/northflank/README.md); the
committed descriptor is
[`deploy/northflank/service.json`](../../deploy/northflank/service.json). This
file records what the descriptor implements and how to check it. Ticket 135
owned the original config; ticket 19 moved the committed shape to one Northflank
instance.

## Host: Northflank, not Cloudflare Workers

The cascade service runs on **Northflank** as **one combined service** with
**one instance**. Northflank's public HTTP/2 port carries the long-lived
WebSocket for the length of a call, a normal container keeps the Python
process, the socket loop and the durable-store adapter unchanged, and one
Postgres addon supplies the shared store.

**Cloudflare Workers is excluded** for the cascade service, and the reason is
recorded rather than implied: Workers is request/response oriented and cannot
hold a three-minute vendor WebSocket per call, its CPU and connection limits
make a 60-minute STT session and a 3,600-second TTS session unsafe, and it has
no persistent process for a drain supervisor. The `voni` app's existing
Workers deploy is a different question; this record does not move it.

Vercel is the AI Gateway URL for the managed path, never a cascade host.

## Topology

| | Resource | Image | Descriptor |
|---|---|---|---|
| Cascade voice service | Northflank combined service `voice-pipeline` | `voice-pipeline/Dockerfile` (built here) | `deploy/northflank/service.json` |
| App | `voni-app`, deployed by its own pipeline | built and pushed by the app's own pipeline | not part of this descriptor |

- **One service, one instance.** `service.deploy.instances = 1`. The
  `CallTokenRegistry` and the delivered-body channel are in-process
  (`voice-pipeline/cascade/token.py`), so a second instance would break single
  use and hold return. One instance is a correctness property, not only a
  hosting choice.
- **No sticky sessions.** One call per socket means there is nothing to pin.
  The public HTTP/2 port forwards to `ports[0].internalPort = 8766`.
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
- **Liveness vs readiness.** The platform probe is HTTP liveness
  `GET /healthz` on `8766` (`healthCheck.type = "liveness"`). Readiness
  (`/readyz`, ticket 139) is deliberately **not** the platform probe: a
  draining instance must stay reachable while it finishes live calls.
  `/healthz` touches no store, vendor or key, so a store outage never restarts
  an instance serving live calls. `/readyz` answers "this instance may take a
  new call": it reports `protocolVersion`, the drain state, and one check each
  for the durable store, the daily counter and the breaker record. A draining
  instance returns 503 on `/readyz` and refuses new calls with
  `{"type":"error","code":"draining"}`, while calls already running finish.
- **One Postgres addon.** `database.type = "postgres"`, name `voni-store`,
  injecting `DATABASE_URL`. Only the durable breaker, routing switch and daily
  counter are shared, and they are read through the store protocol in
  `voice-pipeline/cascade/store.py`. The asyncpg adapter is
  `voice-pipeline/cascade/pg_store.py`; readiness proves it is readable on
  every probe without touching a vendor. The single-host `SqliteStore` stays a
  local/test adapter.
- **One single-read/write volume.** `volumes` names exactly one entry,
  `voice-events`, `accessMode = "ReadWriteOnce"`, `1` GB, mounted at
  `/var/lib/voni`. Every call writes one operational-event JSONL artifact under
  `VOICE_PIPELINE_EVENTS_DIR = /var/lib/voni/events`; the image creates that
  directory for uid 10001. The artifact is best-effort: if the write fails, the
  call still runs and the end message carries `eventsError` with the reason
  instead of claiming an `eventsPath`.
- **Drain seam.** `terminationGracePeriodSeconds = 30` equals the recorded
  `deploy.drain_max_wait_ms` (30 000 ms) in
  `voice-pipeline/cascade/thresholds.json`. On SIGTERM the drain supervisor
  (`voice-pipeline/cascade/drain.py`, ticket 140) flips the `DrainState` the
  routes read — `/readyz` 503, new sockets refused with
  `{"type":"error","code":"draining"}`, the call-body route 503 — then waits
  for the calls this process accepted, bounded by that recorded value, and only
  then exits. It never cancels a call task: reaching the bound is logged as an
  operational-policy event (`deploy.drain_max_wait_ms reached; N live call(s)
  still running`) and the process exits. One instance means a deploy refuses
  new demo calls for up to the drain bound; deploy outside demo hours.

## Deploy window

One instance means there is no second instance to serve new calls while the
old one drains. A deploy therefore refuses new calls for up to the 30-second
bound and the visitor sees the unavailable state; a live call finishes. That
window is the accepted cost of the one-instance shape, not a fault.

## Shared state: the routing switch

The routing switch is shared state too (ticket 24). Read it before flipping, and
flip it with the operator CLI: this is the **runtime rollback**, not a deploy.

```sh
cd voice-pipeline
# 1. Read first: mode, recordVersion, decidedAt and every past change.
../telephony-bot/.venv/bin/python scripts/routing_switch.py show \
  --database-url "$DATABASE_URL"
# 2. Then flip future calls. Empty operator/reason, no-ops and lost
#    compare-and-set writes are refused by name; the DSN is never printed.
../telephony-bot/.venv/bin/python scripts/routing_switch.py set --mode off \
  --operator ops@voni --reason "rollback rehearsal" \
  --database-url "$DATABASE_URL"
```

A missing switch reads as `off` (fail-safe), not an error; an unreadable or
corrupt switch is a named failure. A flip governs new calls only: a live call
keeps the decision it was admitted with and finishes. The audit trail records
who, when, from, to and why. The store is exactly one of
`--sqlite`/`CASCADE_STORE_PATH` or `--database-url`/`DATABASE_URL`; there is no
hidden default.

## Protocol version

The app and the service speak exactly one protocol version: `PROTOCOL_VERSION`
in `voice-pipeline/cascade/token.py` and `CASCADE_PROTOCOL_VERSION` in
`voni/src/lib/voice/cascade-session.ts`.
`voice-pipeline/cascade/test_protocol_version.py` reads the app's export and
fails when the two drift, so a half-deployed pair cannot silently run two
versions.

The browser's one config frame carries `protocolVersion`. A missing or unknown
version is refused before the body is claimed or any vendor socket opens, with
an error frame carrying `code: "protocol_version"` and a message naming both
versions. The client surfaces that named error and tears the socket down, so a
mismatch fails loudly instead of leaving the UI hanging. The end message also
reports `protocolVersion`, and the client checks it on a call that did open.

## Versions

The service reports its **build** and its **protocol** version, not only the
protocol one. `GET /healthz` returns `service`, `buildVersion`, `buildSource`
and `protocolVersion`; the end message on every call carries `buildVersion` and
`protocolVersion`. The build comes from the host environment,
`VOICE_PIPELINE_BUILD_VERSION`. When it is unset the report says `unversioned`
(`source: "none"`): an honest absence, never a guessed value. The protocol
number is `cascade.token.PROTOCOL_VERSION`, re-exported by `cascade.version`.

`deploy/versions.json` is the artifact: it names the app and the service, the
version each is deployed at (the app's is pinned to `voni/package.json`; the
service's is the host-supplied build), and the protocol each half speaks.
`python deploy/topology.py` reads it together with both code copies of the
protocol number and refuses a mismatch, so a half-deployed pair is a named
deploy error before a cutover claim, not a surprise mid-call.

## Secrets

Names only, set in the Northflank secret group linked to the `voice-pipeline`
service; `deploy/voice-pipeline.env.example` is the list and carries no values.
The service reads `META_API_KEY`, `META_IDENTIFIER_SALT`, `ASSEMBLYAI_API_KEY`,
`AI_GATEWAY_API_KEY`, `VONI_TOOL_SECRET`,
`VOICE_PIPELINE_ENVELOPE_SECRET` and `DATABASE_URL`. There is **exactly one
envelope secret**, `VOICE_PIPELINE_ENVELOPE_SECRET`: the app signs with it and
the service verifies with it, one value on both sides, never committed. The app
has its own secret set on its own deploy; the two are never shared.

The deployment also carries two **required non-secret host settings**, recorded
in `deploy/voice-pipeline.env.example` and this record: `META_REASONING_EFFORT`
is the measured effort (M03). Spark has no default, so a default-rung call fails
setup while it is unset; the host supplies the measured value, never this
repository. `VOICE_PIPELINE_TOOL_BASE_URL` is the app's public origin
(`https://app.voni.cc`) the tool route calls; when it is empty no
`ToolExecutor` is constructed and every tool call is dropped. Neither required
setting is written into the descriptor `env` or Compose's `environment` with an
empty value: Compose gives that block precedence over `env_file`, and a blank
entry is the blank runtime value, so an empty entry would prevent the real value
from being used. `python deploy/topology.py` fails by name when a required
setting is present but empty, when the example or this record does not name it,
and when the tool base URL is not the app's public origin.

The repository scan is ticket 141's second guard: `python deploy/topology.py`
runs it (and `python deploy/secret_scan.py` runs it alone). It reports a
key-shaped value, a URL carrying real userinfo, or a long secret assignment in
any **committed** file as `path:line: kind` — never the value. Test modules and
fixtures are exempt because a refusal test needs a string that looks like a key;
production code, config, docs and scripts are not. `deploy/versions.json` and a
health or end report carry versions only.

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
python deploy/secret_scan.py         # the credential scan alone
cd voice-pipeline && python -m unittest test_deploy_topology test_deploy_versions -v
```

The validator is the same file a reviewer reads. It fails by name when the
descriptor names a second service, when the instance count is not exactly one,
when the Postgres addon or the single-read/write volume is missing or doubled,
when the liveness probe is not `GET /healthz` on 8766, when the grace period is
not the recorded drain bound, when a deleted host descriptor reappears, when the
example names a second envelope secret or carries a value, when a secret value
appears in a committed file, and when the version artifact and the code disagree
on the protocol.

## Rehearsal

`deploy/docker-compose.yml` reproduces the shape locally: **one** service
replica, the one volume mounted at `/var/lib/voni`, a `/healthz` health check,
`SIGTERM` with a 30 s grace period, and the app as a separate container:

```sh
docker compose -f deploy/docker-compose.yml up --build
```

The drain supervisor that makes the wait a policy is ticket 140. A two-replica
rehearsal is not this topology: the token registry is in-process, so the
rehearsal runs one replica and a deploy is the only drain window.

# Demo cutover runbook (ticket 25)

The one page an operator reads before, during and after the demo cascade
cutover. The decision is recorded in
[ADR-0012](../adr/0012-demo-cascade-only.md); the host shape is
[`README.md`](README.md) and `/deploy/northflank/README.md`.

## The two values

| Value | Meaning |
|---|---|
| **`routing=demo`** | **Production.** Every new `demo:<voice>` call is eligible for the cascade. Tenant calls stay managed. |
| **`routing=off`** | **The one rollback.** Every new demo call is refused, zero vendor sessions open, and the visitor sees the unavailable state. No deploy, no rebuild, no engine change. |

`routing=all` is unused by this product (ADR-0012). A never-written switch is
`off` (fail-safe), and an unreadable switch is a named failure — never "off".

The switch is read exactly once per call and frozen, so **a flip never moves a
live call**. That is pinned by
`voice-pipeline/cascade/test_routing.py::RoutingSwitchDecisionTest::test_a_live_call_is_never_moved_by_a_later_change`
(a call admitted with `demo` keeps `cascade` after the switch is flipped to
`off`; the next new call is `managed`).

## The deploy window

The cascade runs **one instance** (ADR-0012 and the Northflank descriptor): the
call-token registry and the delivered-body channel are in-process, so a second
instance would break single use and hold return.

- A deploy sends `SIGTERM`; the drain supervisor flips readiness, refuses new
  calls with `{"type":"error","code":"draining"}`, and lets live calls finish
  for up to the recorded drain bound — **30 seconds**
  (`deploy.drain_max_wait_ms = 30000`, `terminationGracePeriodSeconds = 30`).
- There is no second instance to take the traffic: **new demo calls are refused
  during the deploy window**, and the visitor sees the unavailable state. A
  live call finishes and is not cut.
- **Deploy outside demo hours.** The refused window is the accepted cost of one
  instance; the only cheap mitigation is to deploy when no visitor is likely to
  start a call.

The refused-connect visitor state is proven by the ticket-16 rig:
`voni/tests/e2e/cascade-delivery.spec.ts`, "a refused cascade connect shows the
demo unavailable state and opens no managed session" — `code:"managed"` shows
`data-testid="demo-unavailable"` with `DEMO_UNAVAILABLE_MESSAGES.managed`, the
state is `ended`, and zero managed sessions open.

## Before a demo / after a deploy

Run both, from `voni/` with the app's environment loaded:

```sh
npm run parity:check -- --sqlite "$CASCADE_STORE_PATH"      # local store
npm run parity:check -- --database-url "$DATABASE_URL"      # Northflank store
npm run check:real-legs                                     # needs META_API_KEY + ASSEMBLYAI_API_KEY
```

- **`parity:check`** proves the app's pipeline host, the pipeline's app origin,
  a signed v2 throwaway body accepted by the service, and prints the routing
  mode. It reads the switch, never flips it.
- **`check:real-legs`** starts a two-turn call through the app's own
  `buildDemoCascadeBody` / `deliverCallBody`, then asserts the trace binds to
  the call id and `demo:<voice>` and the `cost.priced` row is measured or names
  its reason. It skips by name without the vendor keys, and it must not skip
  for a cutover claim to stand.
- **Before the run**, confirm `AI_GATEWAY_API_KEY` is set for the app: the
  signed demo body carries the gateway model override. In the call's end
  frame, `providers.llm.provider` must be the gateway model, not `spark`
  (Spark's first token measured 0.7-3.5 s and it ignores `end_call`).
- **Live hang-up check:** say "please hang up", then assert the call ends with
  `endedBy: "stop"`, one agent goodbye (not two), and `counts.end_call: 1`.
  A call that says goodbye but stays open is the Spark/`end_call` regression.
- The cutover is **not done** until `check:real-legs` passes against the
  deployed service and ADR-0012 is in place (ticket 25 acceptance).

## The cutover proof command

`voni/scripts/cutover-check.mts`, exposed as `npm run cutover:check`:

```sh
cd voni

# Read the switch and its append-only audit trail (fails if unreadable).
npm run cutover:check -- --show --database-url "$DATABASE_URL"

# The kill-switch proof: off → deliver a real signed v2 demo body → open the
# real WebSocket → assert code "managed", no greeting/turn/leg rows, then
# restore the mode it found and print the audit.
npm run cutover:check -- --prove-off \
  --base-url "$VOICE_PIPELINE_SERVICE_URL" \
  --events-dir "$VOICE_PIPELINE_EVENTS_DIR" \
  --operator ops@voni --reason "kill-switch rehearsal" \
  --database-url "$DATABASE_URL"

# Flip future calls; who/when/from/to is verified by a re-read afterwards.
npm run cutover:check -- --set demo \
  --operator ops@voni --reason "demo cutover" \
  --database-url "$DATABASE_URL"
```

`--set` refuses a no-op and a missing operator or reason by name. Every check
prints its source (the CLI, the socket URL, the trace path, the cited rig).

## The production flip — the operator's human step

This workspace has **no Northflank credentials**. The production switch is the
operator's human step, run once against the Northflank Postgres; **the
production flip has not been executed here**, and no command below was run
against production by this checkout.

```sh
# 1. Read first. The audit trail names every past change.
cd voice-pipeline
python scripts/routing_switch.py show --json --database-url "$DATABASE_URL"

# 2. Set the demo's production value. Non-empty operator and reason are required.
python scripts/routing_switch.py set --mode demo \
  --operator "you@voni" \
  --reason "demo cutover: routing=demo is production (ADR-0012)" \
  --database-url "$DATABASE_URL"

# 3. Prove the entry landed, then run the post-deploy checks from voni/.
python scripts/routing_switch.py show --json --database-url "$DATABASE_URL"
cd ../voni
npm run parity:check -- --database-url "$DATABASE_URL"
npm run check:real-legs
```

Then start one real demo call and read its trace by call id.

## The rollback — one action

Flip `off`; do not deploy and do not change the app:

```sh
cd voice-pipeline
python scripts/routing_switch.py set --mode off \
  --operator "you@voni" \
  --reason "demo rollback: <why>" \
  --database-url "$DATABASE_URL"
```

New calls are refused with `code:"managed"`, zero vendor sessions open, and the
visitor sees the unavailable state. Live calls finish where they are. Restore
with the same command and `--mode demo` when the cause is cleared.

## The local rehearsal (what was run in this workspace)

Against the local plain pipeline and the dedicated local Postgres, not
production:

```sh
cd voni
npm run cutover:check -- --show --database-url "$DATABASE_URL"
npm run cutover:check -- --prove-off --keep-off \
  --base-url http://127.0.0.1:8767 \
  --events-dir /path/to/voice-pipeline/.events \
  --operator rehearsal --reason "demo cutover rehearsal" \
  --database-url "$DATABASE_URL"
npm run cutover:check -- --set demo \
  --operator rehearsal --reason "demo cutover rehearsal" \
  --database-url "$DATABASE_URL"
```

`--keep-off` leaves the switch off so the operator's own `--set demo` is the
audited restore. Without it, `--prove-off` restores the mode it found itself.

## Checklist

- [ ] `parity:check` green pre-demo and post-deploy.
- [ ] `check:real-legs` green (not skipped) post-deploy.
- [ ] Deploy outside demo hours; the drain bound is 30 s and new calls are refused meanwhile.
- [ ] Operator sets `routing=demo` on the Northflank Postgres and verifies the audit entry.
- [ ] Rollback is `routing=off`, one command, no deploy.
- [ ] ADR-0012 cited; ticket 25 stays open until every box above is observed.

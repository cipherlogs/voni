# 140: Drain on deploy, never kill a live call

**What to build:** On termination, the instance fails readiness, stops accepting new calls, lets live calls finish and exits. The wait is an operational policy with a stated source, not a reason to terminate a call.

**Blocked by:** 135 (Container host and two-instance topology), 139 (Liveness and readiness are different questions), 03 (Threshold registry with a source requirement), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] On termination, readiness fails, new calls are refused and live calls finish before exit.
- [ ] A live call is never terminated by the drain.
- [ ] The maximum wait is the recorded value and is reported when it is reached.
- [ ] A call held open across a rolling deploy completes.
- [ ] A draining instance receives no new call; the app routes elsewhere or managed.

## Answer

# 140 — Drain on deploy, never kill a live call

- SIGTERM → `cascade.drain.DrainSupervisor.start()` flips the `DrainState` the routes already read: `/readyz` 503, `/v1/call-body` 503, a new socket gets `{"type":"error","code":"draining"}`; the call is counted live only after acceptance.
- `LiveCalls` brackets each accepted socket; `DrainSupervisor.wait()` awaits idle bounded by `deploy.drain_max_wait_ms` (read from `cascade.thresholds`, 30 000 ms), reports the bound when reached (`cascade.drain` WARNING naming the bound + remaining count) and leaves the call running — it never cancels a task. `drain_then_exit` requests the exit only after that wait.
- `server.main` installs the SIGTERM/SIGINT handler and disables uvicorn's default one (which would exit at once), with `timeout_graceful_shutdown=0`; the process exits at the recorded bound, the platform's `kill_timeout` (30 s) is the same operational policy.
- Tests (`cascade/test_drain.py`, 12): signal flip, counting, finish path, exit-only-after-finish, bound reached reported at 30 000 ms with the call still live, supervisor-driven refusal on both routes + socket, a live call finishing across the drain at the server seam. Mutation-proved red-first: deleting the drain read → refusal test fails; deleting the live bracket → count test fails; skipping `wait_idle()` → exit test fails.
- Evidence: `voice-pipeline/cascade/drain.py`, `voice-pipeline/cascade/test_drain.py`, `server.py` (`create_app(live_calls=)`, `main`), `docs/deploy/README.md` "Drain seam". Suite 1892 → 1903.

_Implemented on `feat/meta-cascade`._

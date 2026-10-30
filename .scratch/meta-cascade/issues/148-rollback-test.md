# 148: The way back is a routing flip, proved in CI

**What to build:** A test flips routing off and asserts that new calls route managed while live calls finish. The rollback is a runtime switch, not a deploy, so it works when a deploy is the thing that failed.

**Blocked by:** 24 (Routing switch: off, demo, all), 142 (Provider fixtures run in CI)

**Status:** resolved

- [ ] Flipping routing off makes new calls route managed.
- [ ] Live calls finish untouched.
- [ ] The test asserts zero new cascade sockets after the flip.
- [ ] The flip is a runtime switch, not a deploy.
- [ ] The test runs in CI.

## Answer

# 148 — The way back is a routing flip, proved in CI

**Status: done.** Branch `cluster/antilie-145-148` @ `0d54abd7`, based on
integration tip `06f9f097`.

- **Built:** `voice-pipeline/cascade/test_rollback.py` (3 tests). One call is
  admitted and starts streaming while routing is `demo`; the test then flips
  the durable switch to `off` through the **same `RoutingSwitch` object and
  store** (one CAS write, audit entry `demo → off`, actor/reason/clock) while
  that call is mid-stream. After the flip, demo and tenant new calls all route
  managed and `len(factory.connections)` stays at 1 — zero new sockets, across
  a 10-call loop too. The live call is then released and finishes its scripted
  stream (`["hello","goodbye"]`), closes its socket, and still carries its
  frozen `cascade` decision. No process/env/deploy step is involved.
- **CI:** `.github/workflows/ci.yml` adds a named `Anti-lie and rollback` step
  in the `python` job running `cascade.test_admission cascade.test_rollback`,
  and a named `Anti-lie reply gap` step in `verify` for ticket 145. The existing
  `required-python` gate covers the python step.
- **TDD red first:** delete the routing read in `admit_new_call` (fabricate an
  `all` decision instead of `switch.decide`) → **Ran 3, FAILED (failures=3)**:
  post-flip calls connect and the connection count moves. Log:
  `/tmp/opencode/meta-cascade/148-red-routing-read-deleted.log`. Restored.
- **Green:** `python -m unittest cascade.test_admission cascade.test_rollback`
  → **Ran 8, OK**. Full pipeline discovery → **1463 tests, OK (skipped=1)**
  (1455 baseline + 5 admission + 3 rollback); TS full `npm test` →
  **2145 tests, 2144 pass, 0 fail, 1 skipped**; `npm run typecheck` clean.
- **Merger notes:** the test models the live call with the ticket-01 scripted
  socket, not a live vendor. `admission.py` is the integration point; if a
  later service loop opens its own socket without calling `admit_new_call`,
  that path is out of this test's reach and needs its own seam test.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

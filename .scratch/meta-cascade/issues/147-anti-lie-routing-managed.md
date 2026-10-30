# 147: Anti-lie: managed routing opens zero cascade sockets

**What to build:** With routing set to managed, a new call opens no cascade socket. The test counts connections, not log lines, and is red when the routing check is removed.

**Blocked by:** 24 (Routing switch: off, demo, all), 142 (Provider fixtures run in CI)

**Status:** resolved

- [ ] Routing to managed opens zero cascade sockets.
- [ ] The test counts connections, not log lines.
- [ ] The test is red when the routing check is removed.
- [ ] The red case is attached.

## Answer

# 147 — Anti-lie: managed routing opens zero cascade sockets

**Status: done.** Branch `cluster/antilie-145-148` @ `8aada448`, based on
integration tip `06f9f097`.

- **Built:** new `voice-pipeline/cascade/admission.py` — the one seam between a
  frozen `RoutingDecision` and an open socket. `admit_new_call()` reads the
  switch exactly once and returns **before** the injected opener when the
  decision routes managed, so `routing=off` is a connection count of zero, not
  a field a caller may ignore. `Admission` refuses to be constructed when the
  decision and the opened socket disagree. New `cascade/test_admission.py`
  (5 tests) passes a real `ScriptedSocketFactory` as the opener and asserts on
  `factory.connections` (the sockets that actually opened), never a log line.
  Off (including a never-written switch) → zero connections for demo and tenant
  subjects; demo mode → exactly one connection at the cascade URL, same object
  in the admission; the opener is not called at all when off.
- **TDD red first:** delete the routing check in `admit_new_call` (open
  unconditionally) → **Ran 5, FAILED (failures=1, errors=3)**; the opener is
  reached while routing is off and the factory records sockets. Log:
  `/tmp/opencode/meta-cascade/147-red-routing-check-deleted.log`. Restored.
- **Green:** `python -m unittest cascade.test_admission` → **Ran 5, OK**. Full
  pipeline discovery → **1463 tests, OK (skipped=1)**.
- **Merger notes:** additive production module; no existing module edited. It
  imports `RoutingSwitch`/`RoutingDecision` and the ticket-01 socket kit; no new
  dependency. `test_admission.py` is auto-discovered and also named in the new
  CI step (148 commit).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

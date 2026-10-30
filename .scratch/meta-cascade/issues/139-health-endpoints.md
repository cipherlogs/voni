# 139: Liveness and readiness are different questions

**What to build:** Liveness touches no vendor. Readiness reports the drain state and whether the breaker and counter stores are reachable, so a draining or store-blind instance receives no new call while live calls continue.

**Blocked by:** 135 (Container host and two-instance topology), 15 (Breaker record and durable shared store), 102 (Durable, atomic, shared daily counter)

**Status:** resolved

- [ ] Liveness touches no vendor.
- [ ] Readiness reports drain state and breaker and counter store reachability.
- [ ] A store outage fails readiness and new calls are refused; live calls continue.
- [ ] Readiness does not call a vendor on every probe.
- [ ] A fake store asserts both ready and not-ready states.

## Answer

# 139 — liveness vs readiness

**Status: done.** Branch `cluster/deploy-136-139`, commit `f71499e6`, base `33e85a57`.

- **`/healthz`:** unchanged liveness — process up, protocol version, no store/vendor/key read. A store with failing `ping`/`read` still returns 200 (tested).
- **`/readyz`:** `cascade/health.py` probes each dependency once and reports `{ready, protocolVersion, draining, drainReason, checks{drain,store,counter,breaker}}`, 200 only when all are `ok`, 503 otherwise. Store outage, unreadable/corrupt counter, corrupt breaker → closed with a named reason (redacted); a missing breaker record is a fresh deploy, not an outage. Readiness never opens a vendor (tripwire test).
- **Drain:** `DrainState`; a draining instance fails readiness and refuses new calls — `POST /v1/call-body` 503 and the socket gets `code: "draining"` — while a call already running finishes (tested mid-call).
- **Store:** `cascade/pg_store.py` implements `DurableStore` over `DATABASE_URL` (asyncpg lazy, CAS, `repr`/errors never echo the DSN); `create_app` builds store/counter/breaker or records a configuration error that fails readiness closed. No vendor key needed for either route.
- **Proof:** `cascade.test_health` 19 (fakes for ready/not-ready, real FastAPI routes). `deploy/topology.py` exits 0. Full Python suite 1876 OK (1 skipped).
- **Merger notes:** `/readyz` is not a Fly check by design (a draining machine must keep serving); ticket 140 owns flipping `DrainState` on SIGTERM.

_Implemented on `feat/meta-cascade`._

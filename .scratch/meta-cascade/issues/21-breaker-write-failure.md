# 21: A failed breaker write never kills a live call

**What to build:** A failed write alerts and leaves the live call on the rung it already selected. The next call re-reads and fails closed to the last durable state.

**Blocked by:** 15 (Breaker record and durable shared store)

**Status:** resolved

- [ ] A failed write alerts and the live call continues on its chosen rung.
- [ ] The call is not moved, cancelled or restarted by the write failure.
- [ ] The next call re-reads and uses the last durable state.
- [ ] A test simulates a store outage and asserts the call completes.

## Answer

21 done — `cascade/ladders.py` gains `read_choices()` (one durable read per leg, no cache), `LegUnreadable`, `ProviderAlert`, `LegOutcome` and `CallRungs`; `cascade/test_breaker_write_failure.py` is new (8 tests).
Live call: `CallRungs` holds the rungs the call selected at start and never re-selects. `failed()`/`succeeded()` write the breaker for future calls; when that write does not land they raise nothing, append a `breaker_write_failed` `ProviderAlert` (leg, rung, error, injected-clock time, `to_document()`) and optionally hand it to an `on_alert` sink. A test drives a whole call through a store outage mid-turn, then a success write that also fails: two alerts, the call finishes on the rung it started on, the backend is constructed once (no move, cancel or restart), and the frozen `RungChoice` object is unchanged.
Next call: `read_choices` re-reads the durable record each time, so after a lost write it starts on the last durable state (test asserts primary while the lost write said open, then fallback after a write that lands). A store read outage raises `LegUnreadable(leg, reason)` — the new call refuses rather than inventing a `closed`/primary leg — and a failed write on a `half_open` leg leaves the durable record `half_open` (no synthetic `closed`).
Judgments: alerting is in-process (`alerts` + sink); shipping it to the operational event stream is ticket 110's, and readiness (`/readyz`) stays ticket 139's. `read_choices` treats missing/corrupt records exactly like an outage: unknown is not healthy.
Evidence: `test_breaker_write_failure` 8 tests; red-first (no `CallRungs`), then mutations: alert branch disabled → 2 fail, outage silently replaced by a closed record → 2, rung re-selected after the write → 2. Full suite 511 OK. Branch `cluster/breaker-18-23`, base 83ea36ed, merge → "Already up to date".
Merger notes: tickets 22/23 open providers through this same `read_choices`; the transport/connect path (ticket 65) should raise `LegUnreadable` into a managed routing decision, never into a cascade socket.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

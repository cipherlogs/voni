# 146: Anti-lie: deleting the fallback emission fails eligibility

**What to build:** The eligibility test depends on the fallback event, so removing the emission breaks it. That is the proof the event is load-bearing rather than decorative.

**Blocked by:** 109 (Every fallback is emitted, including at connect), 116 (Only a clean run can be green), 142 (Provider fixtures run in CI)

**Status:** resolved

- [ ] Deleting the fallback emission makes the eligibility test fail.
- [ ] A fallback at connect is covered.
- [ ] The red case is attached as a run, not described as an intention.
- [ ] No second place emits the event.

## Answer

# 146 — Anti-lie: the fallback emission is load-bearing

**Status: done.** Branch `cluster/antilie-143-146` @ `3adadafc`, based on
integration tip `43f0d427` (`git merge feat/meta-cascade` → "Already up to date").

- **Built:** `voice-pipeline/cascade/fallback_audit.py` — the only connect caller
  of ticket 109's one emitter. `emit_connect_fallbacks(writer, choices, ladders,
  …)` turns a call's frozen `RungChoice`s into connect events: every leg reading
  `fallback` emits one `provider_fallback` (`phase="connect"`, `turn=None`,
  `from` = ladder primary, `to` = chosen fallback, trigger `manual_pin` when
  pinned, `probe_failed` for a stale half-open record, else `breaker_open`).
  Primary/`none` legs emit nothing. `assert_fallbacks_emitted(choices, events,
  phase="connect")` refuses a run whose frozen fallback rung has no event in
  that phase, naming the leg and phase (`MissingFallbackEvent`). A mid-turn
  event does not stand in for the connect emission.
- **Refusal is not a fallback:** a primary-only call emits nothing and needs no
  event; a routing refusal's document/`eligibility_refusal` events are accepted
  and never contamination; `connect_fallback(trigger="routing_refusal")` is
  already refused by name ("not a provider fault").
- **One emitter:** `fallback_audit.py` composes `emit_fallback` and contains no
  `call_scoped(` and no quoted `"provider_fallback"`; `events.py` still has
  exactly one definition and one emission site (`FALLBACK_EVENT_TYPE` count 2).
- **TDD red first (two independent deletions):** delete `sink(event)` in
  `events.emit_fallback` → **Ran 11, failures=3, errors=1** (connect/pinned
  streams empty; the audit refuses); delete the `MissingFallbackEvent` raise →
  **Ran 11, failures=3** (a fallback rung with no event read clean). Logs:
  `/tmp/opencode/meta-cascade/146-red-emission-deleted.log`,
  `146-red-audit-refusal-deleted.log`. Restored; no Actions run URL (branch not
  pushed).
- **CI:** named `Anti-lie fallback emission` step in the `python` job
  (`cascade.test_anti_lie_fallback_emission`), covered by `required-python`.
- **Green:** new module **11/11**; full Python discovery **1595 tests, OK
  (skipped=1)** (1584 baseline + 11).
- **Merger notes:** additive production module; no existing module edited. The
  call/artifact path must call `emit_connect_fallbacks` at connect and
  `assert_fallbacks_emitted` before writing the run's evidence — those call
  sites are not in this ticket, so a future path that emits from elsewhere or
  skips the audit would bypass this proof by name.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

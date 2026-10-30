# 17: Breaker transitions on a fake clock

**What to build:** The state machine: closed opens on a trigger, open moves to half-open only when a probe is due, and a stale record reads as half-open even when it says closed.

**Blocked by:** 15 (Breaker record and durable shared store), 16 (Failure classification: trigger, bug or planned reconnect)

**Status:** resolved

- [ ] closed to open on a trigger; open to half-open only when at least 30 s have passed since the last probe.
- [ ] A record whose last probe is older than 60 s reads as half-open even when its stored state says closed.
- [ ] half-open goes to open on any failure, and to closed only through the hysteresis rules.
- [ ] Every transition emits its trigger, reason and phase.
- [ ] Transitions are driven by the injected clock; no test sleeps.

## Answer

17 done — `cascade/breaker.py` gains `BreakerTransitions` (+`BreakerTransition`, `TransitionOutcome`, `ManualOverrideRefused`, `PIN_TARGETS`, and one additive `Breaker.now()`), `cascade/test_breaker_transitions.py` is new; no record-shape and no store-API change (`Breaker.write` still does the CAS).
Machine: `read_state()` reports a stale closed leg and a probe-due open leg as `half_open` without writing; `settle()` writes open→half_open; `record_probe_success()` closes only on three stored successes each ≥ one injected `probe_interval_s` apart and never closes on two or on a too-soon run; `record_probe_failure()` reopens; `record_failure()` opens a closed leg only on a `failures.classify` trigger (a bug-class 400/1008 fails visibly and writes nothing) but reopens *any* failure from half_open; `record_real_call_success()` records lastSuccessAt; a probe outcome before the interval moves an open leg not at all.
Pin: `pin(leg, target="fallback", actor=, why=)` writes `manualOverride` and travels who/when/why on the event for ticket 19's audit store; probes, staleness and failures never clear it; `clear_pin(actor=, why=)` is the only writer back to `none`; a `target="primary"` request is refused by name; every write goes through `_apply`, which retries a lost CAS once, then returns `written=False` with `error` (write/read outage never raises and leaves the live call on its rung); `BreakerRecordMissing` still propagates (seeding bug).
Judgments: the first probe of a never-probed open leg counts from `openedAt` (no probe storm on trip); a staleness-driven half_open sets `openedAt=now` only when it was null; `trigger`/`reason` describe the last durable write; probe successes are not real-call successes.
Tests: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 278, OK (28 new, FakeClock only, no sleeps); red proven by module-missing import, then five mutations each killed a test (`probe_due` false, spacing ignored, no staleness, pin cleared on open, write raises). Branch `ticket/17-breaker-transitions`, base df21bedb, `git merge feat/meta-cascade` → "Already up to date". Merger notes: ticket 18 should own the probe scheduler/canary call site and ticket 19 the pin audit store + rung selection, both calling this one engine — do not add a second state machine; ticket 21 can wire the `TransitionOutcome.error` alert.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

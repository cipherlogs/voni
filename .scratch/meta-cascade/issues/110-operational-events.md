# 110: Breaker, budget, greeting and reconnect are events

**What to build:** Operational decisions stop being console lines. Breaker transitions, budget crossings and stops, greeting marks, reconnects, protocol errors and failed turns are first-class events with their required fields and no transcript.

**Blocked by:** 107 (One event envelope and reader refusal), 17 (Breaker transitions on a fake clock), 103 (At 80% of the daily cap, route new calls managed), 104 (At 100% refuse cascade, never the call), 105 (The per-call ceiling drains, never truncates), 77 (The greeting is spoken before any user audio), 94 (One reconnect per leg, and planned reconnects are separate)

**Status:** resolved

- [ ] Breaker transitions, budget crossings and stops, greeting marks, reconnects, protocol errors and failed turns are first-class events.
- [ ] Each carries its required fields: leg and rungs; line, day, spend and cap; call, spend and ceiling; leg, reason and planned or failure.
- [ ] None carries transcript text.
- [ ] A breaker transition is an operational event, not a turn event.
- [ ] Each event's shape is asserted; a console line is not the only trace.

## Answer

110 done — operational decisions are first-class events through the one envelope.
New `cascade.events.OperationalEvents(stream, subject=, now=)` builds every line with the one `EventWriter` and writes it through the one `EventStream`, so the shared sanitizer always runs and a forbidden key writes nothing. Types/shapes: `budget.crossing` (line, day, spend, cap; subject, turn null, phase end), `budget.stopped` (callId, spendUsd, ceilingUsd, measured, reason, optional unmeasuredReason; phase drain), `deploy.drain` (reason, planned=true), `reconnect` (leg, reason, planned, action, code, failureClass), `greeting.start/first_audio/done` (voiceId, frames, sampleRate, cancelled, cause; turn null, phase connect), `breaker.transition` (operational: leg in place of subject/turn; from, to, trigger, reason, manualPin, triggerCode/Turn), `protocol.error`, `turn.failed`. Budget and breaker events are refused on a managed writer, matching the TS `CASCADE_ONLY_EVENT_TYPES`.
Wired in `CallLifecycle`: a ceiling breach emits exactly one `budget.stopped`; the greeting emits start at the opening, first_audio at the chime, done at finish; ticket 94's recorded reconnects are flushed as `reconnect` events; `deploy_draining(reason)` emits one `deploy.drain` for ticket 140. Breaker/protocol/turn.failed call sites belong to their owners (17/27/42/turn layer) — the one tested emitter is here.
Tests: full suite `Ran 1923, OK (skipped=1)`; 24 new in `cascade/test_operational_events.py` (shapes, both 80/100 crossings, one-charge two-lines, sanitizer redaction, managed refusal, live call emissions). Red first (ImportError on the new names). Mutations: deleting each call-site emission (`budget.stopped`, greeting start/first_audio/done flush, reconnect flush, deploy.drain) turns the suite red.
Branch `cluster/money-104-110`, commit `52701113`, base `2c0b7b76`; `git merge feat/meta-cascade` → already up to date.
Merger notes: no TS edit needed — the new types are call-scoped with subject + turn (null) and `reconnect`'s `leg` is an allowed payload name since 109; `breaker.transition` stays the one operational shape. `CallLifecycle` gained additive `operational_events=`; a sink failure is logged and never ends a call. `on_budget_stopped` remains the generic alert hook, `operational_events` owns the event.

_Implemented on `feat/meta-cascade`._

# 109: Every fallback is emitted, including at connect

**What to build:** A fallback is a first-class event with the leg, the rungs, the trigger, the turn and the phase. A connect-time fallback is still a fallback and still contaminates the run.

**Blocked by:** 107 (One event envelope and reader refusal), 22 (Speech ladder: Meta, AssemblyAI, then fail), 23 (Model ladder: Spark, gateway, then fail)

**Status:** resolved

- [ ] Every fallback emits an event with leg, from, to, trigger, turn or null, and phase.
- [ ] A connect-time fallback is emitted and names the connect phase.
- [ ] A routing refusal does not emit a fallback event.
- [ ] Deleting the emission makes the eligibility test fail.
- [ ] A mid-turn fallback and a connect fallback produce two events with the right phase.

## Answer

109: Every fallback is one `provider_fallback` line — `emit_fallback(writer, fallback, subject=, at_ms=, sink=)` in `voice-pipeline/cascade/events.py`, built by the one `EventWriter` (never a second builder) and written to the call's sink.
Payload is `leg, from, to, trigger` (+ optional `reason`); `turn` and `phase` stay envelope fields: `connect_fallback(...)` is `phase="connect", turn=None`, `turn_fallback(...)` names the turn. Both phases produce distinct events.
Triggers are a closed provider-fault set (`connect_failed, breaker_open, manual_pin, mid_turn_failure, probe_failed`); routing/eligibility/budget triggers are refused by name — a refusal is a routing decision, not a fallback. A managed writer refuses `provider_fallback`.
Load-bearing: `test_a_run_with_a_fallback_event_is_not_clean` reads clean/contaminated off the emitted stream, so deleting `sink(event)` fails it; `test_a_connect_and_a_mid_turn_fallback_are_two_events_with_the_right_phase` pins both phases.
Evidence: `cascade.test_events` 26 → Python suite `939 tests OK`; `node --import tsx --test src/lib/demo/event-envelope.test.ts` 15 pass; full `npm test` 2089 pass, 1 skipped; typecheck clean.
Merger notes: fixture gained `cascadeFallback`; `event-envelope.ts` now reserves envelope names per shape, so a call-scoped event may carry a payload `leg` (107's blanket "call event cannot carry a leg" rule blocked the spec's `leg`); `event-envelope.test.ts` updated accordingly. Branch `cluster/events-109-111`, base `8ff36c2a`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

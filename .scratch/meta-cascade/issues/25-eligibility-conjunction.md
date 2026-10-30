# 25: Eligibility is a conjunction with recorded reasons

**What to build:** A pure evaluator decides whether a new call may cascade: routing permits it, the body adapter accepts the body, the voice has a binding, the Locale is fixed, and the daily counter is below its line. Every refusal records its own reason and routes managed.

**Blocked by:** 24 (Routing switch: off, demo, all)

**Status:** resolved

- [ ] Eligibility is one conjunction over injected predicates: routing, adapter acceptance, binding, fixed Locale and counter.
- [ ] Each failing predicate records its own reason; the call routes managed rather than failing.
- [ ] A routing refusal is never emitted as a provider fallback event.
- [ ] Removing any one predicate makes every call eligible, so each predicate is proved to be read.
- [ ] The evaluator is pure over its inputs and is tested with no live call.

## Answer

25 eligibility conjunction: done, green — 520 tests (+14 in `cascade/test_eligibility.py`) on Python 3.14 venv; branch `cluster/body-58-25`, base `83ea36ed`, commit `e0312b7f`.
One conjunction: `evaluate_eligibility(body, subject=, routing=, counter=, keyterm_limit=, rules=DEFAULT_RULES)` runs routing → binding → locale → accepted (adapter + keyterm cap) → counter; `CounterReading(spent_usd, line_usd)` is injected (ticket 103 computes the line; the cap stays open) and the call cascades only while strictly below it.
Every refusal records its own `Refusal(predicate, reason)`; a body failing routing + locale + counter yields exactly those three reasons, and routing's own refusal is carried on `decision.routing` (already `managed`).
Not a fallback: `decision.events()` only ever emits `eligibility_refusal`; the routing-refusal test asserts `provider_fallback` appears nowhere in the decision. The evaluator is sync, reads no clock/socket/store, and two identical calls return equal decisions; a refused call does not affect the next eligible one.
Removal proof: with injected rules, dropping any one of the five makes the call eligible (AC's own framing); each default rule also has an isolating refusal test (routing off/demo, unbound voice, no fixed Locale, smuggled key, counter at line) so every default predicate is proved read. `evaluate_body` remains the body-only half; no wiring into transport/orchestrator (M06/M17).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

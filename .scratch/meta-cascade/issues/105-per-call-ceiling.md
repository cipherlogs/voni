# 105: The per-call ceiling drains, never truncates

**What to build:** A call has its own ceiling, checked after every billable unit. A breach drains the call with a spoken localized goodbye and blocks further requests except the goodbye itself.

**Blocked by:** 101 (A named rate table and reproducible cost), 102 (Durable, atomic, shared daily counter), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] The ceiling is checked after each billable unit.
- [ ] A breach ends the call with a drain, a spoken localized goodbye and a budget-stopped mark.
- [ ] No new model or voice request is allowed after the breach except the goodbye.
- [ ] The goodbye's cost is recorded and does not re-trigger the ceiling.
- [ ] A single model turn that crosses the ceiling still gets the goodbye.

## Answer

105 done — `CallLifecycle(ceiling_usd=None)` reads `budget.per_call_ceiling` (USD 0.25) by name at the first billable unit and checks ticket 101's `cost_call(usage_meter.usage())` after every provider event the turn layer receives; the model usage chunk is recorded live (once per turn) so the check sees each unit, not just the end total.
A breach drains the turn layer, speaks `GOODBYE_LINES` through the still-open voice (Spanish for the `lola` vector), then sends the end message: `endedBy: "budget"`, a `budget` block (`mark: budget_stopped`, spend, ceiling, measured, reason), and the ledger's `budget_stopped` mark. The goodbye is spoken before the end signal (audio frames observed while zero end messages had been sent), and after the breach `may_request("llm"/"tts")` is False while `may_request("goodbye")` is True; further provider events are not delivered.
The goodbye's `Termination` characters are recorded in the end cost (60 chars / USD 0.0009 in the test) and the guard latches, so it cannot re-trigger: one stop fact and one alert callback only.
Unmeasured is not zero and not a false stop: with no measured units, or a measured floor under the ceiling, the call ends normally with `cost.totalUsd: null`; a measured floor already at/over the ceiling is a proved breach (exactly USD 0.25 breaches). Tests: full suite `Ran 1829, OK (skipped=1)`; 6 new in `cascade/test_call_ceiling.py`. Red proved (`ceiling_usd` unexpected kwarg); mutations killed (remove the per-event check → 4 errors; `<=` boundary → exact-ceiling test fails).
Branch `cluster/money-103-105`, commit `02006430`, base `33e85a57`; merge → already up to date. Merger notes: adds `budget_stopped` to `metrics.MARKS` (additive; managed golden unchanged) and `"budget"` to `cascade.call.ENDED_BY`; `BudgetStop`/`CallCeiling` live in `call.py`, no new module. M06's turn layer should consult `lifecycle.may_request(...)` as its request gate.

_Implemented on `feat/meta-cascade`._

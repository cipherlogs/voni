# 104: At 100% refuse cascade, never the call

**What to build:** Crossing 100% refuses cascade for new calls with a recorded reason and alerts once. Refusing cascade never refuses the call: managed is the product.

**Blocked by:** 102 (Durable, atomic, shared daily counter), 103 (At 80% of the daily cap, route new calls managed)

**Status:** resolved

- [ ] Crossing 100% makes new calls route managed and refuses cascade with a recorded reason.
- [ ] One alert per day per line.
- [ ] Refusing cascade never refuses the call; managed is the product.
- [ ] A call that cannot use managed fails with an ordinary error, not a cascade-specific one.
- [ ] The refusal is a routing decision, not a fallback event.

## Answer

104 done — the daily cap now refuses cascade at the admission seam, never the call.
`admit_new_call(..., budget=counter)` passes ticket 102's day bucket into the one pre-first-frame `RoutingSwitch.decide`; at exactly 100% (25/25 USD) it returns `Admission(connections=0)` with a frozen managed decision and the opener is never reached. The 100% reason now says "cascade is refused for new calls, which route managed; the call itself is never refused". 99.9% shows the 80% line without the refusal line; a live call's frozen cascade decision is untouched by a later crossing; a counter read outage fails closed to managed with its named reason; the refusal writes no row and carries no fallback shape; both money lines alert once per day per line, again on a new UTC day.
Tests: `cd voice-pipeline && …/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 1923, OK (skipped=1); 7 new in `cascade/test_daily_cap_refusal.py`. Red proved (`admit_new_call() got an unexpected keyword argument 'budget'`); message test pins the new sentence. Mutation: dropping `budget=budget` fails 6 tests.
Branch `cluster/money-104-110`, commit `290c7b02`, base `2c0b7b76`; `git merge feat/meta-cascade` → already up to date.
Merger notes: `admission.py` gained an additive keyword-only `budget` (one read of the day before the switch read, same order as 103's seam); production transport/M06 must pass the `DailyCounter` here or the 80/100 lines are not consulted where the call is admitted. `counter.py` changed only the 100% reason text. 110 builds the `budget.crossing` events on the same `on_crossing` sink.

_Implemented on `feat/meta-cascade`._

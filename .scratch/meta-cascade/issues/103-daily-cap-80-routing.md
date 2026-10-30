# 103: At 80% of the daily cap, route new calls managed

**What to build:** Crossing 80% of the daily cap makes the next new calls route managed and fires one alert per day per line. Live cascade calls continue.

**Blocked by:** 102 (Durable, atomic, shared daily counter), 24 (Routing switch: off, demo, all), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] Crossing 80% makes the next new calls route managed and fires one alert.
- [ ] Live cascade calls continue untouched.
- [ ] The alert fires once per day per line, not once per call; a re-cross after a reset alerts again.
- [ ] The routing decision is recorded with its reason.
- [ ] At 79.9% a call still routes cascade; at 80.1% the same call routes managed.

## Answer

103 done — `RoutingSwitch.decide(subject, budget=counter)` now reads the durable switch once and today's day bucket once, before any frame, and freezes one `RoutingDecision`. At 79.9% (19.975/25) the call cascades; at exactly 80.0% (20/25) and 80.1% (20.025/25) it routes managed with the counter's sentence (line, percent, cap) recorded in `reason`; the decision is frozen so a later charge moves only new calls.
Unknown is never zero: a `StoreUnavailable`/corrupt counter read routes managed with a named reason ("an unknown day's spend is never read as zero"), and an unmeasured day (ratio None) routes managed with the day's own reason. No fallback event is anywhere on this path — the outcome is a routing/eligibility fact.
`DailyCounter(on_crossing=...)` now delivers each `Crossing` exactly once from the writer that made it durable; the 80% line alerts once per day per line, a second charge on the crossed line emits nothing, a second instance emits nothing, and a new UTC day (fresh crossing set) alerts again.
Tests: `cd voice-pipeline && …/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 1829, OK (skipped=1); 10 new in `cascade/test_daily_cap_routing.py`. Red proved (`decide() got an unexpected keyword argument 'budget'`, then `DailyCounter() got an unexpected keyword argument 'on_crossing'`); mutations killed (drop budget refusal → 6 failures; drop alert dispatch → 2 failures).
Branch `cluster/money-103-105`, commit `f3b85ec3`, base `33e85a57`; `git merge feat/meta-cascade` → already up to date. Merger notes: `decide(..., budget=)` is additive (default None); callers must pass `DailyCounter` and freeze the decision before the first frame (transport wiring still M06/M17, same as ticket 24). The alert sink failure is swallowed because the crossing is already durable. A refusal writes no store row and emits no fallback-shaped document (test pins it). 104 builds on the same seam (`would_refuse_cascade` reason is already in `routing_refusal`).

_Implemented on `feat/meta-cascade`._

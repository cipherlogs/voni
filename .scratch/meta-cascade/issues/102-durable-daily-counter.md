# 102: Durable, atomic, shared daily counter

**What to build:** A durable counter shared by every instance, bucketed by UTC day, with each billable unit charged to the day it was consumed. Two simultaneous calls cannot both cross a line unnoticed.

**Blocked by:** 101 (A named rate table and reproducible cost), 03 (Threshold registry with a source requirement), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] The counter is durable, atomic and shared; two simultaneous increments produce one crossing event.
- [ ] Buckets are UTC days, confirmed by the open-value decision.
- [ ] Each billable unit lands on the day it was consumed, so a call spanning midnight charges both days.
- [ ] Reconnect replays and fallback legs are counted; a prefetch that produced no usage is not.
- [ ] Advancing the fake clock across midnight asserts both buckets.

## Answer

Ticket 102 done — new `cascade/counter.py`: one versioned document per UTC day (`budget.daily:<YYYY-MM-DD>`) in `DurableStore`; every write is a compare-and-set with re-read/retry, so two instances share one total and two simultaneous charges produce exactly one crossing per line (the crossing set is stored with the money).
The day key is UTC-only and read from `budget.day_boundary` (a non-UTC value is refused by name); cap/80%/100% come from the registry (`budget.daily_cap`, `budget.route_managed_ratio`, `budget.refuse_cascade_ratio`) and none is restated. A charge lands on the day of consumption, so a midnight-spanning call writes both buckets; a charge never moves or refuses a live call (that stays 105's ceiling).
Money is ticket 101's `CallCost.amount`, never an estimate. A measured zero is a charge; an unmeasured cost is not zero — no amount is added, the day records the reasons and `ratio` is `None`, so both lines fail closed (route managed / refuse cascade) until the day is known. Reservations hold a measured cost so an in-flight call counts on the line: a measured settle releases the hold and charges the consumption day, an unmeasured settle keeps the hold and flags the day, and `release` is idempotent.
Tests: `cd voice-pipeline && /home/cipherlogs/Repos/AI/leadcalls/telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 1724, OK (skipped=1); 34 new in `cascade/test_counter.py`; five mutations killed (crossing history ignored, line uses charged-only, unmeasured read as a number, no CAS retry, local-date bucket). Branch `cluster/money-102`, base `bd9180dc`, commit `1f94552d`; merge of `feat/meta-cascade` → already up to date.
Merger notes: 103/104 read `await snapshot()` (`ratio`, `would_route_managed`, `would_refuse_cascade`, `routing_refusal`, `to_document()`); a failed read raises `StoreUnavailable` — route managed with a recorded reason, never read it as zero. M06 must charge once per recorded vendor record (reconnect replay and fallback leg both count) and must not charge a prefetch that produced no usage: an unmeasured charge flags the whole day. A cross-midnight `settle` charges the new day then releases the old hold — a store outage between those two writes needs a manual `release` (idempotent). No orchestrator, ceiling, alert or routing-decision wiring here.

_Implemented on `feat/meta-cascade`._

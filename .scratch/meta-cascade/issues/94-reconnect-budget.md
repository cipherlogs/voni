# 94: One reconnect per leg, and planned reconnects are separate

**What to build:** Recovery is bounded. Each leg gets one failure reconnect per call, a planned reconnect at a session limit is counted separately, and a second failure on the same leg ends the call.

**Blocked by:** 75 (Call lifecycle and the end message)

**Status:** resolved

- [ ] Each leg gets one failure reconnect per call.
- [ ] A planned reconnect at a session limit is counted separately and does not consume the budget.
- [ ] A second failure on the same leg ends the call.
- [ ] The budget is visible in the ledger and the end message.
- [ ] Two injected failures produce one reconnect and then an end.

## Answer

Ticket 94 done: new `cascade/reconnect.py` holds the one call-level reconnect ledger. `ReconnectBudget.failed(verdict, mid_reply=...)` spends one failure reconnect per leg (`stt/llm/tts`) and returns `END` on the second failure; it never routes to managed. `planned(leg, code=SESSION_LIMIT|3008|DELIBERATE)` and a planned verdict passed to `failed()` are counted in `plannedReconnects`, never touch `failures`/`budget_left`, and never open the breaker (`opens_breaker` forced false). A model failure with `mid_reply=True` returns `DRAIN` and never `RECONNECT`, because a restart would repeat speech; it still counts as that leg's failure, so the next one ends.
Budget visibility: each reconnect writes the shared ledger's `reconnect` mark, and `to_document()` gives `budgetPerLeg`, per-leg `{failures, failureReconnects, plannedReconnects, budgetLeft}` for all three legs (untouched = zero), and the first-class event list (leg, at, action, code, failureClass, planned, reason). It opens no socket and sends nothing; 95-99 own the mechanics and the final end.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1106, OK (22 new in `cascade/test_reconnect.py`; red-first import failure, then mutation checks: unlimited budget, no planned bypass, no mid-reply guard, no ledger mark, bugs spending/not counting budget all go red).
Branch `cluster/reconnect-94`, commit `326fedf9`, base `cce8b788` (= `feat/meta-cascade`; nothing to merge).
Merger notes: 95/96/97 must route per-leg decisions through `ReconnectBudget`; 31/32/42 already keep adapter-local one-retry counters (`meta_stt._retry_used`, `meta_llm._leg_failures`/`MAX_LEG_FAILURES`) — do not nest two budgets, delegate or replace. 99 should place `budget.to_document()` under the end message (`reconnects`) and treat `END` as terminal; `FAIL` leaves call-vs-turn scope to the caller.
Evidence: `voice-pipeline/cascade/reconnect.py`, `voice-pipeline/cascade/test_reconnect.py`, spec "Reconnect, sequence dedupe, partial reply" + operational note (60-min STT / 3,600-s TTS are facts).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# 68: Unknown, duplicate and late events

**What to build:** A stray or repeated event never corrupts a turn. An unknown turn is logged and ignored, a duplicate completion is idempotent, a partial without a start never reaches the model, and a final before any start is a protocol violation.

**Blocked by:** 67 (Event rules: the final is the only reply trigger)

**Status:** resolved

- [ ] A start or completion for an unknown turn is logged and ignored.
- [ ] A duplicate completion is idempotent: one reply at most.
- [ ] A partial with no preceding start never reaches the model.
- [ ] A final before any start is logged, ignored, and produces no reply.

## Answer

68 done — `cascade/event_rules.py` now returns `EventOutcome.ignored_reason` (`IgnoreReason`: unknown_event, unknown_turn, late_event, duplicate_complete, unattributed_partial) and counts per reason via `ignored_counts()`/`ignored_count()`; every ignored event is logged by reason/type/turn/epoch and never with the caller's words.
Ignoring never invokes the reply sink and never mutates an open turn: a final/start/end for no open turn, a start for a closed turn or with an empty turn id (was a ValueError escaping `apply`), a stale-epoch event, a duplicate completion (`duplicate_finals` guard, one reply at most) and a partial with no start / after the final are all counted and silent.
Untouched: backchannel/echo final suppression is ticket 71 (no classifier added here), reply ordering 69, ledger vocabulary (`metrics.py` not edited — the per-reason count lives on EventRules).
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 940, OK (11 new in `cascade/test_event_rules.py`; 923 after this commit). Red-proofed by deleting the counter increment (4 failures) and the empty-turn-id guard (1 error).
Branch `cluster/orch-68-70`, base `8ff36c2a`, commit `7cec48b2`; `git merge feat/meta-cascade` → "Already up to date".

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

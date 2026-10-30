# 71: Backchannel and echo finals are counted, not answered

**What to build:** A final that is filler or the agent's own voice is counted and produces nothing. A command final takes the floor and steers the next turn; a normal final generates a reply.

**Blocked by:** 70 (Floor arbitration while the agent holds the floor)

**Status:** resolved

- [ ] A backchannel final is counted, produces no reply and sends no cancel.
- [ ] An echo or overheard final is counted and produces no reply, using the existing classifier.
- [ ] A command final takes the floor and steers the next turn.
- [ ] A normal final generates a reply.
- [ ] Removing suppression makes the backchannel test fail.

## Answer

71 done — `cascade/floor.py` adds `FinalGate` (`FinalAction` reply/steer/suppressed, `FinalReason` normal/command/backchannel/echo/empty) and `is_echo`, the single Python port of the browser's `judgeOverlap` similarity rule (`ECHO_SHARE = 0.6`, read back from `voni/src/lib/voice/barge-in.ts` by a parity test); `turns.clean_tokens` is now the one tokenizer.
`EventRules` gains an optional `final_gate` + `agent_text` and keeps the one reply call site: a backchannel/echo final is counted on the existing `backchannel`/`overheard` counters, closes the turn, asks for nothing and reports `cancel=False`; a command final counts `yield`, carries its `steer_text` and cancels only while the agent holds the floor; normal finals are answered.
Order is backchannel → echo → command, so an echo of "please stop the timer" never steers; the control test (`EventRules` without a gate answers the same "uh-huh") proves suppression is what changes the outcome.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1127, OK (14 in `cascade/test_final_suppression.py`). Red-proof: bypassing `_decide` → 2 failures + 6 errors; moving echo after command → the own-voice test fails.
Branch `cluster/orch-71-73`, base cce8b788, commit e939522f; `git merge feat/meta-cascade` → "Already up to date". Ticket 93 must reuse `floor.is_echo`, not add a second copy. No `commit` vocabulary, no `.scratch/` edit.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

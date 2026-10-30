# 74: Interleaved turns keep separate state

**What to build:** Two open turns are two objects. A late completion lands in its own turn, a reply is never captioned as another turn's user text, and a vendor turn id reused after reconnect is disambiguated by the session epoch.

**Blocked by:** 67 (Event rules: the final is the only reply trigger), 33 (Overlapping turns and a session epoch)

**Status:** resolved

- [ ] Turn one's state and turn two's state are separate objects.
- [ ] A late completion for turn one after turn two opened merges into turn one.
- [ ] A reply to turn one is never captioned as turn two's user text.
- [ ] A vendor turn id reused after reconnect is disambiguated by epoch and never merges with the old turn.

## Answer

74 done — interleaved turns are independent objects and every slot stays keyed on the logical id. `TurnStateStore` now guards the replaced-epoch check before *any* key shape, so a stale event naming a `TurnState`/`LogicalTurnId` can no longer finalise, partial, cut, close or even read a live turn; `close()` and `get()` take the event's `epoch`. Added `reply()` (reply carries `turn_id` + the authoritative `user_text` it answers) and `user_text()` (the only caption source; a partial is never one).
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 935, OK (7 new in `cascade/test_turn_state.py`); red evidence was 2 failures + 3 errors before the epoch guard/reply API.
Branch `cluster/turn-74-75`, base `8ff36c2a`, commit `fc7c730c`; `git merge feat/meta-cascade` → "Already up to date". No `.scratch/` edits, no thresholds invented.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

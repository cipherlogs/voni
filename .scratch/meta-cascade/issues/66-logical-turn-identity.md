# 66: Logical turn identity and keyed state

**What to build:** Every piece of turn state is keyed on a logical turn identity that survives overlapping vendor turns and reconnects: partial text, start and end timestamps, final text, tool loop, reply, audio cut point and provider attribution.

**Blocked by:** 01 (Shared determinism kit), 05 (Retire commit vocabulary on the cascade)

**Status:** resolved

- [ ] The logical id is the session epoch plus the vendor turn id, and it survives an overlapping turn or a reconnect.
- [ ] Partial text, timestamps, final text, tool loop, reply, cut point and attribution are all keyed on it.
- [ ] Two turns can be open at once and never share state.
- [ ] A test reuses a vendor turn id in a new epoch and observes two distinct logical turns.

## Answer

66 done — `cascade/turn_state.py` adds `LogicalTurnId(session_epoch, provider_turn_id)` and `TurnStateStore` (`open`/`partial`/`end`/`finalise`/`cut`/`close`, plus `new_epoch`/`bind`/`resolve`); every field — partial, start/end timestamps, final, tool loop, reply, cut point, attribution — hangs off one `TurnState`, so overlapping turns are two objects.
Identity: provider ids bind per session epoch, so a reused id in a new epoch is a distinct turn, stale-epoch events return None, and `bind()` maps a replayed reconnect id onto the existing logical turn while keeping the old attribution in `attribution_history`.
Lifecycle: `speechEnd` never finalises, `speechComplete` is authoritative and idempotent on duplicate, close records a reason, and the audio cut point is first-write-wins; timestamps come only from the injected clock.
Tests: `cd voice-pipeline && /home/cipherlogs/Repos/AI/leadcalls/telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 266 tests, OK (16 in `cascade/test_turn_state.py`); red case proven first (ModuleNotFoundError, then the epoch/overlap/reconnect assertions drive the API).
Branch `ticket/66-logical-turn-identity`, base df21bedb, commit 47d3e6bd, `git merge feat/meta-cascade` → "Already up to date"; no orchestrator/thresholds/I-O touched, no `commit` vocabulary, no `.scratch/` edits.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

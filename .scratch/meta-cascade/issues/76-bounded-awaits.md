# 76: Every await that can outlive a turn is bounded

**What to build:** The reply task, stall guard, tool timeout, drain and reconnect handshake each have a named bound from the registry. No unbounded network await sits in the audio path.

**Blocked by:** 75 (Call lifecycle and the end message), 03 (Threshold registry with a source requirement)

**Status:** resolved

- [ ] The reply task, stall guard, tool timeout, drain and reconnect handshake each read a named bound from the registry.
- [ ] No unbounded network await exists in the audio path; a test fails on one.
- [ ] A timed-out bound produces a recorded, named outcome rather than a hang.
- [ ] A never-completing fake proves each bound fires.

## Answer

76 done — `cascade/call.py` now has one `BOUNDED_WAITS` table mapping each wait to a registry bound and a named timeout outcome: reply task `turn.reply_task_ms`, stall guard `turn.stall_guard_ms`, tool `tool.timeout_ms`, drain/close `deploy.drain_max_wait_ms`, reconnect `reconnect.handshake_ms`, plus the audio path's greeting synthesis on the settled `tts.idle_timeout_ms`. `CallLifecycle.run_bounded(stage, work)` reads the registry, never a literal, and the four public seams (`run_reply_task`, `run_stall_guard`, `run_tool`, `run_reconnect_handshake`) are what the turn layer will call.
A never-completing fake returns a recorded `BoundOutcome` (stage, registry name, `error.name`) instead of hanging; outcomes travel on the end message as `bounds`. An unset bound raises `UnsetBoundError` by name (no default), a zero/negative bound is `InvalidBound`, and the test suite also shows the direct await would hang while the bounded one ends.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1119, OK (6 new for 76 in `cascade/test_call.py`, plus the drain-bound assertions). Branch `cluster/call-76-98`, base `cce8b788`, commit `20d64e26`.
Merger notes: `CallEnd.bounds` is additive; `drain_bound_ms` still works as an injected override; the browser `receive()` await belongs to ticket 65's transport and is the only unbounded wait left in this file.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

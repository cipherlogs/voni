# 79: Barge-in cancels the greeting

**What to build:** If the visitor starts speaking during the greeting, the greeting is cancelled and the caller's turn wins. It does not resume afterwards.

**Blocked by:** 77 (The greeting is spoken before any user audio), 52 (Cancel semantics and the next flush id)

**Status:** resolved

- [ ] A speech start or a taking-the-floor partial during the greeting sends a cancel.
- [ ] The greeting does not resume.
- [ ] The caller's turn is answered.
- [ ] A test that removes the cancel hears the greeting finish over the caller and fails.

## Answer

79 done — the opening is now a listening window: `CallGreeting.start` returns a `GreetingPlayback`, the lifecycle pumps caller frames into STT and buffers provider events while the greeting sounds, and a `speechStart` or non-filler partial calls `GreetingPlayback.cancel` → synthesis `Cancel`, producer stopped, pending text discarded, `cancelled` mark + `interruption` count, `greeting_done` marked, no resume. The buffered event is then replayed to the turn layer so the caller's turn is answered.
Evidence: `cascade/test_greeting_barge_in.py` (6 tests: cut stops frames/one Cancel/no resume, idempotent second cut, real adapter sends `Cancel` and discards the second sentence, lifecycle speechStart and partial cuts with the caller turn delivered, backchannel does not cut).
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1315, OK (skipped=1). Branch `cluster/greet-78-80`, commit `4bc9ccc8`.
Merger notes: `cascade/call.py` integration rewritten around one browser reader + one STT reader; `cascade/test_call.py`'s hanging-greeting test now injects an empty STT trace because a `speechStart` legitimately cuts a hanging greeting. `GreetingOutcome` gains `cancelled`/`cause`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

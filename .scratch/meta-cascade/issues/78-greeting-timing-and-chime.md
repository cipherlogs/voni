# 78: Greeting timing and the connected chime

**What to build:** The greeting is sent only after the synthesis session is confirmed and before the first user frame, with the first sentence flushed immediately. The connected chime fires on the first audible sample, not on a schedule.

**Blocked by:** 77 (The greeting is spoken before any user audio)

**Status:** resolved

- [ ] The greeting is sent after the session acknowledgement and before the first user frame.
- [ ] It is one generate and flush; a long greeting splits at sentence boundaries with the first sentence flushed immediately.
- [ ] The first audible sample fires the connected chime, not the schedule.
- [ ] A test with zero microphone frames produces greeting audio and exactly one chime.

## Answer

78 done — `CallGreeting` now refuses to speak before the opened session acknowledged `Begin` (`GreetingNotConnected`) and fires the connected chime from the first frame with PCM, once, before that frame reaches the call's sink; an awaitable chime is never awaited, so it cannot delay the first word. `CallLifecycle` records the trigger (`chime_calls`, `chime_at`) and reports `greeting.chimeFired`; zero microphone frames still speak the greeting and fire exactly one chime.
Evidence: `cascade/test_greeting_timing.py` (8 tests: Begin-before-greet, chime order/count, empty-frame, never-awaited chime, zero-mic-frames lifecycle, open→greet→chime→stream order).
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1309, OK (skipped=1) at this commit. Branch `cluster/greet-78-80`, base `098fdf9d`, commit `ed04c5eb`.
Merger notes: additive `chime` argument on `CallGreeting`/`CallLifecycle`; `GreetingOutcome` gains `chime_fired` (`chimeFired` on the end message).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

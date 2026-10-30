# 80: Greeting failure is visible and the text is pinned

**What to build:** A greeting that cannot be synthesized ends the call visibly and records the voice trigger; there is no silent opening. The greeting text equals the body's greeting and the clip's source line.

**Blocked by:** 77 (The greeting is spoken before any user audio), 55 (Voice close policy: trigger, bug, expiry)

**Status:** resolved

- [ ] A greeting synthesis failure ends the call visibly, records the voice trigger and opens the breaker.
- [ ] There is no silent opening; the idle timeout is never what reveals an unflushed greeting.
- [ ] The greeting text equals the body's greeting and the clip's source line.
- [ ] A text mismatch is a test failure, not a copy edit.

## Answer

80 done — a raw synthesis close during the greeting is routed through the voice's own `handle_close` (ticket 55), so a trigger is retried once before audio and the second failure opens the voice breaker; a bug close alerts without opening. `CallFailure` now carries the provider verdict as `trigger` (`leg`, `code`, `class`, `reason`) on the end message. A greeting that never produces a frame raises `GreetingSilent` immediately — the recorded greeting bound is `ok=False` with `GreetingSilent`, never `GreetingTimedOut` — and the call ends with a visible error before the stream starts.
Text equality: the test reads the committed clip evidence (`voni/evidence/audition-clips/clips.json`) and the greeting source (`voni/src/lib/demo/voni-agent.ts`), compares them for every bound demo voice, checks each clip's line hash, and proves the call's `Generate` text and `GreetingOutcome.text` equal the body line unchanged.
Evidence: `cascade/test_greeting_failure.py` (7 tests). Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1322, OK (skipped=1). Branch `cluster/greet-78-80`, commit `eb4e773d`.
Merger notes: `CallFailure.to_document()` gains an optional `trigger` block (additive); no announcement/tool narration touched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

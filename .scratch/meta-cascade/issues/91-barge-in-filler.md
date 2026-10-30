# 91: A filler interruption neither cuts nor replies

**What to build:** A backchannel keeps the floor where it is. If audio was cut for another reason, the existing filler-resume contract still recovers the tail without a model call.

**Blocked by:** 88 (Barge-in cuts with Cancel, not a socket close), 71 (Backchannel and echo finals are counted, not answered)

**Status:** resolved

- [ ] A filler or backchannel interruption sends no cancel and produces no reply.
- [ ] If audio was cut for another reason, the filler-resume contract still recovers the tail with zero model calls.
- [ ] A filler misclassified as a real cut is recovered by the resume.
- [ ] The filler-resume budget is read from the frozen table, not re-declared.

## Answer

91 done — `BargeInCutPath.interrupt(action, …)` dispatches the floor action: `backchannel` returns a `FillerResume` plan and sends no `Cancel`, starts no generation, adds no frame and asks no model; `wait` returns `None`; `take_floor` is ticket 88's cut. A cut for another reason leaves its located tail (89) available, and `filler()` carries exactly that tail forward; a filler misclassified as a real cut is recovered from the cut's seam, not restarted. A `FillerResume` is never a reply (`is_reply` False, `model_calls` 0) and a real reply, a later cut or `stop()` cancels it (`plan.cancelled`). Counting stays with `FloorArbiter`, so a backchannel is not counted twice.
The budget is `FILLER_RESUME_BUDGET_MS = require_bound("barge_in.filler_resume_tail_ms")`; the test reads `fillerResumeTailMs` back from `voni/src/lib/demo/scoreboard-budgets.json` and asserts equality, so a re-declared literal fails.
Tests: `cd voice-pipeline && …/python -m unittest cascade.test_barge_in_filler` → 9 pass; full suite Ran 1329, OK (skipped=1). Red-proof: routing `backchannel` through the cut + not cancelling a pending plan fails 4 tests + 3 errors. Ticket 90 still owns speaking the plan on a new flush id.
Files: `voice-pipeline/cascade/{barge_in.py,test_barge_in_filler.py}`; commit `e6f152eb`; branch `cluster/barge-89-93`; base `098fdf9d`; `git merge feat/meta-cascade` → Already up to date.
Merger: 90 consumes `FillerResume.text`/`budget_ms`/`resume` and must speak it, not rebuild it; `start()` intentionally cancels a pending plan and clears the resume cut so a stale tail cannot follow a new answer.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

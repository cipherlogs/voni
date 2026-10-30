# 90: The tail resumes with zero model calls

**What to build:** The unheard tail is re-synthesized on a new flush id with the same voice and language, continuing the same reply rather than starting a new answer, and a new caller turn cancels a stale resume.

**Blocked by:** 89 (The unheard tail is located from the played position), 49 (Sentence scheduling: first sentence flushes immediately)

**Status:** resolved

- [ ] The unheard tail is re-synthesized on a new flush id with the same voice and language.
- [ ] Zero model requests are made during the resume.
- [ ] The resume continues the existing reply rather than a new answer.
- [ ] A new caller turn cancels a stale resume.
- [ ] A counting model sees zero calls.

## Answer

90 done — the located tail (89) is spoken by `BargeInCutPath.resume(plan)`: the same opened synthesis session (same voice and language, one socket, no reopen), the vendor's next `flush_id` read from the first audio frame (5 in the test, never computed), and the cut seam's turn/reply kept on `TailResume` (`continues_reply=True`, `starts_new_answer=False`, `is_reply=False`, `model_calls=0`). Word-level when `WordBoundaries` are complete; the sentence not fully played otherwise; the heard prefix is never re-sent. A plan is consumed once (`plan.resumed`) so a second resume is `StaleResumeError` by name and the tail plays exactly once; a new caller turn (`start`), a second cut, or `stop()` cancels a stale resume; a reply that fully played refuses with `NoUnheardTailError` instead of repeating.
Tests: `cd voice-pipeline && …/python -m unittest cascade.test_barge_in_tail_resume` → 11 pass; full suite Ran 1466, OK (skipped=1). Red-proofs: dropping the resume flush-id capture fails `5 != None`; dropping resume preemption fails with `ReplyInFlightError` on the new caller turn; the one-word-loss mutation in the adapter's `_tail_from` (run for ticket 92) also breaks this module's "never lose a word" tail.
Files: `voice-pipeline/cascade/{barge_in.py,test_barge_in_tail_resume.py}`; commit `49180f71`; branch `cluster/barge-90-92`; base `06f9f097`; `git merge feat/meta-cascade` → Already up to date (integration tip is still 06f9f097).
Merger: `ResumeRefusedError` (`NoUnheardTailError`, `StaleResumeError`) are new named refusals; `start()` now preempts an in-flight resume but still raises `ReplyInFlightError` for a live answer; `FillerResume` gained `resumed`; no thresholds or wire shapes added.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

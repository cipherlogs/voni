# 89: The unheard tail is located from the played position

**What to build:** The client reports the last played position with the interruption, and the server maps it to the reply text, so the resume starts at the first word the caller did not hear.

**Blocked by:** 88 (Barge-in cuts with Cancel, not a socket close), 51 (Word boundaries and resume granularity)

**Status:** resolved

- [ ] The client reports the last played audio position with the interruption.
- [ ] The server maps it to text using per-sentence flush durations and complete word boundaries.
- [ ] When boundaries are unavailable, the resume point is the start of the first sentence not fully played.
- [ ] A short repeat is accepted; a lost word is not, and the test asserts the word is present.

## Answer

89 done — the client's `played_ms` on a cut is now located against the reply text: `BargeInCutPath.cut_point(played_ms)` makes it sample-exact (whole samples at the rate of the audio actually played, floored so a fractional report repeats a word, never loses one) and the session's own `resume_point` maps it to the first unheard word when `WordBoundaries` are complete, else the start of the first sentence not fully played. The located point is stored on `CutSeam.cut_point` (with `resume`/`resume_text`/`word_level` readers) for ticket 90; nothing is re-synthesized. `CutSeam.played_ms` stays the raw client report, and a cut with no report has `cut_point=None` (never 0).
Tests: `cd voice-pipeline && …/python -m unittest cascade.test_barge_in_played_position` → 9 pass; full suite Ran 1329, OK (skipped=1). Red-proofs: using the raw report instead of derived samples fails the sample-exact test; forcing sentence granularity fails 4 word-level tests. The word-at-the-cut test asserts "there." is present.
Files: `voice-pipeline/cascade/{barge_in.py,test_barge_in_played_position.py}`; commit `860cf800`; branch `cluster/barge-89-93`; base `098fdf9d`; `git merge feat/meta-cascade` → Already up to date.
Merger: 90 reads `cut.seam.resume`/`resume_text` and must not re-locate; `cut_point()` is the one location seam. `UnknownSampleRateError` is refused by name only on the explicit call; a cut still stops with `cut_point=None` when no rate is known.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

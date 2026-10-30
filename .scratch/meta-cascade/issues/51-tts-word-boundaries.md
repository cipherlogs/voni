# 51: Word boundaries and resume granularity

**What to build:** Word-level boundaries are captured when the vendor reports them complete, so a barge-in can resume from the first unheard word; an incomplete status falls back to the sentence boundary with no guessing.

**Blocked by:** 47 (Synthesis connect per transport)

**Status:** resolved

- [ ] Word boundaries are captured per sentence when the vendor reports complete.
- [ ] Any other status is recorded, and resume granularity falls back to the sentence boundary.
- [ ] The cut point is the first unheard word, or the first sentence not fully played.
- [ ] A test with complete and incomplete boundary fixtures yields two different resume points by name.

## Answer

51 done — each `WordBoundaries` frame is captured per request on `SynthesisRequest` (`flush_id`, `audio_start_ms`, word tuples), matched by `flush_id` and never by arrival order, so a frame that lands after the next request's audio still lands on the right sentence.
`resume_point(played_ms)` cuts on the session's continuous audio timeline: with `word_boundaries_status == "complete"` (or a live call before any `Termination`) and a boundaries frame for the request at the cut, it resumes from the first unheard word; any other status (`none`, `disabled`) is recorded on `word_boundaries_status` and the cut falls back to the first sentence not fully played.
No guessing: the word tail is taken from the original request text by the vendor's 1:1 whitespace-token guarantee (case and punctuation survive), and a token count that disagrees with the boundaries falls back to the sentence with a named reason instead of approximating.
Tests: 12 new in `cascade/test_tts_word_boundaries.py`; the complete and incomplete fixtures yield two resume points by name (`word` vs `sentence`) at the same `played_ms`; forcing sentence granularity fails 5 tests. Full suite 484 OK.
Files: `voice-pipeline/cascade/{assemblyai_tts.py,test_tts_word_boundaries.py}`; commit `0f49cc0c`.
Merger notes: a minimal `terminate()` landed here only to reach `Termination.word_boundaries_status`; ticket 54 replaced its return with `TerminationRecord`. Boundaries for the last sentence arrive after its `FlushDone`, so they are recorded by the next read or by `terminate`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

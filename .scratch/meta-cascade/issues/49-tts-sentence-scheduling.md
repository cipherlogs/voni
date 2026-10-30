# 49: Sentence scheduling: first sentence flushes immediately

**What to build:** Text is sent per sentence. The first sentence of a reply and the greeting flush immediately so audio starts without waiting for more context; long sentences split at a clause or under the character cap; per-token flushing is impossible.

**Blocked by:** 47 (Synthesis connect per transport)

**Status:** resolved

- [ ] The first sentence of a reply and the greeting are generated and flushed immediately.
- [ ] A long sentence splits at a clause boundary or under the 2,000-character cap; an over-cap request is never sent.
- [ ] Per-token flushing is impossible because the scheduler only flushes at a sentence boundary.
- [ ] The control-frame rate stays within the vendor's budget; a test counts frames per second.

## Answer

49 done — `schedule(text)` splits a reply into one `Generate` text per sentence (keeping trailing whitespace, since the vendor joins frames with no separator), and `speak` sends `Generate`+`Flush` for the first sentence before any later sentence, then tops up one sentence per `FlushDone`; the greeting uses the same path via `speak_greeting`.
Cap: `GENERATE_CHAR_CAP` is read once from `cascade.thresholds.require_bound("tts.generate_char_cap")`; a long sentence splits at a clause boundary (`,;:` + whitespace), then whitespace, then a hard cut under the cap — `"".join(schedule(text)) == text` and an over-cap `Generate` is never sent (a defensive guard also refuses it).
Per-token flushing is unexpressible: the only public flush path is sentence scheduling (1 sentence of 10 tokens = 1 Flush; 3 sentences = 3 Flushes), and the control-frame guard refuses a burst over the session's own `Begin.configuration.limits.max_control_frames_per_sec` as a `ControlFramePacingError` (3010 pacing bug).
Tests: 15 new in `cascade/test_tts_sentence_scheduling.py`, including a per-second frame count against an injected `FakeClock` (8/s for a delivery-paced 5-sentence reply, budget 20/s) and a 0-delay burst refused at 20 frames; 11 failed with `schedule`/guard removed. Full suite 472 OK.
Files: `voice-pipeline/cascade/{assemblyai_tts.py,test_tts_sentence_scheduling.py}`; commit `c4be8ef3`.
Merger notes: `speak` takes `clock=` (default `time.monotonic`) for the pacing window; ticket 53's keepalive must send through `_send_control` to share the budget, and `control_frame_times` is the recorded evidence.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

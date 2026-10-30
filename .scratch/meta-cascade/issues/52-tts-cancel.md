# 52: Cancel semantics and the next flush id

**What to build:** Cancel stops in-flight synthesis and discards unflushed text and pending flushes. Frames that arrive before the cancellation is acknowledged belong to the old request and are dropped, and the next flush id is read rather than computed.

**Blocked by:** 47 (Synthesis connect per transport)

**Status:** resolved

- [ ] Cancel stops in-flight synthesis and discards unflushed text and pending flushes.
- [ ] Audio frames between the cancel and its acknowledgement are dropped.
- [ ] The next flush id is read from the first frame after the acknowledgement, never computed.
- [ ] A generate sent immediately after a cancel is not caught by that cancel.
- [ ] A cancel with nothing in flight is acknowledged with zero duration and the client flush still runs.

## Answer

52 done — `cancel()` sends `{"type":"Cancel"}` and returns immediately with a `Cancellation` record (no wait on the ack, so a barge-in cut stays local): it bumps a cancel generation, marks `_discarding`, and records `discarded_characters` for the scheduled-but-unsent sentences.
The running `speak` stops at its next iteration (generation mismatch) and sends no further `Generate`/`Flush`; the next frame read drops every old-request `Audio` (counted in `dropped_audio_bytes`) and `FlushDone` (counted in `dropped_flushes`) until `Cancelled`, then takes `next_flush_id` from the first `Audio`/`FlushDone` after it — read, never computed (fixture skips 0→7).
A `Generate` after `cancel()` is not caught by it (new request's audio is yielded), and a cancel with nothing in flight acks `0.0` and the next client `Flush` runs normally.
Tests: 7 new in `cascade/test_tts_cancel.py`; red first (no `cancel`), and removing the discard window or the generation guard fails them. Full suite 491 OK.
Files: `voice-pipeline/cascade/{assemblyai_tts.py,test_tts_cancel.py}`; commit `b683b8fb`.
Merger notes: `Cancellation.audio_duration_seconds` stays `None` until acknowledged; the ack is consumed lazily by the next read, so the orchestrator must keep reading (the next `speak`/`terminate` does) for the record to fill in.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

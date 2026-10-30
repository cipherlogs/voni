# 98: Call-level sequence numbers survive reconnect

**What to build:** Every audio frame carries a monotonic sequence number independent of the synthesis flush id. The client never plays a frame it has already played, and a reconnect continues the sequence rather than resetting it.

**Blocked by:** 75 (Call lifecycle and the end message)

**Status:** resolved

- [ ] Every server-to-browser audio frame carries a call-level monotonic sequence number independent of the flush id.
- [ ] The client drops any frame whose sequence is not greater than the highest played.
- [ ] A reconnect continues the sequence and never resets.
- [ ] A sequence gap is logged and the call continues; a duplicate with different bytes is dropped and logged.
- [ ] A test asserts a duplicated frame is never played twice.

## Answer

98 done — `cascade/call.py` now owns the call-level audio sequence: `CallSequence` hands out one monotonic `seq` (first frame 1), keeps it independent of the TTS `flush_id`, and `reconnect()`/`session_reconnected()` advances only the session epoch, never the counter. `CallLifecycle.emit_audio()` is the one audio door for greeting and reply frames, so no frame can reach the browser without a seq and no path can restart it.
`CallPlayout` is the receiving contract: a frame whose `seq` is not greater than the highest played is dropped; a duplicate with different bytes is dropped and logged as such; a gap is logged and playback continues; the gate is keyed on `seq` alone, so it dedupes/orders across epochs. The duplication test proves one emitted frame is played exactly once.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1119, OK (14 new in `cascade/test_call_sequence.py`). Branch `cluster/call-76-98`, base `cce8b788`, commit `4f9a292e`.
Merger notes: `send_audio` now receives `OutboundAudio(seq, epoch, pcm, sample_rate, kind, flush_id)`; ticket 65's transport must put `seq` on the wire and the TS playout must mirror `CallPlayout` (not edited here — TS is outside this cluster's ownership); the turn layer must call `emit_audio` for reply frames.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

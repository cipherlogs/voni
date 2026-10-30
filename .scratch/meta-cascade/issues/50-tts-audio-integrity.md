# 50: Audio decode and loss detection

**What to build:** Audio is decoded at the rate the session confirmed, and the vendor's duration report is checked against the bytes received, so dropped audio is a fact rather than a guess.

**Blocked by:** 49 (Sentence scheduling: first sentence flushes immediately)

**Status:** resolved

- [ ] Audio is decoded at the confirmed sample rate, never a hardcoded one.
- [ ] The flush duration is compared with bytes received divided by rate and sample size.
- [ ] A difference beyond the named tolerance fails the call as audio loss and records the delta.
- [ ] Every frame holds whole samples; a partial sample is refused.

## Answer

# 50 — TTS audio integrity and loss detection

1. **Format echo and loss.** `_record_flush_done` derives each request's real
   duration as `audio_bytes / (audio_sample_rate × bytes_per_sample) × 1000` and
   fails the call as `AudioLossError` when it differs from
   `FlushDone.audio_duration_ms` beyond `tts.audio_loss_tolerance_ms`; the signed
   delta, reported/derived ms and byte count are recorded in `tts.audio_losses`
   and on the error (`cascade/assemblyai_tts.py`).
2. **Rate and width come from the session.** The rate is the `Begin` echo
   (`audio_sample_rate`), never 24 kHz; the width is the transport encoding's
   (`TransportFormat.bytes_per_sample`: `pcm_s16le`=2, `pcm_mulaw`=1). An 8 kHz
   mu-law flush of 1,600 bytes / 200 ms passes; the 24 kHz hardcode red-proof
   makes it a 133 ms "loss".
3. **Whole samples.** `_decode_audio` refuses a payload that is not a whole
   number of samples (`PartialSampleError`), for delivered, residual and
   cancelled frames alike; Terminate's residual audio is now attributed to its
   request so the final `FlushDone` is checked too.
4. **Verdict:** audio loss is classified as `3005` (vendor's "no output while a
   FlushDone was owed"): visible, call-ending, opens the voice leg, no retry
   after audio was delivered. No keepalive (53) or fixture file (56) touched.
5. **Tests:** 15 new tests in `cascade/test_tts_audio_integrity.py`; full suite
   `cd voice-pipeline && …/.venv/bin/python -m unittest discover -s . -p 'test_*.py'`
   → **Ran 799 tests, OK**. Red-proofs: removing the check → 6 fail; hardcoding
   24 kHz → 2 fail; dropping the whole-sample guard → 1 fails.

**Merger notes.** (a) I added one registry entry, `tts.audio_loss_tolerance_ms`
= 5 ms (ticket 50, gate `tts.format-echo-and-loss`, sourced in
`thresholds.json`) — the spec says "a few milliseconds" without a number, so
ticket 04/spec owner may retune it; the code reads it only via `require_bound`.
(b) I touched the shared TTS fixtures in `cascade/test_tts_support.py`
(new `pcm_ms`/`audio_ms`, `flush_done(audio_duration_ms=None)`) and made the
existing 47–55 fixtures byte-accurate — they previously paired 2-byte payloads
with 800 ms reports, which the new check correctly refuses. Base: `03ad6476`
(integration tip, merge = "Already up to date"). Branch: `cluster/tts-50`,
commit `4e91907a`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# 29: Speech audio path, pacing and malformed frames

**What to build:** Audio goes up as raw binary only, at approximately real time, with silence sent during silence and malformed client frames dropped before they reach the vendor.

**Blocked by:** 26 (Meta speech handshake and injected socket seam)

**Status:** resolved

- [ ] Only binary frames are sent: signed 16-bit little-endian mono at 24 kHz. JSON audio, base64 and containers are refused locally.
- [ ] Audio is paced at approximately real time and never more than 5 s ahead.
- [ ] PCM silence is sent during silence so the vendor's idle-input close does not fire.
- [ ] A malformed browser frame is dropped and logged before it reaches the vendor.
- [ ] The audio path never awaits a network round trip.

## Answer

29 done — `send_audio` forwards only raw s16le mono 24 kHz bytes; `str` payloads (JSON audio, base64), non-bytes objects and RIFF/Ogg/FLAC/ID3/Matroska containers raise `AudioFrameRejected` locally, while an empty or odd-length binary frame is dropped, logged and counted in `dropped_frames` without reaching the vendor.
Pacing: a named `MAX_LEAD_S = 5.0` (spec: "never more than 5 s ahead") is checked against the injected clock before every frame; a frame that would cross it is shed and counted, and a later frame fits again once the clock catches up. No sleep is ever awaited on the send path.
Silence: `send_silence(seconds)` and the gap-fill before each caller frame emit 20 ms (`SILENCE_FRAME_MS`, 960-byte) all-zero PCM frames up to the same lead budget, so a quiet tick keeps the vendor's idle-input close away; both are bounded and deterministic under `FakeClock`.
No round trip: a counting socket proves `send_audio`/`send_silence` never advance `__anext__`; only the socket write is awaited.
Red/green: `cascade/test_meta_stt_audio.py` (14 tests) red at import pre-implementation; suite 485 OK at `f718db1f`. Merger: `MAX_LEAD_S`/`SILENCE_FRAME_MS` are spec constants not yet in `thresholds.json` (ticket 04 may register them); `send_silence` is the seam for a caller-owned idle pump.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

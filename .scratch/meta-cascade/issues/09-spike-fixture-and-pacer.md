# 09: Spike fixture and real-time pacer

**What to build:** The recorded input the feasibility spike measures: one 20 s mono 24 kHz 16-bit PCM WAV with a known speech-end position, streamed to the vendor at approximately real time. The pacer is part of the fixture because the vendor rejects a stream that runs ahead.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] The WAV is byte-stable and its speech-end sample position is recorded alongside it.
- [ ] The pacer emits audio at real time and refuses to run more than 5 s ahead of the vendor's processing.
- [ ] A test with the injected clock proves the pacing law without sleeping.
- [ ] The audio is gitignored working data; only its hash and provenance are recorded.

## Answer

- `voice-pipeline/spike/fixture.py`: 20 s mono 24 kHz s16 PCM WAV from stdlib `wave`; speech end 12.4 s = sample 297600 (pinned non-zero so "last non-silent sample" is exact for any `--speech-end`); `--write`/`--verify` CLI.
- Committed `voice-pipeline/spike/fixtures/caller-20s.json`: sha256 `e51d09a8ba52f3f9c322d855e80cb1e43aca66c95648d040a2821adcbd6f9448`, shape, frame/speech-end sample, speech_end_ms, provenance + reproduce command; WAV lives in gitignored `voice-pipeline/.spike/`.
- `verify` fails by field name (`sha256`, `speech_end_sample`, `speech_end_ms`, `version`, shape) and is proved by tamper tests; `test_spike_fixture.py` = 13 tests.
- `voice-pipeline/spike/pacer.py`: injected clock + wait, never sends before media start, returns `Blocked` (no sleep/poll) when media end exceeds `MAX_LEAD_S=5.0`; `test_spike_pacer.py` = 10 tests, zero wall-clock sleeps.
- Evidence: full discovery 115 tests OK 1.25 s; cap-check deleted -> 3 failures, wait deleted -> 4, committed sidecar deleted -> 4. Merger note: `thresholds.py` (ticket 03) is absent here; if it declares a lead cap, pacer should read it instead of its local constant. No keys/network; tickets 10-13 untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# 20: Cheap probes per leg

**What to build:** A probe per leg that spends nothing meaningful: a short speech session, a bounded minimal model completion, and an empty synthesis request.

**Blocked by:** 17 (Breaker transitions on a fake clock)

**Status:** resolved

- [ ] The speech probe opens, handshakes, sends silence, sends end-of-stream and requires a normal close.
- [ ] The model probe is one bounded minimal completion with no tools and a small token cap.
- [ ] The voice probe opens, sends an empty generate, flush and terminate, and requires a flush confirmation with zero duration and a termination.
- [ ] Each probe records its latency and result on the leg record.
- [ ] A test asserts no probe exceeds the named character or token cap.

## Answer

20 done — new `cascade/probes.py` (target protocols + `speech_probe`/`model_probe`/`voice_probe` and the recording wrappers `probe_speech`/`probe_model`/`probe_voice`), `cascade/test_probes.py` (15 tests), and one additive `thresholds.json` bound.
Speech: `open` (the handshake is `open`), one 16-bit PCM silence frame at the backend's declared 24 kHz, `end_stream`, `close` — and close `1000` or the probe fails with the classified code (1011/1013/no-code all trigger). Model: one `ProbeRequest` with `tools=None` (never serialised) and `max_completion_tokens` supplied explicitly; `model_probe_cap()` reads `probe.model_max_completion_tokens`, which ships OPEN, so an unset cap raises `UnsetBoundError` by name instead of inventing a number, and the function has no default. Synthesis: open, empty `Generate` + `Flush` + `Terminate`, then requires `FlushDone audio_duration_ms == 0` followed by `Termination`; a non-zero duration or a missing frame fails.
Cost: the synthesis probe sends 0 characters, checked against the registry's `tts.generate_char_cap` (2,000); the model probe's request carries exactly the named cap and its `ProbeResult` exposes `chars`/`tokens`/`max_tokens`/`char_cap` with `within_cap`; every probe result is written through ticket 17's transitions (success → `ProbeSuccess` with the measured latency, failure → probe failure with its verdict), and a failed breaker write still returns the probe result.
Judgments: probe targets are narrow injected protocols, not the vendor backends, because `StreamingSTT.close()` cannot yet return `endStream`'s close code (ticket 30) and `LLMStream.complete()` has no token cap (ticket 31+); adapters land with those tickets. `probes.py` imports `SAMPLE_RATE` from `meta_stt` rather than restating it.
Evidence: `test_probes` 15 tests; red-first (no `cascade.probes`), then mutations: normal-close check removed → 2 fail, silent-flush check removed → 2, cap +1 → 1. Full suite 511 OK. Branch `cluster/breaker-18-23`, base 83ea36ed, merge → "Already up to date". One follow-up commit on this branch keeps the unset-cap test honest if ticket 04 records a value.
Merger notes: `test_thresholds.py`'s `OPEN_BOUNDS` expectation gained `probe.model_max_completion_tokens: "20"` (a registry change must move its test); ticket 04 must record that value before any scheduler runs the model probe.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

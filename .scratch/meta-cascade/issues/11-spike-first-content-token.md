# 11: Spike: first content token from Spark

**What to build:** The spike measures the gap from the final transcript to the first content delta from the model, excluding reasoning, at the default effort and the lowest supported effort.

**Blocked by:** 09 (Spike fixture and real-time pacer)

**Status:** resolved

- [ ] The term is the gap from speechComplete receipt to the first content delta; a reasoning_content delta does not count.
- [ ] The default effort and the lowest supported effort are both measured and reported.
- [ ] reasoning_effort "none" is reported as unavailable, with the vendor's HTTP 400 recorded.
- [ ] A stream that emits only reasoning until it ends is reported as unmeasured, never as a fast first token.

## Answer

`voice-pipeline/spike/first_token.py` owns M00 term 3: `first_content_token_ms` = injected-clock gap from the `speechComplete` receipt to the first non-empty `content` delta; `reasoning_content` is counted as evidence (`first_reasoning_ms`, `reasoning_only`) and never marks the term, so the reasoning-first trace (reasoning 110 ms, content 810 ms) reports 810.
`reasoning_effort: "none"` is never requested: `Effort`/`build_payload` raise `UnavailableEffortError` from `recorded_none_refusal()` (status 400 recorded; body `None` with `body_captured: false` because no live key; `recorded_none_refusal(body=...)`/`measure_efforts(none_refusal=...)` carry a captured body), and every `FirstContentReport` carries that row in `unavailable`.
`measure_efforts` requires both `default` and `lowest` rows by name (`MissingEffortError`); default omits the field, `lowest_effort(value, source=...)` takes the live-probe value (the unresolved row is unmeasured, never sent, reason "not named"); a reasoning-only / tool-call-only / empty / HTTP-400 / no-transport run yields `first_content_ms=None` plus a producer line, never a time.
Evidence: `voice-pipeline/test_spike_first_token.py` 24 tests, synthetic SSE `TraceTransport` + fake clock, red-proved by mutation (reasoning-as-content 6 fails, producer removed 1, clock removed 4, `none` allowed 1) and the captured-body test failed before `none_refusal`; `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → 274 OK.
Branch `ticket/11-spike-first-content-token` @ `bf770cfd`, base `df21bedb`, `git merge feat/meta-cascade` → "Already up to date"; merger note: no fixture file added (traces are inline), the live run must name the lowest effort value and may capture the 400 body; no other ticket's files touched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

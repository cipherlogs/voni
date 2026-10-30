# 31: Speech close-code policy

**What to build:** Each speech close produces its documented action: normal completion, a non-retryable request bug, a retryable failure with one new session, or rate limiting that backs off and opens the leg.

**Blocked by:** 26 (Meta speech handshake and injected socket seam), 27 (Handshake ack, protocol error and 10 s timeout), 22 (Speech ladder: Meta, AssemblyAI, then fail)

**Status:** resolved

- [ ] 1000 is normal completion.
- [ ] 1008 fails the call, alerts, is not retried and does not open the leg.
- [ ] 1011 retries once with a new session; a max-duration reason is treated as a planned reconnect.
- [ ] 1013 backs off and opens the speech leg.
- [ ] A close with no code is treated as 1011, and each code is pinned by a fixture.

## Answer

31 done — `MetaStreamingSTT.handle_close(code, reason)` classifies through `cascade.failures.classify_stt` (no second table) and acts once; `events()` continues across a retry/planned reconnect and raises `SpeechCallFailure` (visible, `call_ended`, `fallback=None`).
1000 clean (socket left for the deliberate `close()` endStream); 1008 BUG fails + `alerts`/`alert` sink, never retries, never opens; 1011 and a codeless close retry once with a new session (session id epoch bumps), a second one fails and opens; 1011 with a max-duration reason is a planned reconnect (new session, no failure, retry budget untouched); 1013 never retries, sets `backoff`, and opens.
The leg write is the ticket-22 seam: constructor takes `leg_failures: SpeechLegFailures` (`CallRungs.failed("stt", verdict=…, phase="stream")`) and an optional `alert(verdict, reason)`. Tests prove a real `MemoryStore`/`Breaker` record flips to `open` with trigger code 1013, and stays `closed` on 1008.
"Back off" is no immediate retry plus the opened leg (breaker probe interval), not a second hardcoded delay; no backoff number exists in `thresholds.json`, so none was invented.
Evidence: `cascade/test_meta_stt_close_codes.py` 13 tests (red at import, mutations 7F+5E); full suite 797 OK at `959c8306`. Branch `cluster/stt-31-33`, base `03ad6476`. Merger: handshake closes stay ticket-27 `.verdict` (connect flow owns any pre-first-frame retry); `events()` treats only socket exceptions as closes — a vendor `error` event still raises `MetaStreamError`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

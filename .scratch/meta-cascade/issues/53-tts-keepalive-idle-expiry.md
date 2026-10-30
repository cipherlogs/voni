# 53: Keepalive, idle timeout and session expiry

**What to build:** A long caller pause does not silently close the voice leg; the session is kept alive at a named interval, and expiry is planned between turns rather than discovered mid-sentence.

**Blocked by:** 47 (Synthesis connect per transport), 03 (Threshold registry with a source requirement), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] A keepalive at the named interval keeps the session open through a pause longer than the idle timeout.
- [ ] A missed keepalive is a voice failure, not a silent gap.
- [ ] At expiry the adapter drains the current reply and opens a new session between turns, never mid-sentence.
- [ ] The keepalive counts against the control-frame budget; a test asserts the interval is below the idle timeout and inside the budget.

## Answer

# 53 — TTS keepalive and idle expiry

- `keepalive_if_idle()` is the idle seam: one `KeepAlive` per `tts.keepalive_interval_ms` (30 s, `require_bound`, no literal) only while the session is silent and no reply is in flight; the same frame is counted in `control_frame_times`/`control_frames_sent`, and a tick whose frame would be the (limit+1)th in the window is `SHED`, never sent blindly.
- An idle past `tts.idle_timeout_ms` (120 s) is routed through the close policy as 1006: the one failure reconnect, then a visible `SynthesisCallFailure` that opens the leg — a missed keepalive is a failure, not a silent gap. `Begin.expires_at` is armed once against an injected `wall_clock` and handed over as `SESSION_LIMIT` (planned): at a tick/next turn, or between sentences mid-reply, so a sentence is never cut in half.
- Evidence: `voice-pipeline/cascade/test_tts_keepalive.py` (15 tests: interval-from-registry + inside-budget, 600 s pause survives, budget spend/shed, busy guard, miss/2nd-miss, expiry between turns and mid-reply, stale `expires_at`). Red proofs: deleting send/busy/shed/miss/expiry each fails 1–4 tests.
- Full suite: `cd voice-pipeline && python -m unittest discover -s . -p 'test_*.py'` → **1705 tests, OK (1 skipped)**.
- Merger note: `expires_at` is epoch seconds, so the adapter gained an additive `wall_clock` kwarg (default `time.time`) and compares it once at `Begin`; a stale/past `expires_at` is deliberately not a scheduled deadline (the wire 3008/close reports it) — this is what keeps the recorded fixtures (expires_at 2026-09-17) valid.

_Implemented on `feat/meta-cascade`._

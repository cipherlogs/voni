# 55: Voice close policy: trigger, bug, expiry

**What to build:** A voice failure is visible, never papered over. Retryable closes retry once then fail and open the leg; configuration and pacing errors fail and alert without opening it; expiry is planned; there is no second voice vendor.

**Blocked by:** 47 (Synthesis connect per transport), 16 (Failure classification: trigger, bug or planned reconnect)

**Status:** resolved

- [ ] A trigger close is retried once where specified, then fails the call visibly and opens the voice leg.
- [ ] Configuration and pacing closes fail the call and alert without opening the leg, because they are our bug.
- [ ] Session expiry is a planned reconnect, never a trigger.
- [ ] Voice has no fallback: a failure ends the call visibly and no managed handover happens.
- [ ] A voice failure at greeting time produces a browser-visible error, never a silent opening.

## Answer

55 done — `handle_close(code)` classifies through the existing `cascade.failures.classify_tts` (no second table) and returns a `CloseDecision` or raises `SynthesisCallFailure` (`visible=True`, `call_ended=True`, `fallback=None`).
Trigger (`1011`, `1006`, `3005`, no code): retried once with a fresh socket whose `Begin` is echoed again (`reconnects`, `factory` connection count asserted), and only before any audio was delivered; a second trigger or a mid-reply close fails visibly, records the verdict and appends to `breaker_opens` (the voice leg).
Bug (`3006`, `3010`, `3011`, `1009`): fails the call, appends to `alerts` (and calls the injected `alert` sink), never opens the breaker and never reconnects. `3008`/`SESSION_LIMIT` are `PLANNED_RECONNECT` with `needs_reconnect` and no failure; `1000` is clean; any unlisted code fails closed (no breaker) rather than reading as clean.
No fallback anywhere: nothing returns a managed handover, and a greeting-stage `Error` frame raises with `stage="greeting"` and `visible=True`, so the browser never gets a silent opening.
Tests: 15 new in `cascade/test_tts_close_policy.py`; red first, and disabling retry/planned branches fails 6. Full suite 516 OK.
Files: `voice-pipeline/cascade/{assemblyai_tts.py,test_tts_close_policy.py}`; commit `362f38dc`, branch `cluster/tts-48-55`, base `83ea36ed`, `git merge feat/meta-cascade` → "Already up to date".
Merger notes: `ControlFramePacingError` is now a `SynthesisCallFailure` (3010) and records/alert through the same path; `handle_close` closes the socket on every terminal outcome.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

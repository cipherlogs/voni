# 42: Model failure policy by phase

**What to build:** A request bug is not an outage. A 400 fails the turn and alerts without opening the leg; a retryable failure retries once before the first token and never restarts a reply already being spoken.

**Blocked by:** 36 (Chat Completions request contract), 23 (Model ladder: Spark, gateway, then fail)

**Status:** resolved

- [ ] HTTP 400 fails the turn, alerts, and does not open the model leg.
- [ ] 429, 5xx and a timeout before the first content token retry once; after the retry they open the leg.
- [ ] A failure mid-reply never restarts the completion; the call drains the queue and closes at the last complete sentence.
- [ ] A second failure on the leg ends the call.
- [ ] The retry decision is recorded with its phase: connect, turn or reply.

## Answer

Ticket 42 done: `MetaLLM.complete()` classifies each attempt through `failures.classify("llm", ...)` and records a `FailureDecision(attempt, phase, verdict, retry, opened_leg, reason)` on `turn.failure_decisions` (`last_failure` convenience), with phase from delivery evidence: `connect` before any frame, `turn` after frames but before caller-visible output, `reply` after content or a tool handoff.
HTTP 400 (BUG) fails the turn as `MetaLLMTurnFailed`, alerts via `on_alert`, posts none again and leaves the leg closed; 429/5xx/timeout retry exactly once before caller-visible output, and the second failure opens the leg via the injected `CallRungs.failed("llm", ...)` and raises `MetaLLMLegExhausted`.
A reply already delivered is never re-requested (no second POST, text yielded once): it raises `MetaLLMReplyInterrupted` with `disposition.speak=True, retry_allowed=False` for the caller to drain, and the leg opens because the retry policy offers nothing mid-reply; a later second failure on the leg ends the call even mid-reply.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_failures` = 12 OK; full discover = 826 OK (red-first: policy types absent; mutations removing the mid-reply guard fail 3, allowing unlimited retries fails 1).
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_failures.py`; branch `cluster/llm-40-45`, base 03ad6476.
Merger notes: construct `MetaLLM(rungs=<the call's CallRungs>, on_alert=...)` in the model factory; M06 must catch `MetaLLMReplyInterrupted` and drain the sentence queue to the last complete sentence (the drain is downstream, not implemented here). The one-retry budget counts trigger failures per `MetaLLM` instance (one leg for one call), not per turn; unclassified failures (401/reset) are recorded, alerted and re-raised unchanged. No reconnect work (94-99).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

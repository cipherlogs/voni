# 37: Content deltas are the only speech

**What to build:** The model always reasons. Only content is speech, only the first content delta marks the first token, and reasoning is recorded without ever reaching synthesis.

**Blocked by:** 36 (Chat Completions request contract)

**Status:** resolved

- [ ] Content deltas are yielded as the only text, and the first one marks the first token.
- [ ] Reasoning deltas are recorded for usage and telemetry and never sent to synthesis.
- [ ] A reasoning-only stream does not mark the first token.
- [ ] A test that treats reasoning as content fails on a fixture that reasons before it speaks.

## Answer

Ticket 37 done: `MetaLLM.complete()` now parses the SSE stream (incremental UTF-8, so a multi-byte character split across chunks stays whole) and yields content deltas as `TokenDelta` in order; `reasoning_content`/`reasoning` is folded into `MetaLLMTurn.reasoning_text` + `reasoning_deltas` for usage/telemetry and is never yielded, so it cannot reach TTS.
First content delta marks `first_token` on an optional injected `TimingLedger` (first-write-wins, so the orchestrator may also mark it); a reasoning-only stream yields nothing and marks no first token, and a reasoning-first fixture whose spoken text is asserted contains no reasoning.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_content` = 7 OK; full discover = 494 OK (red-first: `MetaLLMTurn` absent; mutation "treat reasoning as content" fails 3 tests).
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_content.py`. Branch `cluster/llm-37-44`, base 83ea36ed, merge of `feat/meta-cascade` = already up to date.
Merger notes: hidden `reasoning` spelling also accepted; per-turn record is passed via `complete(turn=...)` or read as `last_turn`; ticket 45 owns the recorded fixtures, not written here.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

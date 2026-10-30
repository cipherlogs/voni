# 43: Finish reasons and empty replies

**What to build:** Each finish reason produces its documented speech: normal, truncated, filtered, tool handoff, and an empty reply that closes the turn silently.

**Blocked by:** 36 (Chat Completions request contract)

**Status:** resolved

- [ ] Stop closes normally.
- [ ] Length and content filter speak what was generated, mark the reply truncated or filtered, and do not retry.
- [ ] Tool calls hand off to the tool loop; function call is treated as tool calls.
- [ ] Stop with empty content speaks nothing, closes the turn and records it.

## Answer

Ticket 43 done: `MetaLLMTurn.disposition` (frozen `ReplyDisposition`, computed once in `close()`) turns the vendor string into documented speech: `stop` → NORMAL; `length` → TRUNCATED and `content_filter` → FILTERED, both speaking exactly what arrived with `retry_allowed=False`; `tool_calls` and legacy `function_call` → TOOL_HANDOFF with `speak=False` and `hold_line=True` (content stays for history, never audio).
`stop` with no speakable content (empty, whitespace-only, or reasoning-only) is EMPTY: no audio, turn closed and recorded; `turn.truncated`/`turn.filtered` are the convenience marks.
A missing or unknown finish reason is INCOMPLETE rather than a guessed normal stop, with `retry_allowed` true only before the first content token — the seam ticket 42 reads.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_finish` = 11 OK; full discover = 494 OK (red-first: `ReplyOutcome` absent; mutation disabling the `length` branch fails 1 test).
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_finish.py`. Branch `cluster/llm-37-44`, base 83ea36ed.
Merger notes: M08/M09 must speak the localized hold line when `disposition.hold_line` is set; ticket 42 should use `disposition.retry_allowed` rather than re-deriving "before the first token".

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

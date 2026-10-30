# 39: Tool-call deltas accumulate by index

**What to build:** Tool calls arrive split across chunks. Each index accumulates into exactly one request, with the id, name and arguments joined before anything is executed.

**Blocked by:** 36 (Chat Completions request contract)

**Status:** resolved

- [ ] A split id, a split name and split arguments accumulate by index into one request.
- [ ] Exactly one request is emitted per index when the finish reason is tool calls or the stream ends.
- [ ] A call id outside 1 to 64 characters is a provider contract violation that fails the turn.
- [ ] A missing or empty call id produces a request that is not executed; the turn closes with a hold line and the denial is recorded.
- [ ] Two indices produce two requests in index order.

## Answer

Ticket 39 done: tool-call deltas accumulate into one slot per `index`; split `id`, split `name` and split `arguments` are joined in stream order (legacy `function_call` deltas fold into index 0), and `MetaLLMTurn.tool_calls` is the index-ordered raw view.
Exactly one `ToolCallRequest` per index is emitted when `finish_reason` is `tool_calls`/`function_call` and again at stream end, guarded by an emitted-index set, so a split call can never execute twice; two indices emit two requests in index order.
`call_id` > 64 chars raises `ToolCallIdentityError` and fails the turn; a missing/empty id is emitted with `call_id=""` (not executable), records `denied_tool_calls`, sets `hold_line_required` and counts `tool_denied` on the ledger.
Arguments are parsed only for object-ness: malformed, non-object or absent text is withheld into `rejected_tool_calls` and never emitted as `{}` — ticket 40's tool-failure seam.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_tool_calls` = 10 OK; full discover = 494 OK (red-first: `CALL_ID_MAX_LENGTH` absent; mutation removing the emitted-index guard fails the suite).
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_tool_calls.py`. Branch `cluster/llm-37-44`, base 83ea36ed.
Merger notes: ticket 40 should replace the withhold path with a tool-failure result and add schema checks; `MetaToolCall.arguments` keeps the raw text for that. Denied calls still surface as `ToolCallRequest(call_id="")` by design.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

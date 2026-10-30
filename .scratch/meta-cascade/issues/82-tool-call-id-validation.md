# 82: Tool calls need a real call id

**What to build:** A tool is executed only with a real call id of 1 to 64 characters. A missing or empty id is not executed; an overlength id fails the turn as a provider contract violation.

**Blocked by:** 81 (Tools execute over the existing HTTP route), 40 (Arguments are validated before execution)

**Status:** resolved

- [ ] A missing or empty call id is not executed; the turn closes with a hold line and the denial is recorded.
- [ ] A call id longer than 64 characters fails the turn as a contract violation.
- [ ] The executed request carries the exact call id so the route can dedupe.
- [ ] A test that executes without an id fails.

## Answer

# 82 — Tool calls need a real call id

1. `tools.require_call_id` is the one rule shared by `ToolRequest` and `ToolExecutor.start`: an id of 1–64 characters, reusing `meta_llm.CALL_ID_MAX_LENGTH` (no second copy of the vendor number).
2. Missing or blank id: `start()` returns a `DeniedCall` outcome with a `missing_call_id` `ToolDenial` and sends nothing; `continue_after_tool` records it once (identity `(name, call_id, code)`, so the LLM layer's own denial is not double-counted), sets `hold_line_required`, and makes no continuation request — a `tool` message cannot answer an unidentified call.
3. Overlength id: `ToolCallIdOverlong` (a `meta_llm.ToolCallIdentityError`) is raised before any request, so the turn fails as a provider contract violation rather than being denied.
4. The executed request still carries the exact id in `toolCallId`, at the 64-character limit as well, so the route can dedupe.
5. `end_call` stays call control (no identity requirement, no HTTP); failure mapping (84), ordering (86) and caps (87) are untouched.

Evidence: `voice-pipeline/cascade/tools.py` (`require_call_id`, `DeniedCall`, `ToolExecutor.start`, `_record_denial`), `cascade/test_tools_call_id.py` (8 tests). Red proof: without the guard, 6 failures + 3 errors, including a POST sent with no identity. Full suite from `voice-pipeline/`: `Ran 1329 tests ... OK (skipped=1)`. Branch `cluster/tools-82-85`, commit `4b27da82`, base `098fdf9d`. Merger note: the hold line itself is spoken by 85; M06 must pass `ledger=` to `continue_after_tool` to count a denial that the LLM layer did not already record.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# 40: Arguments are validated before execution

**What to build:** The arguments string is parsed and validated. A malformed or non-object result is a tool failure the model can correct, never a silent execution with empty arguments.

**Blocked by:** 39 (Tool-call deltas accumulate by index)

**Status:** resolved

- [ ] A malformed arguments string is a tool failure, never an execution with an empty object.
- [ ] A valid JSON value that is not an object is a tool failure.
- [ ] Arguments outside the tool's schema are validated before invocation and refused as a tool failure.
- [ ] The failure is returned as a tool result so the model can correct on the next request.

## Answer

Ticket 40 done: arguments are parsed as JSON, then validated against the tool's declared `parameters` schema from the same `tools` list sent on the wire; a malformed, absent, non-object or schema-violating payload is withheld as a `ToolDenial(code=...)` and never emitted as a request or executed with `{}`.
A correctable denial carries the call id and `as_tool_message()` returns the exact `{"role":"tool","tool_call_id":...,"content":{"error","message"}}` result the model corrects on its next request; a denial without a call id stays non-answerable (hold line, `tool_denied` count), so ticket 39's call-id rules hold.
The validator enforces a documented JSON Schema subset (type, required, properties, additionalProperties, enum/const, anyOf/allOf/oneOf/not, length/min/max bounds, items); an unsupported keyword (e.g. `$ref`) raises `ToolSchemaError` and fails the turn by name rather than running unvalidated.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_arguments` = 16 OK; full discover = 826 OK (red-first: `ToolSchemaError`/`tool_failures` absent; mutation deleting the validation call fails 6 tests).
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_arguments.py`; branch `cluster/llm-40-45`, base 03ad6476.
Merger notes: `turn.rejected_tool_calls` now holds `ToolDenial(code, call_id)` and `turn.tool_failures` is the correctable subset; M08 must append `as_tool_message()` for every failure and must not execute a call whose denial has no id. No message-assembly work (ticket 41) was done.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

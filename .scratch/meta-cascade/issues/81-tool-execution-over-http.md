# 81: Tools execute over the existing HTTP route

**What to build:** A tool call is executed by the app's existing tool route, not reimplemented in the pipeline. The call carries its context and secret, the result returns to the model as a tool message, and the same turn continues.

**Blocked by:** 75 (Call lifecycle and the end message), 64 (Signed body envelope and hash verification), 41 (Message assembly and tool-turn replay)

**Status:** resolved

- [ ] A tool call is executed over the existing HTTP route with the call context and the tool secret.
- [ ] The result returns as a tool message with the matching call id.
- [ ] The same logical turn continues with a new model request.
- [ ] The tool hop is off the audio path; the reply stream does not await it inline.
- [ ] A fake route asserts exactly one request and the continued reply.

## Answer

# 81 — Tools execute over the existing HTTP route

1. `cascade/tools.py` posts one `POST {app}/api/tools/{name}` per model call: bearer `VONI_TOOL_SECRET`, `{toolCallId, arguments, context:{kind:"call", callId}}`; the call id comes only from `tool_executor.from_verified(VerifiedBody)` (ticket 64 seam), never from the model or browser.
2. The hop's bound is `require_bound("tool.timeout_ms")` (still OPEN — ticket 76); an unset bound raises `UnsetBoundError` by name and sends nothing, an injected bound reaches the session as `timeout_s` and `asyncio.wait_for`.
3. The route's JSON (including its own `{"ok": false, "error": …}`) becomes the `role: "tool"` message via `meta_llm.tool_result_message` with the matching call id; `continue_after_tool` appends the assistant `tool_calls` message + result and issues the same logical turn's next model request. Transport failures are named (`ToolRouteError`/`ToolTimeout`) for ticket 84 to convert.
4. `start()` returns a `ToolHop` (task) so the audio path never awaits the hop inline; `end_call` is an `EndCallSignal` — zero requests, zero events, history untouched (87 owns the closing line). Multi-call turns refuse by name for ticket 86; no memo (83), id validation (82), hold line (85), ordering (86) or cap (87).

Evidence: `voice-pipeline/cascade/tools.py`, `voice-pipeline/cascade/test_tools.py` (16 tests; 1 skip = registry bound still open). Full suite from `voice-pipeline/`: `Ran 1100 tests ... OK (skipped=1)`. Branch `cluster/tools-81`, commit `273780ef`, base `cce8b788` (= current `feat/meta-cascade`, no merge needed). Merger note: 76 must fill `tool.timeout_ms`; 84 should catch `ToolHopError` from `ToolHop.outcome()`; `ENV VONI_TOOL_SECRET` and the app `base_url` must be wired by the deployment ticket.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

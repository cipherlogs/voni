# 41: Message assembly and tool-turn replay

**What to build:** The body's system prompt is sent unchanged; hidden context is appended for the next turn; a tool turn replays the assistant message that requested the tools before the results, because omitting it is a vendor error.

**Blocked by:** 36 (Chat Completions request contract), 40 (Arguments are validated before execution)

**Status:** resolved

- [ ] The body's system prompt is sent unchanged as the system message.
- [ ] Hidden context is appended as a system message for the next turn and is never captioned or spoken.
- [ ] A tool turn replays the full assistant message with its tool calls before the tool messages; omitting it reproduces the vendor's 400 as a test.
- [ ] History contains what the caller heard plus the tool messages; an unspoken tail is absent.

## Answer

Ticket 41 done: `meta_llm.py` now owns message assembly, not just the request wrapper. `build_messages` stays the single wire-array builder (prompt first, unchanged; history in order; hidden context appended as plain system messages).
`MessageHistory` is the per-call recorder: `append_user`, `append_reply(turn, spoken_text=...)` records only the prefix the caller heard (an unspoken tail, and a fully unspoken reply, never enter history; a spoken prefix the model did not generate is refused by name), `append_tool_turn(turn, results)` appends `tool_call_message(turn)` (full assistant message: content verbatim, one `tool_calls` entry per accumulated call, arguments as streamed) *before* the `tool` results, and `add_hidden_context` holds context for exactly one `request_messages()` (uncaptioned, never in the recorded conversation).
Narration-held tool turns keep their content in the assistant message even though the caller heard the hold line; `assistant_reply_message` refuses a tool turn so `tool_calls` cannot be dropped by accident. A tool result for an undeclared/absent call id is refused (`MessageAssemblyError`).
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_messages` = 17 OK; full discover = 929 OK. Red-first per slice (import errors, then missing `add_hidden_context`, then the plain-reply guard). The vendor 400 is a strict local stand-in that enforces the documented message rule: dropping the assistant message gets HTTP 400 and `MetaLLMTurnFailed`; the assembled turn gets 200 and continues.
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_messages.py`. Branch `cluster/llm-41`, base 8ff36c2a (integration tip, 0 commits ahead; no merge needed).
Merger notes: M06 should own one `MessageHistory` per call and pass `spoken_text` = the text actually played at the cut point (the turn record does not know the playout position); when `MetaLLM` owns the body prompt, build the history without `system_prompt` (tests pin both, and `MetaLLM.complete` still accepts `hidden_context=` directly). No orchestrator/transport wiring, no 42/45 work, no reconnect.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

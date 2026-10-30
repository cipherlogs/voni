# 36: Chat Completions request contract

**What to build:** The request is the one the spec pins: bearer auth, the full history, a streamed completion with usage, and automatic tool choice when tools exist. Unsupported parameters are never sent.

**Blocked by:** 01 (Shared determinism kit)

**Status:** resolved

- [ ] The request posts to chat completions with bearer auth, the full message history, streaming and usage included.
- [ ] Tool choice is automatic whenever tools are supplied, and parallel tool calls are left at the vendor default.
- [ ] Store, stop, frequency and presence penalties, multiple completions, logprobs and unsupported modalities are never present; a test asserts their absence.
- [ ] The reasoning effort comes from configuration set by the spike's measurement; an absent value refuses at startup.

## Answer

Ticket 36 done: `cascade/meta_llm.py` builds and posts the pinned Chat Completions request (POST https://api.meta.ai/v1/chat/completions, Bearer META_API_KEY, resolved Standard model, full history, stream:true, stream_options.include_usage:true, reasoning_effort verbatim, tools + tool_choice:"auto" only when tools exist, parallel_tool_calls left unset); store/stop/penalties/n/logprobs/temperature/modalities/user/safety_identifier are absent by exact-payload test.
Message assembly: stored system_prompt first and unchanged, history replayed in order (assistant tool_calls before tool messages), hidden_context appended uncaptioned as system message(s) for that call only; reasoning_effort has no default (absent refused at construction, "none" refused as a Spark 400), resolve_model() is the first constructor statement before the effort/key/session fields.
Tests: `cd voice-pipeline && /home/cipherlogs/Repos/AI/leadcalls/telephony-bot/.venv/bin/python -m unittest cascade.test_meta_llm_request` = 19 OK; full discover = 269 OK (red-first proven for module absence, missing-key refusal, and builder effort validation; mutation check dropped tool_choice/stream_options and went red).
Merger notes: `_stream_events()` is the empty seam for 37-39 (complete() patches the request today); `prefetch()` is a no-op handle for 72; ticket 41 should extend `build_messages()` (unspoken-tail + omitted-assistant 400), and M03 must supply the measured reasoning_effort.
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_request.py` (only); branch `ticket/36-meta-llm-request-contract` at 6c83637e on base df21bedb, merged feat/meta-cascade already up to date.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# AssemblyAI Voice Agents API notes

Facts this repo learned from the live API. The public docs are authoritative;
this file records the shapes that are easy to get wrong. Code: `voni/src/lib/demo/stored-agents.ts`,
`voni/src/lib/agents/provision.ts`, `voni/src/lib/voice/session.ts`.

## Agents

- Base: `https://agents.assemblyai.com/v1`. Auth: `Authorization: Bearer <ASSEMBLYAI_API_KEY>`.
- `GET /agents` lists; `GET /agents/<id>` returns the body; `POST /agents` creates (201);
  `PUT /agents/<id>` updates (200); `DELETE /agents/<id>` returns 204 (a later GET is 404).
- The stored body owns the prompt, greeting, voice, tools, and input tuning.
  A browser token binds the call with `{ session: { agent_id } }`; inline sessions
  send their own `system_prompt`/tools. The landing demo uses stored agents.

## `llm` override

```json
"llm": [{ "base_url": "https://…/v1", "model": "…", "api_key": "…", "reasoning_effort": "none" }]
```

- It is a **bring-your-own OpenAI-compatible endpoint**, not a managed-model
  picker. There is no `provider` field; sending one is silently dropped.
- `maxItems: 1` (two entries -> 422). `llm: []` is the documented revert to the
  managed model. PUT with the key absent keeps a previously stored override, so
  always send `llm: []` to clear it.
- `api_key` is write-only: it is never returned by GET and must never reach the
  browser. `base_url` must be https. Model access is entitlement-dependent; a
  wrong model can return 200 on write and fail on the first call.
- Demo default: Vercel AI Gateway (`https://ai-gateway.vercel.sh/v1`) with
  `google/gemini-2.5-flash` and `reasoning_effort: "none"`, read from
  `AI_GATEWAY_API_KEY` / optional `DEMO_LLM_*`. It is hashed into the agent
  fingerprint so a change refreshes the cached agent.

## Input tuning

- `input.turn_detection: null` means adaptive/meaning-based end-of-turn. **Any
  object switches it off** and makes replies slower (ADR-0003); the managed path
  must keep null. Demo and tenant agents are both built by `buildStoredAgent`,
  so no managed body can carry an object — the tenant's pre-64 object is gone
  (voice-parity 65).
- `input.transcription_mode`: `min_latency` | `balanced` | `max_accuracy`. Balanced
  is the voice-agent default; entity-aware endpointing still holds tags/addresses.
- `input.voice_focus: "near-field"` for browser mics; `language_codes` locks the
  language; `keyterms` / `transcription_prompt` steer recognition.

## Tools

- Stored tools use the REST shape (no `type` field). `end_call` is built-in and
  uses `execution_mode: "hold"`; its result is a pure signal with
  `response_instructions` forbidding speech after the goodbye.
- A bound agent's `tool.call` **must** be answered. An unknown tool stalls the
  turn for its timeout (observed 30s), so the eval routes every demo tool through
  the local executor; a new tool needs an answer path before it can ship.
- `show_test_address` is answered by `/api/demo/tools`; the result carries the
  exact invite and tag. The model must not say the tag before that result.

## Sessions and evidence

- Raw calls: `wss://agents.assemblyai.com/v1/ws?token=…`. The eval mints a token
  and connects either inline or with an `agent_id`.
- Call Trace fields used by the scoreboard: `user_speech_started_at_ms`,
  `user_speech_ended_at_ms` (can be null), `agent_reply_started_at_ms`,
  `time_to_first_audio_ms`, `trigger`, `interrupted_at_ms`, `tool_calls`.
- `user_speech_ended_at_ms` is the server's turn boundary, not necessarily the
  caller's last word; do not compare it to the audio clip end without checking
  both. Reply-gap budgets are measured from the server's turn boundary.

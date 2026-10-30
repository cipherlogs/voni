# 65: The browser sends a token, not a prompt

**What to build:** The browser stops assembling the body. It sends only a call token, the agent id and the protocol version; the service receives the prompt and tools from the app, never from the client.

**Blocked by:** 64 (Signed body envelope and hash verification)

**Status:** resolved

- [ ] The browser's config message carries only the call token, agent id and protocol version.
- [ ] A message carrying a system prompt, tools or a pipeline object is refused by name.
- [ ] The service never accepts a client-assembled prompt or tool list after this ticket.
- [ ] The app and service change together; an old client against a new service fails loudly rather than silently running a different body.
- [ ] A test asserts the browser payload has no prompt or tools keys.

## Answer

# 65 — The browser sends a token, not a prompt

The browser config frame is now identity only: `{type, protocolVersion, agentId, callToken}`.
`cascade/token.py` parses it with a closed field set and refuses in this order: unknown/missing
protocol version, then `pipeline`/`system_prompt`/`systemPrompt`/`tools` by name, then unknown keys.
`transport.handle_browser_call` claims the app's signed body from `StoredBodyChannel` by token, verifies
it (ticket 64), reads prompt/tools via `adapt_body`, and builds `PipelineConfig` from host env + body only.
`POST /v1/call-body` is the app→service handoff; `/healthz` and the end message report `protocolVersion`.

Old client / new service: the pre-65 frame (pipeline + system_prompt + tools, no version) gets exactly one
`{"type":"error"}` naming the protocol version and opens no backend (`test_an_old_client_is_refused_on_the_protocol_version`);
with a valid version the same body keys are refused by name and still open no backend.

Evidence: `voice-pipeline/cascade/token.py` + `cascade/test_token.py` (16), `voice-pipeline/test_transport.py` (14),
`voice-pipeline/test_server.py` (10), `voni/src/lib/voice/cascade-session.ts` + `.test.ts` (11).
Python: 942 OK (`discover -s . -p 'test_*.py'`; 912 at base). TS: full `npm test` 2089 tests, 2088 pass / 1 skipped;
`npm run typecheck` OK; eslint clean on touched files.

Branch `cluster/token-65`, commit `091bf367`, base `8ff36c2a` (feat/meta-cascade tip; merge says up to date).

Merger notes: (1) M17 says the call token travels in the WS query string, while ticket 65 puts it in the config
frame — the `parse_browser_config` seam is where M17 would take it from the connect URL. (2) `StoredBodyChannel`
is in-process by design for M1; M17's durable/token-verified store replaces it behind `deliver`/`claim`, and the
`/v1/call-body` route needs the app-channel auth M17 owns. (3) No cascade token mint exists in the app yet;
`voice-call.tsx` passes the token it has (usually empty) and the service refuses by name. (4) `scripts/smoke_call.py`
still sends the pre-65 frame and now gets the named protocol-version refusal; not updated (outside ticket scope).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

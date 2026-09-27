# Tool results go back at once; end_call's waits for the goodbye to finish

AssemblyAI's client-tools page says to hold an interactive tool's result until `reply.done`. Measured live on the Voice Agent API (2026-09-27, `npm run eval:demo-agent`), the platform instead holds the calling reply open until the result arrives. Holding it deadlocks until the tool times out: in the owner's first real demo call (`sess_c477d8f8`) the invite stalled 5s, then the model invented an inbox address. So `ToolCoordinator` sends every result the moment it is ready, as the docs' own "non-obvious things" list advises. The one exception, measured the other way round: an `end_call` result sent while the goodbye is still being generated makes the platform cut the goodbye's audio (~0.7s of a ~6s line) and speak it again in a new reply, which the session drops, so the caller heard only "No problem." `end_call`'s result therefore waits for its reply's `reply.done` (`holdUntilReplyDone`).

## Consequences

- A held `end_call` result is still sent when its goodbye is interrupted: the platform waits for it either way. The session only hangs up while the hang-up is still armed. A caller who cut in has taken the floor back. A goodbye cut by pure noise is resumed and re-armed.
- If the platform holds the goodbye open waiting for the result (measured ~1 in 10: a 12.6s hang-up), 3s without goodbye audio releases it (`HELD_RESULT_RELEASE_MS`).
- Still-running results of an interrupted reply are dropped, as before.
- The platform's own reply to a tool result is not reliable enough to carry exact data. It skipped, garbled ("demo 102") or repeated the demo's Test tag in ~1 in 3 runs. The demo replaces that reply with its own (`VoiceSession.replaceNextReply`). The platform ignores the replacement ~3 in 10 times, and it is then resent once the replaced reply ends.
- Evals: `bye-audio` (goodbye plays whole), `invite-tag`, plus `EVAL_HOLD_INTERACTIVE=1` and `EVAL_END_CALL=now`, which replay the old behaviours.

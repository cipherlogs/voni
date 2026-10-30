# 85: Narration on a tool turn is replaced by a hold line

**What to build:** When the model narrates before calling a tool, the caller hears a localized hold line instead of the model thinking out loud, while history keeps exactly what the model said.

**Blocked by:** 81 (Tools execute over the existing HTTP route), 49 (Sentence scheduling: first sentence flushes immediately)

**Status:** resolved

- [ ] Content emitted on a turn ending in tool calls is discarded from audio.
- [ ] A localized hold line is spoken instead.
- [ ] The assistant message, including its content and tool calls, is appended to history verbatim.
- [ ] A test that speaks the raw content fails; a test that drops the assistant message fails the next request.

## Answer

# 85 — Narration on a tool turn is replaced by a hold line

1. `ToolNarrationHold.speak(turn=…, hop=…)` only acts on a tool handoff (`hold_line_required` or `reply_disposition(...).hold_line`); a normal turn is untouched, so its reply is spoken as generated.
2. Narration is discarded from audio: any `turn.content_text` that might already be synthesizing is cut with the voice's `Cancel` (ticket 52's path) before anything else is spoken; the model's words never reach the sink.
3. The localized hold line comes from `HOLD_LINES`, one line per `voice_binding.LOCALES` code (en/es/fr/de/it/pt, parity pinned by a test); the line is spoken through the same TTS session and forwarded to the injected audio sink, so the wait is not dead air.
4. The hold is cancellable: `cancel()` stops the line (and cancels the voice); a barge-in keeps the floor and the tool result still lands in history. A hop that already answered (`hop.done`) skips the line entirely — a fast tool speaks nothing.
5. `continue_after_tool` still appends the assistant message with its content and `tool_calls` verbatim, so the next request shows the model what it actually said; the hold only changes audio. The orchestrator's barge-in trigger (M06) and the cap (87) are out of scope.

Evidence: `voice-pipeline/cascade/tools.py` (`HOLD_LINES`, `hold_line`, `HoldOutcome`, `ToolNarrationHold`), `cascade/test_tools_narration.py` (11 tests: dialogue, per-locale, cancel, fast-tool skip, history verbatim). Red proof: speaking `turn.content_text` instead of the hold fails 10 tests; dropping the assistant message fails the history test. Full suite from `voice-pipeline/`: `Ran 1329 tests ... OK (skipped=1)`. Branch `cluster/tools-82-85`, commit `400d0aef`, base `098fdf9d`. Merger note: M06 must call `speak()` at the tool handoff (before awaiting the hop), pass the `ToolHop` so a settled tool skips the line, and call `cancel()` on `speechStart`/a taking-the-floor partial.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

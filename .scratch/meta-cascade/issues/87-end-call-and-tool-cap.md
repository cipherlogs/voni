# 87: end_call, unknown tools and the loop cap

**What to build:** Ending a call is call control, not a tool. It speaks the closing line through the same voice, disarms on a barge-in, denies an unknown tool, and closes an over-long tool loop with a localized line.

**Blocked by:** 81 (Tools execute over the existing HTTP route), 41 (Message assembly and tool-turn replay), 03 (Threshold registry with a source requirement), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] End call is call control, never an HTTP tool.
- [ ] It speaks the closing line through the same synthesis path, then ends the turn and the call.
- [ ] A barge-in during the goodbye disarms the hangup and the caller wins.
- [ ] An end call without a closing line is denied and recorded.
- [ ] The tool loop cap speaks a localized fallback line, ends the turn and records the cap.

## Answer

87 done — `cascade/tools.py`: `end_call` stays call control (zero HTTP, zero
`role: tool`), must carry a non-empty `closing_line` or it returns `DeniedCall`
code `missing_closing_line`, is recorded on the turn (`denied_tool_calls`,
`tool_denied`, hold line) and stops the rest of the batch. `EndCallSignal` carries
the line; `CallClosing.speak` speaks it through the call's own `voice.speak`, ends
the turn with reason `end_call`, counts `end_call`, then arms a one-shot
`take_hangup()`; `barge_in()` (cut cause `goodbye` when a `BargeInCutPath` is
wired) disarms it, stops stale frames and leaves the turn open for the caller.
`ToolLoop` reads `tool.loop_cap` (3) from the registry at construction (unset →
`UnsetBoundError` by name) and `continue_after_tool(loop=...)` refuses the round
past the cap, yields the Locale's `LOOP_CAP_LINES` fallback, runs `on_cap` to end
the turn and records `LoopCapOutcome`; an `end_call` at the cap still ends the call.
Evidence: `cascade/test_end_call.py` (12), `cascade/test_tool_cap.py` (8).
Commit `a200c405`; branch `cluster/turn-69-87`; base `bd9180dc`; full suite
Ran 1722, OK (skipped=1). Merge: `test_tools.py`/`test_tools_order.py` `end_call`
cases now pass a `closing_line` (ticket 87 supersedes "no args still ends"); the
orchestrator must own `take_hangup()`/drain and pass `turns` to `CallClosing.speak`.

_Implemented on `feat/meta-cascade`._

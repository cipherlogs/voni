# 84: Tool failures become results, not crashes

**What to build:** A timeout, an error response or an unreadable body becomes a tool result that says it failed and why. The call continues, and a timed-out side effect is recorded as indeterminate rather than retried behind the caller's back.

**Blocked by:** 81 (Tools execute over the existing HTTP route), 83 (Turn-keyed tool idempotency)

**Status:** resolved

- [ ] A timeout, 401, 404, 500 or unreadable response becomes a tool result with a failure flag and a reason; the call continues.
- [ ] A timed-out side-effecting tool is recorded as indeterminate and not automatically retried in the turn.
- [ ] The route receives the tool call id so the tool can dedupe.
- [ ] A test that crashes the call on a 500 fails.

## Answer

# 84 — tool failures become results

- Every route failure (non-2xx, timeout, unreadable body, non-object body, dropped connection) is a `ToolFailure` (a `ToolResult` subclass) with the matching `toolCallId`, a stable `code`, `failure: true` and a recoverable/terminal classification; nothing raises, the call continues.
- Timeout / post-request connection drop are `indeterminate: true`; the turn memo stores the failure, so a repeated `(name, args)` replays it (one POST) instead of retrying the side effect.
- 401/404 (other than 408/429) are `terminal`; 5xx, 429, 408, body failures are `recoverable`. `DeniedCall` (no call id) is terminal and is never a tool message.
- Evidence: `voice-pipeline/cascade/test_tools_failures.py` (9 tests, incl. 500-continues test), updated `test_tools.py`.
- Command: `cd voice-pipeline && .../python -m unittest discover -s . -p 'test_*.py'` → 1464 tests, OK (skipped=1).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

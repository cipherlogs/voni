# 83: Turn-keyed tool idempotency

**What to build:** Within one logical turn, a tool call identified by its name and canonical arguments is memoised. A repeat replays the result instead of causing a second side effect, and the memo survives a model reconnect in the same turn.

**Blocked by:** 81 (Tools execute over the existing HTTP route)

**Status:** resolved

- [ ] A name and canonical arguments pair is memoised within one logical turn; a repeat replays the result.
- [ ] Canonicalisation sorts object keys and normalises scalar formatting.
- [ ] The memo survives a model reconnect in the same turn and resets on a new turn.
- [ ] A counting executor sees one invocation for a retried identical call.

## Answer

# 83 — Turn-keyed tool idempotency

1. `canonical_arguments` is the memo key's argument half: object keys sorted recursively, `1`/`1.0` normalised to one spelling, bool/string/int kept distinct, emitted as compact JSON so it can be logged.
2. `ToolCallMemo` keys on `(turn, name, canonical arguments)` and `begin_turn(key)` clears when the turn changes — a reconnect that re-labels the same logical turn keeps replaying, a new turn executes again. The memo belongs to the call and hangs off the logical turn; callers hand it to `ToolExecutor(memo=...)`.
3. A memo hit returns the first payload re-addressed to the repeated call id with `replayed=True`, so the retry's `role: "tool"` message answers the call the vendor is waiting on; the route sees no second request.
4. Only `ToolResult` is memoised (success and the route's own `ok: false`); denied calls and transport failures are not, so 84 can still record a timeout as indeterminate.
5. Ordering (86), caps (87) and failure mapping (84) are untouched.

Evidence: `voice-pipeline/cascade/tools.py` (`canonical_arguments`, `ToolCallMemo`, `_replayed`, `ToolExecutor.start`/`_hop`), `cascade/test_tools_idempotency.py` (9 tests, incl. a counting session factory seeing one invocation). Red proof: removing the memo lookup/put fails the four core replay tests. Full suite from `voice-pipeline/`: `Ran 1329 tests ... OK (skipped=1)`. Branch `cluster/tools-82-85`, commit `7ff18d10`, base `098fdf9d`. Merger note: M06 must call `memo.begin_turn(turn.event_id)` on each new logical turn and keep the memo across an LLM reconnect; without a memo the executor keeps 81's non-idempotent behaviour.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

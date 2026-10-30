# 86: Multiple tool calls execute in index order

**What to build:** When the model asks for several tools in one turn, they run one at a time in index order and their results are appended in call order. Side-effect order is not traded for off-path latency.

**Blocked by:** 81 (Tools execute over the existing HTTP route), 83 (Turn-keyed tool idempotency)

**Status:** resolved

- [ ] Multiple calls in one turn execute in index order, one at a time, even when the vendor allows parallel calls.
- [ ] One tool message per call, appended in call order.
- [ ] A test with two calls asserts execution and message order.
- [ ] Side-effect order is not traded for off-path latency.

## Answer

# 86 — multiple tool calls in index order

- `execute_turn_calls(executor, turn, calls)` runs a turn's calls strictly one at a time, ordered by `MetaToolCall.index` (never list order), so a scrambled batch and a vendor that allows `parallel_tool_calls` still produce one side-effect order.
- An `end_call` in the batch stops every later hop: calls after it make no request (ticket 87 owns the goodbye).
- `continue_after_tool` accepts one outcome or a batch, appends one `role:"tool"` message per call in index order, then makes exactly one continuation request; results before an `end_call` are recorded, nothing after it is spoken.
- Evidence: `voice-pipeline/cascade/test_tools_order.py` (7 tests, serial route flags any overlap, scrambled-batch order, out-of-order outcomes, end_call mid-batch), updated `test_tools.py` multi-call test.
- Command: `cd voice-pipeline && .../python -m unittest discover -s . -p 'test_*.py'` → 1471 tests, OK (skipped=1).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# 38: Per-turn usage, with unmeasured as a real value

**What to build:** Usage is captured from the final chunk: prompt, completion, total, cached and reasoning tokens. An interrupted stream records unmeasured rather than a made-up zero.

**Blocked by:** 36 (Chat Completions request contract)

**Status:** resolved

- [ ] The final chunk's usage records prompt, completion, total, cached and reasoning counts per turn.
- [ ] An interrupted stream records unmeasured and never zero.
- [ ] A missing cached or reasoning count is recorded as absent, not zero.
- [ ] Cost calculation can cite the per-turn units without re-parsing the stream.

## Answer

Ticket 38 done: `MetaLLMTurn.usage` is a frozen `TurnUsage` filled only from a vendor usage frame (bare final chunk with `choices: []`, or usage attached to the last choice): prompt, completion, total, cached (`prompt_tokens_details.cached_tokens` or top-level) and reasoning (`completion_tokens_details.reasoning_tokens` or top-level).
`TurnUsage.unmeasured()` is the default and the only value an interrupted stream can record: an exception mid-stream and a caller abandoning the generator (barge-in `break`) both close the record `interrupted=True` with every count `None`, never zero; an omitted cached/reasoning detail is `None` while the measured counts stay ints.
`TurnUsage.as_dict()` is the stable artifact shape, so ticket 101 can price a turn without re-parsing the SSE; `measured` is the only honest branch.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_usage` = 7 OK; full discover = 494 OK (red-first: `MetaLLMTurn.usage` absent; mutation zero-fills usage and drops the unmeasured reset → 3 failures).
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_usage.py`. Branch `cluster/llm-37-44`, base 83ea36ed.
Merger notes: a normal stream that ends without a usage chunk is also `unmeasured` (vendor bug recorded honestly, not priced as free); `parse_usage` is exported for ticket 45's pinned fixtures.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

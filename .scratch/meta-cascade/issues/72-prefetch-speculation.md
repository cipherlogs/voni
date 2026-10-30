# 72: Speculative prefetch that can never commit a turn

**What to build:** While the agent is silent, a growing partial may start speculative model work. It is read-only, cancellable, adopted only on an exact message match with the final, and never a reply.

**Blocked by:** 70 (Floor arbitration while the agent holds the floor), 37 (Content deltas are the only speech)

**Status:** resolved

- [ ] A speculatively started reply is read-only, cancellable and never sent as a reply.
- [ ] It is adopted only on an exact message match with the final; any difference discards it.
- [ ] A dropped prefetch is counted and never turns a partial into a user message.
- [ ] Prefetch never runs while the agent holds the floor.
- [ ] A test that adopts a differing prefetch fails.

## Answer

72 done — new `cascade/prefetch.py`: `PrefetchSpeculator` holds at most one `PrefetchTicket` (canonical `message_key` over messages *and* tools), calls only `LLMStream.prefetch` and has no reply sink, so a speculation can never become a reply or a user message.
`offer` refuses while the floor is held (`FloorArbiter`) and at/after `speechEnd` (`TurnPhase`), ignores an identical partial, replaces+cancels the previous ticket, and swallows a failing prefetch as `prefetch_cancelled` (speculation never fails a call).
`adopt` requires `takes_floor=True`, an uncancelled ticket, the exact same canonical request and the exact same text as the final; anything else is dropped, counted and reported by `DropReason` (replaced/mismatch/suppressed/cancelled/failed/call_end). Adoption deletes the pending ticket, so a second adopt returns None.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1127, OK (21 in `cascade/test_prefetch.py`, incl. an end-to-end `EventRules` + sink turn). Red-proof: forcing `exact = True` → 4 failures; deleting the floor guard → 2 failures.
Branch `cluster/orch-71-73`, base cce8b788, commit c9de0b12; `git merge feat/meta-cascade` → "Already up to date". Counters reused: `prefetch_started`, `prefetch_cancelled`, `prefetch_used`; `metrics.py` untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

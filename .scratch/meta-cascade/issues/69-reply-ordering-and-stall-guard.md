# 69: Reply ordering and the stall guard

**What to build:** Finals are answered in logical order. A later turn waits for an earlier open turn, and a bounded guard closes an abandoned turn without inventing a reply or losing the later turn.

**Blocked by:** 67 (Event rules: the final is the only reply trigger), 03 (Threshold registry with a source requirement), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] A later turn's final waits for any earlier open turn to complete.
- [ ] The stall guard closes an abandoned turn with no reply and records it, using the named bound.
- [ ] If the guard fires, the later turn is still answered and the abandonment is visible in the event stream.
- [ ] A test with turn 2 finishing before turn 1 asserts reply order and the recorded gap.

## Answer

69 done — `cascade/event_rules.py` now routes every reply through `ReplyOrder`:
finals queue by logical turn `seq`, a later final is held (`EventOutcome.held`) until
every earlier turn settles, and `EventRules.settle(turn)` is the reply-finished seam
that releases it. `EventRules.tick()` closes an earlier turn that never finishes:
after `turn.stall_guard_ms` (2,500 ms, read via `require_bound` at wait start) it
records `AbandonedTurn` (turn id, waited ms, guard ms, "no reply"), closes the turn
with reason `abandoned`, and answers the held turn exactly once. Clock is injected
(`TurnStateStore(clock=FakeClock())`), the guard never sleeps and never reads wall
time; an unset bound raises `UnsetBoundError` naming `turn.stall_guard_ms`.
Evidence: `cascade/test_reply_ordering.py` (12 tests) covers AC1 wait, AC4 turn-2-
first order with `OrderedReply.waited_ms`/`blocked_by`, the 2,499 vs 2,500 ms edge,
late final ignored, duplicate final ignored, `FrozenClock` never fires, no
`asyncio.sleep`, registry override and unset-bound refusal.
Commit `9ce6ccf8`; branch `cluster/turn-69-87`; base `bd9180dc`; full suite
Ran 1722, OK (skipped=1). Merge: `ReplyOrder` is the only reply call site; M06 must
call `settle()` when a reply finishes (and may schedule `tick()` from
`CallLifecycle.run_stall_guard`'s bound) or later finals stay held.

_Implemented on `feat/meta-cascade`._

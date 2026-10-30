# 03: Threshold registry with a source requirement

**What to build:** One registry for every cascade bound the spec leaves open, naming the unit, the gate that consumes it and the source of the number. A bound that is absent refuses at startup; no code path substitutes a default. This is the mechanism that lets ticket 04 supply values without any ticket inventing one.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Looking up an unset bound fails with the bound's name and the ticket that owns it; no code path substitutes a default.
- [ ] A bound supplied without a stated source is refused by the registry itself.
- [ ] Every consumer reads the same entry; a second hardcoded copy of a bound fails review.
- [ ] The frozen budgets (1500/2500/1500/2500) are read from the existing table, not duplicated.

## Answer

Registry lives in `voice-pipeline/cascade/thresholds.json` (data) read by `thresholds.py`; `require_bound(name)` raises `UnsetBoundError` naming the bound, owning ticket and gate.
Every valued bound needs unit+gate+ticket+source+date; the four frozen budgets are record-backed (`budget_key`, sha256-pinned) and a literal plus `budget_key` is refused as `CopiedBudgetError`.
Declared open: daily cap, per-call ceiling, deploy drain wait, turn stall guard, tool loop cap, TTS keepalive, day boundary, browser E2E budget, reply task, tool timeout, reconnect handshake; spec-stated 80%/100%, 10 s STT handshake, 120 s TTS idle and 2,000-char cap are set with spec sources.
Ticket 04 edits only `thresholds.json` to supply a value (test proves no code edit); consumers: 69, 76, 87, 101-105, 119, 140 via `require_bound`/`lookup`/`bound`.
Evidence: `voice-pipeline/cascade/test_thresholds.py` (22 tests, red-proved by deleting the unset raise and pasting a copied 1500); full suite 114 OK; commit `4405e5a7` on `ticket/03-threshold-registry` (base `20751132`).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

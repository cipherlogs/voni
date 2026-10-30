# 19: Manual fallback pin that probes never clear

**What to build:** An operator can pin a leg to its fallback rung. The pin forces the rung on every read, no probe or canary clears it, and only a human write with who, when and why returns it to none.

**Blocked by:** 15 (Breaker record and durable shared store), 17 (Breaker transitions on a fake clock)

**Status:** resolved

- [ ] The fallback pin selects the fallback rung on every read regardless of the stored state.
- [ ] No probe success, canary or staleness rule clears the pin.
- [ ] Only a human write returns it to none, and the audit trail records who, when and why.
- [ ] There is no automated primary pin; a request to add one is refused by name.
- [ ] A pinned leg still reports its underlying state and last probe, so an operator can see why it is pinned.

## Answer

19 done — new `cascade/ladders.py` (`Ladder`, `Rung`, `RungChoice`, `choose_rung`) and `cascade/override_audit.py` (`OverrideEntry`/`OverrideTrail` v1, `OverrideAudit`), plus `cascade/test_manual_pin.py` (14 tests).
Rung selection: `manualOverride: "fallback"` wins over the stored state on every read, so a pinned leg always uses the fallback rung; unpinned `closed` uses the primary, `open` and a stale `closed` (read as `half_open`) use the fallback; a ladder with no fallback (TTS: AssemblyAI only) selects `none`/`provider=None` and says the call fails visibly. The choice always reports stored `state`, read-time `effective_state`, `lastProbeAt`, `pinned` and the record's own `provider`, so a pinned leg still shows why it is pinned.
Audit: append-only, CAS, keyed `breaker_override:<leg>`, chain-validated on read (from→to must join, like the routing switch). `pin`/`clear` are the only writers: record first, entry only if that write landed; who (actor), when (event time), why (reason) per entry; an unpin records `from fallback → to none`; an unaudited-but-landed pin is returned `audited=False` with the error rather than hidden.
Rules: no probe success, canary, staleness rule or failure clears the pin or appends an entry (test drives all four); a request for `target="primary"` is refused by name before any write; an absent actor/why is refused and audits nothing.
Evidence: `test_manual_pin` 14 tests; red-first (no `cascade.ladders`), then mutations: pin branch disabled → 2 fail, state branch disabled → 2, audit append skipped → 3. Full suite 511 OK. Branch `cluster/breaker-18-23`, base 83ea36ed, merge → "Already up to date".
Merger notes: the record has no audit field (spec shape), so the trail lives beside it under its own store key — same protocol, one adapter per deploy. `choose_rung` is the single reader tickets 22/23 use; do not add a second rung decision.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

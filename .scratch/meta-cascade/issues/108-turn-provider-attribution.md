# 108: Every turn names the providers that served it

**What to build:** A turn records the speech, model and voice actually used, including a fallback rung and a null for a leg that did not run. A managed turn records the provider table as vendor-owned, not a fabricated name.

**Blocked by:** 107 (One event envelope and reader refusal), 75 (Call lifecycle and the end message)

**Status:** resolved

- [ ] Every turn names the speech, model and voice actually used, including a fallback rung.
- [ ] A leg that did not run is null, for example a backchannel with no model.
- [ ] A managed turn records the provider table as vendor-owned, not a fabricated vendor name.
- [ ] A turn's attribution matches the provider table in the end message.
- [ ] A fallback turn names both rungs.

## Answer

108: A turn names its providers in `cascade/events.py` — `TurnAttribution` (stt/llm/tts `LegAttribution`, each with provider, rung, reason; `from` when a fallback rung served, so both rungs are named) and one emitter `emit_attribution(...)` → `turn.attribution` through the existing `EventWriter` (scratch: `test_every_attribution_is_built_by_the_one_envelope_writer`). A leg that did not run is an explicit `null` (backchannel = no model); a managed turn is `N/A — vendor-owned` with `vendorOwned: true`; a cascade writer refuses that table and a managed writer refuses a named vendor, writing nothing.
Keyed by the logical turn: `TurnState.providers` is set by `TurnStateStore.attribute(...)`, keyed by `LogicalTurnId.event_id` (`<sessionEpoch>:<providerTurnId>`, new `turn_key`), so a reconnect/rebind/replayed `speechStart` keeps the same record and another turn's record cannot be rewritten (mismatched key raises `AttributionError` by name; a replaced-epoch record is ignored).
Never guessed: `TurnState.provider_attribution()` returns `TurnAttribution.unmeasured(turn.id, reason)` when nothing was recorded — providers null, the reason names the turn.
Derivable end table: `TurnStateStore.provider_table(missing_reason=...)` returns `call.ProviderTable` (most recent turn per leg; a backchannel does not erase a leg; an unmeasured turn adds nothing; an unused leg is `null` with the named reason; a managed call is all `vendor-owned`). `test_the_end_message_table_is_the_derived_table` builds a `CallEnd` from it, so a turn and the table cannot disagree.
Evidence: `cascade.test_events_attribution` 39 new; `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1123, OK. Branch `cluster/events-108`, base `cce8b788`; `git merge feat/meta-cascade` → already up to date. Merger notes: M06 wires `store.attribute(...)` once the reply's legs are known and passes `provider_table(missing_reason="not opened at connect")` as `CallEnd.providers` (call.py still derives from `OpenedLeg`; not edited). No TS change — the reader is type-generic and `vendorOwned` stays managed-only. No fallback emission or gap work (109/113/114 untouched).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

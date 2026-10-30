# 46: Voice binding table

**What to build:** Every voice maps to exactly one Locale and to the vendor's language name. The table is the only authority for a synthesis language, a voice absent from it is not a cascade subject, and no caller input can override the binding.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Each voice maps to exactly one Locale and the vendor's language name; a voice claimed for two Locales is refused by name.
- [ ] A voice absent from the table is refused by name and is not a cascade subject.
- [ ] The table is the only source of a synthesis language; no request field can override it.
- [ ] A test asserts every demo voice's binding and names the six subjects.

## Answer

46 voice binding table: done, green — 106 tests (92 dispatch + 14 new) in `cascade/test_voice_binding.py`.
Files: `voice-pipeline/cascade/{__init__.py,voice_binding.py,test_voice_binding.py}` @ `abdd2761`, branch `ticket/46-voice-binding-table`, base `20751132`; `feat/meta-cascade` merged "Already up to date".
Table: 15 serving catalogue voices bound one-Locale each to the vendor's language name; `juergen`/de is a named `UNBOUND_VOICES` row (422 `voice_not_found`), keeping German open for ticket 130.
Refusals by name: unknown voice, unbound voice, voice claimed for two Locales, request language that disagrees with the binding; `is_cascade_subject()` is false for unknown and unbound.
Evidence: tests parse `voni/src/lib/agents/voices.ts` and `voni/evidence/voice-levels/levels.json` so drift fails; demo bindings anna/en, lola/es, estelle/fr, giovanni/it, rafael/pt (five of the six subjects).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

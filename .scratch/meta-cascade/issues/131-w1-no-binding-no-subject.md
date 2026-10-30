# 131: No voice without a binding, and no quiet drop

**What to build:** A voice that cannot be bound to one Locale is not a cascade subject. The Locale stays open: not beta, not dropped, not cut over.

**Blocked by:** 46 (Voice binding table), 61 (Body eligibility refusals)

**Status:** resolved

- [ ] A voice that cannot be bound to one Locale is not a cascade subject.
- [ ] The Locale stays open: not beta, not dropped, not cut over.
- [ ] An unbound voice asserts its refusal path.
- [ ] The subject list names each Locale's status explicitly.

## Answer

# 131 — No voice without a binding, and no quiet drop

- `bindCascadeVoice` / `isCascadeSubjectVoice` mirror `cascade/voice_binding.py`: `juergen`/de is the one unbound row (`422 voice_not_found`), refused by name with voice, Locale and reason; an unknown voice is a separate named refusal.
- `resolveCascadeSubject` applies the binding gate after the managed subject resolution, so an unbound voice can never be a cascade subject and is refused before any audio is spent.
- The Locale stays open: `cascadeSubjectList()` lists one row per offered Locale with an explicit status (`bound`/`open`); German is `open` with `voices: []` and the named reason. There is no beta/dropped/cut-over status, and a refused run does not mutate the list.
- `SubjectRecord` gains the `pipeline` axis (absent = managed): `sameSubject` compares it, so the managed and cascade runs of one voice are two subjects in the A/B; `formatSubject` prints `, cascade`.
- Drift guards: unbound voices must exist in the registry with their declared Locale, must match `UNMEASURED_VOICE_LEVELS` (`voice_not_found`), and must be named in the Python binding table.

Evidence: `voni/src/lib/demo/subject.ts` (+ test). Tests: 24 in `subject.test.ts`; full suite 2109 tests, 0 fail.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

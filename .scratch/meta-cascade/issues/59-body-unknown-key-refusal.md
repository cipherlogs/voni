# 59: Unknown body keys fail by name

**What to build:** A body key that is neither mapped nor deliberately ignored fails the adapter by name, before any vendor socket opens. A smuggled setting is a visible error, not a cascade feature.

**Blocked by:** 57 (Stored-body field map), 58 (Ignore set with a reason per field)

**Status:** resolved

- [ ] An unknown top-level key fails by name.
- [ ] An unknown input or output subkey fails by name.
- [ ] The failure happens before any vendor socket opens.
- [ ] A smuggled key is reported by name, never silently dropped.
- [ ] A body key added by a future builder change fails until the map or ignore set is deliberately extended.

## Answer

59 unknown-key refusal: done, green — 463 tests (+9 in `cascade/test_body_map.py`) on Python 3.14 venv; branch `cluster/body-58-25`, base `83ea36ed`, commit `0d15b5ec`.
Rule: `_reject_unknown_keys` derives the allowed children per call from `FIELD_MAP | IGNORE_SET` (+ `llm`, the documented refusal) and raises `UnknownBodyKeyError` naming `path` (e.g. `input.language`, `output.gain_db`, `voice.clone_id`) for top level, `input`, `output` and `voice`; a non-object section is a named `BodyFieldError`.
Before any socket: the refusal is inside `adapt_body`; a test adapts-then-opens through `MetaStreamingSTT` with `ScriptedSocketFactory` and asserts `factory.connections == []`.
Tripwire: a fixture of the full body `buildStoredAgent` emits today is accepted; adding a key to it (`input.endpointing_sensitivity`) fails until the map/ignore set is deliberately extended — then the same body passes with the field recorded.
Updated 57's smuggled-key test: five unmapped keys now each raise by name (never silently read as a setting); no other module touched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# 57: Stored-body field map

**What to build:** The cascade reads the stored body through one explicit field map: system prompt, greeting, voice, language codes, keyterms and tools. A new body field is never passed through by accident.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Every mapped field appears in the produced config: system prompt, greeting, voice, language codes, keyterms and tools.
- [ ] The map is explicit; a new body field is not passed through implicitly.
- [ ] Language codes become vendor language names for speech bias and the voice's own Locale for synthesis.
- [ ] Tools are converted to the model's function shape.
- [ ] A minimal body produces exactly the expected config, pinned by a test.

## Answer

57 stored-body field map: done, green — 268 tests (17 new in `cascade/test_body_map.py`) on Python 3.14 venv.
Files: `voice-pipeline/cascade/{body_map.py,test_body_map.py}` @ `6f33d09d`, branch `ticket/57-body-field-map`, base `df21bedb`; `feat/meta-cascade` merged "Already up to date".
Map: `FIELD_MAP` is exactly the spec's six paths (system_prompt, greeting, voice.voice_id, input.language_codes, input.keyterms, tools); `adapt_body` builds `CascadeBody` only from that map, and the frozen config's constructor makes a missing/extra map entry a build error.
Languages: codes become vendor names for STT bias (`es`→`Spanish`) while `synthesis_language` stays the bound voice's Locale (bias `["en","es"]` + `lola` → bias English/Spanish, synthesis Spanish); unknown code refused by name. Binding reuse: `juergen` (UnboundVoiceError) and unknown voice (UnknownVoiceError) come from ticket 46, no second table.
Tools: REST `{name,description,parameters,execution_mode,timeout_seconds}` → `{type:"function",function:{name,description,parameters}}`, exact-equality pinned so execution metadata and any unmapped body key cannot leak. Deferred as dispatched: ignore set (58), unknown-key refusal (59 — a test comment marks the flip), LLM override (60), eligibility routing (61), fingerprint (63), envelope (64); `config.py`/`transport.py` untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

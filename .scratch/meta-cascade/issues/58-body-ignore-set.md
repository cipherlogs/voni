# 58: Ignore set with a reason per field

**What to build:** Fields that must not reach the cascade are listed with a reason and recorded as ignored, so a recognition-carrying field like the transcription prompt cannot disappear silently.

**Blocked by:** 57 (Stored-body field map)

**Status:** resolved

- [ ] Every ignored field is listed with a reason: name, volume, redundant voice, formats, transcription mode, transcription prompt, voice focus and its threshold, and turn detection.
- [ ] Ignoring the transcription prompt is recorded on the call so the pre-cutover recognition check can see it.
- [ ] No ignored field reaches a vendor request; a test scans the built requests.
- [ ] The ignore set is data, not scattered conditionals.

## Answer

58 ignore set: done, green — 454 tests (+8 in `cascade/test_body_map.py`) on Python 3.14 venv; branch `cluster/body-58-25`, base `83ea36ed`, commit `09a86b2d`.
Data: `IGNORE_SET` in `voice-pipeline/cascade/body_map.py` is exactly the spec's ten fields (name, output.volume/voice/format, input.format/transcription_mode/transcription_prompt/voice_focus/voice_focus_threshold/turn_detection), each with a reason; nothing conditionals on a field name — an extended mapping is the whole change (proved by patching the mapping).
Recorded, not dropped: `adapt_body` returns `CascadeBody.ignored` as `IgnoredField(path, reason, value)` for every ignored field present, so a non-empty `input.transcription_prompt` carries its words for the pre-cutover recognition check; absent ignored fields record nothing.
No leak: a test builds the STT handshake and the Chat Completions payload from the adapted config and scans both for every ignored key and for unique ignored values (prompt text, volume, call name) — all absent.
Deferred: unknown-key refusal (59), LLM override (60), eligibility (61), fingerprint (63), envelope (64); `config.py`/`transport.py` untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

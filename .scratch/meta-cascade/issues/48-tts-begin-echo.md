# 48: Begin echo is an assertion

**What to build:** The session's opening frame echoes what we asked for. Voice, language, sample rate, encoding and model are compared with the request; a mismatch fails the call before a single audio frame is played.

**Blocked by:** 47 (Synthesis connect per transport)

**Status:** resolved

- [ ] The echoed voice, language, sample rate, encoding and model are compared with the request.
- [ ] A mismatch fails the call visibly, records the mismatch and plays no audio.
- [ ] A non-empty list of unknown parameters refuses the call as a configuration bug.
- [ ] The session expiry and limits are recorded on the call.

## Answer

48 done — `AssemblyAIStreamingTTS.open()` now asserts the `Begin` echo: `voice_id`, `language`, `sample_rate`, `encoding` and `model` are compared field by field, strings lowercased as the vendor normalizes them (a lowercase `language` echo is not a mismatch), and every disagreement is recorded on `begin_mismatches` before the call fails.
A mismatch raises `SynthesisEchoError` naming the field, and a non-empty `Begin.configuration.unknown_params` raises `SynthesisConfigurationError` as a configuration bug; both close the socket, send nothing, and play no audio (asserted against `socket.sent`).
Facts: `expires_at`, `begin_id`, `configuration` and `limits` are kept as a read-only call record; a `Begin` missing expiry/limits records `None`/`{}` rather than inventing values.
Tests: 11 new in `cascade/test_tts_begin_echo.py`; red first (ImportError/AttributeError), then green; mutation check (assertion deleted) fails the mismatch suite. Full suite 457 OK.
Files: `voice-pipeline/cascade/{assemblyai_tts.py,test_tts_begin_echo.py,test_tts_support.py}`; commit `e1d9748d`, branch `cluster/tts-48-55`, base `83ea36ed`.
Merger notes: the echo assertion exposed a stale ticket-47 fixture — `test_tts_connect.py`'s phone case now echoes `lola`/`Spanish` (it previously echoed `anna`/`English` for a lola session); that fixture change is the only touch outside my new files.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

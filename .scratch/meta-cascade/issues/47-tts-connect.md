# 47: Synthesis connect per transport

**What to build:** One synthesis socket per call, opened at call start before the first user frame, with voice, language, sample rate, encoding and model taken from the binding and the transport.

**Blocked by:** 01 (Shared determinism kit), 46 (Voice binding table)

**Status:** resolved

- [ ] One socket is opened per call at call start, before the first user frame.
- [ ] Voice, language, sample rate, encoding and model come from the binding and the transport.
- [ ] Word boundaries are requested.
- [ ] The socket factory is injected and the test never opens a real socket.
- [ ] A transport without a defined rate and encoding refuses by name.

## Answer

47 done — `AssemblyAIStreamingTTS` opens exactly one synthesis socket per call at `open()`, built only from the voice binding (`voice_id`, vendor language name via `VoiceBinding.language`) and the transport format (`browser` 24000/`pcm_s16le`, `telnyx` 8000/`pcm_mulaw`), with `model_id=assemblyai-tts-1` and `word_boundaries=true`; no constructor or `open()` argument can override any of them (unknown kwargs are a `TypeError`), and an unknown voice (`UnknownVoiceError` from 46) or transport (`UnknownTransportError`, names it) refuses before a socket exists.
Handshake plumbing: `open()` reads the first frame, keeps it on `begin` for ticket 48's echo assertion, and raises `SynthesisHandshakeError` naming the code if the first frame is an `Error` or not `Begin`; `expires_at`/`limits`/`unknown_params` are deliberately left to 48, and `speak()` raises `NotImplementedError` pointing at 49, so 48-56 have their seams.
Files: new `voice-pipeline/cascade/assemblyai_tts.py` (+`TransportFormat`/`TRANSPORT_FORMATS`/`transport_format`) and `voice-pipeline/cascade/test_tts_connect.py`; imported `cascade.testing.socket_factory.ScriptedSocketFactory` as the injected factory, so no test opens a socket.
Tests: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 261, OK; red proven first (module absent), then 11 connect tests green; `cascade.test_tts_connect` alone → 11 OK.
Merger notes: branch `ticket/47-tts-connect`, base `df21bedb`, commit `b0c41208`, `git merge feat/meta-cascade` → "Already up to date"; 48 must add the echo assertion inside `open()` where the ticket-48 comment sits; `TRANSPORT_FORMATS` is keyed by `config.TRANSPORTS` names and a test iterates that tuple so a new transport cannot land without a format.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

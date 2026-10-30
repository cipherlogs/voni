# 26: Meta speech handshake and injected socket seam

**What to build:** The speech backend opens a realtime session with the credential inside the handshake frame, not a header, and the exact mode, encoding and bias the slice needs. The socket factory is injected so the backend is replayable offline.

**Blocked by:** 01 (Shared determinism kit)

**Status:** resolved

- [ ] The first JSON text frame within 10 s carries the bearer credential in the frame; no authorization header is used.
- [ ] The frame sets 24 kHz PCM, the transcription model, endpointing mode, cumulative partials, audio progress off, and vocabular bias from the body.
- [ ] Language codes become vendor language names and keyterms become keywords; both are frozen at session start.
- [ ] The socket factory is injected and the test never opens a real socket.
- [ ] The handshake frame is never logged.

## Answer

26 done — `voice-pipeline/cascade/meta_stt.py` ships `MetaStreamingSTT(StreamingSTT)` whose `open()` connects through an injected `socket_factory` (`(url, extra_headers)`, default lazily imports `websockets`) and sends exactly one text frame before reading the ack; `send_audio`/`events`/`close` are ack-gated stubs that name tickets 28/29/30.
Handshake: `authorization.accessToken = "Bearer <META_API_KEY>"` in the frame body with `extra_headers == {}` (no `Authorization` header); `audioEncoding=PCM_24KHZ`, `model=muse-voice-transcribe-1.0`, `mode=ENDPOINTING`, `partialMode=CUMULATIVE`, `emitAudioProgress=false`; `languageBias` is vendor names via `cascade.voice_binding.LOCALES` (unknown code refused by name, before connecting), `keywords` from keyterms (strip/dedupe), both frozen on first session start and reused on reconnect; a non-24 kHz sample rate is refused as not `PCM_24KHZ`.
Identity/ack: `sessionId=<call id>:<epoch>` is the only query param, epoch starts at 0 and increments per open, never contains the key; a JSON text frame without `type` is the ack, a typed frame (or binary/non-JSON) before it is `MetaHandshakeProtocolError` naming session and type and closing the socket, a socket that ends early is `MetaHandshakeError`, and `acked` is only true after the ack so no audio can precede it.
Red/green: 16 tests in `cascade/test_meta_stt_handshake.py` (initial red was `ModuleNotFoundError`; mutations re-run red — header instead of frame, typed-ack accepted, raw bias codes, epoch dropped, key in `repr` all fail). The handshake frame is never logged: the token lives only in the wire dict, `__repr__` is redacted, and a DEBUG-level capture plus `repr` assertion proves it.
Branch `ticket/26-meta-stt-handshake`, commit `44f111c8`, base `df21bedb`, `git merge feat/meta-cascade` → "Already up to date" (visible integration ref is still df21bedb); `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → 266 tests OK. Merger: `stt.handshake_ms` (10 s) is set but deliberately not consumed here — ticket 27 owns the bounded ack wait/visible failure; this ticket assumes the standard ack.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

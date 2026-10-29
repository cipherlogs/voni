"""Shared recorded-frame fixtures for the synthesis tests (tickets 48-55).

This module holds no tests: it is the one place the vendor's frame shapes are
written down, so every TTS test asserts against the same recorded protocol
(``.scratch/meta-cascade/spec.md``, M1 "AssemblyAI speech synthesis backend").
Each helper returns one wire frame as the vendor sends it; the socket factory
is injected, so no test opens a real socket.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterable, Mapping
from typing import Any

from cascade.assemblyai_tts import AssemblyAIStreamingTTS
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory

API_KEY = "test-key"

#: The vendor's default session lifetime and limits, as ``Begin`` echoes them.
BEGIN_EXPIRES_AT = 1789556741
BEGIN_ID = "10885144-0d4b-4928-9eff-ef292a352937"
VENDOR_LIMITS: Mapping[str, Any] = {
    "max_generate_text_length": 2000,
    "max_control_frames_per_sec": 20.0,
    "max_egress_audio_buffer_ms": 300000,
    "text_throttle_max_chars_per_sec": 100.0,
    "text_max_buffer_chars": 8000,
    "session_ttl_grace_sec": 60,
}


def begin(
    *,
    voice_id: str = "anna",
    language: str = "English",
    sample_rate: int = 24000,
    encoding: str = "pcm_s16le",
    model: str = "assemblyai-tts-1",
    unknown_params: Iterable[str] = (),
    expires_at: int | None = BEGIN_EXPIRES_AT,
    limits: Mapping[str, Any] | None = None,
) -> str:
    """A ``Begin`` frame shaped like the vendor's, for the session under test."""
    frame: dict[str, Any] = {
        "type": "Begin",
        "id": BEGIN_ID,
        "configuration": {
            "language": language,
            "sample_rate": sample_rate,
            "encoding": encoding,
            "voice_id": voice_id,
            "model": model,
            "word_boundaries": True,
            "limits": dict(VENDOR_LIMITS if limits is None else limits),
            "unknown_params": list(unknown_params),
        },
    }
    if expires_at is not None:
        frame["expires_at"] = expires_at
    return json.dumps(frame)


def pcm(*values: int) -> bytes:
    """Little-endian 16-bit PCM from sample values, as one ``Audio`` payload."""
    return b"".join(int(value).to_bytes(2, "little", signed=True) for value in values)


def audio(payload: bytes, *, flush_id: int = 0) -> str:
    """One ``Audio`` frame: base64 codec bytes under their request's id."""
    return json.dumps(
        {
            "type": "Audio",
            "audio": base64.b64encode(payload).decode("ascii"),
            "flush_id": flush_id,
        }
    )


def flush_done(*, flush_id: int = 0, audio_duration_ms: int = 1200) -> str:
    """One ``FlushDone`` frame: that request's audio has left the vendor."""
    return json.dumps(
        {
            "type": "FlushDone",
            "flush_id": flush_id,
            "audio_duration_ms": audio_duration_ms,
        }
    )


def words(*entries: tuple[str, int, int]) -> list[dict[str, Any]]:
    """Word entries ``(word, start_ms, end_ms)`` at full confidence."""
    return [
        {"word": word, "start": start, "end": end, "confidence": 0.99}
        for word, start, end in entries
    ]


def word_boundaries(
    *, flush_id: int = 0, audio_start_ms: int = 0, entries: Iterable[Mapping[str, Any]] = ()
) -> str:
    """One ``WordBoundaries`` frame, best effort, trailing its ``FlushDone``."""
    return json.dumps(
        {
            "type": "WordBoundaries",
            "flush_id": flush_id,
            "audio_start_ms": audio_start_ms,
            "words": list(entries),
        }
    )


def cancelled(*, audio_duration_seconds: float = 0.0) -> str:
    """The ``Cancelled`` frame answering one ``Cancel``."""
    return json.dumps(
        {"type": "Cancelled", "audio_duration_seconds": audio_duration_seconds}
    )


def termination(
    *,
    total_input_char_length: int = 96,
    billed_characters: int | None = 96,
    audio_duration_seconds: float = 5.304,
    session_duration_seconds: int = 8,
    word_boundaries_status: str = "complete",
) -> str:
    """The clean end's summary; keys the vendor may add are simply absent."""
    frame: dict[str, Any] = {
        "type": "Termination",
        "session_duration_seconds": session_duration_seconds,
        "total_input_char_length": total_input_char_length,
        "audio_duration_seconds": audio_duration_seconds,
        "word_boundaries_status": word_boundaries_status,
    }
    if billed_characters is not None:
        frame["billed_characters"] = billed_characters
    return json.dumps(frame)


def error(code: int, message: str = "refused") -> str:
    """An ``Error`` frame; its ``error_code`` is the close code that follows."""
    return json.dumps(
        {"type": "Error", "error_code": code, "error": message, "retryable": False}
    )


def make_session(
    plan: Iterable[Frame | str | bytes],
    *,
    transport: str = "browser",
    voice_id: str = "anna",
    clock: Any = None,
    socket_factory: ScriptedSocketFactory | None = None,
    api_key: str | None = API_KEY,
) -> tuple[AssemblyAIStreamingTTS, ScriptedSocketFactory]:
    """Build a session over one scripted plan without opening it."""
    factory = socket_factory or ScriptedSocketFactory(list(plan))
    extra = {} if clock is None else {"clock": clock}
    tts = AssemblyAIStreamingTTS(
        voice_id=voice_id,
        transport=transport,
        api_key=api_key,
        socket_factory=factory,
        **extra,
    )
    return tts, factory


def sent(factory: ScriptedSocketFactory) -> list[dict[str, Any]]:
    """Every frame the client sent on the most recent socket, parsed."""
    socket = factory.socket
    assert socket is not None, "no socket was opened"
    return [json.loads(message) for message in socket.sent]


def sent_types(factory: ScriptedSocketFactory) -> list[str]:
    """The ``type`` of every frame the client sent, in order."""
    return [frame["type"] for frame in sent(factory)]


def sent_texts(factory: ScriptedSocketFactory) -> list[str]:
    """The ``text`` of every ``Generate`` frame, in order."""
    return [frame["text"] for frame in sent(factory) if frame["type"] == "Generate"]

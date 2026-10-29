"""Replay one recorded synthesis session and compare it with its pins (ticket 56).

A fixture is a JSON document under ``cascade/fixtures/tts/``: the session's
``Begin`` frame, the vendor frames that follow it, and the projection the
caller must observe. :func:`assert_parity` replays the document through the
production adapter over the ticket-01 scripted socket factory, projects the
call record, and raises with the fixture's name and the drifted fields when a
pin moves.

The document schema is closed on purpose. An unknown document field, an item
in the wrong place for its ``kind``, or an expectation the projection would not
produce is refused by name, so a typo cannot hide an unpinned contract. A
fixture that no longer opens is an error, never a skip.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from cascade.assemblyai_tts import (
    ECHO_FIELDS,
    AssemblyAIStreamingTTS,
    SynthesisCallFailure,
)
from cascade.testing.socket_factory import ScriptedSocketFactory

#: Explicitly supplied so no test can depend on a vendor key in the environment.
TEST_KEY = "test-tts-key"

FIXTURE_DIR = Path(__file__).with_name("fixtures") / "tts"

#: Which document fields each ``kind`` may carry. A ``close_code`` in a
#: ``speak`` fixture is a schema error, not an ignored key.
KIND_FIELDS = {
    "open": frozenset({"transport", "voice_id", "begin", "frames"}),
    "speak": frozenset({"transport", "voice_id", "begin", "frames", "text"}),
    "terminate": frozenset({"transport", "voice_id", "begin", "frames", "text"}),
    "cancel": frozenset({"transport", "voice_id", "begin", "frames", "text", "tail"}),
    "close": frozenset({"transport", "voice_id", "begin", "frames", "close_code"}),
}

#: The projection fields each kind pins, exactly: a pinned field that the
#: projection would not produce is refused, and an omission would let a known
#: field drift silently.
EXPECT_FIELDS = {
    "open": frozenset(
        {
            "url_params",
            "echo",
            "expires_at",
            "limits",
            "unknown_params",
            "mismatches",
            "sent",
            "error",
        }
    ),
    "speak": frozenset(
        {
            "sent",
            "sent_at_first_audio",
            "chunks",
            "audio_bytes",
            "flush_math",
            "audio_losses",
            "flush_id",
            "failures",
            "error",
        }
    ),
    "cancel": frozenset(
        {
            "sent",
            "tail_chunks",
            "cancellations",
            "flush_id",
            "audio_bytes",
            "failures",
            "error",
        }
    ),
    "terminate": frozenset(
        {
            "sent",
            "chunks",
            "final_flush",
            "residual_audio_bytes",
            "billing",
            "word_boundaries_status",
            "flush_math",
            "error",
        }
    ),
    "close": frozenset(
        {
            "sent",
            "action",
            "failure_class",
            "retried",
            "needs_reconnect",
            "reconnects",
            "breaker_opens",
            "alerts",
            "failures",
            "visible",
            "call_ended",
            "error",
        }
    ),
}


class FixtureError(AssertionError):
    """A fixture cannot be read, replayed, or matched to its pins."""


def load(name: str) -> dict[str, Any]:
    """Read one fixture by file stem, refusing a missing or malformed document."""
    path = FIXTURE_DIR / f"{name}.json"
    if not path.is_file():
        raise FixtureError(f"fixture {name!r} does not exist at {path}")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise FixtureError(f"fixture {name!r} is not valid JSON: {exc}") from None
    validate_document(document, expected_name=name)
    return document


def validate_document(
    document: object, *, expected_name: str | None = None
) -> None:
    """Refuse a document the replay could not produce, naming the fixture."""
    if not isinstance(document, dict):
        raise FixtureError("a fixture document must be a JSON object")
    name = document.get("name")
    label = name if isinstance(name, str) else expected_name
    if expected_name is not None and name != expected_name:
        raise FixtureError(f"fixture file {expected_name!r} names itself {name!r}")
    if not isinstance(name, str) or not name:
        raise FixtureError(f"fixture {label!r} has no name")
    description = document.get("description")
    if not isinstance(description, str) or not description:
        raise FixtureError(f"fixture {name!r} has no description")
    kind = document.get("kind")
    if kind not in KIND_FIELDS:
        raise FixtureError(
            f"fixture {name!r} has unknown kind {kind!r}; known kinds: "
            f"{', '.join(sorted(KIND_FIELDS))}"
        )
    allowed = {"name", "description", "kind", "expect"} | KIND_FIELDS[kind]
    unknown = sorted(set(document) - allowed)
    if unknown:
        raise FixtureError(
            f"fixture {name!r} has field(s) {', '.join(unknown)} that kind "
            f"{kind!r} cannot replay"
        )
    required = {"name", "description", "kind", "begin", "frames", "expect"}
    missing = sorted(required - set(document))
    if missing:
        raise FixtureError(f"fixture {name!r} is missing {', '.join(missing)}")
    if not isinstance(document["begin"], dict):
        raise FixtureError(f"fixture {name!r} begin must be a Begin frame object")
    if document["begin"].get("type") != "Begin":
        raise FixtureError(f"fixture {name!r} begin must have type 'Begin'")
    frames = document["frames"]
    if not isinstance(frames, list):
        raise FixtureError(f"fixture {name!r} frames must be a list")
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
            raise FixtureError(
                f"fixture {name!r} frame {index} must be an object with a type"
            )
    expect = document["expect"]
    if not isinstance(expect, dict):
        raise FixtureError(f"fixture {name!r} expect must be an object")
    unknown = sorted(set(expect) - EXPECT_FIELDS[kind])
    if unknown:
        raise FixtureError(
            f"fixture {name!r} pins unknown expectation field(s) "
            f"{', '.join(unknown)} for kind {kind!r}"
        )
    missing = sorted(EXPECT_FIELDS[kind] - set(expect))
    if missing:
        raise FixtureError(
            f"fixture {name!r} does not pin {', '.join(missing)}; an unpinned "
            "known field could drift silently"
        )
    if kind == "close" and not isinstance(document.get("close_code"), int):
        raise FixtureError(f"fixture {name!r} close_code must be an integer")
    if kind in {"speak", "terminate", "cancel"} and not isinstance(
        document.get("text"), str
    ):
        raise FixtureError(f"fixture {name!r} text must be a string")
    if kind == "cancel" and not isinstance(document.get("tail"), str):
        raise FixtureError(f"fixture {name!r} tail must be a string")


def _begin_json(document: dict[str, Any]) -> str:
    return json.dumps(document["begin"])


def _frames_json(document: dict[str, Any]) -> list[str]:
    return [json.dumps(frame) for frame in document["frames"]]


def _session(
    document: dict[str, Any],
) -> tuple[AssemblyAIStreamingTTS, ScriptedSocketFactory]:
    """Open one session over the recorded plan, before anything is sent."""
    begin = _begin_json(document)
    factory = ScriptedSocketFactory(
        [[begin, *_frames_json(document)], [begin]]
    )
    tts = AssemblyAIStreamingTTS(
        voice_id=document.get("voice_id", "anna"),
        transport=document.get("transport", "browser"),
        api_key=TEST_KEY,
        socket_factory=factory,
    )
    return tts, factory


def _sent(factory: ScriptedSocketFactory) -> list[dict[str, Any]]:
    socket = factory.socket
    if socket is None:
        return []
    return [json.loads(message) for message in socket.sent]


def _error_name(exc: BaseException | None) -> str | None:
    return None if exc is None else type(exc).__name__


def _mismatch(mismatch: Any) -> dict[str, Any]:
    return {
        "field": mismatch.field,
        "requested": mismatch.requested,
        "echoed": mismatch.echoed,
    }


def _project_open(
    tts: AssemblyAIStreamingTTS,
    factory: ScriptedSocketFactory,
    exc: BaseException | None,
) -> dict[str, Any]:
    configuration = dict(tts.configuration)
    return {
        "url_params": dict(parse_qsl(urlsplit(tts.url).query)),
        "echo": {field: configuration.get(field) for field in ECHO_FIELDS},
        "expires_at": tts.expires_at,
        "limits": dict(tts.limits),
        "unknown_params": list(tts.unknown_params),
        "mismatches": [_mismatch(item) for item in tts.begin_mismatches],
        "sent": _sent(factory),
        "error": _error_name(exc),
    }


def _chunks(chunks: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "text": chunk.text,
            "sample_rate": chunk.sample_rate,
            "bytes": len(chunk.pcm),
        }
        for chunk in chunks
    ]


def _flush_math(tts: AssemblyAIStreamingTTS) -> list[dict[str, Any]]:
    """Each request's received audio in ms against the vendor's own report."""
    rows: list[dict[str, Any]] = []
    for key in tts.request_order:
        request = tts.requests[key]
        derived = request.derived_audio_duration_ms
        reported = request.audio_duration_ms
        if derived is None and reported is None:
            continue
        rows.append(
            {
                "flush_id": request.flush_id,
                "reported_ms": reported,
                "derived_ms": None if derived is None else round(derived, 3),
                "delta_ms": (
                    None
                    if derived is None or reported is None
                    else round(derived - reported, 3)
                ),
            }
        )
    return rows


def _losses(tts: AssemblyAIStreamingTTS) -> list[dict[str, Any]]:
    return [
        {
            "flush_id": loss.flush_id,
            "reported_ms": loss.reported_ms,
            "derived_ms": round(loss.derived_ms, 3),
            "delta_ms": round(loss.delta_ms, 3),
            "audio_bytes": loss.audio_bytes,
        }
        for loss in tts.audio_losses
    ]


def _failure_classes(tts: AssemblyAIStreamingTTS) -> list[str]:
    return [verdict.failure_class.value for verdict in tts.failures]


def _project_speak(
    tts: AssemblyAIStreamingTTS,
    factory: ScriptedSocketFactory,
    trace: "_Trace",
    exc: BaseException | None,
) -> dict[str, Any]:
    return {
        "sent": _sent(factory),
        "sent_at_first_audio": trace.sent_at_first_audio,
        "chunks": _chunks(trace.chunks),
        "audio_bytes": tts.audio_bytes,
        "flush_math": _flush_math(tts),
        "audio_losses": _losses(tts),
        "flush_id": tts.flush_id,
        "failures": _failure_classes(tts),
        "error": _error_name(exc),
    }


def _cancellation(cancellation: Any) -> dict[str, Any]:
    return {
        "audio_duration_seconds": cancellation.audio_duration_seconds,
        "dropped_audio_bytes": cancellation.dropped_audio_bytes,
        "dropped_flushes": cancellation.dropped_flushes,
        "discarded_characters": cancellation.discarded_characters,
        "next_flush_id": cancellation.next_flush_id,
        "acknowledged": cancellation.acknowledged,
    }


def _project_cancel(
    tts: AssemblyAIStreamingTTS,
    factory: ScriptedSocketFactory,
    trace: "_Trace",
    exc: BaseException | None,
) -> dict[str, Any]:
    return {
        "sent": _sent(factory),
        "tail_chunks": _chunks(trace.tail_chunks),
        "cancellations": [_cancellation(item) for item in tts.cancellations],
        "flush_id": tts.flush_id,
        "audio_bytes": tts.audio_bytes,
        "failures": _failure_classes(tts),
        "error": _error_name(exc),
    }


@dataclass
class _Trace:
    """What the caller observed, kept across the exception a fixture may record."""

    chunks: list[Any] = field(default_factory=list)
    tail_chunks: list[Any] = field(default_factory=list)
    sent_at_first_audio: int | None = None
    termination: Any = None
    decision: Any = None


def _billing(billing: Any) -> dict[str, Any]:
    return {
        "characters": billing.characters,
        "measured": billing.measured,
        "source": billing.source,
        "total_input_char_length": billing.total_input_char_length,
        "audio_duration_seconds": billing.audio_duration_seconds,
        "session_duration_seconds": billing.session_duration_seconds,
        "audio_bytes": billing.audio_bytes,
    }


def _final_flush(request: Any) -> dict[str, Any] | None:
    if request is None:
        return None
    derived = request.derived_audio_duration_ms
    return {
        "flush_id": request.flush_id,
        "reported_ms": request.audio_duration_ms,
        "derived_ms": None if derived is None else round(derived, 3),
    }


def _project_terminate(
    tts: AssemblyAIStreamingTTS,
    factory: ScriptedSocketFactory,
    trace: "_Trace",
    exc: BaseException | None,
) -> dict[str, Any]:
    record = trace.termination
    return {
        "sent": _sent(factory),
        "chunks": _chunks(trace.chunks),
        "final_flush": _final_flush(
            record.final_flush if record is not None else None
        ),
        "residual_audio_bytes": (
            len(record.residual_audio) if record is not None else 0
        ),
        "billing": _billing(record.billing if record is not None else tts.billing),
        "word_boundaries_status": tts.word_boundaries_status,
        "flush_math": _flush_math(tts),
        "error": _error_name(exc),
    }


def _project_close(
    tts: AssemblyAIStreamingTTS,
    factory: ScriptedSocketFactory,
    trace: "_Trace",
    exc: BaseException | None,
) -> dict[str, Any]:
    decision = trace.decision
    if decision is not None:
        failure_class = decision.verdict.failure_class.value
    elif tts.failures:
        failure_class = tts.failures[-1].failure_class.value
    else:
        failure_class = None
    failure = exc if isinstance(exc, SynthesisCallFailure) else None
    return {
        "sent": _sent(factory),
        "action": None if decision is None else decision.action.value,
        "failure_class": failure_class,
        "retried": False if decision is None else decision.retried,
        "needs_reconnect": tts.needs_reconnect,
        "reconnects": tts.reconnects,
        "breaker_opens": len(tts.breaker_opens),
        "alerts": len(tts.alerts),
        "failures": _failure_classes(tts),
        "visible": None if failure is None else failure.visible,
        "call_ended": None if failure is None else failure.call_ended,
        "error": _error_name(exc),
    }


def _sent_count(factory: ScriptedSocketFactory) -> int:
    socket = factory.socket
    return 0 if socket is None else len(socket.sent)


async def _speak(
    tts: AssemblyAIStreamingTTS,
    factory: ScriptedSocketFactory,
    text: str,
    trace: "_Trace",
) -> None:
    """Drain one reply, noting how many frames had been sent at first audio."""
    async for chunk in tts.speak(text):
        if trace.sent_at_first_audio is None:
            trace.sent_at_first_audio = _sent_count(factory)
        trace.chunks.append(chunk)


async def _cancel_then_tail(
    tts: AssemblyAIStreamingTTS,
    text: str,
    tail: str,
    trace: "_Trace",
) -> None:
    """Cut the reply after its first chunk, then speak the tail on a new request."""
    generator = tts.speak(text)
    trace.chunks.append(await generator.__anext__())
    await tts.cancel()
    try:
        await generator.__anext__()
    except StopAsyncIteration:
        pass
    else:
        raise FixtureError("a cancelled reply yielded another chunk after Cancel")
    async for chunk in tts.speak(tail):
        trace.tail_chunks.append(chunk)


async def _terminate(
    tts: AssemblyAIStreamingTTS, text: str, trace: "_Trace"
) -> None:
    if text:
        async for chunk in tts.speak(text):
            trace.chunks.append(chunk)
    trace.termination = await tts.terminate()


async def _close(tts: AssemblyAIStreamingTTS, code: int, trace: "_Trace") -> None:
    trace.decision = await tts.handle_close(code)


def replay(document: dict[str, Any]) -> dict[str, Any]:
    """Replay one fixture and return what the caller and the call record observe."""
    validate_document(document)
    kind = document["kind"]
    if kind not in EXPECT_FIELDS:
        raise FixtureError(
            f"fixture {document['name']!r}: kind {kind!r} has no replay yet"
        )
    tts, factory = _session(document)
    trace = _Trace()
    exc: BaseException | None = None
    try:
        asyncio.run(tts.open())
        if kind == "speak":
            asyncio.run(_speak(tts, factory, document["text"], trace))
        elif kind == "cancel":
            asyncio.run(
                _cancel_then_tail(tts, document["text"], document["tail"], trace)
            )
        elif kind == "terminate":
            asyncio.run(_terminate(tts, document["text"], trace))
        elif kind == "close":
            asyncio.run(_close(tts, document["close_code"], trace))
    except Exception as caught:  # recorded as the fixture's outcome, never a skip
        exc = caught
    if kind == "open":
        return _project_open(tts, factory, exc)
    if kind == "speak":
        return _project_speak(tts, factory, trace, exc)
    if kind == "cancel":
        return _project_cancel(tts, factory, trace, exc)
    if kind == "terminate":
        return _project_terminate(tts, factory, trace, exc)
    return _project_close(tts, factory, trace, exc)


def assert_parity(document: dict[str, Any]) -> dict[str, Any]:
    """Replay one fixture and fail by name on the first pinned field that moved."""
    actual = replay(document)
    expected = document["expect"]
    drifted = [
        field for field in sorted(EXPECT_FIELDS[document["kind"]])
        if actual[field] != expected[field]
    ]
    if drifted:
        detail = "; ".join(
            f"{field} pinned {expected[field]!r}, replayed {actual[field]!r}"
            for field in drifted
        )
        raise AssertionError(
            f"fixture {document['name']!r} drifted at "
            f"{', '.join(drifted)}: {detail}"
        )
    return actual

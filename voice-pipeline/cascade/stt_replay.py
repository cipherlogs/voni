"""Replay one recorded speech session and compare it with its pins (ticket 34).

A fixture is a JSON document under ``cascade/fixtures/stt/``: the plan the
vendor socket replays, the audio the caller sent (when the fixture is about the
audio path), the close the call observed, and the projection the caller and the
call record must see. :func:`assert_parity` replays the document through the
production :class:`cascade.meta_stt.MetaStreamingSTT` over the ticket-01
scripted socket factory and fake clock, projects what the adapter exposes, and
raises with the fixture's name and the drifted fields when a pin moves.

The document schema is closed on purpose. An unknown document field, a frame
with two payloads, a session ending the projection would not produce, or an
expectation the replay could not pin is refused by name, so a typo cannot hide
an unpinned contract. A fixture that can no longer be produced is an error,
never a skip.

No credential is read from the environment: the replay supplies an explicit
test key, so the suite runs in the Python CI job untouched.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from cascade.meta_stt import (
    SAMPLE_RATE,
    MetaStreamingSTT,
    SpeechCallFailure,
)
from cascade.testing.clock import FakeClock
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from metrics import TimingLedger

#: Explicitly supplied so no test can depend on a vendor key in the environment.
TEST_KEY = "test-meta-key"
CALL_ID = "call-123"

FIXTURE_DIR = Path(__file__).with_name("fixtures") / "stt"

#: Which document fields each ``kind`` may carry. A ``close`` object in an
#: ``events`` fixture is a schema error, not an ignored key.
KIND_FIELDS = {
    "handshake": frozenset({"open", "plans"}),
    "events": frozenset({"open", "plans"}),
    "audio": frozenset({"open", "plans", "audio"}),
    "close": frozenset({"open", "plans", "close"}),
    "lifetime": frozenset({"open", "plans", "end"}),
    "overlap": frozenset({"open", "plans"}),
}

#: The projection fields every kind pins, plus the kind's own rows. Exactly
#: these are required: an omission would let a known field drift silently, and
#: a pinned field the projection never produces would be a typo.
BASE_EXPECT = frozenset(
    {"sent", "connections", "session_ids", "acked", "epoch", "error"}
)
EXPECT_FIELDS = {
    "handshake": BASE_EXPECT | {"failure_reason"},
    "events": BASE_EXPECT | {"events", "turns", "stale_events"},
    "audio": BASE_EXPECT | {"events", "dropped_frames"},
    "close": BASE_EXPECT
    | {
        "events",
        "action",
        "failure_class",
        "retried",
        "backoff",
        "reconnects",
        "failures",
        "breaker_opens",
        "alerts",
        "session_endings",
        "ledger_marks",
    },
    "lifetime": BASE_EXPECT
    | {"events", "reconnects", "failures", "session_endings", "ledger_marks"},
    "overlap": BASE_EXPECT | {"events", "turns", "stale_events"},
}

FRAME_FIELDS = frozenset(
    {
        "json",
        "text",
        "binary_hex",
        "close_code",
        "error",
        "delay_ms",
        "repeat",
        "reason",
    }
)
AUDIO_FIELDS = frozenset(
    {"audio_ms", "value", "pcm_hex", "text", "silence_ms", "advance_ms"}
)
OPEN_FIELDS = frozenset({"language_codes", "keyterms"})
CLOSE_FIELDS = frozenset({"code", "reason"})
ERROR_KINDS = frozenset({"connection_reset", "no_code"})


class FixtureError(AssertionError):
    """A fixture cannot be read, replayed, or matched to its pins."""


class ClosedWithoutCode(ConnectionError):
    """A dropped socket: ``websockets``-shaped, with no close code and a reason.

    The production adapter reads ``.code`` and ``.reason`` through
    ``getattr``, so this is a fault script value, not an adapter dependency.
    """

    code = None

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


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


def _refuse(name: str, reason: str) -> FixtureError:
    return FixtureError(f"fixture {name!r} {reason}")


def validate_document(
    document: object, *, expected_name: str | None = None
) -> None:
    """Refuse a document the replay could not produce, naming the fixture."""
    if not isinstance(document, dict):
        raise FixtureError("a fixture document must be a JSON object")
    name = document.get("name")
    label = name if isinstance(name, str) and name else expected_name
    if expected_name is not None and name != expected_name:
        raise _refuse(str(expected_name), f"names itself {name!r}")
    if not isinstance(name, str) or not name:
        raise _refuse(str(label), "has no name")
    description = document.get("description")
    if not isinstance(description, str) or not description:
        raise _refuse(name, "has no description")
    kind = document.get("kind")
    if kind not in KIND_FIELDS:
        raise _refuse(
            name,
            f"has unknown kind {kind!r}; known kinds: "
            f"{', '.join(sorted(KIND_FIELDS))}",
        )

    allowed = {"name", "description", "kind", "expect"} | KIND_FIELDS[kind]
    unknown = sorted(set(document) - allowed)
    if unknown:
        raise _refuse(
            name,
            f"has field(s) {', '.join(unknown)} that kind {kind!r} cannot replay",
        )
    missing = sorted({"plans", "expect"} - set(document))
    if missing:
        raise _refuse(name, f"is missing {', '.join(missing)}")

    _validate_open(document.get("open"), name)
    _validate_plans(document["plans"], name)

    if kind == "audio":
        if "audio" not in document:
            raise _refuse(name, "has no audio steps")
        _validate_audio(document["audio"], name)
    if kind == "close":
        _validate_close(document.get("close"), name)
    if kind == "lifetime" and "end" in document and document["end"] != "deliberate":
        raise _refuse(name, f"has unknown end {document['end']!r}")

    expect = document["expect"]
    if not isinstance(expect, dict):
        raise _refuse(name, "expect must be an object")
    unknown = sorted(set(expect) - EXPECT_FIELDS[kind])
    if unknown:
        raise _refuse(
            name,
            f"pins unknown expectation field(s) {', '.join(unknown)} "
            f"for kind {kind!r}",
        )
    missing = sorted(EXPECT_FIELDS[kind] - set(expect))
    if missing:
        raise _refuse(
            name,
            f"does not pin {', '.join(missing)}; an unpinned known field "
            "could drift silently",
        )


def _validate_open(value: Any, name: str) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise _refuse(name, "open must be an object")
    unknown = sorted(set(value) - OPEN_FIELDS)
    if unknown:
        raise _refuse(name, f"open has unknown field(s) {', '.join(unknown)}")
    for field in ("language_codes", "keyterms"):
        if field in value and not (
            isinstance(value[field], list)
            and all(isinstance(item, str) for item in value[field])
        ):
            raise _refuse(name, f"open.{field} must be a list of strings")


def _validate_plans(plans: Any, name: str) -> None:
    if not isinstance(plans, list) or not plans:
        raise _refuse(name, "plans must be a non-empty list of socket plans")
    for index, plan in enumerate(plans):
        if not isinstance(plan, list):
            raise _refuse(name, f"plan {index} must be a list of frames")
        for frame_index, frame in enumerate(plan):
            _validate_frame(frame, name, index, frame_index)


def _validate_frame(frame: Any, name: str, plan: int, index: int) -> None:
    where = f"frame {index} of plan {plan}"
    if not isinstance(frame, dict):
        raise _refuse(name, f"{where} must be an object")
    unknown = sorted(set(frame) - FRAME_FIELDS)
    if unknown:
        raise _refuse(name, f"{where} has unknown field(s) {', '.join(unknown)}")
    payloads = [
        field
        for field in ("json", "text", "binary_hex", "close_code", "error")
        if field in frame
    ]
    if len(payloads) != 1:
        raise _refuse(
            name,
            f"{where} needs exactly one of json, text, binary_hex, close_code "
            f"or error, got {payloads or 'none'}",
        )
    if "json" in frame and not isinstance(frame["json"], dict):
        raise _refuse(name, f"{where} json must be an object")
    if "text" in frame and not isinstance(frame["text"], str):
        raise _refuse(name, f"{where} text must be a string")
    if "binary_hex" in frame:
        try:
            bytes.fromhex(frame["binary_hex"])
        except (TypeError, ValueError):
            raise _refuse(name, f"{where} binary_hex must be a hex string") from None
    if "close_code" in frame and not isinstance(frame["close_code"], int):
        raise _refuse(name, f"{where} close_code must be an integer")
    if "error" in frame and frame["error"] not in ERROR_KINDS:
        raise _refuse(
            name,
            f"{where} error must be one of {', '.join(sorted(ERROR_KINDS))}",
        )
    if "delay_ms" in frame and (
        not isinstance(frame["delay_ms"], (int, float)) or frame["delay_ms"] < 0
    ):
        raise _refuse(name, f"{where} delay_ms must be a non-negative number")
    if "repeat" in frame and (
        not isinstance(frame["repeat"], int) or frame["repeat"] < 1
    ):
        raise _refuse(name, f"{where} repeat must be an integer of at least 1")
    if "reason" in frame and not isinstance(frame["reason"], str):
        raise _refuse(name, f"{where} reason must be a string")


def _validate_audio(steps: Any, name: str) -> None:
    if not isinstance(steps, list) or not steps:
        raise _refuse(name, "audio must be a non-empty list of steps")
    for index, step in enumerate(steps):
        where = f"audio step {index}"
        if not isinstance(step, dict):
            raise _refuse(name, f"{where} must be an object")
        unknown = sorted(set(step) - AUDIO_FIELDS)
        if unknown:
            raise _refuse(name, f"{where} has unknown field(s) {', '.join(unknown)}")
        payloads = [
            field
            for field in ("audio_ms", "pcm_hex", "text", "silence_ms")
            if field in step
        ]
        if len(payloads) != 1 and not (not payloads and "advance_ms" in step):
            raise _refuse(
                name,
                f"{where} needs exactly one of audio_ms, pcm_hex, text or "
                f"silence_ms (or advance_ms alone for a clock tick), got "
                f"{payloads or 'none'}",
            )
        if "value" in step and "audio_ms" not in step:
            raise _refuse(name, f"{where} value only applies to audio_ms")
        if "audio_ms" in step and (
            not isinstance(step["audio_ms"], (int, float))
            or step["audio_ms"] < 0
        ):
            raise _refuse(name, f"{where} audio_ms must be a non-negative number")
        if "silence_ms" in step and (
            not isinstance(step["silence_ms"], (int, float))
            or step["silence_ms"] < 0
        ):
            raise _refuse(name, f"{where} silence_ms must be a non-negative number")
        if "pcm_hex" in step:
            try:
                bytes.fromhex(step["pcm_hex"])
            except (TypeError, ValueError):
                raise _refuse(name, f"{where} pcm_hex must be a hex string") from None
        if "text" in step and not isinstance(step["text"], str):
            raise _refuse(name, f"{where} text must be a string")
        if "advance_ms" in step and (
            not isinstance(step["advance_ms"], (int, float))
            or step["advance_ms"] < 0
        ):
            raise _refuse(name, f"{where} advance_ms must be a non-negative number")


def _validate_close(close: Any, name: str) -> None:
    if not isinstance(close, dict):
        raise _refuse(name, "close must be an object")
    unknown = sorted(set(close) - CLOSE_FIELDS)
    if unknown:
        raise _refuse(name, f"close has unknown field(s) {', '.join(unknown)}")
    if "code" not in close:
        raise _refuse(name, "close has no code (use null for no code)")
    if close["code"] is not None and not isinstance(close["code"], int):
        raise _refuse(name, "close.code must be an integer or null")
    if not isinstance(close.get("reason", ""), str):
        raise _refuse(name, "close.reason must be a string")


def _frame(spec: dict[str, Any]) -> Frame:
    extra: dict[str, Any] = {}
    if "json" in spec:
        extra["data"] = json.dumps(spec["json"])
    elif "text" in spec:
        extra["data"] = spec["text"]
    elif "binary_hex" in spec:
        extra["data"] = bytes.fromhex(spec["binary_hex"])
    elif "close_code" in spec:
        extra["close_code"] = spec["close_code"]
    else:
        kind = spec["error"]
        reason = spec.get("reason", "")
        if kind == "no_code":
            extra["exc"] = ClosedWithoutCode(reason or "socket vanished")
        else:
            extra["exc"] = ConnectionResetError(
                reason or "scripted connection reset"
            )
    if "delay_ms" in spec:
        extra["delay_ms"] = spec["delay_ms"]
    if "repeat" in spec:
        extra["repeat"] = spec["repeat"]
    if "reason" in spec:
        extra["reason"] = spec["reason"]
    return Frame(**extra)


def _plans(document: dict[str, Any]) -> list[list[Frame]]:
    return [[_frame(spec) for spec in plan] for plan in document["plans"]]


def _pcm_step(step: dict[str, Any]) -> Any:
    """The payload one audio step hands to the adapter."""
    if "audio_ms" in step:
        samples = int(step["audio_ms"] * SAMPLE_RATE / 1000.0)
        value = int(step.get("value", 1))
        return value.to_bytes(2, "little", signed=True) * samples
    if "pcm_hex" in step:
        return bytes.fromhex(step["pcm_hex"])
    if "text" in step:
        return step["text"]
    return step["silence_ms"]  # a duration, not PCM: send_silence


def _normalise_sent(message: str | bytes) -> dict[str, Any]:
    """One client frame as a pin: JSON as itself, binary by size and hash."""
    if isinstance(message, bytes):
        return {
            "bytes": len(message),
            "sha256": hashlib.sha256(message).hexdigest()[:16],
            "silence": not any(message),
        }
    try:
        parsed = json.loads(message)
    except json.JSONDecodeError:
        return {"text": message}
    return parsed if isinstance(parsed, dict) else {"text": message}


def _sent(factory: ScriptedSocketFactory) -> list[list[dict[str, Any]]]:
    return [
        [_normalise_sent(message) for message in connection["socket"].sent]
        for connection in factory.connections
    ]


def _session_ids(factory: ScriptedSocketFactory) -> list[str]:
    ids: list[str] = []
    for connection in factory.connections:
        query = parse_qs(urlsplit(connection["url"]).query)
        ids.append(query.get("sessionId", [""])[0])
    return ids


def _event_row(event: Any) -> dict[str, Any]:
    row: dict[str, Any] = {"type": type(event).__name__}
    text = getattr(event, "text", None)
    if text is not None:
        row["text"] = text
    turn_id = getattr(event, "turn_id", None)
    if turn_id is not None:
        row["turn_id"] = turn_id
    if hasattr(event, "session_epoch"):
        row["session_epoch"] = event.session_epoch
    return row


def _turn_row(turn: Any) -> dict[str, Any]:
    return {
        "session_epoch": turn.id.session_epoch,
        "turn_id": turn.id.provider_turn_id,
        "phase": turn.phase.value,
        "partial_text": turn.partial_text,
        "partial_updates": turn.partial_updates,
        "final_text": turn.final_text,
        "duplicate_finals": turn.duplicate_finals,
    }


def _failure_row(verdict: Any) -> dict[str, Any]:
    return {"code": verdict.code, "class": verdict.failure_class.value}


def _ending_row(ending: Any) -> dict[str, Any]:
    return {
        "epoch": ending.epoch,
        "kind": ending.kind.value,
        "code": ending.code,
        "planned": ending.planned,
        "end_stream_sent": ending.end_stream_sent,
    }


def _error_name(exc: BaseException | None) -> str | None:
    return None if exc is None else type(exc).__name__


def _project(
    backend: MetaStreamingSTT,
    factory: ScriptedSocketFactory,
    ledger: TimingLedger,
    events: list[Any],
    decision: Any,
    exc: BaseException | None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "sent": _sent(factory),
        "connections": len(factory.connections),
        "session_ids": _session_ids(factory),
        "acked": backend.acked,
        "epoch": backend.epoch,
        "error": _error_name(exc),
        "failure_reason": backend.failure_reason,
        "events": [_event_row(event) for event in events],
        "turns": [_turn_row(turn) for turn in backend.turns],
        "stale_events": backend.stale_events,
        "dropped_frames": backend.dropped_frames,
        "reconnects": backend.reconnects,
        "failures": [_failure_row(verdict) for verdict in backend.failures],
        "breaker_opens": len(backend.breaker_opens),
        "alerts": len(backend.alerts),
        "session_endings": [
            _ending_row(ending) for ending in backend.session_ledger
        ],
        "ledger_marks": sorted(ledger.summary()["marks"]),
    }
    if decision is not None:
        row["action"] = decision.action.value
        row["failure_class"] = decision.verdict.failure_class.value
        row["retried"] = decision.retried
        row["backoff"] = decision.backoff
    elif isinstance(exc, SpeechCallFailure):
        row["action"] = "fail"
        row["failure_class"] = exc.verdict.failure_class.value
        row["retried"] = False
        row["backoff"] = exc.backoff
    else:
        row["action"] = None
        row["failure_class"] = None
        row["retried"] = False
        row["backoff"] = False
    # Only the pinned rows matter; the projection is shared by every kind and
    # assert_parity compares exactly the kind's fields.
    return row


def replay(document: dict[str, Any]) -> dict[str, Any]:
    """Replay one fixture and return what the caller and the call record observe."""
    validate_document(document)
    kind = document["kind"]
    clock = FakeClock()
    factory = ScriptedSocketFactory(_plans(document), clock=clock)
    ledger = TimingLedger(now=clock)
    options = document.get("open") or {}
    backend = MetaStreamingSTT(
        call_id=CALL_ID,
        api_key=TEST_KEY,
        socket_factory=factory,
        clock=clock,
        ledger=ledger,
        keyterms=options.get("keyterms", ()),
    )
    events: list[Any] = []
    decision: Any = None
    exc: BaseException | None = None

    async def scenario() -> None:
        nonlocal decision
        await backend.open(
            language_codes=list(options.get("language_codes", [])),
            sample_rate=SAMPLE_RATE,
        )
        if kind == "handshake":
            return
        if kind == "close":
            close = document["close"]
            decision = await backend.handle_close(
                close["code"], reason=close.get("reason", "")
            )
            return
        if kind == "audio":
            for step in document["audio"]:
                if step.get("advance_ms"):
                    clock.advance_ms(step["advance_ms"])
                if not any(
                    field in step
                    for field in ("audio_ms", "pcm_hex", "text", "silence_ms")
                ):
                    continue
                payload = _pcm_step(step)
                if "silence_ms" in step:
                    await backend.send_silence(payload / 1000.0)
                else:
                    await backend.send_audio(payload)
        events.extend([event async for event in backend.events()])
        if kind == "lifetime" and document.get("end") == "deliberate":
            await backend.close()

    try:
        asyncio.run(scenario())
    except Exception as caught:  # recorded as the fixture's outcome, never a skip
        exc = caught
    return _project(backend, factory, ledger, events, decision, exc)


def assert_parity(document: dict[str, Any]) -> dict[str, Any]:
    """Replay one fixture and fail by name on the first pinned field that moved."""
    actual = replay(document)
    expected = document["expect"]
    fields = EXPECT_FIELDS[document["kind"]]
    drifted = [
        field for field in sorted(fields) if actual[field] != expected[field]
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

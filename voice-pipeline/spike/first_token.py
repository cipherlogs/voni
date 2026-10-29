"""Term 3 of the M00 latency spike: ``speechComplete`` -> Spark's first content.

The number is the wall-clock gap between the receipt of ``speechComplete`` (the
moment the LLM request is issued) and the first delta that carries **content**.
Spark always reasons: ``reasoning_content`` deltas arrive before anything the
caller can hear, so counting the first delta at all would report a fast model
that says nothing. Only a non-empty ``content`` delta marks the term; a
reasoning-only stream is reported as unmeasured, never as a fast first token.

``reasoning_effort: "none"`` is not a candidate to try: Spark answers it with
HTTP 400 (spec M0, verified vendor facts 2026-10-29). The spike reports it as
an unavailable row carrying the recorded status, and the report requires the
default and the lowest supported effort instead. The lowest value is named by a
live probe, never guessed here: an unresolved lowest row is unmeasured and says
why.

The transport is injected. Synthetic SSE traces drive the offline tests; a live
stream drives the owner-gated run. Arrival times come from the injected clock,
so removing the clock read or the content classification fails a test. An
unmeasured term always carries a producer line and ``first_content_ms=None``;
no time is ever fabricated.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

#: The report's term name: think (``speechComplete`` -> first content token).
TERM = "first_content_token_ms"

MODEL = "muse-spark-1.3"
ENDPOINT = "https://api.meta.ai/v1/chat/completions"

DEFAULT_LABEL = "default"
LOWEST_LABEL = "lowest"
#: The report must carry both rows; a missing one is refused by name.
REQUIRED_LABELS = (DEFAULT_LABEL, LOWEST_LABEL)

#: Spark rejects this value with HTTP 400; it is reported, never sent.
UNAVAILABLE_EFFORT = "none"

_SEEN_HTTP = "spec M0 verified vendor facts 2026-10-29"


class FirstTokenError(RuntimeError):
    """The first-content term cannot be measured or reported honestly."""


class UnknownEffortLabelError(FirstTokenError):
    """The report has a closed set of effort rows."""


class EffortValueError(FirstTokenError):
    """An effort row carries a value its label cannot mean."""


class EffortSourceRequiredError(FirstTokenError):
    """A vendor effort value must say where it came from."""


class UnavailableEffortError(FirstTokenError):
    """The vendor rejects this effort value; it must never be requested."""

    def __init__(self, refusal: "EffortUnavailable") -> None:
        self.refusal = refusal
        super().__init__(
            f"reasoning_effort {refusal.effort!r} is unavailable: Spark answers "
            f"HTTP {refusal.status} ({refusal.source}); the spike reports it and "
            "never sends it"
        )


class MissingEffortError(FirstTokenError):
    """The report is missing the default or the lowest supported effort."""

    def __init__(self, missing: tuple[str, ...]) -> None:
        self.missing = missing
        super().__init__(
            "the spike must report both the default and the lowest supported "
            f"reasoning_effort; missing {', '.join(missing)}"
        )


class MissingProducerError(FirstTokenError):
    """A term without its producer line is not reportable (M00 test rule)."""


class SseFormatError(FirstTokenError):
    """A transport handed over a line that is not an SSE data payload."""


class HttpError(FirstTokenError):
    """The vendor refused the stream before any delta (recorded, not timed)."""

    def __init__(self, status: int, body: str | None = None) -> None:
        self.status = status
        self.body = body
        detail = body if body is not None else "<no response body captured>"
        super().__init__(f"Spark answered HTTP {status}: {detail}")


class StreamingTransport(Protocol):
    """The injected seam: yield raw SSE lines as they arrive.

    A live transport yields each line when the socket delivers it; a replayed
    trace yields it after advancing the injected clock. The measurement reads
    that clock on receipt, so the term is never a schedule the trace asserts.
    """

    name: str

    def stream(self, payload: Mapping[str, Any]) -> Iterator[str]: ...


@dataclass(frozen=True)
class EffortUnavailable:
    """An effort value the vendor refuses; a row, never a request."""

    effort: str
    status: int
    source: str
    body: str | None = None
    producer: str = ""

    @property
    def body_captured(self) -> bool:
        return self.body is not None

    def as_dict(self) -> dict[str, Any]:
        return {
            "effort": self.effort,
            "available": False,
            "status": self.status,
            "body": self.body,
            "body_captured": self.body_captured,
            "source": self.source,
            "producer": self.producer,
        }


PRODUCER_NONE = (
    f"spike.first_token: {ENDPOINT} model {MODEL}, reasoning_effort "
    f"{UNAVAILABLE_EFFORT!r} — vendor refusal recorded, request never sent"
)


def recorded_none_refusal(body: str | None = None) -> EffortUnavailable:
    """The recorded HTTP 400 for ``reasoning_effort: "none"``.

    The status is a verified vendor fact; the body is only carried when a live
    run captured one. No body is invented.
    """
    if body is None:
        source = (
            f"{_SEEN_HTTP}: reasoning_effort 'none' returns HTTP 400; response "
            "body not captured (no live key)"
        )
    else:
        source = "captured live from Spark: reasoning_effort 'none' returns HTTP 400"
    return EffortUnavailable(
        effort=UNAVAILABLE_EFFORT,
        status=400,
        source=source,
        body=body,
        producer=PRODUCER_NONE,
    )


@dataclass(frozen=True)
class Effort:
    """One ``reasoning_effort`` row of the measurement.

    ``reasoning_effort=None`` on the default row means "omit the field and take
    the vendor default". On the lowest row it means the vendor value has not
    been named yet: the row is unmeasured, never sent.
    """

    label: str
    reasoning_effort: str | None = None
    source: str = ""

    def __post_init__(self) -> None:
        if self.label not in REQUIRED_LABELS:
            raise UnknownEffortLabelError(
                f"unknown effort row {self.label!r}; the report has exactly "
                f"{', '.join(REQUIRED_LABELS)}"
            )
        value = self.reasoning_effort
        if value is None:
            return
        if value == UNAVAILABLE_EFFORT:
            raise UnavailableEffortError(recorded_none_refusal())
        if not value.strip():
            raise EffortValueError(f"effort row {self.label!r} has a blank value")
        if self.label == DEFAULT_LABEL:
            raise EffortValueError(
                "the default effort row is the vendor default: omit "
                "reasoning_effort instead of naming a value"
            )
        if not self.source.strip():
            raise EffortSourceRequiredError(
                f"effort row {self.label!r} names the vendor value {value!r} "
                "but not where that value came from"
            )

    @property
    def is_resolved(self) -> bool:
        """Whether the row has a value that can actually be requested."""
        return self.label == DEFAULT_LABEL or self.reasoning_effort is not None


DEFAULT_EFFORT = Effort(DEFAULT_LABEL)
#: Offline placeholder: the lowest supported value is a live-probe finding.
UNRESOLVED_LOWEST_EFFORT = Effort(LOWEST_LABEL)
DEFAULT_EFFORTS = (DEFAULT_EFFORT, UNRESOLVED_LOWEST_EFFORT)


def lowest_effort(value: str, *, source: str) -> Effort:
    """The lowest supported effort, named by a live probe or the vendor docs."""
    return Effort(LOWEST_LABEL, value, source)


def build_payload(effort: Effort, transcript: str) -> dict[str, Any]:
    """The Spark request for one measurement; the default omits the field."""
    if effort.reasoning_effort == UNAVAILABLE_EFFORT:
        raise UnavailableEffortError(recorded_none_refusal())
    if not effort.is_resolved:
        raise EffortValueError(
            f"effort row {effort.label!r} has no named vendor value; it cannot "
            "be requested"
        )
    payload: dict[str, Any] = {
        "model": MODEL,
        "messages": [{"role": "user", "content": transcript}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if effort.reasoning_effort is not None:
        payload["reasoning_effort"] = effort.reasoning_effort
    return payload


def parse_sse_line(line: str) -> dict[str, Any] | None:
    """Parse one SSE line into its JSON object, or ``None`` for non-data lines."""
    stripped = line.strip()
    if not stripped or stripped.startswith(":"):
        return None
    if not stripped.startswith("data:"):
        field = stripped.split(":", 1)[0]
        if field in ("event", "id", "retry"):
            return None
        raise SseFormatError(f"not an SSE data line: {line!r}")
    payload = stripped[len("data:") :].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as error:
        raise SseFormatError(f"SSE data is not JSON ({error}): {line!r}") from None
    if not isinstance(data, dict):
        raise SseFormatError(f"SSE data is not a JSON object: {line!r}")
    return data


def classify_chunk(data: Mapping[str, Any]) -> tuple[str, str]:
    """Classify a chunk: ``content`` wins over reasoning in the same delta."""
    if "error" in data:
        return ("error", str(data["error"]))
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ("other", "")
    choice = choices[0]
    if not isinstance(choice, dict):
        return ("other", "")
    delta = choice.get("delta")
    if not isinstance(delta, dict):
        return ("other", "")
    content = delta.get("content")
    if isinstance(content, str) and content != "":
        return ("content", content)
    reasoning = delta.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning != "":
        return ("reasoning", reasoning)
    if delta.get("tool_calls"):
        return ("tool_call", "")
    return ("other", "")


@dataclass(frozen=True)
class FirstContentTerm:
    """The measured term, or an explicit unmeasured row with its producer."""

    effort: Effort
    producer: str
    first_content_ms: float | None = None
    unmeasured_reason: str = ""
    reasoning_deltas: int = 0
    first_reasoning_ms: float | None = None
    content_deltas: int = 0
    tool_call_deltas: int = 0
    http_status: int | None = None
    http_body: str | None = None

    def __post_init__(self) -> None:
        if not self.producer.strip():
            raise MissingProducerError(
                f"term {TERM} for effort {self.effort.label!r} has no producer "
                "line; an unproduced measurement is a test failure"
            )

    @property
    def measured(self) -> bool:
        return self.first_content_ms is not None

    @property
    def reasoning_only(self) -> bool:
        return (
            self.reasoning_deltas > 0
            and self.content_deltas == 0
            and self.tool_call_deltas == 0
            and not self.measured
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "term": TERM,
            "effort": self.effort.label,
            "reasoning_effort": self.effort.reasoning_effort,
            "effort_source": self.effort.source,
            "first_content_ms": self.first_content_ms,
            "measured": self.measured,
            "reasoning_only": self.reasoning_only,
            "reasoning_deltas": self.reasoning_deltas,
            "first_reasoning_ms": self.first_reasoning_ms,
            "content_deltas": self.content_deltas,
            "tool_call_deltas": self.tool_call_deltas,
            "http_status": self.http_status,
            "http_body": self.http_body,
            "producer": self.producer,
            "unmeasured_reason": self.unmeasured_reason,
        }


@dataclass(frozen=True)
class TraceEvent:
    """One SSE line of a synthetic trace, timed from the stream's open."""

    at_ms: float
    data: str


@dataclass(frozen=True)
class Trace:
    """A recorded or synthetic Spark stream; ``error`` replays an HTTP refusal."""

    name: str
    events: tuple[TraceEvent, ...] = ()
    error: HttpError | None = None


class TraceTransport:
    """Replay a trace, advancing the injected clock to each event's arrival."""

    def __init__(
        self,
        trace: Trace,
        *,
        clock: Callable[[], float],
        advance: Callable[[float], None] | None = None,
    ) -> None:
        self.trace = trace
        self.name = trace.name
        self.clock = clock
        mover = advance or getattr(clock, "advance", None)
        if mover is None:
            raise TypeError(
                "TraceTransport needs an advance(seconds) callable or a clock "
                "with .advance so arrival times are injected, not slept"
            )
        self._advance = mover
        self.requests: list[dict[str, Any]] = []

    def stream(self, payload: Mapping[str, Any]) -> Iterator[str]:
        self.requests.append(dict(payload))
        if self.trace.error is not None:
            raise self.trace.error
        elapsed_s = 0.0
        for event in self.trace.events:
            delay_s = event.at_ms / 1000.0 - elapsed_s
            if delay_s > 0:
                self._advance(delay_s)
                elapsed_s += delay_s
            yield event.data


def _ms(seconds: float) -> float:
    return round(seconds * 1000.0, 3)


def _producer(effort: Effort, transport: StreamingTransport | None) -> str:
    name = getattr(transport, "name", None)
    source = f"trace {name}" if name else "live Spark stream"
    return (
        f"spike.first_token[{effort.label}] {source}: speechComplete receipt -> "
        "first content delta (reasoning_content excluded)"
    )


def measure_first_content(
    transport: StreamingTransport | None,
    *,
    effort: Effort = DEFAULT_EFFORT,
    speech_complete_at_s: float | None,
    transcript: str = "",
    clock: Callable[[], float] | None = None,
) -> FirstContentTerm:
    """Measure one effort row; an unmeasurable run yields ``None``, never a time."""
    producer = _producer(effort, transport)

    unmeasured: list[str] = []
    if transport is None:
        unmeasured.append("no live Spark stream was supplied (no META_API_KEY)")
    elif speech_complete_at_s is None:
        unmeasured.append("the speechComplete receipt was not recorded")
    if not effort.is_resolved:
        unmeasured.append(
            "the lowest supported reasoning_effort value is not named; a live "
            "probe must record the value Spark accepts (it is never guessed here)"
        )
    if unmeasured:
        return FirstContentTerm(
            effort=effort,
            producer=producer,
            unmeasured_reason="unmeasured: " + "; ".join(unmeasured),
        )

    payload = build_payload(effort, transcript)
    now = clock or getattr(transport, "clock", None) or time.monotonic
    reasoning_deltas = 0
    first_reasoning_ms: float | None = None
    tool_call_deltas = 0

    try:
        for line in transport.stream(payload):
            received_at_s = now()
            data = parse_sse_line(line)
            if data is None:
                continue
            kind, text = classify_chunk(data)
            if kind == "content":
                return FirstContentTerm(
                    effort=effort,
                    producer=producer,
                    first_content_ms=_ms(received_at_s - speech_complete_at_s),
                    reasoning_deltas=reasoning_deltas,
                    first_reasoning_ms=first_reasoning_ms,
                    content_deltas=1,
                    tool_call_deltas=tool_call_deltas,
                )
            if kind == "reasoning":
                reasoning_deltas += 1
                if first_reasoning_ms is None:
                    first_reasoning_ms = _ms(received_at_s - speech_complete_at_s)
                continue
            if kind == "tool_call":
                tool_call_deltas += 1
                continue
            if kind == "error":
                return FirstContentTerm(
                    effort=effort,
                    producer=producer,
                    unmeasured_reason=(
                        "unmeasured: Spark stream error before the first content "
                        f"delta: {text}"
                    ),
                    reasoning_deltas=reasoning_deltas,
                    first_reasoning_ms=first_reasoning_ms,
                    tool_call_deltas=tool_call_deltas,
                )
    except HttpError as error:
        return FirstContentTerm(
            effort=effort,
            producer=producer,
            unmeasured_reason=(
                f"unmeasured: Spark answered HTTP {error.status} before the "
                "first content delta"
            ),
            reasoning_deltas=reasoning_deltas,
            first_reasoning_ms=first_reasoning_ms,
            tool_call_deltas=tool_call_deltas,
            http_status=error.status,
            http_body=error.body,
        )

    if tool_call_deltas:
        reason = (
            "unmeasured: the stream ended in tool calls "
            f"({tool_call_deltas} delta(s)) with no content delta"
        )
    elif reasoning_deltas:
        reason = (
            "unmeasured: reasoning-only stream "
            f"({reasoning_deltas} reasoning_content delta(s), no content delta "
            "before the stream ended) — a reasoning-only stream is never a fast "
            "first token"
        )
    else:
        reason = "unmeasured: the stream ended with no delta at all"
    return FirstContentTerm(
        effort=effort,
        producer=producer,
        unmeasured_reason=reason,
        reasoning_deltas=reasoning_deltas,
        first_reasoning_ms=first_reasoning_ms,
        tool_call_deltas=tool_call_deltas,
    )


#: The recorded "none" row every report carries, beside the measured efforts.
RECORDED_NONE_REFUSAL = recorded_none_refusal()


@dataclass(frozen=True)
class FirstContentReport:
    """Both required effort rows, plus the unavailable ``none`` row."""

    speech_complete_at_s: float | None
    terms: tuple[FirstContentTerm, ...]
    unavailable: tuple[EffortUnavailable, ...] = (RECORDED_NONE_REFUSAL,)

    def term(self, label: str) -> FirstContentTerm:
        for term in self.terms:
            if term.effort.label == label:
                return term
        raise UnknownEffortLabelError(
            f"the report has no effort row {label!r}; rows: "
            + ", ".join(term.effort.label for term in self.terms)
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "term": TERM,
            "speech_complete_at_s": self.speech_complete_at_s,
            "efforts": [term.as_dict() for term in self.terms],
            "unavailable": [row.as_dict() for row in self.unavailable],
        }


def measure_efforts(
    transport: StreamingTransport | None,
    *,
    speech_complete_at_s: float | None,
    transcript: str = "",
    efforts: tuple[Effort, ...] = DEFAULT_EFFORTS,
    clock: Callable[[], float] | None = None,
    none_refusal: EffortUnavailable | None = None,
) -> FirstContentReport:
    """Measure the default and the lowest supported effort, in that order.

    ``transport=None`` is the honest no-key run: both rows are unmeasured with
    producer lines, and the ``none`` refusal is still reported. ``none_refusal``
    attaches a live-captured HTTP 400 body to that row; it is never requested.
    """
    labels = [effort.label for effort in efforts]
    if len(set(labels)) != len(labels):
        raise EffortValueError(
            f"duplicate effort rows in {labels!r}; one row per label"
        )
    missing = tuple(label for label in REQUIRED_LABELS if label not in labels)
    if missing:
        raise MissingEffortError(missing)
    if none_refusal is not None and (
        none_refusal.effort != UNAVAILABLE_EFFORT or none_refusal.status != 400
    ):
        raise EffortValueError(
            "the none row must be reasoning_effort 'none' with the recorded HTTP "
            f"400; got {none_refusal.effort!r}/{none_refusal.status}"
        )

    terms = []
    receipt = speech_complete_at_s
    now = clock or getattr(transport, "clock", None) or time.monotonic
    for index, effort in enumerate(efforts):
        if index:
            # Each effort is a separate request: a later attempt is issued when
            # it starts, not at the first attempt's speechComplete receipt.
            receipt = now() if transport is not None else None
        terms.append(
            measure_first_content(
                transport,
                effort=effort,
                speech_complete_at_s=receipt,
                transcript=transcript,
                clock=now,
            )
        )
    return FirstContentReport(
        speech_complete_at_s=speech_complete_at_s,
        terms=tuple(terms),
        unavailable=(none_refusal or recorded_none_refusal(),),
    )


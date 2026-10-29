"""The cheap probe for each leg: prove the provider works, spend nothing.

The spec's probe set, one per leg, and the reason each one is cheap enough to
run on a schedule:

* **speech** — open a session (the handshake is what ``open`` does), send one
  frame of PCM silence, send ``endStream``, and require a normal close
  (``1000``). No caller audio is ever sent, so no recognition is paid for.
* **model** — one minimal completion, ``tools`` absent, bounded by the caller's
  ``max_completion_tokens``. There is no default cap: the bound is
  ``probe.model_max_completion_tokens`` (:func:`model_probe_cap`) and an unset
  bound raises by name rather than inventing a number.
* **synthesis** — open, one **empty** ``Generate`` + ``Flush`` + ``Terminate``,
  and require ``FlushDone`` with ``audio_duration_ms: 0`` then ``Termination``.
  Zero characters in, zero milliseconds out: nothing is billed.

Each probe result is written to the leg's durable record through
:class:`cascade.breaker.BreakerTransitions` (a success appends a
:class:`cascade.breaker.ProbeSuccess` with its measured latency; a failure
records a probe failure with its classified verdict). A failed breaker write
never raises and never hides the probe result.

Targets are narrow protocols, not the vendor backends: the speech target is the
``open``/``send_audio``/``end_stream``/``close`` surface a ``StreamingSTT``
adapter exposes (its ``endStream`` lands with ticket 30), the model target takes
a :class:`ProbeRequest` (a ``max_completion_tokens`` the ``LLMStream`` ABC does
not carry, so the backend adapter owns it), and the voice target is the raw
``Generate``/``Flush``/``Terminate`` frame surface of the synthesis socket.
Every target is injected, so no test opens a socket.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from providers import TokenDelta

from cascade.breaker import (
    BreakerLeg,
    BreakerTransitions,
    ProviderBreakerRecord,
    TransitionOutcome,
)
from cascade.failures import FailureVerdict, classify
from cascade.meta_stt import SAMPLE_RATE

#: The model probe's cap is a registry bound, never a literal here.
MODEL_PROBE_CAP_BOUND = "probe.model_max_completion_tokens"

#: The synthesis probe's text is empty; its ceiling is the sentence cap.
SYNTHESIS_CHAR_CAP_BOUND = "tts.generate_char_cap"

#: The smallest prompt that is still an ordinary completion request.
MODEL_PROBE_PROMPT = "ping"

#: One PCM frame of silence. A frame shape, not a product bound: the vendor only
#: needs non-empty input so its idle-input close does not fire.
PROBE_SILENCE_FRAME_MS = 20

#: A speech probe is healthy only on this close code.
NORMAL_CLOSE = 1000

#: Synthesis flush confirmation that proves no audio was produced.
SILENT_FLUSH_MS = 0


class ProbeTargetError(TypeError):
    """A probe target does not expose the surface its probe needs."""


def model_probe_cap() -> int:
    """The model probe's token cap from the threshold registry.

    The spec says "small enough to bound cost" and leaves the number open, so
    the bound ships unset (ticket 04 records it) and an unset bound raises
    :class:`cascade.thresholds.UnsetBoundError` naming it.
    """
    from cascade.thresholds import require_bound

    return int(require_bound(MODEL_PROBE_CAP_BOUND))


def synthesis_char_cap() -> int:
    """The Generate ceiling the empty probe text is checked against."""
    from cascade.thresholds import require_bound

    return int(require_bound(SYNTHESIS_CHAR_CAP_BOUND))


def silence_frame(
    sample_rate: int = SAMPLE_RATE, *, frame_ms: int = PROBE_SILENCE_FRAME_MS
) -> bytes:
    """One frame of 16-bit little-endian mono PCM silence at ``sample_rate``."""
    if sample_rate <= 0:
        raise ValueError(f"sample_rate must be positive, got {sample_rate!r}")
    if frame_ms <= 0:
        raise ValueError(f"frame_ms must be positive, got {frame_ms!r}")
    samples = sample_rate * frame_ms // 1000
    return b"\x00\x00" * samples


@dataclass(frozen=True)
class ProbeRequest:
    """The one request a model probe sends.

    Deliberately not an ``LLMStream.complete()`` call: the ABC has no
    ``max_completion_tokens``, and the probe's whole point is that the cap is
    explicit. ``tools`` is ``None`` and never serialised.
    """

    messages: tuple[dict[str, str], ...]
    max_completion_tokens: int
    tools: None = None

    def __post_init__(self) -> None:
        if isinstance(self.max_completion_tokens, bool) or not isinstance(
            self.max_completion_tokens, int
        ):
            raise ProbeTargetError(
                f"max_completion_tokens must be an int, got {self.max_completion_tokens!r}"
            )
        if self.max_completion_tokens <= 0:
            raise ProbeTargetError(
                f"max_completion_tokens must be positive, got {self.max_completion_tokens!r}"
            )
        messages = tuple(self.messages)
        if not messages:
            raise ProbeTargetError("a probe request needs one message")
        for message in messages:
            if not isinstance(message, Mapping) or "role" not in message:
                raise ProbeTargetError(f"a message needs a role, got {message!r}")
        object.__setattr__(self, "messages", messages)

    def to_document(self) -> dict[str, Any]:
        return {
            "messages": [dict(message) for message in self.messages],
            "max_completion_tokens": self.max_completion_tokens,
        }


def model_probe_request(max_completion_tokens: int) -> ProbeRequest:
    """The minimal, tool-free request a model probe sends."""
    return ProbeRequest(
        messages=({"role": "user", "content": MODEL_PROBE_PROMPT},),
        max_completion_tokens=max_completion_tokens,
    )


class SpeechProbeTarget(Protocol):
    """The speech session surface a probe drives."""

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        """Connect and complete the handshake."""

    async def send_audio(self, pcm: bytes) -> None:
        """Send one binary PCM frame."""

    async def end_stream(self) -> int | None:
        """Send ``endStream`` and return the close code the vendor answered."""

    async def close(self) -> None:
        """Release the socket."""


class ModelProbeTarget(Protocol):
    """The chat surface a probe drives."""

    def probe(self, request: ProbeRequest) -> AsyncIterator[TokenDelta]:
        """Run one bounded completion and stream its content deltas."""


class VoiceProbeTarget(Protocol):
    """The synthesis session surface a probe drives."""

    async def open(self) -> None:
        """Connect and read ``Begin``."""

    async def generate(self, text: str) -> None:
        """Send one ``Generate`` frame."""

    async def flush(self) -> None:
        """Send one ``Flush`` frame."""

    async def terminate(self) -> None:
        """Send ``Terminate``."""

    def events(self) -> AsyncIterator[Mapping[str, Any]]:
        """Read the vendor frames that follow."""


@dataclass(frozen=True)
class ProbeResult:
    """What one probe did, what it cost and whether the leg answered."""

    leg: BreakerLeg
    ok: bool
    latency_ms: float
    detail: str = ""
    chars: int = 0
    tokens: int = 0
    max_tokens: int | None = None
    char_cap: int | None = None
    close_code: int | None = None
    verdict: FailureVerdict | None = field(default=None, compare=False)

    def __post_init__(self) -> None:
        if self.latency_ms < 0:
            raise ValueError(f"latency_ms must not be negative, got {self.latency_ms!r}")
        if not self.ok and self.verdict is None:
            raise ValueError("a failed probe must carry the verdict it records")
        if self.ok and self.verdict is not None:
            raise ValueError("a successful probe has no failure verdict")
        if self.chars < 0 or self.tokens < 0:
            raise ValueError("a probe cannot spend negative characters or tokens")

    @property
    def within_cap(self) -> bool:
        """Whether the probe stayed inside the caps it was given."""
        if self.max_tokens is not None and self.tokens > self.max_tokens:
            return False
        if self.char_cap is not None and self.chars > self.char_cap:
            return False
        return True


@dataclass(frozen=True)
class ProbeOutcome:
    """A probe result plus what the durable write did with it."""

    result: ProbeResult
    transition: TransitionOutcome

    @property
    def written(self) -> bool:
        return self.transition.written

    @property
    def error(self) -> str:
        return self.transition.error

    @property
    def record(self) -> ProviderBreakerRecord | None:
        return self.transition.record


def _elapsed_ms(clock: Any, started: float) -> float:
    return (clock() - started) * 1000.0


def _code_of(error: BaseException) -> int | str | None:
    for name in ("code", "status"):
        value = getattr(error, name, None)
        if isinstance(value, (int, str)):
            return value
    return None


def _verdict(leg: BreakerLeg, error: BaseException) -> FailureVerdict:
    if isinstance(error, TimeoutError):
        return classify(leg, None, timed_out=True) if leg == "llm" else classify(leg, None)
    code = _code_of(error)
    if leg == "llm":
        return classify(leg, code if isinstance(code, int) else None)
    return classify(leg, code)


async def speech_probe(
    target: SpeechProbeTarget,
    *,
    clock: Any,
    language_codes: Sequence[str],
    sample_rate: int = SAMPLE_RATE,
) -> ProbeResult:
    """Open, handshake, send silence, ``endStream``, and require close ``1000``."""
    for name in ("open", "send_audio", "end_stream", "close"):
        if not hasattr(target, name):
            raise ProbeTargetError(f"a speech probe target needs {name}()")
    frame = silence_frame(sample_rate)
    started = clock()
    close_code: int | None = None
    try:
        await target.open(language_codes=list(language_codes), sample_rate=sample_rate)
        await target.send_audio(frame)
        close_code = await target.end_stream()
        await target.close()
    except Exception as error:  # noqa: BLE001 - a probe turns a failure into a result
        detail = f"{type(error).__name__}: {error}"
        return ProbeResult(
            leg="stt",
            ok=False,
            latency_ms=_elapsed_ms(clock, started),
            detail=detail,
            verdict=_verdict("stt", error),
        )
    latency_ms = _elapsed_ms(clock, started)
    if close_code != NORMAL_CLOSE:
        return ProbeResult(
            leg="stt",
            ok=False,
            latency_ms=latency_ms,
            detail=f"speech probe closed with {close_code!r}, not {NORMAL_CLOSE}",
            close_code=close_code if isinstance(close_code, int) else None,
            verdict=classify("stt", close_code),
        )
    return ProbeResult(leg="stt", ok=True, latency_ms=latency_ms, close_code=close_code)


async def model_probe(
    target: ModelProbeTarget,
    *,
    clock: Any,
    max_completion_tokens: int,
) -> ProbeResult:
    """One minimal completion, no tools, bounded by ``max_completion_tokens``."""
    if not hasattr(target, "probe"):
        raise ProbeTargetError("a model probe target needs probe()")
    request = model_probe_request(max_completion_tokens)
    started = clock()
    deltas = 0
    try:
        async for delta in target.probe(request):
            if isinstance(delta, TokenDelta):
                deltas += 1
    except Exception as error:  # noqa: BLE001 - a probe turns a failure into a result
        return ProbeResult(
            leg="llm",
            ok=False,
            latency_ms=_elapsed_ms(clock, started),
            detail=f"{type(error).__name__}: {error}",
            max_tokens=request.max_completion_tokens,
            verdict=_verdict("llm", error),
        )
    latency_ms = _elapsed_ms(clock, started)
    if deltas == 0:
        return ProbeResult(
            leg="llm",
            ok=False,
            latency_ms=latency_ms,
            detail="the completion ended with no content: the leg is unproven",
            max_tokens=request.max_completion_tokens,
            verdict=classify("llm", None),
        )
    result = ProbeResult(
        leg="llm",
        ok=True,
        latency_ms=latency_ms,
        tokens=deltas,
        max_tokens=request.max_completion_tokens,
    )
    if not result.within_cap:
        return ProbeResult(
            leg="llm",
            ok=False,
            latency_ms=latency_ms,
            detail=(
                f"the probe spent {deltas} deltas over its cap of "
                f"{request.max_completion_tokens} tokens"
            ),
            tokens=deltas,
            max_tokens=request.max_completion_tokens,
            verdict=classify("llm", None),
        )
    return result


async def voice_probe(
    target: VoiceProbeTarget, *, clock: Any
) -> ProbeResult:
    """Empty ``Generate`` + ``Flush`` + ``Terminate``; require a silent flush."""
    for name in ("open", "generate", "flush", "terminate", "events"):
        if not hasattr(target, name):
            raise ProbeTargetError(f"a voice probe target needs {name}()")
    text = ""
    cap = synthesis_char_cap()
    if len(text) > cap:
        raise ProbeTargetError(
            f"the synthesis probe's text is {len(text)} characters, over the "
            f"{cap}-character Generate cap"
        )
    started = clock()
    flush_ms: float | None = None
    terminated = False
    try:
        await target.open()
        await target.generate(text)
        await target.flush()
        await target.terminate()
        async for frame in target.events():
            kind = frame.get("type") if isinstance(frame, Mapping) else None
            if kind == "FlushDone" and flush_ms is None:
                flush_ms = frame.get("audio_duration_ms")
            elif kind == "Termination":
                terminated = True
                break
    except Exception as error:  # noqa: BLE001 - a probe turns a failure into a result
        return ProbeResult(
            leg="tts",
            ok=False,
            latency_ms=_elapsed_ms(clock, started),
            detail=f"{type(error).__name__}: {error}",
            chars=len(text),
            char_cap=cap,
            verdict=_verdict("tts", error),
        )
    latency_ms = _elapsed_ms(clock, started)
    if flush_ms != SILENT_FLUSH_MS:
        return ProbeResult(
            leg="tts",
            ok=False,
            latency_ms=latency_ms,
            detail=(
                "the probe's FlushDone carried audio_duration_ms="
                f"{flush_ms!r}, not {SILENT_FLUSH_MS}: an empty Generate must "
                "produce no audio"
            ),
            chars=len(text),
            char_cap=cap,
            verdict=classify("tts", None),
        )
    if not terminated:
        return ProbeResult(
            leg="tts",
            ok=False,
            latency_ms=latency_ms,
            detail="the session ended without Termination",
            chars=len(text),
            char_cap=cap,
            verdict=classify("tts", None),
        )
    return ProbeResult(
        leg="tts", ok=True, latency_ms=latency_ms, chars=len(text), char_cap=cap
    )


async def _record(
    transitions: BreakerTransitions, result: ProbeResult
) -> ProbeOutcome:
    if result.ok:
        transition = await transitions.record_probe_success(
            result.leg, latency_ms=result.latency_ms
        )
    else:
        assert result.verdict is not None, "a failed probe carries its verdict"
        transition = await transitions.record_probe_failure(
            result.leg, verdict=result.verdict
        )
    return ProbeOutcome(result=result, transition=transition)


async def probe_speech(
    transitions: BreakerTransitions,
    *,
    target: SpeechProbeTarget,
    clock: Any,
    language_codes: Sequence[str],
    sample_rate: int = SAMPLE_RATE,
) -> ProbeOutcome:
    """Run the speech probe and record its latency and result on the stt leg."""
    result = await speech_probe(
        target, clock=clock, language_codes=language_codes, sample_rate=sample_rate
    )
    return await _record(transitions, result)


async def probe_model(
    transitions: BreakerTransitions,
    *,
    target: ModelProbeTarget,
    clock: Any,
    max_completion_tokens: int,
) -> ProbeOutcome:
    """Run the model probe and record its latency and result on the llm leg."""
    result = await model_probe(
        target, clock=clock, max_completion_tokens=max_completion_tokens
    )
    return await _record(transitions, result)


async def probe_voice(
    transitions: BreakerTransitions, *, target: VoiceProbeTarget, clock: Any
) -> ProbeOutcome:
    """Run the synthesis probe and record its latency and result on the tts leg."""
    result = await voice_probe(target, clock=clock)
    return await _record(transitions, result)

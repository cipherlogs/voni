"""Scripted provider fakes that implement the ``providers.py`` contracts.

Every cascade test that needs an STT, LLM or TTS stands one of these in and
scripts the event trace. Delays are *virtual*: they advance the injected
``FakeClock`` and never wait on the wall clock, so a test can script a
45-second stall and still finish in microseconds.

Public API (later tickets import these; do not rename):

    Step            one scripted step: event | delay_ms | exc
    as_steps        normalise a mixed list of provider events and Steps
    ScriptedSTT     StreamingSTT over a scripted Partial/Final trace
    ScriptedLLM     LLMStream over per-completion scripted replies
    ScriptedTTS     StreamingTTS over per-utterance scripted chunks

Recorded surfaces, asserted by provider tests:

    ScriptedSTT.opened / .audio / .emitted / .closed
    ScriptedLLM.requests / .prefetches / .responses_served
    ScriptedTTS.spoken / .sample_rate

A script that runs out fails loudly with ``LookupError`` naming the call
index: silent repetition of the last reply hides ordering bugs.
"""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Tests run with cwd = voice-pipeline/, where providers.py is a flat module.
# Append (never insert) so a direct import from elsewhere still resolves.
_VOICE_PIPELINE_ROOT = Path(__file__).resolve().parents[2]
if str(_VOICE_PIPELINE_ROOT) not in sys.path:
    sys.path.append(str(_VOICE_PIPELINE_ROOT))

from providers import (  # noqa: E402 - path bootstrap above
    LLMStream,
    PrefetchHandle,
    SentenceAudio,
    StreamingSTT,
    StreamingTTS,
    TokenDelta,
    ToolCallRequest,
)

from cascade.testing.clock import Clock


@dataclass(frozen=True)
class Step:
    """One scripted provider step.

    Smallest unit later tickets script:

        Step(TokenDelta(text="Hi"))                 # emit an event
        Step(ToolCallRequest(name="end_call"))      # emit a tool call
        Step(TokenDelta(text="Hi"), delay_ms=1200)  # emit after 1.2s virtual
        Step(exc=TimeoutError("llm timeout"))       # fail at this position
    """

    event: Any = None
    delay_ms: float = 0.0
    exc: BaseException | None = None

    def __post_init__(self) -> None:
        if self.delay_ms < 0:
            raise ValueError(f"delay_ms cannot be negative: {self.delay_ms!r}")
        if self.exc is not None and self.event is not None:
            raise ValueError("a Step either emits an event or raises, not both")

    @property
    def raises(self) -> bool:
        return self.exc is not None


def as_steps(items: Iterable[Step | Any]) -> list[Step]:
    """Wrap raw provider events as ``Step`` objects; keep existing steps."""
    return [item if isinstance(item, Step) else Step(item) for item in items]


async def _wait_for(step: Step, clock: Clock | None, owner: str) -> None:
    if step.delay_ms == 0.0:
        return
    if clock is None:
        raise RuntimeError(
            f"{owner}: scripted delay {step.delay_ms}ms needs an injected clock; "
            "pass clock=FakeClock() so the wait is virtual, never wall-clock"
        )
    await clock.sleep(step.delay_ms / 1000.0)


class ScriptedSTT(StreamingSTT):
    """StreamingSTT that replays a scripted event trace."""

    def __init__(
        self, trace: Iterable[Step | Any] = (), *, clock: Clock | None = None
    ) -> None:
        self._trace = as_steps(trace)
        self._clock = clock
        self.opened: dict[str, Any] | None = None
        self.audio: list[bytes] = []
        self.emitted: list[Any] = []
        self.closed = False

    @property
    def audio_bytes(self) -> int:
        return sum(len(frame) for frame in self.audio)

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        self.opened = {
            "language_codes": list(language_codes),
            "sample_rate": sample_rate,
        }

    async def send_audio(self, pcm: bytes) -> None:
        self.audio.append(pcm)

    async def events(self) -> AsyncIterator[Any]:
        for step in self._trace:
            await _wait_for(step, self._clock, "ScriptedSTT")
            if step.raises:
                raise step.exc  # type: ignore[misc]
            self.emitted.append(step.event)
            yield step.event

    async def close(self) -> None:
        self.closed = True


class ScriptedPrefetch(PrefetchHandle):
    """PrefetchHandle that records its messages and cancellation."""

    def __init__(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> None:
        self.messages = messages
        self.tools = tools
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


class ScriptedLLM(LLMStream):
    """LLMStream that serves one scripted reply per ``complete()`` call."""

    def __init__(
        self,
        replies: Iterable[Iterable[Step | Any]],
        *,
        clock: Clock | None = None,
    ) -> None:
        self._replies = [as_steps(reply) for reply in replies]
        self._clock = clock
        self.requests: list[dict[str, Any]] = []
        self.prefetches: list[ScriptedPrefetch] = []
        self.responses_served = 0

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[TokenDelta | ToolCallRequest]:
        index = self.responses_served
        self.responses_served += 1
        self.requests.append({"messages": list(messages), "tools": tools})
        if index >= len(self._replies):
            raise LookupError(
                f"ScriptedLLM has no reply for completion #{index} "
                f"({len(self._replies)} scripted)"
            )
        for step in self._replies[index]:
            await _wait_for(step, self._clock, "ScriptedLLM")
            if step.raises:
                raise step.exc  # type: ignore[misc]
            yield step.event

    def prefetch(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ScriptedPrefetch:
        handle = ScriptedPrefetch(list(messages), tools)
        self.prefetches.append(handle)
        return handle


class ScriptedTTS(StreamingTTS):
    """StreamingTTS that replays scripted chunk lists per utterance.

    With no ``script``, each utterance yields exactly one ``SentenceAudio``
    whose PCM is the UTF-8 text — the same convention the orchestrator's
    existing FakeTTS uses, so audio joins stay readable in assertions.
    """

    def __init__(
        self,
        script: Iterable[Iterable[Step | Any]] | None = None,
        *,
        clock: Clock | None = None,
        sample_rate: int = 24000,
    ) -> None:
        self._script = (
            None if script is None else [as_steps(chunks) for chunks in script]
        )
        self._clock = clock
        self.sample_rate = sample_rate
        self.spoken: list[str] = []

    async def speak(self, text: str) -> AsyncIterator[SentenceAudio]:
        index = len(self.spoken)
        self.spoken.append(text)
        if self._script is None:
            yield SentenceAudio(
                pcm=text.encode(), sample_rate=self.sample_rate, text=text
            )
            return
        if index >= len(self._script):
            raise LookupError(
                f"ScriptedTTS has no chunk list for utterance #{index} "
                f"({len(self._script)} scripted)"
            )
        for step in self._script[index]:
            await _wait_for(step, self._clock, "ScriptedTTS")
            if step.raises:
                raise step.exc  # type: ignore[misc]
            yield step.event

"""The body's greeting, spoken before any caller audio (ticket 77).

The greeting is the one line a call says before the visitor can speak, and the
same line the audition clip and the reference render use. This module is the
call's only greeting path: it hands the body's text to the opened voice
session, forwards every synthesized frame to the call's audio sink, and records
the three ledger marks the scoreboard reads.

Three facts shape the implementation:

* **The bound voice speaks it.** The opened session is expected to expose
  ``speak_greeting`` — the adapter path that sends one ``Generate`` + ``Flush``
  with the first sentence flushed immediately (ticket 49). A session bound to a
  different voice refuses by name rather than speaking in the wrong Locale.
* **The greeting is not a turn.** It writes ``greeting_start``,
  ``greeting_first_audio`` and ``greeting_done`` and nothing else. It never
  writes ``first_playout`` or ``speech_complete``, so it cannot enter a
  reply-gap sample.
* **A silent opening is a bug.** An empty or absent greeting is an intentional
  silent open and is recorded as such. A greeting that cannot be synthesized,
  that produces no audio, or that was never flushed raises a visible
  :class:`GreetingFailure`; the caller ends the call instead of pretending the
  opening happened.

The audio sink is injected because the wire is the transport's business: this
module forwards :class:`providers.SentenceAudio` and knows nothing about base64,
sequence numbers or sampling.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from cascade.body_map import CascadeBody
from metrics import TimingLedger
from providers import SentenceAudio

#: Where one synthesized greeting frame goes. The call lifecycle wraps this
#: with the call-level sequence and the transport.
AudioSink = Callable[[SentenceAudio], Awaitable[None] | None]

#: The marks this module owns, in the order a spoken greeting writes them.
GREETING_MARKS: tuple[str, ...] = (
    "greeting_start",
    "greeting_first_audio",
    "greeting_done",
)


class GreetingFailure(RuntimeError):
    """The greeting cannot be spoken; the call must not open silently."""

    stage = "greeting"
    visible = True


class GreetingUnavailable(GreetingFailure):
    """The opened voice session has no greeting path."""

    def __init__(self, voice_id: str) -> None:
        self.voice_id = voice_id
        super().__init__(
            f'voice "{voice_id}" cannot speak a greeting: the opened session has '
            "no speak_greeting path, so the body's line would be dropped"
        )


class GreetingVoiceMismatch(GreetingFailure):
    """The opened voice is not the voice the body bound."""

    def __init__(self, expected: str, actual: str) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(
            f'the body binds voice "{expected}" but the opened session speaks '
            f'"{actual}"; the greeting is never spoken in another voice'
        )


class GreetingSilent(GreetingFailure):
    """The synthesis path completed without producing a single audio frame."""

    def __init__(self, text: str) -> None:
        self.text = text
        super().__init__(
            "the greeting synthesis produced no audio; a greeting that is never "
            f"flushed is a bug, not a silent opening (text {text!r})"
        )


@dataclass(frozen=True)
class GreetingOutcome:
    """What the opening actually did, recorded on the call's end message."""

    spoken: bool
    reason: str = ""
    text: str = ""
    frames: int = 0
    audio_bytes: int = 0
    sample_rate: int = 0

    @classmethod
    def silent(cls, reason: str) -> "GreetingOutcome":
        """The body has no greeting; this is intentional, not a defect."""
        return cls(spoken=False, reason=reason)

    def to_document(self) -> dict[str, Any]:
        return {
            "spoken": self.spoken,
            "reason": self.reason,
            "text": self.text,
            "frames": self.frames,
            "audioBytes": self.audio_bytes,
            "sampleRate": self.sample_rate,
        }


class CallGreeting:
    """Speak one body's greeting through the call's opened voice."""

    def __init__(
        self,
        *,
        voice: Any,
        ledger: TimingLedger,
        sink: AudioSink | None = None,
    ) -> None:
        self._voice = voice
        self._ledger = ledger
        self._sink = sink

    async def speak(self, body: CascadeBody) -> GreetingOutcome:
        """Speak ``body.greeting`` now, or record that the body has none."""
        text = body.greeting
        if not body.has_greeting:
            return GreetingOutcome.silent(
                "the body has no greeting; the call opens silently by design"
            )

        speaker = getattr(self._voice, "speak_greeting", None)
        if not callable(speaker):
            raise GreetingUnavailable(_voice_id(self._voice, body))

        binding = getattr(self._voice, "binding", None)
        opened = getattr(binding, "voice_id", None)
        if isinstance(opened, str) and opened != body.voice_id:
            raise GreetingVoiceMismatch(body.voice_id, opened)

        self._ledger.mark("greeting_start")
        frames = 0
        audio_bytes = 0
        sample_rate = 0
        async for audio in speaker(text):
            if frames == 0:
                self._ledger.mark("greeting_first_audio")
            frames += 1
            audio_bytes += len(audio.pcm)
            sample_rate = audio.sample_rate
            if self._sink is not None:
                result = self._sink(audio)
                if inspect.isawaitable(result):
                    await result
        if frames == 0:
            raise GreetingSilent(text)
        self._ledger.mark("greeting_done")
        return GreetingOutcome(
            spoken=True,
            reason="spoken",
            text=text,
            frames=frames,
            audio_bytes=audio_bytes,
            sample_rate=sample_rate,
        )


def _voice_id(voice: Any, body: CascadeBody) -> str:
    binding = getattr(voice, "binding", None)
    opened = getattr(binding, "voice_id", None)
    return opened if isinstance(opened, str) else body.voice_id

"""The body's greeting, spoken before any caller audio (ticket 77).

The greeting is the one line a call says before the visitor can speak, and the
same line the audition clip and the reference render use. This module is the
call's only greeting path: it hands the body's text to the opened voice
session, forwards every synthesized frame to the call's audio sink, and records
the three ledger marks the scoreboard reads.

Three facts shape the implementation:

* **The bound voice speaks it.** The opened session is expected to expose
  ``speak_greeting`` — the adapter path that sends one ``Generate`` + ``Flush``
  with the first sentence flushed immediately (ticket 49). The session must
  have acknowledged ``Begin``: a greeting sent into an unconfirmed socket is
  refused by name. A session bound to a different voice refuses by name rather
  than speaking in the wrong Locale.
* **The chime is the first audible sample.** The call's connected earcon is
  triggered by the first frame with PCM, once per greeting, before that frame
  is handed to the sink. The trigger is never awaited, so it cannot delay the
  first word; a greeting with no audible frame never chimes.
* **The greeting is not a turn.** It writes ``greeting_start``,
  ``greeting_first_audio`` and ``greeting_done`` and nothing else. It never
  writes ``first_playout`` or ``speech_complete``, so it cannot enter a
  reply-gap sample.
* **A silent opening is a bug.** An empty or absent greeting is an intentional
  silent open and is recorded as such. A greeting that cannot be synthesized,
  that produces no audio, or that was never flushed raises a visible
  :class:`GreetingFailure`; the caller ends the call instead of pretending the
  opening happened. A raw socket close is classified by the voice's own close
  policy (ticket 55), so a trigger is retried once before audio and the end
  message carries the voice trigger, never a bare connection error.
* **The greeting is cancellable.** :meth:`CallGreeting.start` exposes a
  playback that can be cut with the synthesis session's ``Cancel``; the
  pending text is discarded and the line never resumes.

The audio sink is injected because the wire is the transport's business: this
module forwards :class:`providers.SentenceAudio` and knows nothing about base64,
sequence numbers or sampling.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from cascade.barge_in import CUT_CAUSES
from cascade.body_map import CascadeBody
from metrics import TimingLedger
from providers import SentenceAudio

#: Where one synthesized greeting frame goes. The call lifecycle wraps this
#: with the call-level sequence and the transport.
AudioSink = Callable[[SentenceAudio], Awaitable[None] | None]

#: The connected chime's trigger. It fires on the first audible sample and is
#: never awaited: the earcon belongs to the client, and waiting for it would
#: put a second delay between the greeting's first word and the caller.
ChimeSink = Callable[[], None]

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


class GreetingNotConnected(GreetingFailure):
    """The synthesis session has not acknowledged ``Begin`` yet."""

    def __init__(self, voice_id: str) -> None:
        self.voice_id = voice_id
        super().__init__(
            f'voice "{voice_id}" has not acknowledged Begin; the greeting is '
            "sent only after the synthesis session is confirmed, never into a "
            "socket that has not answered"
        )


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
    chime_fired: bool = False
    cancelled: bool = False
    cause: str = ""

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
            "chimeFired": self.chime_fired,
            "cancelled": self.cancelled,
            "cause": self.cause,
        }


class CallGreeting:
    """Speak one body's greeting through the call's opened voice."""

    def __init__(
        self,
        *,
        voice: Any,
        ledger: TimingLedger,
        sink: AudioSink | None = None,
        chime: ChimeSink | None = None,
    ) -> None:
        self._voice = voice
        self._ledger = ledger
        self._sink = sink
        self._chime = chime

    def start(self, body: CascadeBody) -> "GreetingPlayback":
        """Begin speaking ``body.greeting``; the caller may ``Cancel`` it."""
        return GreetingPlayback(self, body).start()

    async def speak(self, body: CascadeBody) -> GreetingOutcome:
        """Speak ``body.greeting`` to completion, or record that there is none."""
        return await self.start(body).wait()


class GreetingPlayback:
    """One greeting in flight, and the one cut that can stop it.

    The cut is the synthesis session's ``Cancel`` (ticket 52): the greeting
    producer stops on the next frame boundary, the pending text is discarded by
    the adapter, and the greeting never resumes. The playback owns its own
    outcome so a cancelled greeting still reports how much of the line was
    heard.
    """

    def __init__(self, greeting: CallGreeting, body: CascadeBody) -> None:
        self._greeting = greeting
        self.body = body
        self._task: asyncio.Task | None = None
        self._cancel_cause: str | None = None
        self._started = False
        self._frames = 0
        self._audio_bytes = 0
        self._sample_rate = 0
        self._chime_fired = False
        self.outcome: GreetingOutcome | None = None
        self.cancellation: Any = None

    # -- state ------------------------------------------------------------

    @property
    def task(self) -> asyncio.Task:
        """The producer task; the lifecycle waits on it."""
        if self._task is None:
            raise RuntimeError("the greeting has not been started")
        return self._task

    @property
    def cancelled(self) -> bool:
        return self._cancel_cause is not None

    @property
    def cause(self) -> str:
        return self._cancel_cause or ""

    @property
    def done(self) -> bool:
        return self._task is not None and self._task.done()

    @property
    def frames(self) -> int:
        return self._frames

    # -- running ----------------------------------------------------------

    def start(self) -> "GreetingPlayback":
        if self._task is not None:
            raise RuntimeError("one greeting per playback; a second start would repeat it")
        self._task = asyncio.ensure_future(self._run())
        return self

    async def wait(self) -> GreetingOutcome:
        """Wait for the greeting to finish; a synthesis failure surfaces."""
        return await self.task

    async def _run(self) -> GreetingOutcome:
        self.outcome = await self._speak()
        return self.outcome

    async def _speak(self) -> GreetingOutcome:
        g = self._greeting
        body = self.body
        text = body.greeting
        if not body.has_greeting:
            return GreetingOutcome.silent(
                "the body has no greeting; the call opens silently by design"
            )

        speaker = getattr(g._voice, "speak_greeting", None)
        if not callable(speaker):
            raise GreetingUnavailable(_voice_id(g._voice, body))

        if not _acknowledged(g._voice):
            raise GreetingNotConnected(_voice_id(g._voice, body))

        binding = getattr(g._voice, "binding", None)
        opened = getattr(binding, "voice_id", None)
        if isinstance(opened, str) and opened != body.voice_id:
            raise GreetingVoiceMismatch(body.voice_id, opened)

        g._ledger.mark("greeting_start")
        self._started = True
        while True:
            retry = False
            iterator = speaker(text).__aiter__()
            try:
                while self._cancel_cause is None:
                    try:
                        audio = await iterator.__anext__()
                    except StopAsyncIteration:
                        break
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        if await self._retry_after_close(error):
                            retry = True
                            break
                        raise
                    if self._cancel_cause is not None:
                        break
                    await self._emit(audio)
            finally:
                await _aclose(iterator)
            if self._cancel_cause is not None:
                return self._cancelled_outcome()
            if not retry:
                break
        if self._frames == 0 or not self._chime_fired:
            raise GreetingSilent(text)
        g._ledger.mark("greeting_done")
        return GreetingOutcome(
            spoken=True,
            reason="spoken",
            text=text,
            frames=self._frames,
            audio_bytes=self._audio_bytes,
            sample_rate=self._sample_rate,
            chime_fired=self._chime_fired,
        )

    async def _retry_after_close(self, error: BaseException) -> bool:
        """Classify a raw socket close through the voice's close policy.

        A websocket close arrives as a connection error, not as a vendor
        ``Error`` frame. The synthesis adapter's ``handle_close`` is the one
        place that turns its code into a trigger, a bug or a planned reconnect
        (ticket 55), and a trigger is retried once before any audio was
        delivered. A failure the adapter already classified is not reclassified.
        """
        if getattr(error, "verdict", None) is not None:
            return False
        code = getattr(error, "code", None)
        handle = getattr(self._greeting._voice, "handle_close", None)
        if code is None or not callable(handle):
            return False
        decision = await handle(code)
        action = getattr(decision, "action", None)
        return str(getattr(action, "value", action)) == "retry"

    async def _emit(self, audio: SentenceAudio) -> None:
        if audio.pcm and not self._chime_fired:
            # The first audible sample is the call going live: fire the
            # client's earcon before the frame is handed on, and never await
            # it (the chime cannot delay the first word).
            self._chime_fired = True
            self._greeting._ledger.mark("greeting_first_audio")
            if self._greeting._chime is not None:
                self._greeting._chime()
        self._frames += 1
        self._audio_bytes += len(audio.pcm)
        self._sample_rate = audio.sample_rate
        sink = self._greeting._sink
        if sink is not None:
            result = sink(audio)
            if inspect.isawaitable(result):
                await result

    # -- the cut ----------------------------------------------------------

    async def cancel(self, cause: str) -> GreetingOutcome:
        """Take the floor: send ``Cancel``, stop the producer, never resume."""
        if cause not in CUT_CAUSES:
            raise ValueError(
                f"unknown greeting cut cause {cause!r}; expected one of {CUT_CAUSES}"
            )
        if self._task is None:
            raise RuntimeError("the greeting has not been started")
        if self._task.done() and not self._cancel_cause:
            # It finished before the cut landed: nothing to cancel.
            return await self._task
        if self._cancel_cause is not None:
            return self.outcome or self._cancelled_outcome()
        # The frame boundary first: no chunk of the old request may be emitted
        # after this synchronous line, even before Cancel is on the wire.
        self._cancel_cause = cause
        cancel_fn = getattr(self._greeting._voice, "cancel", None)
        if callable(cancel_fn):
            self.cancellation = await cancel_fn()
        if not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self.outcome is None:
            self.outcome = self._cancelled_outcome()
        # A greeting cut is a real interruption: first write wins, so the
        # call-level mark stays one per call even after a later reply cut.
        self._greeting._ledger.mark("cancelled")
        self._greeting._ledger.count("interruption")
        return self.outcome

    async def stop(self) -> GreetingOutcome:
        """Stop the producer without a cut: the call is ending, not yielding."""
        if self._task is None:
            raise RuntimeError("the greeting has not been started")
        if not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        elif self.outcome is not None:
            return self.outcome
        if self._started:
            self._greeting._ledger.mark("greeting_done")
        self.outcome = GreetingOutcome(
            spoken=self._frames > 0,
            reason="the call ended during the greeting",
            text=self.body.greeting,
            frames=self._frames,
            audio_bytes=self._audio_bytes,
            sample_rate=self._sample_rate,
            chime_fired=self._chime_fired,
        )
        return self.outcome

    def _cancelled_outcome(self) -> GreetingOutcome:
        if self._started:
            self._greeting._ledger.mark("greeting_done")
        return GreetingOutcome(
            spoken=self._frames > 0,
            reason=f"cancelled during the greeting ({self._cancel_cause})",
            text=self.body.greeting,
            frames=self._frames,
            audio_bytes=self._audio_bytes,
            sample_rate=self._sample_rate,
            chime_fired=self._chime_fired,
            cancelled=True,
            cause=self._cancel_cause or "",
        )


async def _aclose(iterator: AsyncIterator[Any]) -> None:
    close = getattr(iterator, "aclose", None)
    if close is not None:
        await close()


_NO_BEGIN = object()


def _acknowledged(voice: Any) -> bool:
    """Whether the session confirmed its handshake, when it carries one.

    The real adapter sets ``begin`` from its first frame; a test fake that does
    not model a handshake is allowed through, but a session that exposes
    ``begin`` and has not filled it is refused.
    """
    begin = getattr(voice, "begin", _NO_BEGIN)
    return begin is _NO_BEGIN or begin is not None


def _voice_id(voice: Any, body: CascadeBody) -> str:
    binding = getattr(voice, "binding", None)
    opened = getattr(binding, "voice_id", None)
    return opened if isinstance(opened, str) else body.voice_id

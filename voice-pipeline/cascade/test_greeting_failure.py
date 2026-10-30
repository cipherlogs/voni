"""A greeting failure is visible, and the line is pinned (ticket 80).

Seam: :class:`cascade.call.CallLifecycle` over the real
:class:`cascade.assemblyai_tts.AssemblyAIStreamingTTS`, with recorded frames.
Three facts are observed:

* a synthesis close during the greeting is classified by the voice close policy
  (ticket 55), so the end message carries the voice trigger and the leg's
  breaker is opened only for a trigger;
* a greeting that never produces audio fails by name (``GreetingSilent``), not
  by the session's idle timeout: there is no silent opening to discover later;
* the greeting the call speaks equals the served body's greeting and the
  committed audition clip's line, which is read from the clip evidence rather
  than copied into this test.

Independent expected values: the clip lines come from
``voni/evidence/audition-clips/clips.json``, the greeting source lines from
``voni/src/lib/demo/voni-agent.ts`` (the same two artifacts the audition clip
test compares), and the trigger codes come from the recorded close frames.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import unittest
from pathlib import Path

from cascade.assemblyai_tts import AssemblyAIStreamingTTS
from cascade.body_map import adapt_body
from cascade.call import CallLifecycle, OpenedLeg
from cascade.greeting import CallGreeting, GreetingSilent
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.test_call import (
    CALL_ID,
    ISSUED_S,
    SECRET,
    FakeStream,
    FakeTransport,
    signed_message,
)
from cascade.tts_support import begin
from cascade.testing import FakeClock, ScriptedSTT
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from cascade.voice_binding import bind_voice
from metrics import TimingLedger
from providers import SentenceAudio

REPO = Path(__file__).resolve().parents[2]
CLIPS = json.loads(
    (REPO / "voni/evidence/audition-clips/clips.json").read_text(encoding="utf-8")
)
GREETING_SOURCE = (REPO / "voni/src/lib/demo/voni-agent.ts").read_text(encoding="utf-8")

#: The greeting lines the agent config serves, keyed by the two-letter Locale.
GREETINGS = dict(
    re.findall(r'^\s{2}([a-z]{2}): "(.*)",$', GREETING_SOURCE, re.MULTILINE)
)
CLIP_LINES = {
    clip["voice"]: clip["line"] for clip in CLIPS["clips"] if clip["voice"] in {
        "anna", "lola", "estelle", "giovanni", "rafael"
    }
}

LOLA = bind_voice("lola")


def body_dict(*, voice_id: str = "lola", greeting: str | None = None) -> dict:
    binding = bind_voice(voice_id)
    return {
        "system_prompt": "You are Voni, a careful voice agent.",
        "greeting": GREETINGS[binding.locale.code] if greeting is None else greeting,
        "voice": {"voice_id": voice_id},
        "input": {"language_codes": [binding.locale.code]},
        "output": {"voice": voice_id},
        "tools": [],
        "llm": [],
    }


class SilentGreetingVoice:
    """The greeting path completes without a single frame (never flushed)."""

    def __init__(self) -> None:
        self.binding = LOLA
        self.begin = {}
        self.greeted: list[str] = []

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        if False:  # pragma: no cover - an async generator that yields nothing
            yield SentenceAudio(pcm=b"", sample_rate=24000, text=text)

    async def close(self) -> None:
        return None


class TriggerGreetingVoice:
    """A greeting that fails with one already-classified voice failure."""

    def __init__(self, failure: BaseException) -> None:
        self.binding = LOLA
        self.begin = {}
        self.failure = failure
        self.greeted: list[str] = []

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        raise self.failure
        if False:  # pragma: no cover
            yield SentenceAudio(pcm=b"", sample_rate=24000, text=text)

    async def close(self) -> None:
        return None


class CallHarness(unittest.TestCase):
    def make(
        self,
        *,
        body=None,
        voice=None,
        factory=None,
        transport=None,
        trace=None,
        open_voice=None,
    ):
        body_map = body_dict() if body is None else body
        transport = FakeTransport([]) if transport is None else transport
        stream = FakeStream()
        clock = FakeClock(10.0)
        frames = []

        class Sink:
            async def __call__(self, outbound) -> None:
                frames.append(outbound)

        if open_voice is None:
            assert voice is not None

            async def open_voice(_body):
                return OpenedLeg("tts", "assemblyai", "primary", "one rung", voice)

        speech = ScriptedSTT(
            [SpeechStart("t1"), SpeechComplete("book a demo", turn_id="t1")]
            if trace is None
            else trace,
            clock=clock,
        )

        async def open_speech(_body):
            return OpenedLeg("stt", "meta", "primary", "speech leg is closed", speech)

        lifecycle = CallLifecycle(
            message=signed_message(body_map),
            secret=SECRET,
            call_id=CALL_ID,
            transport=transport,
            open_speech=open_speech,
            open_voice=open_voice,
            stream=stream,
            send_audio=Sink(),
            ledger=TimingLedger(now=clock),
            clock=clock,
            envelope_clock=FakeClock(ISSUED_S),
            drain_bound_ms=1000,
        )
        return lifecycle, transport, stream, frames, speech


class GreetingFailureCallTest(CallHarness):
    def test_a_trigger_close_during_the_greeting_records_the_trigger_and_opens_the_leg(self):
        factory = ScriptedSocketFactory(
            [
                [begin(voice_id="lola", language="Spanish"), Frame(close_code=1011)],
                [begin(voice_id="lola", language="Spanish"), Frame(close_code=1011)],
            ]
        )
        voice: dict[str, AssemblyAIStreamingTTS] = {}

        async def open_voice(_body):
            tts = AssemblyAIStreamingTTS(
                voice_id="lola",
                transport="browser",
                api_key="test-key",
                socket_factory=factory,
            )
            await tts.open()
            voice["tts"] = tts
            return OpenedLeg("tts", "assemblyai", "primary", "one rung", tts)

        lifecycle, transport, stream, frames, speech = self.make(
            open_voice=open_voice
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        tts = voice["tts"]
        self.assertFalse(stream.started)
        self.assertEqual("error", end.ended_by)
        self.assertEqual("greeting", end.error.stage)
        self.assertEqual("SynthesisCallFailure", end.error.name)
        self.assertEqual(
            {
                "leg": "tts",
                "code": 1011,
                "class": "trigger",
                "reason": "abnormal socket close",
            },
            end.error.trigger,
        )
        self.assertEqual(2, len(factory.connections), "one retry, then the failure")
        self.assertEqual(1, len(tts.breaker_opens))
        self.assertEqual("tts", tts.breaker_opens[0].leg)

    def test_a_bug_close_is_recorded_as_the_voice_trigger_without_opening_the_leg(self):
        factory = ScriptedSocketFactory(
            [begin(voice_id="lola", language="Spanish"), Frame(close_code=3006)]
        )
        voice: dict[str, AssemblyAIStreamingTTS] = {}

        async def open_voice(_body):
            tts = AssemblyAIStreamingTTS(
                voice_id="lola",
                transport="browser",
                api_key="test-key",
                socket_factory=factory,
            )
            await tts.open()
            voice["tts"] = tts
            return OpenedLeg("tts", "assemblyai", "primary", "one rung", tts)

        lifecycle, transport, stream, frames, speech = self.make(
            open_voice=open_voice
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        tts = voice["tts"]
        self.assertEqual("greeting", end.error.stage)
        self.assertEqual("bug", end.error.trigger["class"])
        self.assertEqual(3006, end.error.trigger["code"])
        self.assertEqual([], tts.breaker_opens)
        self.assertEqual(1, len(tts.alerts))

    def test_a_greeting_that_never_sounds_fails_by_name_not_by_the_idle_timeout(self):
        lifecycle, transport, stream, frames, speech = self.make(
            voice=SilentGreetingVoice()
        )

        end = asyncio.run(asyncio.wait_for(lifecycle.run(), timeout=2.0))

        self.assertFalse(stream.started)
        self.assertEqual("error", end.ended_by)
        self.assertEqual("GreetingSilent", end.error.name)
        self.assertEqual("greeting", end.error.stage)
        bound = next(
            outcome for outcome in end.bounds if outcome.stage == "greeting"
        )
        self.assertEqual("tts.idle_timeout_ms", bound.bound)
        self.assertFalse(bound.ok)
        self.assertEqual("GreetingSilent", bound.error.name)
        self.assertNotEqual("GreetingTimedOut", bound.error.name)

    def test_a_silent_greeting_body_never_chimes_or_fails(self):
        body = body_dict(greeting="")
        lifecycle, transport, stream, frames, speech = self.make(
            body=body, voice=SilentGreetingVoice()
        )

        end = asyncio.run(lifecycle.run())

        self.assertFalse(end.greeting.spoken)
        self.assertFalse(end.greeting.chime_fired)
        self.assertEqual([], [frame for frame in frames if frame.kind == "greeting"])


class GreetingTextEqualityTest(unittest.TestCase):
    def test_the_greeting_source_line_is_the_committed_clip_line(self):
        for voice_id, clip_line in CLIP_LINES.items():
            with self.subTest(voice=voice_id):
                binding = bind_voice(voice_id)
                self.assertEqual(GREETINGS[binding.locale.code], clip_line)

    def test_the_committed_clip_evidence_hashes_its_own_line(self):
        for clip in CLIPS["clips"]:
            with self.subTest(voice=clip["voice"]):
                self.assertEqual(
                    clip["lineSha256"],
                    hashlib.sha256(clip["line"].encode("utf-8")).hexdigest(),
                )

    def test_the_call_speaks_the_body_line_and_the_clip_line_unchanged(self):
        from cascade.assemblyai_tts import schedule
        from cascade.tts_support import audio_ms, flush_done

        line = CLIP_LINES["lola"]
        plan = [begin(voice_id="lola", language="Spanish")]
        for index in range(len(schedule(line))):
            plan.append(audio_ms(400, flush_id=index))
            plan.append(flush_done(flush_id=index, audio_duration_ms=400))

        async def scenario():
            factory = ScriptedSocketFactory(plan)
            tts = AssemblyAIStreamingTTS(
                voice_id="lola",
                transport="browser",
                api_key="test-key",
                socket_factory=factory,
            )
            await tts.open()
            outcome = await CallGreeting(
                voice=tts,
                ledger=TimingLedger(now=FakeClock()),
                sink=None,
                chime=lambda: None,
            ).speak(adapt_body(body_dict(greeting=line)))
            return factory, outcome

        factory, outcome = asyncio.run(scenario())

        sent = [json.loads(message) for message in factory.socket.sent]
        generated = "".join(
            frame["text"] for frame in sent if frame["type"] == "Generate"
        )
        self.assertEqual(line, outcome.text)
        self.assertEqual(line, generated)
        self.assertEqual(CLIP_LINES["lola"], outcome.text)

if __name__ == "__main__":
    unittest.main()

"""Ticket 85: a tool turn discards narration and speaks a localized hold.

The model narrates before it calls a tool ("Let me check the listings"), and the
caller must not hear it. These tests read what the injected voice was asked to
say and what reached the audio sink, so they fail if narration is spoken, if the
hold line is the English line in every Locale, if a fast tool still speaks a
hold, if a barge-in cannot cancel it, or if the assistant message is dropped
from history because its audio was suppressed.

Seams under test:

* ``ToolNarrationHold.speak`` -> the voice and the audio sink. Catches heard
  narration, a non-localized hold line, a hold spoken for a tool that already
  answered, and a barge-in that cannot stop the line. Misses the orchestrator's
  barge-in trigger (M06) and the tool-call cap (87).
* ``MessageHistory``/``continue_after_tool`` -> the next model request. Catches
  a hold that replaces the model's own words in history, which makes the next
  request lack the assistant message the vendor requires.
"""

import asyncio
import unittest

from cascade.greeting import AudioSink
from cascade.meta_llm import MessageHistory, MetaLLMTurn, MetaToolCall
from cascade.testing import Response, ScriptedLLM, ScriptedSessionFactory
from cascade.tools import (
    HOLD_LINES,
    HoldOutcome,
    ToolExecutor,
    ToolNarrationHold,
    ToolResult,
    UnknownHoldLineError,
    continue_after_tool,
    hold_line,
)
from cascade.voice_binding import LOCALES
from providers import SentenceAudio, ToolCallRequest

BASE_URL = "https://app.example.test"
TOOL_SECRET = "test-tool-secret"
CALL_ID = "8f14e45f-ea11-4d17-9d0a-6c3f3d7f1c1a"
NARRATION = "Let me check the listings for you."


class RecordingVoice:
    """A synthesis session that records what it was asked to say."""

    def __init__(self, frames: int = 1) -> None:
        self.spoken: list[str] = []
        self.cancels = 0
        self._frames = frames

    async def speak(self, text: str):
        self.spoken.append(text)
        for _ in range(self._frames):
            yield SentenceAudio(pcm=text.encode(), sample_rate=24000, text=text)

    async def cancel(self) -> None:
        self.cancels += 1


def narrated_turn() -> MetaLLMTurn:
    turn = MetaLLMTurn(
        content_text=NARRATION,
        finish_reason="tool_calls",
        tool_calls=[
            MetaToolCall(
                index=0,
                call_id="call_1",
                name="search_properties",
                arguments='{"location": "Dubai"}',
            )
        ],
    )
    turn.close()
    return turn


def a_result() -> ToolResult:
    return ToolResult(
        name="search_properties",
        tool_call_id="call_1",
        payload={"ok": True, "data": {"count": 1}},
    )


def spoken_by(hold: ToolNarrationHold, turn: MetaLLMTurn, hop=None):
    """Run one hold and return what the caller heard and what it decided."""

    async def run():
        return await hold.speak(turn=turn, hop=hop)

    return asyncio.run(run())


def collect(events) -> list:
    async def run():
        return [event async for event in events]

    return asyncio.run(run())


class DiscardNarrationTests(unittest.TestCase):
    def test_the_model_narration_is_discarded_and_the_hold_is_spoken(self):
        voice = RecordingVoice()
        sink: list[SentenceAudio] = []
        hold = ToolNarrationHold(voice=voice, locale_code="en", sink=sink.append)

        outcome = spoken_by(hold, narrated_turn())

        self.assertEqual(voice.spoken, ["One moment."])
        self.assertNotIn(NARRATION, voice.spoken)
        self.assertEqual([frame.text for frame in sink], ["One moment."])
        self.assertTrue(outcome.spoken)
        self.assertEqual(outcome.text, "One moment.")

    def test_the_narration_in_flight_is_cancelled_before_the_hold(self):
        voice = RecordingVoice()
        hold = ToolNarrationHold(voice=voice, locale_code="en")

        spoken_by(hold, narrated_turn())

        self.assertEqual(voice.cancels, 1, "the narration was never cut from audio")

    def test_a_normal_turn_keeps_its_narration_and_gets_no_hold(self):
        turn = MetaLLMTurn(content_text="Two properties match.", finish_reason="stop")
        turn.close()
        voice = RecordingVoice()
        hold = ToolNarrationHold(voice=voice, locale_code="en")

        outcome = spoken_by(hold, turn)

        self.assertEqual(voice.spoken, [])
        self.assertEqual(voice.cancels, 0)
        self.assertFalse(outcome.spoken)


class LocalizedHoldTests(unittest.TestCase):
    def test_every_locale_the_catalogue_speaks_has_its_own_hold_line(self):
        self.assertEqual(set(HOLD_LINES), set(LOCALES))

    def test_each_locale_is_spoken_in_its_own_language(self):
        for code in LOCALES:
            with self.subTest(locale=code):
                voice = RecordingVoice()
                hold = ToolNarrationHold(voice=voice, locale_code=code)

                outcome = spoken_by(hold, narrated_turn())

                self.assertEqual(voice.spoken, [hold_line(code)])
                self.assertEqual(outcome.text, hold_line(code))
        self.assertNotEqual(hold_line("en"), hold_line("es"))

    def test_an_unknown_locale_is_refused_by_name(self):
        with self.assertRaises(UnknownHoldLineError) as raised:
            ToolNarrationHold(voice=RecordingVoice(), locale_code="xx")

        self.assertIn("xx", str(raised.exception))


class FastToolTests(unittest.TestCase):
    def test_a_tool_that_answered_before_the_hold_was_needed_speaks_nothing(self):
        async def scenario():
            voice = RecordingVoice()
            hold = ToolNarrationHold(voice=voice, locale_code="en")
            executor = ToolExecutor(
                base_url=BASE_URL,
                call_id=CALL_ID,
                secret=TOOL_SECRET,
                session_factory=ScriptedSessionFactory(
                    [Response(body=b'{"ok": true}')]
                ),
                timeout_ms=2000,
            )
            hop = executor.start(
                ToolCallRequest(
                    name="search_properties",
                    arguments={"location": "Dubai"},
                    call_id="call_1",
                )
            )
            await hop.outcome()
            return await hold.speak(turn=narrated_turn(), hop=hop), voice

        outcome, voice = asyncio.run(scenario())

        self.assertEqual(voice.spoken, [])
        self.assertFalse(outcome.spoken)
        self.assertIn("answered", outcome.reason)

    def test_the_hold_is_spoken_while_the_tool_is_still_in_flight(self):
        release = asyncio.Event()

        class GatedResponse:
            status = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def iter_bytes(self):
                await release.wait()
                yield b'{"ok": true}'

        class GatedSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def post(self, url, *, headers=None, json=None):
                return GatedResponse()

        class GatedRoute:
            def __call__(self, *, timeout_s: float = 0.0):
                return GatedSession()

        async def scenario():
            executor = ToolExecutor(
                base_url=BASE_URL,
                call_id=CALL_ID,
                secret=TOOL_SECRET,
                session_factory=GatedRoute(),
                timeout_ms=2000,
            )
            hop = executor.start(
                ToolCallRequest(
                    name="search_properties",
                    arguments={"location": "Dubai"},
                    call_id="call_1",
                )
            )
            voice = RecordingVoice()
            hold = ToolNarrationHold(voice=voice, locale_code="en")
            outcome = await hold.speak(turn=narrated_turn(), hop=hop)
            pending = hop.done
            release.set()
            await hop.outcome()
            return outcome, pending, voice

        outcome, pending, voice = asyncio.run(scenario())

        self.assertTrue(outcome.spoken)
        self.assertFalse(pending, "the hold waited for the tool instead of speaking")
        self.assertEqual(voice.spoken, ["One moment."])


class GatedVoice:
    """A voice whose next frame is released by the test, so cancel is provable."""

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.cancels = 0
        self.cancelled = False
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.delivered = 0

    async def speak(self, text: str):
        # A Generate sent after a Cancel is not caught by that cancel (spec).
        self.cancelled = False
        self.spoken.append(text)
        self.started.set()
        while True:
            await self.release.wait()
            self.release.clear()
            if self.cancelled:
                return
            self.delivered += 1
            yield SentenceAudio(pcm=text.encode(), sample_rate=24000, text=text)

    async def cancel(self) -> None:
        self.cancels += 1
        self.cancelled = True
        self.release.set()


class CancellableHoldTests(unittest.TestCase):
    def test_a_barge_in_cancels_the_hold_and_the_tool_result_still_lands(self):
        turn = narrated_turn()
        history = MessageHistory()
        history.append_user("Any villas in Dubai?")

        async def scenario():
            voice = GatedVoice()
            sink: list[SentenceAudio] = []
            first_frame = asyncio.Event()

            def collect_frame(audio: AudioSink) -> None:
                sink.append(audio)
                first_frame.set()

            hold = ToolNarrationHold(
                voice=voice, locale_code="en", sink=collect_frame
            )
            task = asyncio.ensure_future(hold.speak(turn=turn))
            await asyncio.wait_for(voice.started.wait(), timeout=1.0)
            voice.release.set()
            await asyncio.wait_for(first_frame.wait(), timeout=1.0)
            await hold.cancel()
            outcome = await asyncio.wait_for(task, timeout=1.0)
            events = [
                event
                async for event in continue_after_tool(
                    llm=ScriptedLLM([[]]), history=history, turn=turn, outcome=a_result()
                )
            ]
            return outcome, sink, voice, events

        outcome, sink, voice, events = asyncio.run(scenario())

        self.assertTrue(outcome.cancelled)
        self.assertEqual(len(sink), 1, "audio kept playing after the hold was cancelled")
        self.assertEqual(events, [], "a cancelled hold changed the tool continuation")
        self.assertEqual(
            [message["role"] for message in history.messages],
            ["user", "assistant", "tool"],
        )

    def test_cancelling_before_the_hold_speaks_nothing(self):
        async def scenario():
            voice = GatedVoice()
            hold = ToolNarrationHold(voice=voice, locale_code="en")
            await hold.cancel()
            return await hold.speak(turn=narrated_turn()), voice

        outcome, voice = asyncio.run(scenario())

        self.assertIsInstance(outcome, HoldOutcome)
        self.assertTrue(outcome.cancelled)
        self.assertEqual(voice.spoken, [])


class HistoryVerbatimTests(unittest.TestCase):
    def test_the_assistant_message_with_narration_is_appended_verbatim(self):
        turn = narrated_turn()
        history = MessageHistory()
        history.append_user("Any villas in Dubai?")
        hold = ToolNarrationHold(voice=RecordingVoice(), locale_code="en")
        llm = ScriptedLLM([[]])

        spoken_by(hold, turn)
        events = collect(
            continue_after_tool(
                llm=llm, history=history, turn=turn, outcome=a_result()
            )
        )

        self.assertEqual(events, [])
        self.assertEqual(len(llm.requests), 1)
        messages = llm.requests[0]["messages"]
        assistant = messages[1]
        self.assertEqual(assistant["role"], "assistant")
        self.assertEqual(assistant["content"], NARRATION)
        self.assertEqual(assistant["tool_calls"][0]["id"], "call_1")
        self.assertEqual(messages[2]["role"], "tool")
        self.assertEqual(messages[2]["tool_call_id"], "call_1")


if __name__ == "__main__":
    unittest.main()

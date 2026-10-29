"""Ticket 95: a dropped speech socket is recovered by replaying the turn.

Spec: `.scratch/meta-cascade/spec.md`, "Reconnect, sequence dedupe, partial
reply" — "A new session, a new handshake, a new provider ``turnId``, and the
current logical turn's buffered audio replayed from its ``speechStart``. The
new provider ``turnId`` maps to the existing logical turn; late events from the
old session are ignored. The turn's text survives because the audio is
replayed, not because the vendor resumes (it has no resume token)."

The adapter's own decision counter is gone: every recovery is decided by the
ticket-94 :class:`cascade.reconnect.ReconnectBudget`, so the failure budget and
the planned-reconnect bucket have exactly one owner. These tests read that
budget, the scripted socket's ``sent`` frames and the logical turn store; no
test reaches into a private counter.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from cascade.meta_stt import (
    MetaStreamingSTT,
    SpeechCallFailure,
    SpeechComplete,
    SpeechPartial,
    SpeechStart,
)
from cascade.reconnect import ReconnectBudget
from cascade.testing.clock import FakeClock
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory

CALL_ID = "call-123"
SAMPLE_RATE = 24000


def ack(epoch: int = 0) -> str:
    return json.dumps({"sessionId": f"{CALL_ID}:{epoch}", "status": "ready"})


def event(type_name: str, **fields) -> str:
    return json.dumps({"type": type_name, **fields})


def pcm(value: int, samples: int = 480) -> bytes:
    """One 20 ms s16le mono frame at 24 kHz."""
    return value.to_bytes(2, "little", signed=True) * samples


def backend_over(plans, *, budget: ReconnectBudget | None = None):
    clock = FakeClock()
    factory = ScriptedSocketFactory(plans, clock=clock)
    backend = MetaStreamingSTT(
        call_id=CALL_ID,
        api_key="test-key",
        socket_factory=factory,
        clock=clock,
        budget=budget,
    )
    return backend, factory


def audio_frames(factory, connection: int) -> list[bytes]:
    """The binary frames the adapter sent on one scripted connection."""
    return [
        message
        for message in factory.connections[connection]["socket"].sent
        if isinstance(message, bytes)
    ]


class ReplayOnDroppedSocketTest(unittest.TestCase):
    def test_a_dropped_socket_replays_the_turn_audio_into_a_new_session(self):
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    Frame(close_code=1011, reason="internal"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-9"),
                    event("speechComplete", turnId="turn-9", text="hello"),
                ],
            ]
        )
        first = pcm(1)
        second = pcm(2)

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            stream = backend.events()
            started = await anext(stream)
            await backend.send_audio(first)
            await backend.send_audio(second)
            rest = [mapped async for mapped in stream]
            return started, rest

        started, rest = asyncio.run(run())

        self.assertEqual(started, SpeechStart(turn_id="turn-1", session_epoch=0))
        self.assertEqual(len(factory.connections), 2, "one new session")
        self.assertEqual(backend.epoch, 1, "the new session has a new epoch")
        self.assertIn(f"{CALL_ID}%3A1", factory.connections[1]["url"])
        self.assertEqual(
            audio_frames(factory, 1),
            [first, second],
            "the unanswered audio is re-sent from the turn's speech start",
        )
        self.assertEqual(
            [(type(mapped).__name__, mapped.turn_id) for mapped in rest],
            [("SpeechStart", "turn-9"), ("SpeechComplete", "turn-9")],
        )
        self.assertEqual(rest[0].session_epoch, 1)
        self.assertEqual(rest[1].text, "hello")

        # One budget, one failure reconnect: the adapter keeps no second counter.
        self.assertEqual(
            backend.reconnect_budget.counters("stt").failure_reconnects, 1
        )
        self.assertEqual(
            backend.reconnect_budget.counters("stt").failures, 1
        )


class LogicalTurnMappingTest(unittest.TestCase):
    """The replayed vendor turn is the same logical turn, not a second one."""

    def test_the_new_provider_turn_maps_to_the_existing_logical_turn(self):
        backend, _ = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    event("transcript", text="hello"),
                    Frame(close_code=1011, reason="internal"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-9"),
                    event("transcript", text="hello"),
                    event("speechComplete", turnId="turn-9", text="hello"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            stream = backend.events()
            await anext(stream)
            await backend.send_audio(pcm(1))
            return [mapped async for mapped in stream]

        events = asyncio.run(run())

        self.assertEqual(len(backend.turns), 1, "one logical turn, not two")
        turn = backend.turns[0]
        self.assertEqual(turn.id.session_epoch, 0)
        self.assertEqual(turn.id.provider_turn_id, "turn-1")
        self.assertEqual(turn.final_text, "hello")
        self.assertEqual(turn.attribution.session_epoch, 1)
        self.assertEqual(turn.attribution.provider_turn_id, "turn-9")
        self.assertEqual(
            [old.provider_turn_id for old in turn.attribution_history], ["turn-1"]
        )
        finals = [mapped for mapped in events if isinstance(mapped, SpeechComplete)]
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0].text, "hello")

    def test_a_late_event_from_the_replaced_session_cannot_change_the_turn(self):
        backend, _ = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    Frame(close_code=1011, reason="internal"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-9"),
                    event("speechComplete", turnId="turn-9", text="hello"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            stream = backend.events()
            await anext(stream)
            await backend.send_audio(pcm(1))
            events = [mapped async for mapped in stream]
            stale = backend.map_event(
                event("speechComplete", turnId="turn-1", text="stale words"),
                epoch=0,
            )
            return events, stale

        events, stale = asyncio.run(run())

        self.assertIsNone(stale)
        self.assertEqual(backend.stale_events, 1)
        self.assertEqual(backend.turns[0].final_text, "hello")
        finals = [mapped for mapped in events if isinstance(mapped, SpeechComplete)]
        self.assertEqual([final.text for final in finals], ["hello"])

    def test_a_replayed_final_is_delivered_once(self):
        backend, _ = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    Frame(close_code=1011, reason="internal"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-9"),
                    event("speechComplete", turnId="turn-9", text="hello"),
                    event("speechComplete", turnId="turn-9", text="hello again"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            stream = backend.events()
            await anext(stream)
            await backend.send_audio(pcm(1))
            with self.assertLogs("cascade.meta_stt", level="WARNING"):
                return [mapped async for mapped in stream]

        events = asyncio.run(run())

        finals = [mapped for mapped in events if isinstance(mapped, SpeechComplete)]
        self.assertEqual([final.text for final in finals], ["hello"])
        self.assertEqual(backend.turns[0].final_text, "hello")
        self.assertEqual(backend.turns[0].duplicate_finals, 1)

    def test_a_finalised_turns_audio_is_not_replayed(self):
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="done"),
                    Frame(close_code=1011, reason="internal"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-2"),
                    event("speechComplete", turnId="turn-2", text="next"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            stream = backend.events()
            await anext(stream)
            await backend.send_audio(pcm(1))
            return [mapped async for mapped in stream]

        events = asyncio.run(run())

        self.assertEqual(audio_frames(factory, 1), [], "nothing is unanswered")
        self.assertEqual(len(backend.turns), 2, "the new turn is its own turn")
        self.assertEqual(
            [mapped.text for mapped in events if isinstance(mapped, SpeechComplete)],
            ["done", "next"],
        )


class PartialJoinTest(unittest.TestCase):
    def test_a_lagging_replayed_partial_never_loses_the_callers_words(self):
        backend, _ = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    event("transcript", text="I want to book a demo"),
                    Frame(close_code=1011, reason="internal"),
                ],
                [
                    ack(1),
                    event("speechStart", turnId="turn-9"),
                    event("transcript", text="I want"),
                    event("speechComplete", turnId="turn-9", text="I want"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            stream = backend.events()
            await anext(stream)
            await backend.send_audio(pcm(1))
            return [mapped async for mapped in stream]

        events = asyncio.run(run())

        partials = [
            mapped.text for mapped in events if isinstance(mapped, SpeechPartial)
        ]
        self.assertEqual(
            partials[-1],
            "I want to book a demo",
            "the lagging replay partial keeps the words the caller already said",
        )
        finals = [mapped for mapped in events if isinstance(mapped, SpeechComplete)]
        self.assertEqual([final.text for final in finals], ["I want to book a demo"])


class BudgetOwnershipTest(unittest.TestCase):
    """Ticket 95 routes every decision through ticket 94's one budget."""

    def test_a_second_failure_ends_the_call_without_a_second_reconnect(self):
        budget = ReconnectBudget(now=FakeClock())
        backend, factory = backend_over(
            [
                [ack(0), Frame(close_code=1011, reason="internal")],
                [ack(1), Frame(close_code=1011, reason="internal")],
                [ack(2)],
            ],
            budget=budget,
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            return [mapped async for mapped in backend.events()]

        with self.assertRaises(SpeechCallFailure):
            asyncio.run(run())

        self.assertEqual(len(factory.connections), 2, "one retry, never two")
        self.assertEqual(budget.counters("stt").failures, 2)
        self.assertEqual(budget.counters("stt").failure_reconnects, 1)
        self.assertEqual(budget.counters("stt").budget_left, 0)
        self.assertTrue(backend.retry_used)

    def test_rate_limiting_spends_the_budget_without_reconnecting(self):
        budget = ReconnectBudget(now=FakeClock())
        backend, factory = backend_over(
            [[ack(0), Frame(close_code=1013, reason="rate limited")]],
            budget=budget,
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            return [mapped async for mapped in backend.events()]

        with self.assertRaises(SpeechCallFailure):
            asyncio.run(run())

        self.assertEqual(len(factory.connections), 1, "no immediate retry storm")
        self.assertEqual(
            budget.counters("stt").failure_reconnects,
            0,
            "the budget was spent but no reconnect happened",
        )
        self.assertEqual(budget.counters("stt").budget_left, 0)

    def test_a_planned_reconnect_spends_no_failure_budget(self):
        budget = ReconnectBudget(now=FakeClock())
        backend, factory = backend_over(
            [
                [
                    ack(0),
                    event("speechStart", turnId="turn-1"),
                    Frame(
                        close_code=1011,
                        reason="max session duration reached",
                    ),
                ],
                [ack(1), Frame(close_code=1000)],
            ],
            budget=budget,
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=SAMPLE_RATE)
            return [mapped async for mapped in backend.events()]

        asyncio.run(run())

        self.assertEqual(len(factory.connections), 2)
        self.assertEqual(budget.counters("stt").planned_reconnects, 1)
        self.assertEqual(budget.counters("stt").failures, 0)
        self.assertEqual(budget.counters("stt").budget_left, 1)
        self.assertFalse(backend.retry_used)


if __name__ == "__main__":
    unittest.main()

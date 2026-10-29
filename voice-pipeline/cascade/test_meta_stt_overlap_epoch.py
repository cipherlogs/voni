"""Overlapping provider turns and the session epoch (ticket 33).

Meta may open a later turn before an earlier one completes. Every event the
adapter yields is stamped with the local session epoch, and the adapter's turn
state is keyed on ``(session epoch, provider turnId)`` — the same
:class:`cascade.turn_state.LogicalTurnId` an orchestrator keys on. A partial
carries no ``turnId`` and belongs to the most recent ``speechStart``; the
authoritative ``speechComplete`` text may differ from it and always wins. A
reconnect bumps the epoch, so a reused vendor ``turnId`` never merges with the
old turn, and a late event from the replaced session is marked (counted and
logged) and ignored.
"""

import asyncio
import json
import unittest

from cascade.meta_stt import (
    MetaStreamingSTT,
    SpeechComplete,
    SpeechEnd,
    SpeechPartial,
    SpeechStart,
)
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from cascade.turn_state import LogicalTurnId, TurnPhase
from providers import PartialTranscript


def ack() -> str:
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def event(type_name: str, **fields) -> str:
    return json.dumps({"type": type_name, **fields})


def backend_over(plans):
    factory = ScriptedSocketFactory(plans)
    backend = MetaStreamingSTT(
        call_id="call-123", api_key="test-key", socket_factory=factory
    )
    return backend, factory


def drain(backend):
    async def run():
        await backend.open(language_codes=[], sample_rate=24000)
        return [mapped async for mapped in backend.events()]

    return asyncio.run(run())


def state_for(backend, epoch: int, turn_id: str):
    wanted = LogicalTurnId(epoch, turn_id)
    for state in backend.turns:
        if state.id == wanted:
            return state
    return None


class EpochOnEveryEventTest(unittest.TestCase):
    def test_every_yielded_event_carries_the_session_epoch(self):
        events = drain(
            backend_over(
                [
                    [
                        ack(),
                        event("speechStart", turnId="turn-1"),
                        event("transcript", text="hel"),
                        event("speechEnd", turnId="turn-1"),
                        event("speechComplete", turnId="turn-1", text="hello"),
                    ]
                ]
            )[0]
        )

        self.assertEqual([mapped.session_epoch for mapped in events], [0, 0, 0, 0])

    def test_a_partial_carries_an_epoch_and_never_a_turn_id(self):
        events = drain(
            backend_over(
                [[ack(), event("speechStart", turnId="turn-1"), event("transcript", text="hi")]]
            )[0]
        )

        partial = events[1]
        self.assertIsInstance(partial, SpeechPartial)
        self.assertIsInstance(partial, PartialTranscript)
        self.assertFalse(hasattr(partial, "turn_id"))
        self.assertEqual(partial.session_epoch, 0)

    def test_the_event_field_sets_are_the_epoch_contract(self):
        self.assertEqual(
            SpeechStart.__dataclass_fields__.keys(), {"turn_id", "session_epoch"}
        )
        self.assertEqual(
            SpeechEnd.__dataclass_fields__.keys(), {"turn_id", "session_epoch"}
        )
        self.assertEqual(
            SpeechComplete.__dataclass_fields__.keys(),
            {"text", "turn_duration_ms", "turn_id", "session_epoch"},
        )
        self.assertEqual(
            SpeechPartial.__dataclass_fields__.keys(), {"text", "session_epoch"}
        )


class OverlappingTurnsTest(unittest.TestCase):
    def test_a_later_start_before_an_earlier_completion_keeps_both_turns(self):
        backend, _ = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechStart", turnId="turn-2"),
                    event("speechComplete", turnId="turn-1", text="one"),
                    event("speechComplete", turnId="turn-2", text="two"),
                ]
            ]
        )

        events = drain(backend)

        self.assertEqual(
            [mapped.turn_id for mapped in events],
            ["turn-1", "turn-2", "turn-1", "turn-2"],
        )
        self.assertEqual(len(backend.turns), 2)
        first = state_for(backend, 0, "turn-1")
        second = state_for(backend, 0, "turn-2")
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertNotEqual(first.id, second.id)
        self.assertEqual(first.final_text, "one")
        self.assertEqual(second.final_text, "two")
        self.assertIs(first.phase, TurnPhase.FINALISED)
        self.assertIs(second.phase, TurnPhase.FINALISED)

    def test_a_partial_belongs_to_the_most_recent_start_not_the_latest_final(self):
        backend, _ = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("transcript", text="a"),
                    event("speechStart", turnId="turn-2"),
                    event("transcript", text="b"),
                    event("speechComplete", turnId="turn-1", text="one"),
                    event("transcript", text="c"),
                    event("speechComplete", turnId="turn-2", text="two"),
                ]
            ]
        )

        drain(backend)

        first = state_for(backend, 0, "turn-1")
        second = state_for(backend, 0, "turn-2")
        self.assertEqual(first.partial_text, "a")
        self.assertEqual(second.partial_text, "c")
        self.assertEqual(first.final_text, "one")
        self.assertEqual(second.final_text, "two")
        self.assertEqual(first.partial_updates, 1)
        self.assertEqual(second.partial_updates, 2)

    def test_speech_complete_text_wins_over_the_last_partial(self):
        backend, _ = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("transcript", text="how are"),
                    event("speechComplete", turnId="turn-1", text="How are you?"),
                ]
            ]
        )

        drain(backend)

        state = state_for(backend, 0, "turn-1")
        self.assertEqual(state.partial_text, "how are")
        self.assertEqual(state.final_text, "How are you?")

    def test_a_partial_with_no_preceding_start_is_not_attributed(self):
        backend, _ = backend_over(
            [[ack(), event("transcript", text="orphan")]]
        )

        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            events = drain(backend)

        self.assertEqual(events, [])
        self.assertEqual(backend.turns, ())

    def test_a_completion_for_an_unknown_turn_is_logged_and_ignored(self):
        backend, _ = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-9", text="ghost"),
                ]
            ]
        )

        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            events = drain(backend)

        self.assertEqual([mapped.turn_id for mapped in events], ["turn-1"])
        self.assertEqual(state_for(backend, 0, "turn-1").final_text, "")
        self.assertIsNone(state_for(backend, 0, "turn-9"))

    def test_a_duplicate_completion_is_idempotent_and_yields_one_final(self):
        backend, _ = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="one"),
                    event("speechComplete", turnId="turn-1", text="one again"),
                ]
            ]
        )

        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            events = drain(backend)

        finals = [mapped for mapped in events if isinstance(mapped, SpeechComplete)]
        self.assertEqual(len(finals), 1)
        state = state_for(backend, 0, "turn-1")
        self.assertEqual(state.final_text, "one")
        self.assertEqual(state.duplicate_finals, 1)

    def test_a_speech_end_for_an_unknown_turn_is_logged_and_ignored(self):
        backend, _ = backend_over(
            [[ack(), event("speechEnd", turnId="turn-9")]]
        )

        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            events = drain(backend)

        self.assertEqual(events, [])
        self.assertEqual(backend.turns, ())


class SessionEpochTest(unittest.TestCase):
    def test_a_reconnect_stamps_a_new_epoch_on_every_event(self):
        backend, factory = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="first"),
                ],
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="second"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            first = [mapped async for mapped in backend.events()]
            await backend.close()
            await backend.open(language_codes=[], sample_rate=24000)
            second = [mapped async for mapped in backend.events()]
            await backend.close()
            return first, second

        first, second = asyncio.run(run())

        self.assertEqual([mapped.session_epoch for mapped in first], [0, 0])
        self.assertEqual([mapped.session_epoch for mapped in second], [1, 1])
        self.assertEqual(len(factory.connections), 2)

    def test_a_reused_turn_id_after_reconnect_is_two_distinct_logical_turns(self):
        backend, _ = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="first"),
                ],
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="second"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.close()
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.close()

        asyncio.run(run())

        self.assertEqual(len(backend.turns), 2)
        old = state_for(backend, 0, "turn-1")
        new = state_for(backend, 1, "turn-1")
        self.assertIsNotNone(old)
        self.assertIsNotNone(new)
        self.assertNotEqual(old.id, new.id)
        self.assertEqual(old.final_text, "first")
        self.assertEqual(new.final_text, "second")

    def test_a_late_event_from_the_replaced_session_is_marked_and_ignored(self):
        backend, _ = backend_over(
            [
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="first"),
                ],
                [
                    ack(),
                    event("speechStart", turnId="turn-1"),
                    event("speechComplete", turnId="turn-1", text="second"),
                ],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.close()
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            return backend.map_event(
                event("speechComplete", turnId="turn-1", text="late"),
                epoch=0,
            )

        with self.assertLogs("cascade.meta_stt", level="WARNING") as captured:
            late = asyncio.run(run())

        self.assertIsNone(late)
        self.assertEqual(backend.stale_events, 1)
        self.assertTrue(any("epoch 0" in line for line in captured.output))
        self.assertEqual(state_for(backend, 0, "turn-1").final_text, "first")
        self.assertEqual(state_for(backend, 1, "turn-1").final_text, "second")

    def test_a_late_start_from_the_replaced_session_opens_no_turn(self):
        backend, _ = backend_over(
            [
                [ack()],
                [ack(), event("speechStart", turnId="turn-1")],
            ]
        )

        async def run():
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            await backend.close()
            await backend.open(language_codes=[], sample_rate=24000)
            async for _ in backend.events():
                pass
            return backend.map_event(
                event("speechStart", turnId="turn-9"), epoch=0
            )

        with self.assertLogs("cascade.meta_stt", level="WARNING"):
            late = asyncio.run(run())

        self.assertIsNone(late)
        self.assertEqual(backend.stale_events, 1)
        self.assertEqual([state.id for state in backend.turns], [LogicalTurnId(1, "turn-1")])


if __name__ == "__main__":
    unittest.main()

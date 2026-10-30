"""Ticket 10: Meta endpointing and the speechEnd -> speechComplete gap (M00).

Both terms are wall-clock gaps measured against the injected clock, over the
ticket 09 fixture streamed through the ticket 09 pacer into an injectable Meta
STT transport. No network, no sleeps: the scripted transport releases events at
media times the pacer reaches, and stamps each with that arrival instant.

The synthetic timeline injects a known delay per term, so the expected numbers
come from the script, not from the implementation's arithmetic.
"""

import unittest

from cascade.testing.clock import FakeClock
from spike import fixture
from spike.endpointing import (
    ENDPOINTING_TERM,
    POST_PROCESSING_TERM,
    SttEvent,
    measure,
    measure_live,
)


class Script:
    """One event the transport releases ``at_s`` after the stream opens."""

    def __init__(self, at_s: float, kind: str, **payload) -> None:
        self.at_s = at_s
        self.kind = kind
        self.payload = payload


class ScriptedTransport:
    """An injectable Meta STT transport: no socket, no network, no wall clock."""

    def __init__(self, clock: FakeClock, script) -> None:
        self.clock = clock
        self._script = sorted(script, key=lambda item: item.at_s)
        self._pending = list(self._script)
        self._origin_s = 0.0
        self._media_sent_s = 0.0
        self.opened = False
        self.ended = False
        self.closed = False
        self.sent = bytearray()

    def open(self) -> None:
        self.opened = True
        self._origin_s = self.clock()

    def _event(self, item: Script) -> SttEvent:
        return SttEvent(
            received_at_s=self._origin_s + item.at_s, kind=item.kind, **item.payload
        )

    def send_audio(self, chunk: bytes) -> None:
        self.sent.extend(chunk)
        bytes_per_second = fixture.SAMPLE_RATE * fixture.SAMPLE_WIDTH_BYTES
        self._media_sent_s += len(chunk) / bytes_per_second

    def audio_processed_s(self) -> float:
        # The scripted vendor keeps up with everything it was sent; the pacer's
        # lead law is exercised in its own ticket, not here.
        return self._media_sent_s

    def poll(self):
        released = []
        horizon = self.clock() - self._origin_s + 1e-9
        while self._pending and self._pending[0].at_s <= horizon:
            released.append(self._event(self._pending.pop(0)))
        return tuple(released)

    def end_stream(self) -> None:
        self.ended = True

    def drain(self):
        released = tuple(self._event(item) for item in self._pending)
        self._pending.clear()
        return released

    def close(self) -> None:
        self.closed = True


def caller_timeline(
    *, speech_end_at_s=13.1, audio_processed_ms=13_110.0, complete_at_s=None
):
    """One caller turn: speech ends at media 12.4 s, vendor notices at 13.1 s."""
    script = [
        Script(0.5, "speechStart", turn_id="t1"),
        Script(13.0, "transcript", text="how are you"),
        Script(
            speech_end_at_s,
            "speechEnd",
            turn_id="t1",
            audio_processed_ms=audio_processed_ms,
        ),
    ]
    if complete_at_s is not None:
        script.append(
            Script(complete_at_s, "speechComplete", turn_id="t1", text="How are you?")
        )
    return script


def run(script, *, clock=None):
    clock = clock or FakeClock(start=1_000.0)
    transport = ScriptedTransport(clock, script)
    terms = measure(transport, clock=clock, wait=clock.advance)
    return terms, transport, clock


class SyntheticTimelineTests(unittest.TestCase):
    def test_the_injected_delays_reproduce_both_terms(self):
        terms, transport, _ = run(caller_timeline(complete_at_s=13.7))

        self.assertEqual(len(terms), 1)
        turn = terms[0]
        self.assertEqual(turn.turn_id, "t1")

        endpointing = turn.endpointing
        self.assertEqual(endpointing.name, ENDPOINTING_TERM)
        self.assertAlmostEqual(endpointing.value_ms, 700.0, places=3)
        self.assertTrue(endpointing.producer)

        post = turn.post_processing
        self.assertEqual(post.name, POST_PROCESSING_TERM)
        self.assertAlmostEqual(post.value_ms, 600.0, places=3)
        self.assertTrue(post.producer)

        self.assertTrue(transport.opened)
        self.assertTrue(transport.ended)
        self.assertTrue(transport.closed)
        self.assertEqual(bytes(transport.sent), fixture.render_pcm())


class CrossCheckTests(unittest.TestCase):
    def test_a_matching_audio_processed_position_agrees_with_the_wall_clock(self):
        terms, _, _ = run(caller_timeline(complete_at_s=13.7))
        check = terms[0].endpointing.cross_check

        self.assertIsNotNone(check)
        self.assertAlmostEqual(check.wall_ms, 700.0, places=3)
        self.assertAlmostEqual(check.vendor_ms, 710.0, places=3)
        self.assertAlmostEqual(check.delta_ms, 10.0, places=3)
        self.assertTrue(check.agrees)

    def test_a_disagreement_keeps_both_numbers_and_never_averages_them(self):
        terms, _, _ = run(
            caller_timeline(complete_at_s=13.7, audio_processed_ms=14_000.0)
        )
        endpointing = terms[0].endpointing
        check = endpointing.cross_check

        self.assertIsNotNone(check)
        self.assertAlmostEqual(check.wall_ms, 700.0, places=3)
        self.assertAlmostEqual(check.vendor_ms, 1_600.0, places=3)
        self.assertAlmostEqual(check.delta_ms, 900.0, places=3)
        self.assertFalse(check.agrees)
        # the term is the wall-clock measurement; 1150.0 would be the average
        self.assertAlmostEqual(endpointing.value_ms, 700.0, places=3)
        self.assertIn("DISAGREEMENT", endpointing.detail)
        self.assertIn("700.000ms", endpointing.detail)
        self.assertIn("1600.000ms", endpointing.detail)
        self.assertIn("not averaged", endpointing.detail)


class MissingCompleteTests(unittest.TestCase):
    def test_a_turn_without_speech_complete_is_unmeasured_not_zero(self):
        terms, _, _ = run(caller_timeline(complete_at_s=None))
        post = terms[0].post_processing

        self.assertIsNone(post.value_ms)
        self.assertIn("speechComplete", post.producer)
        self.assertIn("unmeasured", post.detail)
        self.assertIn("t1", post.detail)


class TurnAttributionTests(unittest.TestCase):
    def test_the_gap_is_keyed_to_the_same_turnid_when_a_later_turn_starts(self):
        script = caller_timeline(complete_at_s=13.7)
        script.append(Script(13.2, "speechStart", turn_id="t2"))
        terms, _, _ = run(script)
        by_turn = {turn.turn_id: turn for turn in terms}

        self.assertEqual(set(by_turn), {"t1", "t2"})
        self.assertAlmostEqual(by_turn["t1"].post_processing.value_ms, 600.0, places=3)
        self.assertIsNone(by_turn["t2"].post_processing.value_ms)
        self.assertIn("unmeasured", by_turn["t2"].post_processing.detail)

        # The fixture's known speech end belongs to the first caller turn only.
        self.assertAlmostEqual(by_turn["t1"].endpointing.value_ms, 700.0, places=3)
        self.assertIsNone(by_turn["t2"].endpointing.value_ms)
        self.assertIn("t2", by_turn["t2"].endpointing.detail)


class MultiUtteranceTests(unittest.TestCase):
    """A clip with two speech turns cannot anchor the whole file's last sample."""

    def test_two_speech_ends_leave_both_terms_unmeasured_with_the_named_reason(self):
        script = caller_timeline(complete_at_s=13.7)
        script.append(Script(13.2, "speechStart", turn_id="t2"))
        script.append(
            Script(13.9, "speechEnd", turn_id="t2", audio_processed_ms=13_900.0)
        )
        script.append(Script(13.9, "speechComplete", turn_id="t2"))

        terms, _, _ = run(script)

        for turn in terms:
            for term in (turn.endpointing, turn.post_processing):
                self.assertIsNone(term.value_ms)
                self.assertIn("more than one speech turn", term.detail)
                self.assertIn(
                    "record one utterance with trailing silence", term.detail
                )


class NegativeWallTests(unittest.TestCase):
    def test_a_speech_end_before_the_last_speech_sample_is_unmeasured_not_negative(self):
        terms, _, _ = run(
            caller_timeline(
                speech_end_at_s=12.0,
                audio_processed_ms=12_000.0,
                complete_at_s=12.2,
            )
        )
        endpointing = terms[0].endpointing

        self.assertIsNone(endpointing.value_ms)
        self.assertIsNone(endpointing.cross_check)
        self.assertIn("negative", endpointing.detail)
        self.assertNotIn("agree", endpointing.detail)


class OutOfOrderCompleteTests(unittest.TestCase):
    """A speechComplete that beats its speechEnd cannot produce a negative gap."""

    def test_a_speech_complete_before_speech_end_is_unmeasured_not_negative(self):
        script = [
            Script(0.5, "speechStart", turn_id="t1"),
            Script(13.0, "transcript", text="how are you"),
            Script(13.05, "speechComplete", turn_id="t1", text="How are you?"),
            Script(13.1, "speechEnd", turn_id="t1", audio_processed_ms=13_110.0),
        ]
        terms, _, _ = run(script)
        post = terms[0].post_processing

        self.assertIsNone(post.value_ms)
        self.assertIn(
            "speechComplete arrived before speechEnd; out-of-order, "
            "unmeasured, never a negative gap",
            post.detail,
        )
        # The endpointing term is unaffected: only the gap is out of order.
        self.assertAlmostEqual(terms[0].endpointing.value_ms, 700.0, places=3)


class CrossCheckMissingTests(unittest.TestCase):
    def test_a_speechend_without_audio_processed_ms_still_measures_the_wall_clock(self):
        terms, _, _ = run(caller_timeline(complete_at_s=13.7, audio_processed_ms=None))
        endpointing = terms[0].endpointing

        self.assertAlmostEqual(endpointing.value_ms, 700.0, places=3)
        self.assertIsNone(endpointing.cross_check)
        self.assertIn("audioProcessedMs", endpointing.detail)

    def test_unknown_event_types_are_ignored(self):
        script = caller_timeline(complete_at_s=13.7)
        script.append(Script(13.4, "someFutureEvent", turn_id="t1"))
        terms, _, _ = run(script)

        self.assertEqual(len(terms), 1)
        self.assertAlmostEqual(terms[0].post_processing.value_ms, 600.0, places=3)


class NoLiveRunTests(unittest.TestCase):
    def test_without_keys_or_transport_both_terms_are_unmeasured_and_named(self):
        terms = measure_live(transport=None, env={})

        self.assertEqual(len(terms), 1)
        for term in (terms[0].endpointing, terms[0].post_processing):
            self.assertIsNone(term.value_ms)
            self.assertTrue(term.producer)
            self.assertIn("META_API_KEY", term.detail)


if __name__ == "__main__":
    unittest.main()

"""Ticket 12: the synthesis first-audio term and the configured cushion (M00).

Seam: ``spike.first_audio.measure_first_audio`` over a recorded frame list, and
``spike.first_audio.configured_cushion`` over the threshold registry. No socket,
no key, no wall clock: the scripted session runs on the injected ``FakeClock``.

Expected numbers come from the scripted timeline the test builds, never from the
module under test. The cushion comes from a registry fixture, never from a
buffer the module could have measured.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cascade import thresholds
from cascade.testing.clock import FakeClock
from spike import first_audio
from spike.first_audio import (
    AUDIO,
    CUSHION_NAME,
    FLUSH,
    GENERATE,
    Frame,
    FrameOrderError,
    HandshakeInTerm,
    Opening,
    ScriptedSynthesisSession,
    SessionOpenedAfterTurn,
)

#: The cushion as ticket 04 must record it: the worklet's named constant.
WORKLET_SOURCE = (
    "voni/public/playout-processor.js:63 TARGET_CUSHION_S = 0.5 — "
    "the worklet's named constant for the target cushion"
)
CUSHION_BOUND = {
    "unit": "ms",
    "gate": "playout.cushion",
    "ticket": "04",
    "value": 500,
    "source": WORKLET_SOURCE,
    "date": "2026-10-29",
}


def registry_with(**entry):
    """A threshold registry holding one bound, as loaded from the real JSON."""
    return thresholds.Registry(
        {
            "playout.cushion_ms": thresholds.Bound(
                name="playout.cushion_ms",
                unit=entry.get("unit", "ms"),
                gate=entry.get("gate", "playout.cushion"),
                ticket=entry.get("ticket", "04"),
                value=entry.get("value", 500),
                source=entry.get("source", WORKLET_SOURCE),
                date=entry.get("date", "2026-10-29"),
            )
        }
    )


def write_registry(tmp: str, bounds: dict) -> Path:
    path = Path(tmp) / "thresholds.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "note": "fixture",
                "budget_record": {
                    "path": "voni/src/lib/demo/scoreboard-budgets.json",
                    "version": 1,
                    "date": "2026-10-28",
                },
                "bounds": bounds,
            }
        ),
        encoding="utf-8",
    )
    return path


def pre_opened(
    *,
    turn_at_s: float = 3.0,
    handshake_ms: float = 250.0,
    generate_at_s: float | None = None,
    flush_delay_ms: float = 40.0,
    audio_delay_ms: float = 127.0,
) -> ScriptedSynthesisSession:
    """A session opened and acknowledged before the turn, then one sentence."""
    clock = FakeClock(0.0)
    session = ScriptedSynthesisSession(clock=clock, turn_at_s=turn_at_s)
    session.open()
    session.receive_begin(delay_ms=handshake_ms)

    target = turn_at_s if generate_at_s is None else generate_at_s
    clock.advance(target - clock())
    session.send_generate("Hello there, this is the first sentence.")
    session.send_flush(delay_ms=flush_delay_ms)
    session.receive_audio(delay_ms=audio_delay_ms)
    return session


def framed(*items: tuple[str, float, str]) -> tuple[Frame, ...]:
    return tuple(Frame(kind=kind, at_s=at, detail=detail) for kind, at, detail in items)


class TermTests(unittest.TestCase):
    def test_the_term_is_flush_to_first_audio_and_excludes_the_handshake(self):
        result = pre_opened().measure()

        # 3.167s first Audio - 3.040s Flush = 127ms; the 250ms handshake is not
        # in the term, and the 500ms cushion is not either.
        self.assertEqual(result.first_audio_ms, 127.0)
        self.assertEqual(result.handshake_ms, 250.0)
        self.assertEqual(result.term.name, first_audio.TERM_NAME)
        self.assertEqual(result.term.ms, 127.0)
        self.assertEqual(result.term.producer, first_audio.PRODUCER)

    def test_the_term_starts_at_the_flush_not_the_generate(self):
        result = pre_opened(flush_delay_ms=40.0, audio_delay_ms=127.0).measure()
        # From Generate (3.000s) the gap would be 167ms. The term is the
        # committed request: Generate plus Flush.
        self.assertNotEqual(result.first_audio_ms, 167.0)
        self.assertEqual(result.first_audio_ms, 127.0)

    def test_a_longer_handshake_does_not_move_the_term(self):
        short = pre_opened(handshake_ms=250.0).measure()
        long = pre_opened(handshake_ms=2_000.0).measure()

        self.assertEqual(short.first_audio_ms, long.first_audio_ms)
        self.assertEqual(long.handshake_ms, 2_000.0)
        # The handshake is recorded, not dropped: it is a call-start cost.
        self.assertEqual(long.handshake.name, first_audio.HANDSHAKE_NAME)
        self.assertIn("excluded", long.handshake.detail)

    def test_audio_arriving_before_the_flush_is_not_the_first_audio(self):
        opening = Opening(opened_at_s=0.0, begin_at_s=0.25)
        frames = framed(
            (GENERATE, 3.0, ""),
            (AUDIO, 3.02, "in flight from the greeting"),
            (FLUSH, 3.04, ""),
            (AUDIO, 3.167, ""),
        )
        result = first_audio.measure_first_audio(
            opening=opening, turn_at_s=3.0, frames=frames
        )
        self.assertEqual(result.first_audio_ms, 127.0)

    def test_the_term_does_not_include_the_cushion(self):
        result = pre_opened().measure(registry=registry_with())
        self.assertEqual(result.first_audio_ms, 127.0)
        self.assertEqual(result.cushion.ms, 500.0)
        self.assertEqual(
            [entry.name for entry in result.terms()],
            [
                first_audio.TERM_NAME,
                first_audio.CUSHION_NAME,
                first_audio.HANDSHAKE_NAME,
            ],
        )


class PreOpenedSessionTests(unittest.TestCase):
    def test_a_session_opened_after_the_turn_is_rejected(self):
        clock = FakeClock(0.0)
        session = ScriptedSynthesisSession(clock=clock, turn_at_s=1.0)
        clock.advance(5.0)
        session.open()
        session.receive_begin(delay_ms=200.0)
        session.send_generate("Hello there.")
        session.send_flush(delay_ms=40.0)
        session.receive_audio(delay_ms=127.0)

        with self.assertRaises(SessionOpenedAfterTurn) as caught:
            session.measure()

        self.assertIn("opened", str(caught.exception))
        self.assertIn("5.000", str(caught.exception))
        self.assertIn("turn", str(caught.exception))
        self.assertIn("1.000", str(caught.exception))

    def test_a_session_opened_exactly_at_the_turn_is_rejected(self):
        opening = Opening(opened_at_s=3.0, begin_at_s=3.1)
        frames = framed((GENERATE, 3.2, ""), (FLUSH, 3.24, ""), (AUDIO, 3.367, ""))
        with self.assertRaises(SessionOpenedAfterTurn):
            first_audio.measure_first_audio(
                opening=opening, turn_at_s=3.0, frames=frames
            )

    def test_a_session_acknowledged_after_the_turn_is_rejected(self):
        opening = Opening(opened_at_s=0.0, begin_at_s=2.0)
        frames = framed((GENERATE, 2.1, ""), (FLUSH, 2.14, ""), (AUDIO, 2.267, ""))
        with self.assertRaises(HandshakeInTerm) as caught:
            first_audio.measure_first_audio(
                opening=opening, turn_at_s=1.0, frames=frames
            )
        self.assertIn("Begin", str(caught.exception))

    def test_a_measurable_audio_without_a_begin_is_rejected(self):
        opening = Opening(opened_at_s=0.0, begin_at_s=None)
        frames = framed((GENERATE, 3.0, ""), (FLUSH, 3.04, ""), (AUDIO, 3.167, ""))
        with self.assertRaises(HandshakeInTerm):
            first_audio.measure_first_audio(
                opening=opening, turn_at_s=3.0, frames=frames
            )

    def test_a_begin_before_the_session_opened_is_refused(self):
        opening = Opening(opened_at_s=1.0, begin_at_s=0.5)
        with self.assertRaises(FrameOrderError):
            first_audio.measure_first_audio(
                opening=opening, turn_at_s=3.0, frames=framed((AUDIO, 3.1, ""))
            )


class UnmeasuredTests(unittest.TestCase):
    def test_no_recorded_frames_is_unmeasured_with_a_live_producer_line(self):
        result = first_audio.measure_first_audio(
            opening=Opening(opened_at_s=0.0, begin_at_s=0.25),
            turn_at_s=3.0,
            frames=(),
        )

        self.assertIsNone(result.first_audio_ms)
        self.assertIsNone(result.term.ms)
        self.assertIn("spike.run --live", result.term.producer)
        self.assertIn("ASSEMBLYAI_API_KEY", result.term.producer)
        self.assertTrue(result.term.detail, "an unmeasured term must say why")

    def test_frames_without_audio_are_unmeasured_never_zero(self):
        frames = framed((GENERATE, 3.0, ""), (FLUSH, 3.04, ""))
        result = first_audio.measure_first_audio(
            opening=Opening(opened_at_s=0.0, begin_at_s=0.25),
            turn_at_s=3.0,
            frames=frames,
        )
        self.assertIsNone(result.first_audio_ms)
        self.assertIn("Audio", result.term.detail)

    def test_frames_out_of_order_are_refused(self):
        frames = framed((FLUSH, 3.04, ""), (GENERATE, 3.0, ""), (AUDIO, 3.167, ""))
        with self.assertRaises(FrameOrderError):
            first_audio.measure_first_audio(
                opening=Opening(opened_at_s=0.0, begin_at_s=0.25),
                turn_at_s=3.0,
                frames=frames,
            )

    def test_a_flush_before_any_generate_is_refused(self):
        frames = framed((FLUSH, 3.04, ""), (AUDIO, 3.167, ""))
        with self.assertRaises(FrameOrderError):
            first_audio.measure_first_audio(
                opening=Opening(opened_at_s=0.0, begin_at_s=0.25),
                turn_at_s=3.0,
                frames=frames,
            )


class CushionTests(unittest.TestCase):
    def test_the_cushion_is_the_named_configured_value_not_a_buffer_reading(self):
        result = pre_opened().measure(registry=registry_with())

        self.assertEqual(result.cushion.name, CUSHION_NAME)
        self.assertEqual(result.cushion.ms, 500.0)
        self.assertEqual(result.cushion.source, WORKLET_SOURCE)
        self.assertEqual(result.cushion.date, "2026-10-29")
        self.assertTrue(result.cushion.configured)
        self.assertFalse(result.term.configured)

    def test_the_cushion_does_not_move_with_the_audio_the_session_sent(self):
        ten_ms_chunks = pre_opened(audio_delay_ms=127.0).measure(
            registry=registry_with()
        )
        long_reply = pre_opened(audio_delay_ms=1_800.0).measure(
            registry=registry_with()
        )

        self.assertNotEqual(
            ten_ms_chunks.first_audio_ms, long_reply.first_audio_ms
        )
        self.assertEqual(ten_ms_chunks.cushion.ms, long_reply.cushion.ms)
        self.assertEqual(ten_ms_chunks.cushion.ms, 500.0)

    def test_an_open_cushion_bound_is_unmeasured_by_name(self):
        result = pre_opened().measure(registry=registry_with(value=None))

        self.assertIsNone(result.cushion.ms)
        self.assertEqual(result.cushion.name, CUSHION_NAME)
        self.assertIn(CUSHION_NAME, result.cushion.detail)
        self.assertIn("ticket 04", result.cushion.detail)

    def test_an_undeclared_cushion_bound_is_unmeasured_by_name(self):
        result = pre_opened().measure(registry=thresholds.Registry({}))

        self.assertIsNone(result.cushion.ms)
        self.assertEqual(result.cushion.name, CUSHION_NAME)
        self.assertIn(CUSHION_NAME, result.cushion.detail)
        self.assertEqual(result.cushion_entry().name, CUSHION_NAME)
        self.assertIsNone(result.cushion_entry().ms)

    def test_configured_cushion_refuses_an_undeclared_bound(self):
        with self.assertRaises(thresholds.UnknownBoundError):
            first_audio.configured_cushion(registry=thresholds.Registry({}))

    def test_a_cushion_value_without_a_source_is_refused_by_the_registry(self):
        unsourced = dict(CUSHION_BOUND)
        del unsourced["source"]
        with tempfile.TemporaryDirectory() as tmp:
            path = write_registry(tmp, {"playout.cushion_ms": unsourced})
            with self.assertRaises(thresholds.SourceRequiredError):
                thresholds.load_registry(path=path)

    def test_a_cushion_in_another_unit_is_refused(self):
        with self.assertRaises(first_audio.CushionUnitError):
            first_audio.configured_cushion(registry=registry_with(unit="s"))

    def test_the_cushion_producer_line_names_the_registry(self):
        cushion = first_audio.configured_cushion(registry=registry_with())
        self.assertIn(CUSHION_NAME, first_audio.CUSHION_PRODUCER)
        self.assertEqual(cushion.producer, first_audio.CUSHION_PRODUCER)


if __name__ == "__main__":
    unittest.main()

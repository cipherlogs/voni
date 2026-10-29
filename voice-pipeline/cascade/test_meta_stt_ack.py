"""Acknowledgement, protocol error and the bounded handshake wait (ticket 27).

The acknowledgement is recognisable: a text JSON object with no ``type``. Any
other frame before it is a protocol error that names the session. A missing
acknowledgement is bounded by ``stt.handshake_ms`` (10 s, from the threshold
registry, never a literal), fails visibly, records the reason, and a retryable
close at this phase is classified through the shared speech-leg table so the
caller can open the leg.

The bounded wait is exercised without a wall-clock sleep: a silent socket never
yields a frame, and a zero-second injected bound crosses immediately. The
production bound is read from the registry and pinned to the spec's 10 s.
"""

import asyncio
import json
import unittest

from cascade.failures import FailureClass
from cascade.meta_stt import (
    HANDSHAKE_BOUND,
    MetaHandshakeClosed,
    MetaHandshakeError,
    MetaHandshakeProtocolError,
    MetaHandshakeTimeout,
    MetaStreamingSTT,
)
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory
from cascade.thresholds import require_bound


def untyped_ack() -> str:
    return json.dumps({"sessionId": "call-123:0", "status": "ready"})


def open_stt(plan, **kwargs):
    factory = ScriptedSocketFactory(list(plan))
    options = {"api_key": "test-key", "call_id": "call-123"}
    options.update(kwargs)
    backend = MetaStreamingSTT(socket_factory=factory, **options)
    asyncio.run(backend.open(language_codes=[], sample_rate=24000))
    return backend, factory


class SilentSocket:
    """A connected socket that never sends a frame (the vendor stays quiet)."""

    def __init__(self) -> None:
        self.sent: list[str | bytes] = []
        self.closed = False

    def __aiter__(self) -> "SilentSocket":
        return self

    async def __anext__(self) -> str | bytes:
        await asyncio.Event().wait()  # cancelled by the bound; never sleeps
        raise AssertionError("unreachable")  # pragma: no cover

    async def send(self, message: str | bytes) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True


class SilentSocketFactory:
    def __init__(self) -> None:
        self.socket: SilentSocket | None = None

    async def __call__(self, url: str, headers: dict[str, str]):
        self.socket = SilentSocket()
        return self.socket


class AcknowledgementShapeTest(unittest.TestCase):
    def test_a_text_json_object_without_type_is_the_acknowledgement(self):
        backend, factory = open_stt([untyped_ack()])

        self.assertTrue(backend.acked)
        ack = json.loads(factory.socket.sent[0])
        self.assertNotIn("type", ack)

    def test_a_json_value_that_is_not_an_object_is_not_the_ack(self):
        for frame in ('["not", "an", "ack"]', '"ready"', "17"):
            with self.subTest(frame=frame):
                factory = ScriptedSocketFactory([frame])
                backend = MetaStreamingSTT(
                    call_id="call-123", api_key="test-key", socket_factory=factory
                )

                with self.assertRaises(MetaHandshakeProtocolError) as raised:
                    asyncio.run(backend.open(language_codes=[], sample_rate=24000))

                self.assertIn("call-123:0", str(raised.exception))
                self.assertIn("acknowledgement", str(raised.exception))


class HandshakeBoundTest(unittest.TestCase):
    def test_the_production_bound_is_the_registry_value_for_ticket_27(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        # The spec and ticket say 10 s; the registry is the single source.
        self.assertEqual(backend.handshake_timeout_s, 10.0)
        self.assertEqual(backend.handshake_timeout_s * 1000.0, require_bound(HANDSHAKE_BOUND))
        self.assertEqual(HANDSHAKE_BOUND, "stt.handshake_ms")


class MissingAcknowledgementTest(unittest.TestCase):
    def test_no_ack_within_the_bound_fails_by_name_and_records_the_reason(self):
        factory = SilentSocketFactory()
        backend = MetaStreamingSTT(
            call_id="call-123",
            api_key="test-key",
            socket_factory=factory,
            handshake_timeout_s=0.0,
        )

        with self.assertLogs("cascade.meta_stt", level="WARNING") as captured:
            with self.assertRaises(MetaHandshakeTimeout) as raised:
                asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertIn("call-123:0", str(raised.exception))
        self.assertIn("acknowledgement", str(raised.exception))
        self.assertEqual(raised.exception.timeout_s, 0.0)
        self.assertIn("acknowledgement", backend.failure_reason or "")
        self.assertTrue(any("acknowledgement" in line for line in captured.output))
        self.assertFalse(backend.acked)
        self.assertIsNotNone(factory.socket)
        self.assertTrue(factory.socket.closed)

    def test_a_quiet_vendor_is_not_mistaken_for_an_empty_session(self):
        factory = ScriptedSocketFactory([untyped_ack()])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        self.assertIsNone(backend.failure_reason)


class RetryableCloseTest(unittest.TestCase):
    def test_a_retryable_close_during_the_handshake_is_classified_as_a_trigger(self):
        factory = ScriptedSocketFactory([Frame(close_code=1011, reason="backend")])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeClosed) as raised:
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        verdict = raised.exception.verdict
        self.assertEqual(verdict.leg, "stt")
        self.assertIs(verdict.failure_class, FailureClass.TRIGGER)
        self.assertTrue(verdict.opens_breaker)
        self.assertIn("retry once with a new session", str(raised.exception))
        self.assertIn("call-123:0", str(raised.exception))
        self.assertIn("1011", str(raised.exception))
        self.assertTrue(factory.socket.closed)

    def test_a_ratelimited_close_during_the_handshake_also_opens_the_leg(self):
        factory = ScriptedSocketFactory([Frame(close_code=1013, reason="slow down")])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeClosed) as raised:
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertTrue(raised.exception.verdict.opens_breaker)
        self.assertIn("1013", str(raised.exception))

    def test_a_codeless_close_is_treated_as_retryable_and_opens_the_leg(self):
        factory = ScriptedSocketFactory([Frame(close_code=None, exc=ConnectionError("gone"))])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeClosed) as raised:
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertTrue(raised.exception.verdict.opens_breaker)
        self.assertIsNone(raised.exception.verdict.code)

    def test_a_request_bug_close_does_not_open_the_leg(self):
        factory = ScriptedSocketFactory([Frame(close_code=1008, reason="bad frame")])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeClosed) as raised:
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        verdict = raised.exception.verdict
        self.assertIs(verdict.failure_class, FailureClass.BUG)
        self.assertFalse(verdict.opens_breaker)
        self.assertIn("invalid request or pacing", str(raised.exception))

    def test_a_close_before_the_ack_keeps_the_session_named(self):
        factory = ScriptedSocketFactory([Frame(close_code=1011)])
        backend = MetaStreamingSTT(
            call_id="call-123", api_key="test-key", socket_factory=factory
        )

        with self.assertRaises(MetaHandshakeError):
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))

        self.assertFalse(backend.acked)
        self.assertIn("call-123:0", backend.failure_reason or "")


if __name__ == "__main__":
    unittest.main()

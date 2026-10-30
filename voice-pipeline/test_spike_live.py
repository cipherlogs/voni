"""Ticket 14/151: the owner-gated live M00 run.

Every live leg is injected at the seam the offline harness already uses, so no
test dials a vendor: the transports below are scripted against a ``FakeClock``
and the wire adapters are driven by fake sockets. The key gate, the timing lock
and the exit codes are the behaviour; a number is never invented.
"""

import contextlib
import io
import json
import tempfile
import unittest
from collections import deque
from pathlib import Path

from cascade.testing.clock import FakeClock
from live_lock import TimingLockHeldError
from spike import fixture, live, report, run


KEYS = {"META_API_KEY": "meta-test-key", "ASSEMBLYAI_API_KEY": "aai-test-key"}


class KeyGateTests(unittest.TestCase):
    def test_the_live_run_names_every_missing_key_before_it_locks_or_dials(self):
        def forbid(*_args, **_kwargs):
            raise AssertionError("a key-gated refusal must not dial or lock")

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(
                ["--live"],
                env={},
                acquire_lock=forbid,
                live_runner=forbid,
            )
        text = out.getvalue()

        self.assertEqual(code, 2)
        self.assertIn("META_API_KEY", text)
        self.assertIn("ASSEMBLYAI_API_KEY", text)
        self.assertIn("owner-gated", text)
        self.assertNotIn("meta-test-key", text)

    def test_only_the_missing_key_is_named_when_one_is_present(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(
                ["--live"],
                env={"META_API_KEY": "present"},
                acquire_lock=lambda **_kwargs: None,
                live_runner=lambda **_kwargs: None,
            )

        self.assertEqual(code, 2)
        self.assertIn("ASSEMBLYAI_API_KEY", out.getvalue())
        self.assertNotIn("missing META_API_KEY", out.getvalue())


class LockHeldTests(unittest.TestCase):
    def test_a_held_timing_lock_is_a_named_refusal_not_a_number(self):
        def held(**_kwargs):
            raise TimingLockHeldError(Path("/tmp/voni-demo-timing.lock"), None)

        def forbid(**_kwargs):
            raise AssertionError("a held lock must not start the live legs")

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(
                ["--live"], env=KEYS, acquire_lock=held, live_runner=forbid
            )
        text = out.getvalue()

        self.assertEqual(code, 2)
        self.assertIn("timing run holds the lock", text)
        self.assertNotIn("verdict:", text)


class MissingEffortTests(unittest.TestCase):
    def test_without_reasoning_effort_the_term_is_unmeasured_and_exit_is_three(self):
        clock = FakeClock(start=1_000.0)
        calls = []

        def spark(_key):
            calls.append("spark")
            raise AssertionError("no effort means no Spark request")

        measurement = live.run_live(
            env=KEYS,
            stt_factory=lambda _key: ScriptedStt(clock),
            spark_factory=spark,
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
            wall_clock=lambda: 1_700_000_000.0,
        )

        self.assertEqual(calls, [])
        self.assertEqual(measurement.exit_code(), 3)
        self.assertTrue(
            any("META_REASONING_EFFORT" in blocker for blocker in measurement.blockers)
        )
        term = next(
            term
            for term in measurement.report.terms
            if term.name == "first_content_token_ms"
        )
        self.assertIsNone(term.ms)
        self.assertIn("META_REASONING_EFFORT", term.detail)


class KnownSumTests(unittest.TestCase):
    def test_the_fake_wire_produces_the_scripted_five_term_sum(self):
        clock = FakeClock(start=1_000.0)
        stt = ScriptedStt(clock)
        measurement = live.run_live(
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: stt,
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
            wall_clock=lambda: 1_700_000_000.0,
        )

        self.assertEqual(measurement.exit_code(), 0)
        self.assertEqual(measurement.report.verdict, report.PASS)
        self.assertAlmostEqual(measurement.report.sum_ms, 1_450.0, places=3)
        self.assertEqual(measurement.keys_present, ("META_API_KEY", "ASSEMBLYAI_API_KEY"))
        self.assertEqual(measurement.at, "2023-11-14T22:13:20Z")
        self.assertEqual(measurement.blockers, ())
        # The production wire contract is 200 ms frames at 24 kHz mono s16le.
        frame_bytes = int(fixture.SAMPLE_RATE * 0.2) * fixture.SAMPLE_WIDTH_BYTES
        self.assertEqual(len(stt.chunks[0]), frame_bytes)
        self.assertTrue(
            all(len(chunk) == frame_bytes for chunk in stt.chunks[:-1])
        )
        endpointing_term = _term(measurement, "endpointing_ms")
        self.assertIn("tolerance=200.000ms", endpointing_term.detail)


class DegradedLegTests(unittest.TestCase):
    def test_none_effort_is_never_sent_and_exits_three(self):
        clock = FakeClock(start=1_000.0)
        calls = []

        def spark(_key):
            calls.append("spark")
            raise AssertionError("reasoning_effort 'none' is never sent")

        measurement = live.run_live(
            env={**KEYS, "META_REASONING_EFFORT": "none"},
            stt_factory=lambda _key: ScriptedStt(clock),
            spark_factory=spark,
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
        )

        self.assertEqual(calls, [])
        self.assertEqual(measurement.exit_code(), 3)
        self.assertTrue(
            any("none" in blocker and "400" in blocker for blocker in measurement.blockers)
        )
        term = _term(measurement, "first_content_token_ms")
        self.assertIsNone(term.ms)
        self.assertIn("never sent", term.detail)

    def test_a_failed_stt_leg_is_unmeasured_with_its_reason_not_a_partial_pass(self):
        clock = FakeClock(start=1_000.0)

        class BrokenStt:
            def open(self):
                raise RuntimeError("stt socket refused")

            send_audio = audio_processed_s = poll = end_stream = drain = close = None

        measurement = live.run_live(
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: BrokenStt(),
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
        )

        self.assertEqual(measurement.exit_code(), 3)
        self.assertNotEqual(measurement.report.verdict, report.PASS)
        for name in ("endpointing_ms", "post_processing_ms"):
            term = _term(measurement, name)
            self.assertIsNone(term.ms)
            self.assertIn("stt socket refused", term.detail)
        self.assertIn("first_content_token_ms", measurement.degraded)

    def test_a_failed_tts_open_is_unmeasured_with_the_real_reason(self):
        clock = FakeClock(start=1_000.0)

        class BrokenTts:
            def open(self):
                raise RuntimeError("synthesis begin refused")

            def speak(self, _text):
                raise AssertionError("no speak after a failed open")

            def close(self):
                pass

        measurement = live.run_live(
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: ScriptedStt(clock),
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=lambda _key, _voice: BrokenTts(),
            clock=clock,
            wait=clock.advance,
        )

        self.assertEqual(measurement.exit_code(), 3)
        term = _term(measurement, "synthesis.first_audio_ms")
        self.assertIsNone(term.ms)
        self.assertIn("synthesis begin refused", term.detail)

    def test_a_spark_http_refusal_is_an_unmeasured_row_with_the_status(self):
        clock = FakeClock(start=1_000.0)

        class RefusingSpark:
            name = "refusing-spark"

            def stream(self, _payload):
                from spike.first_token import HttpError

                raise HttpError(429, "rate limited")
                yield ""  # pragma: no cover - a generator must yield

        measurement = live.run_live(
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: ScriptedStt(clock),
            spark_factory=lambda _key: RefusingSpark(),
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
        )

        term = _term(measurement, "first_content_token_ms")
        self.assertIsNone(term.ms)
        self.assertIn("429", term.detail)
        self.assertEqual(measurement.exit_code(), 3)


def _term(measurement, name):
    return next(term for term in measurement.report.terms if term.name == name)


class CliTests(unittest.TestCase):
    def test_the_json_run_carries_the_timestamp_and_key_names_but_no_values(self):
        clock = FakeClock(start=1_000.0)
        env = {**KEYS, "META_REASONING_EFFORT": "low"}

        def runner(**kwargs):
            return live.run_live(
                **kwargs,
                stt_factory=lambda _key: ScriptedStt(clock),
                spark_factory=lambda _key: ScriptedSpark(clock),
                tts_factory=lambda _key, _voice: ScriptedTts(clock),
                clock=clock,
                wait=clock.advance,
                wall_clock=lambda: 1_700_000_000.0,
            )

        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "live.json"
            with contextlib.redirect_stdout(out):
                code = run.main(
                    ["--live", "--json", "--out", str(target)],
                    env=env,
                    live_runner=runner,
                    acquire_lock=_FakeLock(),
                )
            payload = json.loads(target.read_text(encoding="utf-8"))
            printed = json.loads(out.getvalue())

        self.assertEqual(code, 0)
        self.assertEqual(printed, payload)
        self.assertEqual(payload["run"]["at"], "2023-11-14T22:13:20Z")
        self.assertEqual(
            payload["run"]["keys_present"], ["META_API_KEY", "ASSEMBLYAI_API_KEY"]
        )
        self.assertEqual(payload["report"]["verdict"], report.PASS)
        encoded = json.dumps(payload)
        for value in KEYS.values():
            self.assertNotIn(value, encoded)

    def test_a_fail_verdict_exits_one(self):
        clock = FakeClock(start=1_000.0)

        def runner(**kwargs):
            return live.run_live(
                **kwargs,
                stt_factory=lambda _key: ScriptedStt(
                    clock, speech_end_at_s=15.0, complete_at_s=15.1
                ),
                spark_factory=lambda _key: ScriptedSpark(clock),
                tts_factory=lambda _key, _voice: ScriptedTts(clock),
                clock=clock,
                wait=clock.advance,
            )

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(
                ["--live"],
                env={**KEYS, "META_REASONING_EFFORT": "low"},
                live_runner=runner,
                acquire_lock=_FakeLock(),
            )

        self.assertEqual(code, 1)
        self.assertIn(f"verdict: {report.FAIL}", out.getvalue())

    def test_the_offline_json_payload_is_unchanged(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(["--offline", "--json"], env={})

        payload = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertNotIn("run", payload)
        self.assertEqual(payload, run.offline_report().as_dict())


class _FakeLock:
    def __init__(self):
        self.released = False

    def __call__(self, **_kwargs):
        return self

    def release(self):
        self.released = True


class FakeSocket:
    """A sync socket: frames in, frames out, no network."""

    def __init__(self, inbound=(), *, clock=None, recv_advance_s=0.0):
        self._inbound = deque(inbound)
        self._clock = clock
        self._recv_advance_s = recv_advance_s
        self._read_closed = False
        self.sent = []
        self.closed = False

    def send(self, message):
        self.sent.append(message)
        if isinstance(message, str):
            try:
                frame = json.loads(message)
            except json.JSONDecodeError:
                return
            if frame.get("type") == "endStream":
                self._read_closed = True

    def recv(self, timeout=None):
        if not self._inbound:
            if self._read_closed:
                return None
            raise TimeoutError
        if self._clock is not None and self._recv_advance_s:
            self._clock.advance(self._recv_advance_s)
        return self._inbound.popleft()

    def close(self):
        self.closed = True


class MetaWireTests(unittest.TestCase):
    def _transport(self, socket, clock):
        return live.LiveMetaSttTransport(
            "meta-key",
            call_id="call-1",
            connect=lambda _url, _headers: socket,
            clock=clock,
            handshake_timeout_s=0.5,
        )

    def test_the_handshake_ack_events_endstream_and_close_are_the_production_contract(self):
        from cascade import meta_stt

        clock = FakeClock(start=2_000.0)
        socket = FakeSocket(
            [
                '{"sessionId":"s"}',
                '{"type":"speechStart","turnId":"t1"}',
                '{"type":"speechEnd","turnId":"t1","audioProcessedMs":12610.0}',
                '{"type":"speechComplete","turnId":"t1","text":"How are you?"}',
            ],
            clock=clock,
            recv_advance_s=0.1,
        )
        transport = self._transport(socket, clock)
        transport.open()

        handshake = json.loads(socket.sent[0])
        self.assertEqual(
            handshake["authorization"], {"accessToken": "Bearer meta-key"}
        )
        self.assertEqual(handshake["audioEncoding"], meta_stt.AUDIO_ENCODING)
        self.assertEqual(handshake["model"], meta_stt.MODEL)
        self.assertEqual(handshake["mode"], meta_stt.MODE)
        self.assertEqual(handshake["partialMode"], meta_stt.PARTIAL_MODE)
        self.assertEqual(handshake["languageBias"], ["English"])
        self.assertIn("sessionId=call-1", transport.url)

        events = transport.poll()
        self.assertEqual([event.kind for event in events], ["speechStart", "speechEnd", "speechComplete"])
        self.assertEqual(events[1].audio_processed_ms, 12_610.0)
        self.assertEqual(transport.caller_turn_id, "t1")
        self.assertIsNotNone(transport.speech_end_at_s)
        self.assertIsNotNone(transport.speech_complete_at_s)
        self.assertEqual(transport.transcript, "How are you?")

        transport.end_stream()
        self.assertEqual(socket.sent[-1], meta_stt.END_STREAM_FRAME)
        transport.close()
        self.assertTrue(socket.closed)

    def test_a_typed_frame_before_the_ack_is_a_named_refusal(self):
        clock = FakeClock(start=2_000.0)
        transport = self._transport(
            FakeSocket(['{"type":"speechStart","turnId":"t1"}']), clock
        )

        with self.assertRaises(live.LiveSttError) as caught:
            transport.open()
        self.assertIn("acknowledgement", str(caught.exception))

    def test_a_missing_ack_is_a_named_refusal_not_a_measurement(self):
        clock = FakeClock(start=2_000.0)
        transport = self._transport(FakeSocket([]), clock)

        with self.assertRaises(live.LiveSttError) as caught:
            transport.open()
        self.assertIn("no acknowledgement", str(caught.exception))

    def test_a_failed_handshake_closes_the_socket(self):
        clock = FakeClock(start=2_000.0)
        socket = FakeSocket([])
        transport = self._transport(socket, clock)

        with self.assertRaises(live.LiveSttError):
            transport.open()
        self.assertTrue(socket.closed)


class SynthesisWireTests(unittest.TestCase):
    def test_the_session_opens_before_the_turn_and_stamps_begin_generate_flush_audio(self):
        from cascade import assemblyai_tts
        from spike import first_audio

        clock = FakeClock(start=3_000.0)
        socket = FakeSocket(
            ['{"type":"Begin","configuration":{}}', '{"type":"Audio","audio":"AA=="}'],
            clock=clock,
            recv_advance_s=0.35,
        )
        session = live.LiveSynthesisSession(
            "aai-key",
            "aai-jane",
            connect=lambda _url, _headers: socket,
            clock=clock,
            timeout_s=1.0,
        )
        opening = session.open()

        self.assertEqual(opening.opened_at_s, 3_000.0)
        self.assertAlmostEqual(opening.begin_at_s, 3_000.35, places=3)
        self.assertIn("voice_id=aai-jane", session.url)
        self.assertIn("language=English", session.url)
        self.assertIn(
            f"sample_rate={assemblyai_tts.TRANSPORT_FORMATS['browser'].sample_rate}",
            session.url,
        )
        self.assertIn(
            f"encoding={assemblyai_tts.TRANSPORT_FORMATS['browser'].encoding}",
            session.url,
        )
        self.assertIn(f"model_id={assemblyai_tts.MODEL_ID}", session.url)

        clock.advance(0.2)
        turn_at_s = clock()
        frames = session.speak("How are you today?")
        measured = first_audio.measure_first_audio(
            opening=opening, turn_at_s=turn_at_s, frames=frames
        )

        self.assertEqual(
            [frame.kind for frame in frames],
            [first_audio.BEGIN, first_audio.GENERATE, first_audio.FLUSH, first_audio.AUDIO],
        )
        self.assertAlmostEqual(measured.first_audio_ms, 350.0, places=3)
        self.assertAlmostEqual(measured.handshake_ms, 350.0, places=3)
        self.assertLess(opening.begin_at_s, turn_at_s)
        sent = [json.loads(message) for message in socket.sent]
        self.assertEqual(sent[0]["type"], "Generate")
        self.assertEqual(sent[0]["text"], "How are you today?")
        self.assertEqual(sent[1]["type"], "Flush")

    def test_a_first_frame_that_is_not_begin_is_a_named_refusal(self):
        clock = FakeClock(start=3_000.0)
        socket = FakeSocket(['{"type":"Audio"}'])
        session = live.LiveSynthesisSession(
            "aai-key",
            connect=lambda _url, _headers: socket,
            clock=clock,
            timeout_s=1.0,
        )

        with self.assertRaises(live.LiveTtsError) as caught:
            session.open()
        self.assertIn("Begin", str(caught.exception))
        self.assertTrue(socket.closed)


class SparkWireTests(unittest.TestCase):
    class Response:
        status = 200

        def __init__(self, lines):
            self._lines = lines
            self.read_called = False

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def __iter__(self):
            return iter(self._lines)

        def read(self):
            self.read_called = True
            return b"refused"

    def test_the_existing_request_builder_is_posted_to_the_spark_endpoint_with_the_bearer(self):
        from spike import first_token

        captured = {}

        def post(url, headers, body):
            captured.update(url=url, headers=headers, body=body)
            return self.Response([b'data: {"choices":[]}\n', b"data: [DONE]\n"])

        transport = live.LiveSparkTransport("meta-key", post=post)
        payload = first_token.build_payload(first_token.DEFAULT_EFFORT, "Hi.")
        lines = list(transport.stream(payload))

        self.assertEqual(captured["url"], first_token.ENDPOINT)
        self.assertEqual(captured["headers"]["Authorization"], "Bearer meta-key")
        body = json.loads(captured["body"])
        self.assertEqual(body["model"], first_token.MODEL)
        self.assertTrue(body["stream"])
        self.assertNotIn("reasoning_effort", body)
        self.assertEqual(len(lines), 2)

    def test_a_non_200_response_is_a_recorded_http_error(self):
        from spike import first_token

        response = self.Response([])
        response.status = 400

        transport = live.LiveSparkTransport(
            "meta-key", post=lambda *_args: response
        )
        with self.assertRaises(first_token.HttpError) as caught:
            list(transport.stream({"model": first_token.MODEL}))
        self.assertEqual(caught.exception.status, 400)
        self.assertTrue(response.read_called)


class ScriptedStt:
    """The ticket 09 scripted Meta transport, at the endpointing seam."""

    def __init__(self, clock, *, speech_end_at_s=12.6, complete_at_s=12.75):
        self.clock = clock
        self.chunks = []
        self._origin_s = 0.0
        self._media_sent_s = 0.0
        self._pending = [
            (0.5, "speechStart", {"turn_id": "t1"}),
            (
                speech_end_at_s,
                "speechEnd",
                {"turn_id": "t1", "audio_processed_ms": 12_610.0},
            ),
            (
                complete_at_s,
                "speechComplete",
                {"turn_id": "t1", "text": "How are you today?"},
            ),
        ]
        self.speech_end_at_s = None
        self.speech_complete_at_s = None
        self.transcript = ""

    def open(self):
        self._origin_s = self.clock()

    def send_audio(self, chunk):
        self.chunks.append(chunk)
        self._media_sent_s += len(chunk) / (
            fixture.SAMPLE_RATE * fixture.SAMPLE_WIDTH_BYTES
        )

    def audio_processed_s(self):
        return self._media_sent_s

    def poll(self):
        from spike.endpointing import SttEvent

        released = []
        horizon = self.clock() - self._origin_s + 1e-9
        while self._pending and self._pending[0][0] <= horizon:
            at_s, kind, payload = self._pending.pop(0)
            received = self._origin_s + at_s
            if kind == "speechEnd":
                self.speech_end_at_s = received
            if kind == "speechComplete":
                self.speech_complete_at_s = received
                self.transcript = payload["text"]
            released.append(SttEvent(kind=kind, received_at_s=received, **payload))
        return tuple(released)

    def end_stream(self):
        pass

    def drain(self):
        released = self.poll()
        while self._pending:
            self.clock.advance(self._pending[0][0])
            released += self.poll()
        return released

    def close(self):
        pass


class ScriptedSpark:
    """A Spark SSE trace at the first_token seam: content at a known offset."""

    name = "scripted-spark"

    def __init__(self, clock):
        self.clock = clock
        self.requests = []

    def stream(self, payload):
        self.requests.append(dict(payload))
        self.clock.advance(0.1)
        yield 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}'
        self.clock.advance(0.15)
        yield 'data: {"choices":[{"delta":{"content":"Hello"}}]}'


class ScriptedTts:
    """A synthesis session at the first_audio seam."""

    def __init__(self, clock):
        self.clock = clock
        self.opened = False
        self.spoken = []

    def open(self):
        from spike import first_audio

        opened_at_s = self.clock()
        self.clock.advance(0.1)
        self.opened = True
        return first_audio.Opening(opened_at_s=opened_at_s, begin_at_s=self.clock())

    def speak(self, text):
        from spike import first_audio

        self.spoken.append(text)
        turn_at_s = self.clock()
        frames = [
            first_audio.Frame(first_audio.GENERATE, turn_at_s + 0.05, text),
            first_audio.Frame(first_audio.FLUSH, turn_at_s + 0.1),
            first_audio.Frame(first_audio.AUDIO, turn_at_s + 0.45),
        ]
        self.clock.advance(0.45)
        return tuple(frames)

    def close(self):
        pass


if __name__ == "__main__":
    unittest.main()

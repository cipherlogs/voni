"""Ticket 14/151: the owner-gated live M00 run.

Every live leg is injected at the seam the offline harness already uses, so no
test dials a vendor: the transports below are scripted against a ``FakeClock``
and the wire adapters are driven by fake sockets. The key gate, the timing lock
and the exit codes are the behaviour; a number is never invented.
"""

import array
import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from collections import deque
from pathlib import Path

from cascade.testing.clock import FakeClock
from live_lock import TimingLockHeldError
from spike import endpointing, fixture, live, report, run


KEYS = {"META_API_KEY": "meta-test-key", "ASSEMBLYAI_API_KEY": "aai-test-key"}


def _caller(label="fixture:caller-20s"):
    """The committed fixture as the caller WAV every live-leg test must supply."""
    return live.CallerWav.from_wav_bytes(label, fixture.build_wav())


def _wav(pcm, **kwargs):
    return fixture.wav_from_pcm(pcm, **kwargs)


class KeyGateTests(unittest.TestCase):
    def test_the_live_runner_names_every_missing_key_before_any_factory(self):
        def forbid(*_args, **_kwargs):
            raise AssertionError("a key-gated refusal must not dial")

        with self.assertRaises(live.MissingKeysError) as caught:
            live.run_live(
                caller=_caller(),
                env={},
                stt_factory=forbid,
                spark_factory=forbid,
                tts_factory=forbid,
            )

        text = str(caught.exception)
        self.assertEqual(caught.exception.missing, live.KEY_ENVS)
        self.assertIn("META_API_KEY", text)
        self.assertIn("ASSEMBLYAI_API_KEY", text)
        self.assertIn("owner-gated", text)
        self.assertNotIn("meta-test-key", text)

    def test_the_cli_names_missing_keys_before_it_locks_or_dials(self):
        def forbid(*_args, **_kwargs):
            raise AssertionError("a key-gated refusal must not lock or dial")

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run.main(
                ["--live"],
                env={},
                acquire_lock=forbid,
                live_runner=forbid,
            )

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("META_API_KEY", err.getvalue())
        self.assertIn("ASSEMBLYAI_API_KEY", err.getvalue())
        self.assertIn("no live call was made", err.getvalue())

    def test_the_cli_catches_the_key_refusal_on_stderr_and_exits_two(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run.main(
                ["--live"],
                env={},
                acquire_lock=_FakeLock(),
                live_runner=live.run_live,
            )

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("META_API_KEY", err.getvalue())
        self.assertIn("ASSEMBLYAI_API_KEY", err.getvalue())
        self.assertIn("owner-gated", err.getvalue())
        self.assertNotIn("meta-test-key", err.getvalue())

    def test_only_the_missing_key_is_named_when_one_is_present(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run.main(
                ["--live"],
                env={"META_API_KEY": "present"},
                acquire_lock=_FakeLock(),
                live_runner=live.run_live,
            )

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("ASSEMBLYAI_API_KEY", err.getvalue())
        self.assertNotIn("missing META_API_KEY", err.getvalue())


class CallerWavTests(unittest.TestCase):
    @staticmethod
    def _pcm():
        # 1000 silent samples, 2000 loud ones, then silence again.
        return array.array("h", [0] * 1000 + [5000] * 2000 + [0] * 1000)

    def test_a_real_wav_records_its_path_sha_and_last_sample_above_silence(self):
        raw = _wav(self._pcm().tobytes())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "caller-2s.wav"
            path.write_bytes(raw)
            caller = live.load_caller_wav(path)

        self.assertEqual(caller.path, str(path))
        self.assertEqual(caller.sha256, hashlib.sha256(raw).hexdigest())
        self.assertEqual(caller.sample_rate, fixture.SAMPLE_RATE)
        self.assertEqual(caller.speech_end_sample, 2999)
        self.assertAlmostEqual(caller.speech_end_ms, 2999 / 24.0, places=3)
        self.assertAlmostEqual(caller.duration_s, 4000 / 24_000.0)
        self.assertEqual(
            caller.metadata(),
            {
                "path": str(path),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "sample_rate": fixture.SAMPLE_RATE,
                "channels": 1,
                "sample_width_bytes": 2,
                "duration_s": 0.166667,
                "speech_end_sample": 2999,
                "speech_end_ms": 124.958,
                "silence_threshold_lsb": live.SPEECH_SILENCE_THRESHOLD_LSB,
            },
        )

    def test_a_wrong_sample_rate_is_a_named_refusal_not_a_resample(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "caller-16k.wav"
            path.write_bytes(_wav(self._pcm().tobytes(), sample_rate=16_000))
            with self.assertRaises(live.CallerWavError) as caught:
                live.load_caller_wav(path)
        text = str(caught.exception)
        self.assertIn("16000 Hz", text)
        self.assertIn("24000 Hz", text)
        self.assertIn("resample", text)

    def test_wrong_channels_are_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "caller-stereo.wav"
            path.write_bytes(_wav(self._pcm().tobytes() * 2, channels=2))
            with self.assertRaises(live.CallerWavError) as caught:
                live.load_caller_wav(path)
        self.assertIn("2 channels", str(caught.exception))
        self.assertIn("mono", str(caught.exception))

    def test_a_wrong_sample_width_is_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "caller-8bit.wav"
            path.write_bytes(_wav(b"\x80" * 8000, sample_width_bytes=1))
            with self.assertRaises(live.CallerWavError) as caught:
                live.load_caller_wav(path)
        text = str(caught.exception)
        self.assertIn("1-byte", text)
        self.assertIn("16-bit", text)

    def test_the_runner_refuses_without_a_wav_before_any_leg(self):
        def forbid(*_args, **_kwargs):
            raise AssertionError("a missing WAV must not open a leg")

        with self.assertRaises(live.CallerWavError) as caught:
            live.run_live(
                env=KEYS,
                stt_factory=forbid,
                spark_factory=forbid,
                tts_factory=forbid,
            )
        text = str(caught.exception)
        self.assertIn("--wav", text)
        self.assertIn("real speech WAV", text)
        self.assertIn("offline-only", text)

    def test_a_silent_wav_is_a_named_refusal(self):
        raw = _wav(array.array("h", [0] * 2000).tobytes())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "caller-silent.wav"
            path.write_bytes(raw)
            with self.assertRaises(live.CallerWavError) as caught:
                live.load_caller_wav(path)
        self.assertIn("silence threshold", str(caught.exception))


class LockHeldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.wav = Path(cls._tmp.name) / "caller-20s.wav"
        cls.wav.write_bytes(fixture.build_wav())

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()


    def test_a_held_timing_lock_is_a_named_refusal_not_a_number(self):
        def held(**_kwargs):
            raise TimingLockHeldError(Path("/tmp/voni-demo-timing.lock"), None)

        def forbid(**_kwargs):
            raise AssertionError("a held lock must not start the live legs")

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run.main(
                ["--live", "--wav", str(self.wav)],
                env=KEYS,
                acquire_lock=held,
                live_runner=forbid,
            )
        text = err.getvalue()

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
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
            caller=_caller(),
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
            caller=_caller(),
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
        caller_wav = measurement.metadata()["caller_wav"]
        self.assertEqual(caller_wav["path"], "fixture:caller-20s")
        self.assertEqual(
            caller_wav["speech_end_sample"],
            fixture.last_speech_sample(fixture.render_pcm()),
        )
        self.assertEqual(
            caller_wav["sha256"],
            hashlib.sha256(fixture.build_wav()).hexdigest(),
        )
        first_content = _term(measurement, "first_content_token_ms")
        self.assertIn("configured, not probed", first_content.producer)
        self.assertIn("M03", first_content.producer)
        self.assertIn("not probed", first_content.detail)

    def test_a_fully_measured_at_risk_run_exits_zero(self):
        clock = FakeClock(start=1_000.0)
        measurement = live.run_live(
            caller=_caller(),
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: ScriptedStt(
                clock, speech_end_at_s=12.8, complete_at_s=12.95
            ),
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
            wall_clock=lambda: 1_700_000_000.0,
        )

        self.assertEqual(measurement.report.verdict, report.AT_RISK)
        self.assertEqual(measurement.report.unmeasured_names, ())
        self.assertEqual(measurement.exit_code(), 0)

    def test_a_fully_measured_fail_run_exits_one(self):
        clock = FakeClock(start=1_000.0)
        measurement = live.run_live(
            caller=_caller(),
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: ScriptedStt(
                clock, speech_end_at_s=15.0, complete_at_s=15.1
            ),
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
            wall_clock=lambda: 1_700_000_000.0,
        )

        self.assertEqual(measurement.report.verdict, report.FAIL)
        self.assertEqual(measurement.report.unmeasured_names, ())
        self.assertEqual(measurement.degraded, ())
        self.assertEqual(measurement.exit_code(), 1)

    def test_an_unmeasured_term_outranks_a_fail_verdict(self):
        clock = FakeClock(start=1_000.0)

        class BrokenTts:
            def open(self):
                raise RuntimeError("synthesis begin refused")

            def close(self):
                pass

        measurement = live.run_live(
            caller=_caller(),
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: ScriptedStt(
                clock, speech_end_at_s=15.0, complete_at_s=15.1
            ),
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=lambda _key, _voice: BrokenTts(),
            clock=clock,
            wait=clock.advance,
        )

        self.assertEqual(measurement.report.verdict, report.FAIL)
        self.assertIn("synthesis.first_audio_ms", measurement.report.unmeasured_names)
        self.assertEqual(measurement.exit_code(), 3)


class MissingReceiptTests(unittest.TestCase):
    def test_a_transport_without_the_declared_receipt_is_named_not_silently_none(self):
        clock = FakeClock(start=1_000.0)

        class NoReceiptStt:
            def __init__(self, inner):
                self._inner = inner

            def __getattr__(self, name):
                if name == "speech_complete_at_s":
                    raise AttributeError("speech_complete_at_s")
                return getattr(self._inner, name)

        measurement = live.run_live(
            caller=_caller(),
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            stt_factory=lambda _key: NoReceiptStt(ScriptedStt(clock)),
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=lambda _key, _voice: ScriptedTts(clock),
            clock=clock,
            wait=clock.advance,
        )

        term = _term(measurement, "first_content_token_ms")
        self.assertIsNone(term.ms)
        self.assertIn("speech_complete_at_s", term.detail)
        self.assertIsNotNone(_term(measurement, "endpointing_ms").ms)
        self.assertEqual(measurement.exit_code(), 3)


class DegradedLegTests(unittest.TestCase):
    def test_none_effort_is_never_sent_and_exits_three(self):
        clock = FakeClock(start=1_000.0)
        calls = []

        def spark(_key):
            calls.append("spark")
            raise AssertionError("reasoning_effort 'none' is never sent")

        measurement = live.run_live(
            caller=_caller(),
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
            caller=_caller(),
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
            caller=_caller(),
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
            caller=_caller(),
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
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.wav = Path(cls._tmp.name) / "caller-20s.wav"
        cls.wav.write_bytes(fixture.build_wav())

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_live_without_a_wav_is_a_usage_refusal_before_the_lock_or_dial(self):
        def forbid(*_args, **_kwargs):
            raise AssertionError("a usage refusal must not lock or dial")

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run.main(
                ["--live"],
                env=KEYS,
                acquire_lock=forbid,
                live_runner=forbid,
            )

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("--wav", err.getvalue())
        self.assertIn("real speech WAV", err.getvalue())
        self.assertIn("offline-only", err.getvalue())

    def test_a_wrong_shape_wav_refuses_by_name_before_the_lock_or_dial(self):
        def forbid(*_args, **_kwargs):
            raise AssertionError("a shape refusal must not lock or dial")

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "caller-16k.wav"
            path.write_bytes(
                fixture.wav_from_pcm(
                    fixture.render_pcm(seconds=2.0, speech_end_s=1.0),
                    sample_rate=16_000,
                )
            )
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = run.main(
                    ["--live", "--wav", str(path)],
                    env=KEYS,
                    acquire_lock=forbid,
                    live_runner=forbid,
                )

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("16000 Hz", err.getvalue())
        self.assertIn("not resampled", err.getvalue())

    def test_the_wav_is_loaded_and_passed_to_the_live_runner(self):
        seen = {}

        def runner(**kwargs):
            seen["caller"] = kwargs["caller"]
            clock = FakeClock(start=1_000.0)
            return live.run_live(
                **kwargs,
                stt_factory=lambda _key: ScriptedStt(clock),
                spark_factory=lambda _key: ScriptedSpark(clock),
                tts_factory=lambda _key, _voice: ScriptedTts(clock),
                clock=clock,
                wait=clock.advance,
            )

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run.main(
                ["--live", "--wav", str(self.wav)],
                env={**KEYS, "META_REASONING_EFFORT": "low"},
                live_runner=runner,
                acquire_lock=_FakeLock(),
            )

        caller = seen["caller"]
        self.assertEqual(code, 0)
        self.assertEqual(caller.path, str(self.wav))
        self.assertEqual(
            caller.sha256, hashlib.sha256(self.wav.read_bytes()).hexdigest()
        )

    def test_help_names_the_required_wav_and_the_refusal_exit_code(self):
        out = io.StringIO()
        with self.assertRaises(SystemExit) as caught:
            with contextlib.redirect_stdout(out):
                run.main(["--help"])

        text = out.getvalue()
        self.assertEqual(caught.exception.code, 0)
        self.assertIn("--wav", text)
        self.assertIn("24 kHz mono 16-bit PCM", text)
        self.assertIn("wrong-shaped --wav", text)

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
                    ["--live", "--wav", str(self.wav), "--json", "--out", str(target)],
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
                ["--live", "--wav", str(self.wav)],
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
                '{"type":"speechComplete","turnId":1,"transcript":"How are you?"}',
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


#: The real Meta STT frames recorded on the M00 wire, verbatim in shape:
#: ``turnId`` is a JSON integer and the final text is ``transcript``. Each frame
#: is paired with the media position at which it arrived; the evidence's wall
#: timestamps are not the contract, the fields are.
M00_RAW_FRAMES = (
    (0.0, '{"sessionId":"m00-raw:0"}'),
    (0.215, '{"type":"speechStart","audioProcessedMs":0,"turnId":0}'),
    (
        0.9,
        '{"type":"transcript","transcript":"Hi","final":false,'
        '"audioProcessedMs":880}',
    ),
    (4.70, '{"type":"speechEnd","audioProcessedMs":4620,"turnId":0}'),
    (
        4.70,
        '{"type":"speechComplete","audioProcessedMs":4620,"turnId":0,'
        '"transcript":"Hi I\'m Voni let\'s try something cool I\'ll show you '
        'what I can do while we talk"}',
    ),
    (4.90, '{"type":"speechStart","audioProcessedMs":4860,"turnId":1}'),
    (
        5.50,
        '{"type":"transcript","transcript":"ready?","final":false,'
        '"audioProcessedMs":5840}',
    ),
    (5.55, '{"type":"speechEnd","audioProcessedMs":5420,"turnId":1}'),
    (
        5.55,
        '{"type":"speechComplete","audioProcessedMs":5420,"turnId":1,'
        '"transcript":"ready?"}',
    ),
    (
        5.75,
        '{"type":"transcript","transcript":"","final":true,'
        '"audioProcessedMs":6080}',
    ),
)


class ConnectionClosedOK(Exception):
    """The close exception websockets raises for code ``1000``, by name."""

    def __init__(self, code=1000, reason=""):
        self.code = code
        self.reason = reason
        super().__init__(f"received {code} ({reason})")


class ConnectionClosedError(Exception):
    """The close exception websockets raises for a failure close, by name."""

    def __init__(self, code=1011, reason=""):
        self.code = code
        self.reason = reason
        super().__init__(f"received {code} ({reason})")


class CloseAfterEndStreamSocket(FakeSocket):
    """A fake socket that closes only once ``endStream`` has been sent."""

    def __init__(self, inbound, close_error, **kwargs):
        super().__init__(inbound, **kwargs)
        self._close_error = close_error
        self._ended = False

    def send(self, message):
        super().send(message)
        if isinstance(message, str) and json.loads(message).get("type") == "endStream":
            self._ended = True

    def recv(self, timeout=None):
        if self._ended and not self._inbound:
            raise self._close_error
        return super().recv(timeout)


class PacedWireSocket:
    """The raw frames, released against the pacer's media clock.

    A frame is readable only once virtual time reaches its media position, so
    the endpointing loop keeps streaming audio between events instead of
    reading the whole wire in the first poll.
    """

    def __init__(self, frames, clock):
        self._frames = deque(frames)
        self._clock = clock
        self._origin_s = None
        self.sent = []
        self.closed = False

    def send(self, message):
        self.sent.append(message)

    def recv(self, timeout=None):
        if self._origin_s is None:
            self._origin_s = self._clock()
        if self._frames:
            due_s, raw = self._frames[0]
            if self._clock() - self._origin_s + 1e-9 >= due_s:
                self._frames.popleft()
                return raw
        raise TimeoutError

    def close(self):
        self.closed = True


class RawWireMappingTests(unittest.TestCase):
    def test_the_real_frames_measure_both_turns_integer_turnid_and_transcript(self):
        clock = FakeClock(start=2_000.0)
        socket = PacedWireSocket(M00_RAW_FRAMES, clock)
        transport = live.LiveMetaSttTransport(
            "meta-key",
            call_id="m00-raw",
            connect=lambda _url, _headers: socket,
            clock=clock,
            handshake_timeout_s=0.5,
        )
        pcm = fixture.render_pcm(seconds=6.0, speech_end_s=4.62)

        turns = endpointing.measure(
            transport,
            pcm=pcm,
            chunk_ms=live.LIVE_FRAME_MS,
            clock=clock,
            wait=clock.advance,
        )

        self.assertEqual([turn.turn_id for turn in turns], ["0", "1"])
        caller, second = turns
        self.assertIsNotNone(caller.endpointing.value_ms)
        self.assertIn("turn 0", caller.endpointing.detail)
        self.assertEqual(caller.post_processing.value_ms, 0.0)
        self.assertEqual(second.post_processing.value_ms, 0.0)
        self.assertEqual(transport.transcript, "ready?")
        self.assertEqual(transport.caller_turn_id, "0")

    def test_the_raw_frames_keep_integer_turnid_and_audio_processed_ms(self):
        clock = FakeClock(start=2_000.0)
        transport = live.LiveMetaSttTransport(
            "meta-key",
            call_id="m00-raw",
            connect=lambda _url, _headers: FakeSocket(
                [raw for _due, raw in M00_RAW_FRAMES], recv_advance_s=0.01
            ),
            clock=clock,
            handshake_timeout_s=0.5,
        )
        transport.open()

        events = transport.poll()
        by_kind = {
            kind: [event for event in events if event.kind == kind]
            for kind in ("speechStart", "speechEnd", "speechComplete")
        }

        self.assertEqual([e.turn_id for e in by_kind["speechStart"]], ["0", "1"])
        self.assertEqual(
            [e.audio_processed_ms for e in by_kind["speechStart"]], [0.0, 4_860.0]
        )
        self.assertEqual([e.turn_id for e in by_kind["speechEnd"]], ["0", "1"])
        self.assertEqual(
            [e.audio_processed_ms for e in by_kind["speechEnd"]], [4_620.0, 5_420.0]
        )
        self.assertEqual(
            [e.audio_processed_ms for e in by_kind["speechComplete"]],
            [4_620.0, 5_420.0],
        )
        self.assertEqual(
            by_kind["speechComplete"][0].text,
            "Hi I'm Voni let's try something cool I'll show you what I can do "
            "while we talk",
        )


class CleanEndTests(unittest.TestCase):
    def _transport(self, socket, clock):
        return live.LiveMetaSttTransport(
            "meta-key",
            call_id="m00-raw",
            connect=lambda _url, _headers: socket,
            clock=clock,
            handshake_timeout_s=0.5,
        )

    def test_a_1000_close_after_endstream_is_a_clean_end_not_a_crash(self):
        clock = FakeClock(start=2_000.0)
        socket = CloseAfterEndStreamSocket(
            [
                '{"sessionId":"s"}',
                '{"type":"speechEnd","audioProcessedMs":4620,"turnId":0}',
                '{"type":"speechComplete","audioProcessedMs":4620,"turnId":0,'
                '"transcript":"ready?"}',
            ],
            ConnectionClosedOK(1000, "No more transcript segments"),
        )
        transport = self._transport(socket, clock)
        transport.open()

        self.assertEqual(
            [event.kind for event in transport.poll()],
            ["speechEnd", "speechComplete"],
        )
        transport.end_stream()
        drained = transport.drain()

        self.assertEqual(drained, ())
        self.assertIs(transport.closed_clean, True)
        self.assertEqual(transport.transcript, "ready?")

    def test_a_failure_close_after_endstream_is_named_with_its_code(self):
        clock = FakeClock(start=2_000.0)
        socket = CloseAfterEndStreamSocket(
            ['{"sessionId":"s"}'],
            ConnectionClosedError(1011, "internal error"),
        )
        transport = self._transport(socket, clock)
        transport.open()
        transport.end_stream()

        with self.assertRaises(live.LiveSttError) as caught:
            transport.drain()
        self.assertIn("1011", str(caught.exception))
        self.assertIn("internal error", str(caught.exception))
        self.assertIs(transport.closed_clean, False)


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

    def test_an_error_first_frame_names_the_vendor_error_type_and_message(self):
        clock = FakeClock(start=3_000.0)
        socket = FakeSocket(
            [
                '{"type":"Error","error_code":3006,'
                '"error":"Unauthorized: Insufficient funds",'
                '"error_type":"insufficient_funds","retryable":false}'
            ]
        )
        session = live.LiveSynthesisSession(
            "aai-key",
            connect=lambda _url, _headers: socket,
            clock=clock,
            timeout_s=1.0,
        )

        with self.assertRaises(live.SynthesisRefusal) as caught:
            session.open()

        refusal = caught.exception
        self.assertEqual(refusal.error_type, "insufficient_funds")
        self.assertEqual(refusal.error_code, 3006)
        self.assertIn(
            "insufficient_funds: Unauthorized: Insufficient funds",
            str(refusal),
        )
        self.assertIn("3006", str(refusal))
        self.assertNotIn("first frame was not Begin", str(refusal))
        self.assertTrue(socket.closed)

    def test_the_runner_reports_the_vendor_tts_refusal_not_a_begin_mismatch(self):
        clock = FakeClock(start=1_000.0)
        socket = FakeSocket(
            [
                '{"type":"Error","error_code":3006,'
                '"error":"Unauthorized: Insufficient funds",'
                '"error_type":"insufficient_funds"}'
            ]
        )

        def tts(_key, _voice):
            return live.LiveSynthesisSession(
                "aai-key",
                connect=lambda _url, _headers: socket,
                clock=clock,
                timeout_s=1.0,
            )

        measurement = live.run_live(
            env={**KEYS, "META_REASONING_EFFORT": "low"},
            caller=_caller(),
            stt_factory=lambda _key: ScriptedStt(clock),
            spark_factory=lambda _key: ScriptedSpark(clock),
            tts_factory=tts,
            clock=clock,
            wait=clock.advance,
        )

        term = _term(measurement, "synthesis.first_audio_ms")
        self.assertIsNone(term.ms)
        self.assertIn(
            "insufficient_funds: Unauthorized: Insufficient funds", term.detail
        )
        self.assertNotIn("not Begin", term.detail)

    def test_an_http_tts_refusal_keeps_the_x_tts_headers(self):
        class Response:
            status_code = 402
            headers = {
                "X-TTS-Voice-Id": "aai-jane",
                "X-TTS-Model": "assemblyai-tts-1",
            }

        class HandshakeRefused(Exception):
            def __init__(self):
                self.response = Response()

        session = live.LiveSynthesisSession(
            "aai-key",
            connect=lambda _url, _headers: (_ for _ in ()).throw(HandshakeRefused()),
            clock=FakeClock(start=3_000.0),
            timeout_s=1.0,
        )

        with self.assertRaises(live.LiveTtsError) as caught:
            session.open()
        text = str(caught.exception)
        self.assertIn("402", text)
        self.assertIn("X-TTS-Voice-Id: aai-jane", text)
        self.assertIn("X-TTS-Model: assemblyai-tts-1", text)

    def test_a_failure_close_before_begin_keeps_its_code(self):
        clock = FakeClock(start=3_000.0)
        socket = CloseAfterEndStreamSocket(
            [], ConnectionClosedError(1011, "auth_unavailable")
        )
        # A close can arrive before any frame; mark it closeable immediately.
        socket._ended = True
        session = live.LiveSynthesisSession(
            "aai-key",
            connect=lambda _url, _headers: socket,
            clock=clock,
            timeout_s=1.0,
        )

        with self.assertRaises(live.LiveTtsError) as caught:
            session.open()
        text = str(caught.exception)
        self.assertIn("1011", text)
        self.assertIn("auth_unavailable", text)

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

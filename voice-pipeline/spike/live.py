"""The owner-gated live M00 run: the five terms measured on the real wire.

``spike.run --live`` is the one path that spends vendor calls. It is gated three
ways before a socket exists:

1. both keys must be present (``META_API_KEY`` and ``ASSEMBLYAI_API_KEY``) —
   the refusal names every missing key and never prints a value;
2. the shared timing lock must be free (``live_lock``, the same file the demo
   scoreboard holds), because a live timing run is one at a time;
3. ``META_REASONING_EFFORT`` must name the effort the owner fixed. It is not
   guessed: an absent value blocks term 3 and the run exits 3. ``"none"`` is
   never sent because Spark answers it with HTTP 400.

The caller audio is a required real speech WAV (``--wav``): 24 kHz mono 16-bit
PCM, checked by shape and never resampled, with its path, sha256 and last
sample above the stated silence threshold recorded in the run. The synthetic
ticket 09 fixture is offline-only because the live vendor emits no ``speechEnd``
for a harmonic tone.

The measurement still goes through the ticket 10-12 producers. The live
transports here are thin: they carry the production wire contract (Meta's 24 kHz
handshake, ack and ``endStream``; Spark's SSE request builder; AssemblyAI's
``Begin``/``Generate``/``Flush``/``Audio`` session) and stamp each frame as it
arrives. The mapper reads the wire as it really is: ``turnId`` is a JSON integer
normalized to ``str``, the final text is ``transcript`` and ``audioProcessedMs``
may ride on ``speechStart``/``speechEnd``/``speechComplete``. A ``1000`` close
after ``endStream`` is a clean end; a synthesis ``Error`` frame is raised with
the vendor's ``error_type``, message and close code, never as a Begin mismatch.
The synthesis session is opened before the turn, so its handshake is recorded as
a call-start cost and never lands inside the first-audio term.

A failed leg degrades to that term ``UNMEASURED`` with the real reason and the
run exits 3. It never becomes a partial ``PASS``, and this module never records
a gate verdict for the owner: it measures and prints, nothing else.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import wave
from collections.abc import Callable, Iterator, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode

from cascade import assemblyai_tts, meta_stt, thresholds, voice_binding
from spike import endpointing, first_audio, first_token, fixture, report

#: The two vendor credentials the live run needs, in refusal order.
KEY_ENVS = ("META_API_KEY", "ASSEMBLYAI_API_KEY")
META_KEY_ENV = KEY_ENVS[0]
ASSEMBLYAI_KEY_ENV = KEY_ENVS[1]

#: The owner-set effort. A missing value is a blocker, never a default.
REASONING_EFFORT_ENV = "META_REASONING_EFFORT"

#: The synthesis voice used for the spike; it does not edit the voice binding.
VOICE_ID_ENV = "AAI_SPIKE_VOICE_ID"
DEFAULT_VOICE_ID = "aai-jane"

#: One short fixed line: the spike measures synthesis latency, not phrasing.
SPIKE_TRANSCRIPT = "How are you today?"

#: The production Meta frame size on the wire: 200 ms of 24 kHz mono s16le.
LIVE_FRAME_MS = 200

#: The fixture's caller turn is English; the STT handshake carries the bias.
STT_LANGUAGE_CODES = ("en",)

#: A client read timeout, not a latency budget: it bounds a stalled socket.
CLIENT_TIMEOUT_S = 30.0

#: How long one poll waits for an unsolicited Meta frame before returning.
POLL_TIMEOUT_S = 0.05

#: The vendor's clean end after ``endStream``; any other code is a failure close.
CLEAN_CLOSE_CODE = 1000

#: The synthesis session's in-band refusal frame; it precedes the failure close.
TTS_ERROR_FRAME = "Error"

#: A 16-bit sample at or below this magnitude is silence: 300 LSB is about
#: -40 dBFS, above dither and room noise, below a human voice's quiet tail.
#: Stated here so the live run's speech-end position is a rule, not a guess.
SPEECH_SILENCE_THRESHOLD_LSB = 300

_TIMEOUT = object()


@dataclass(frozen=True)
class _Closed:
    """The vendor closed the socket; ``code`` is ``None`` when it cannot say."""

    code: int | None = None
    reason: str = ""

    @property
    def clean(self) -> bool:
        # A socket that only says "ended" has no category to call a failure;
        # 1000 is the documented clean end after endStream.
        return self.code is None or self.code == CLEAN_CLOSE_CODE


def _close_detail(closed: _Closed) -> str:
    if closed.code is None:
        return "the socket ended without a close code"
    reason = f" ({closed.reason})" if closed.reason else ""
    return f"close {closed.code}{reason}"


class LiveSpikeError(RuntimeError):
    """The live run cannot measure honestly."""


class MissingKeysError(LiveSpikeError):
    """A vendor key is absent; no live call may start."""

    def __init__(self, missing: tuple[str, ...]) -> None:
        self.missing = missing
        super().__init__(
            "spike.run --live is owner-gated: missing "
            + ", ".join(missing)
            + "; no live call was made"
        )


class CallerWavError(LiveSpikeError):
    """The ``--wav`` input is not the one shape the live run can stream."""


class LiveSttError(LiveSpikeError):
    """The live Meta speech session could not be established or read."""


class LiveTtsError(LiveSpikeError):
    """The live synthesis session could not be established or read."""


class SynthesisRefusal(LiveTtsError):
    """The vendor refused the synthesis session with an ``Error`` frame.

    The frame's ``error_type`` is the stable cause (``insufficient_funds``),
    ``error`` the human message and ``error_code`` the WebSocket close code
    that follows. Quoting them is the point: "the first frame was not Begin"
    hid an HTTP 402 account refusal.
    """

    def __init__(
        self,
        *,
        error_type: str,
        vendor_message: str,
        error_code: int | None = None,
        detail: str = "",
    ) -> None:
        self.error_type = error_type
        self.vendor_message = vendor_message
        self.error_code = error_code
        self.detail = detail
        text = f"{error_type}: {vendor_message}"
        if error_code is not None:
            text += f" (error_code {error_code})"
        if detail:
            text += f" [{detail}]"
        super().__init__(f"AssemblyAI synthesis refused the session: {text}")


def _synthesis_refusal(frame: Mapping[str, Any]) -> SynthesisRefusal:
    """The Error frame's cause, code and message, as the vendor stated them."""
    code = frame.get("error_code")
    code = code if isinstance(code, int) and not isinstance(code, bool) else None
    error_type = frame.get("error_type")
    if not isinstance(error_type, str) or not error_type.strip():
        error_type = str(code) if code is not None else "unspecified_error"
    message = frame.get("error") or frame.get("message") or frame.get("detail")
    return SynthesisRefusal(
        error_type=error_type.strip(),
        vendor_message=(
            message if isinstance(message, str) and message else "no message"
        ),
        error_code=code,
    )


def _handshake_detail(error: BaseException) -> str | None:
    """An HTTP status and any ``X-TTS-*`` headers on a refused upgrade."""
    response = getattr(error, "response", None)
    if response is None:
        return None
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(response, "status", None)
    headers = getattr(response, "headers", None) or {}
    tts_headers = "; ".join(
        f"{name}: {value}"
        for name, value in headers.items()
        if str(name).lower().startswith("x-tts-")
    )
    parts = []
    if status is not None:
        parts.append(f"HTTP {status}")
    if tts_headers:
        parts.append(tts_headers)
    return ", ".join(parts) if parts else None


def missing_keys(env: Mapping[str, str]) -> tuple[str, ...]:
    """Every missing key by name, in refusal order; never a value."""
    return tuple(name for name in KEY_ENVS if not str(env.get(name, "")).strip())


def keys_present(env: Mapping[str, str]) -> tuple[str, ...]:
    """The key names that are present; the values never leave the process."""
    return tuple(name for name in KEY_ENVS if str(env.get(name, "")).strip())


@dataclass(frozen=True)
class CallerWav:
    """The caller recording a live run streams: one validated WAV, one record.

    The ticket 09 fixture is a synthesized harmonic tone and the live vendor
    emits no ``speechEnd`` for it, so ``--live`` takes a real speech WAV. A WAV
    that is not 24 kHz mono 16-bit PCM is refused by name, never resampled:
    resampling would make the endpointing term a property of this harness.
    """

    path: str
    sha256: str
    pcm: bytes
    sample_rate: int
    channels: int
    sample_width_bytes: int
    frame_count: int
    speech_end_sample: int
    silence_threshold_lsb: int = SPEECH_SILENCE_THRESHOLD_LSB

    @property
    def duration_s(self) -> float:
        return self.frame_count / self.sample_rate

    @property
    def speech_end_ms(self) -> float:
        return round(self.speech_end_sample / self.sample_rate * 1000.0, 3)

    def metadata(self) -> dict[str, Any]:
        """The run record: what was streamed, its hash and its speech-end."""
        return {
            "path": self.path,
            "sha256": self.sha256,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "sample_width_bytes": self.sample_width_bytes,
            "duration_s": round(self.duration_s, 6),
            "speech_end_sample": self.speech_end_sample,
            "speech_end_ms": self.speech_end_ms,
            "silence_threshold_lsb": self.silence_threshold_lsb,
        }

    @classmethod
    def from_wav_bytes(cls, path: str, raw: bytes) -> "CallerWav":
        try:
            facts = fixture.read_wav(raw)
        except (wave.Error, EOFError) as error:
            raise CallerWavError(
                f"caller WAV {path!r} is not a readable WAV: {error}"
            ) from None
        if facts.sample_rate != fixture.SAMPLE_RATE:
            raise CallerWavError(
                f"caller WAV {path!r} is {facts.sample_rate} Hz; the live run "
                f"streams {fixture.SAMPLE_RATE} Hz mono 16-bit PCM and a wrong "
                "rate is not resampled"
            )
        if facts.channels != fixture.CHANNELS:
            raise CallerWavError(
                f"caller WAV {path!r} has {facts.channels} channels; the live "
                "run streams mono and a wrong channel count is not downmixed"
            )
        if facts.sample_width_bytes != fixture.SAMPLE_WIDTH_BYTES:
            raise CallerWavError(
                f"caller WAV {path!r} has {facts.sample_width_bytes}-byte "
                f"samples; the live run streams 16-bit "
                f"({fixture.SAMPLE_WIDTH_BYTES}-byte) samples and a wrong width "
                "is not converted"
            )
        speech_end = _last_sample_above_silence(facts.pcm)
        if speech_end < 0:
            raise CallerWavError(
                f"caller WAV {path!r} has no sample above the silence threshold "
                f"({SPEECH_SILENCE_THRESHOLD_LSB} LSB); a real speech recording "
                "is required"
            )
        return cls(
            path=path,
            sha256=hashlib.sha256(raw).hexdigest(),
            pcm=facts.pcm,
            sample_rate=facts.sample_rate,
            channels=facts.channels,
            sample_width_bytes=facts.sample_width_bytes,
            frame_count=facts.frame_count,
            speech_end_sample=speech_end,
        )


def _last_sample_above_silence(pcm: bytes) -> int:
    """The last sample whose magnitude is above the stated silence threshold."""
    samples = fixture.unpack_pcm(pcm)
    for index in range(len(samples) - 1, -1, -1):
        if abs(samples[index]) > SPEECH_SILENCE_THRESHOLD_LSB:
            return index
    return -1


def load_caller_wav(path: str | Path) -> CallerWav:
    """Read and validate one ``--wav`` path; a bad file is a named refusal."""
    target = Path(path)
    try:
        raw = target.read_bytes()
    except OSError as error:
        raise CallerWavError(
            f"caller WAV {str(target)!r} could not be read: {error}"
        ) from None
    return CallerWav.from_wav_bytes(str(target), raw)


class SyncSocket(Protocol):
    """The two-call socket surface the live adapters need, injected in tests."""

    def send(self, message: str | bytes) -> None: ...

    def recv(self, timeout: float | None = None) -> str | bytes: ...

    def close(self) -> None: ...


Connect = Callable[[str, dict[str, str]], SyncSocket]


def _default_connect(url: str, headers: dict[str, str]) -> SyncSocket:
    from websockets.sync.client import connect

    return connect(
        url, additional_headers=headers, open_timeout=CLIENT_TIMEOUT_S
    )  # type: ignore[no-any-return]


def _is_closed(error: BaseException) -> bool:
    """websockets' close exception, matched by name to keep the import lazy."""
    return type(error).__name__.startswith("ConnectionClosed")


def _json_object(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, str):
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _turn_id(message: Mapping[str, Any]) -> str | None:
    """The vendor turn id as a string: Meta sends a JSON integer (``0``, ``1``).

    The spike keeps ``TurnTerms.turn_id`` typed ``str`` so both turns stay
    distinct; an integer is normalized with ``str`` rather than dropped, which
    would make every event unattributable and the whole run unmeasured. Only a
    non-bool integer or a non-empty string is a turn id: a float such as
    ``1.0`` or an object must not be stringified into a fake turn.
    """
    value = message.get("turnId")
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _recv(socket: SyncSocket, timeout_s: float) -> Any:
    """One frame, ``_TIMEOUT``, or ``_Closed`` when the vendor closed.

    ``None`` from a fake socket means the same as a close without a code, so
    both keep the close path testable without a websockets import.
    """
    try:
        raw = socket.recv(timeout=timeout_s)
    except TimeoutError:
        return _TIMEOUT
    except Exception as error:  # noqa: BLE001 - close types are vendor shapes
        if _is_closed(error):
            code = getattr(error, "code", None)
            reason = str(getattr(error, "reason", "") or "")
            return _Closed(
                code=code if isinstance(code, int) else None, reason=reason
            )
        raise
    if raw is None:
        return _Closed()
    return raw


class LiveMetaSttTransport:
    """The production Meta speech contract, adapted to the spike's sync seam.

    Only the handshake, audio frames, event mapping and ``endStream`` are here.
    Reconnect policy, turn state and ledgers belong to ``cascade.meta_stt`` and
    are deliberately not duplicated for a single 20 s measurement.
    """

    def __init__(
        self,
        api_key: str,
        *,
        call_id: str | None = None,
        connect: Connect | None = None,
        clock: Callable[[], float] | None = None,
        handshake_timeout_s: float | None = None,
        poll_timeout_s: float = POLL_TIMEOUT_S,
    ) -> None:
        self._api_key = api_key
        self._call_id = call_id or f"m00-spike-{os.getpid()}"
        self._connect = connect or _default_connect
        self._clock = clock or time.monotonic
        self._handshake_timeout_s = (
            float(thresholds.require_bound(meta_stt.HANDSHAKE_BOUND)) / 1000.0
            if handshake_timeout_s is None
            else handshake_timeout_s
        )
        self._poll_timeout_s = poll_timeout_s
        self._socket: SyncSocket | None = None
        self._origin_s = 0.0
        self._media_sent_s = 0.0
        #: The measured turn's timestamps, read by the runner after ``measure``.
        self.speech_end_at_s: float | None = None
        self.speech_complete_at_s: float | None = None
        self.transcript = ""
        self.caller_turn_id: str | None = None
        #: Whether the stream ended with the vendor's clean ``1000`` close;
        #: ``None`` until the socket closes.
        self.closed_clean: bool | None = None
        #: Whether ``endStream`` was actually sent; the close label depends on it.
        self._end_stream_sent = False

    @property
    def url(self) -> str:
        session = meta_stt.session_id(self._call_id, 0)
        return f"{meta_stt.REALTIME_URL}?{urlencode({'sessionId': session})}"

    def handshake(self) -> dict[str, Any]:
        """The one handshake frame, including the credential in its own field."""
        bias = meta_stt.language_bias(STT_LANGUAGE_CODES)
        frame: dict[str, Any] = {
            "authorization": {"accessToken": f"Bearer {self._api_key}"},
            "audioEncoding": meta_stt.AUDIO_ENCODING,
            "model": meta_stt.MODEL,
            "mode": meta_stt.MODE,
            "partialMode": meta_stt.PARTIAL_MODE,
            "emitAudioProgress": meta_stt.EMIT_AUDIO_PROGRESS,
            "keywords": [],
        }
        if bias:
            frame["languageBias"] = list(bias)
        return frame

    def open(self) -> None:
        socket = self._connect(self.url, {})
        self._socket = socket
        try:
            socket.send(json.dumps(self.handshake()))
            raw = _recv(socket, self._handshake_timeout_s)
            if raw is _TIMEOUT:
                raise LiveSttError(
                    f"Meta STT sent no acknowledgement within "
                    f"{self._handshake_timeout_s:g}s (bound "
                    f"{meta_stt.HANDSHAKE_BOUND!r})"
                )
            if isinstance(raw, _Closed):
                raise LiveSttError(
                    "Meta STT closed before the acknowledgement "
                    f"({_close_detail(raw)}); no audio was sent"
                )
            ack = _json_object(raw)
            if ack is None or "type" in ack:
                raise LiveSttError(
                    "the first Meta STT frame was not the acknowledgement: a frame "
                    "that is a JSON object without a type is the only ack"
                )
        except BaseException:
            self.close()
            raise
        self._origin_s = self._clock()

    def send_audio(self, chunk: bytes) -> None:
        if self._socket is None:
            raise LiveSttError("Meta STT audio sent before the session opened")
        self._socket.send(chunk)
        self._media_sent_s += len(chunk) / meta_stt.BYTES_PER_SECOND

    def audio_processed_s(self) -> float:
        """The send position, which the pacer's due-time law keeps real-time."""
        return self._media_sent_s

    def _event(self, raw: Any) -> endpointing.SttEvent | None:
        message = _json_object(raw)
        if message is None:
            return None
        kind = message.get("type")
        if not isinstance(kind, str):
            return None
        received_at_s = self._clock()
        turn_id = _turn_id(message)
        processed = message.get("audioProcessedMs")
        processed = (
            float(processed)
            if isinstance(processed, (int, float)) and not isinstance(processed, bool)
            else None
        )
        text = message.get("transcript")
        text = text if isinstance(text, str) else None
        if kind == endpointing.SPEECH_END and self.speech_end_at_s is None:
            self.speech_end_at_s = received_at_s
            self.caller_turn_id = turn_id
        elif kind == endpointing.SPEECH_COMPLETE:
            self.speech_complete_at_s = received_at_s
            if text:
                self.transcript = text
        return endpointing.SttEvent(
            kind=kind,
            received_at_s=received_at_s,
            turn_id=turn_id,
            audio_processed_ms=processed,
            text=text,
        )

    def _note_closed(self, closed: _Closed, *, after_end_stream: bool) -> None:
        """Record the close; a failure close is a named error, never a clean end."""
        self.closed_clean = closed.clean
        if closed.clean:
            return
        stage = "after endStream" if after_end_stream else "before endStream was sent"
        raise LiveSttError(
            f"Meta STT closed {stage} with a failure ({_close_detail(closed)})"
        )

    def poll(self) -> tuple[endpointing.SttEvent, ...]:
        if self._socket is None:
            return ()
        events: list[endpointing.SttEvent] = []
        while True:
            raw = _recv(self._socket, self._poll_timeout_s)
            if raw is _TIMEOUT:
                return tuple(events)
            if isinstance(raw, _Closed):
                self._note_closed(raw, after_end_stream=False)
                return tuple(events)
            event = self._event(raw)
            if event is not None:
                events.append(event)

    def end_stream(self) -> None:
        if self._socket is not None:
            self._socket.send(meta_stt.END_STREAM_FRAME)
            self._end_stream_sent = True

    def drain(self) -> tuple[endpointing.SttEvent, ...]:
        if self._socket is None:
            return ()
        events: list[endpointing.SttEvent] = []
        while True:
            raw = _recv(self._socket, self._handshake_timeout_s)
            if raw is _TIMEOUT:
                return tuple(events)
            if isinstance(raw, _Closed):
                self._note_closed(raw, after_end_stream=self._end_stream_sent)
                return tuple(events)
            event = self._event(raw)
            if event is not None:
                events.append(event)

    def close(self) -> None:
        socket, self._socket = self._socket, None
        if socket is not None:
            try:
                socket.close()
            except Exception:  # noqa: BLE001 - a close failure is not a term
                pass


class LiveSparkTransport:
    """POST the existing Spark request and yield its raw SSE lines."""

    name = "live-spark"

    def __init__(
        self,
        api_key: str,
        *,
        post: Callable[[str, dict[str, str], bytes], AbstractContextManager[Any]]
        | None = None,
        timeout_s: float = CLIENT_TIMEOUT_S,
    ) -> None:
        self._api_key = api_key
        self._post = post or self._http_post
        self._timeout_s = timeout_s

    def _http_post(
        self, url: str, headers: dict[str, str], body: bytes
    ) -> AbstractContextManager[Any]:
        import urllib.error
        import urllib.request

        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            return urllib.request.urlopen(request, timeout=self._timeout_s)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise first_token.HttpError(error.code, detail) from None

    def stream(self, payload: Mapping[str, Any]) -> Iterator[str]:
        body = json.dumps(dict(payload)).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        with self._post(first_token.ENDPOINT, headers, body) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                reader = getattr(response, "read", None)
                detail = (
                    reader().decode("utf-8", errors="replace")
                    if callable(reader)
                    else None
                )
                raise first_token.HttpError(status, detail)
            for raw in response:
                yield raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)


class LiveSynthesisSession:
    """One AssemblyAI synthesis session, stamped frame by frame.

    ``open`` reads the ``Begin`` echo before the turn; ``speak`` sends one
    ``Generate`` plus ``Flush`` and returns at the first ``Audio``. The runner
    passes those frames to :func:`spike.first_audio.measure_first_audio`, so the
    term is the vendor's synthesis cost and the handshake stays outside it.
    """

    def __init__(
        self,
        api_key: str,
        voice_id: str = DEFAULT_VOICE_ID,
        *,
        connect: Connect | None = None,
        clock: Callable[[], float] | None = None,
        timeout_s: float = CLIENT_TIMEOUT_S,
    ) -> None:
        self._api_key = api_key
        self._voice_id = voice_id
        self._connect = connect or _default_connect
        self._clock = clock or time.monotonic
        self._timeout_s = timeout_s
        self._socket: SyncSocket | None = None
        self._frames: list[first_audio.Frame] = []
        self._opened_at_s: float | None = None
        self._begin_at_s: float | None = None

    @property
    def url(self) -> str:
        format_ = assemblyai_tts.TRANSPORT_FORMATS["browser"]
        params = [
            ("voice_id", self._voice_id),
            ("language", voice_binding.LOCALES["en"].language),
            ("sample_rate", str(format_.sample_rate)),
            ("encoding", format_.encoding),
            ("model_id", assemblyai_tts.MODEL_ID),
            ("word_boundaries", "true"),
        ]
        return f"{assemblyai_tts.TTS_BASE_URL}?{urlencode(params)}"

    def open(self) -> first_audio.Opening:
        self._opened_at_s = self._clock()
        try:
            socket = self._connect(self.url, {"Authorization": self._api_key})
        except Exception as error:  # noqa: BLE001 - an upgrade refusal is vendor-shaped
            detail = _handshake_detail(error)
            if detail is None:
                raise
            raise LiveTtsError(
                f"AssemblyAI synthesis refused the connection: {detail}"
            ) from None
        self._socket = socket
        try:
            raw = _recv(socket, self._timeout_s)
            if raw is _TIMEOUT:
                raise LiveTtsError(
                    "AssemblyAI synthesis sent no Begin frame; the session did "
                    "not open"
                )
            if isinstance(raw, _Closed):
                raise LiveTtsError(
                    "AssemblyAI synthesis closed before Begin "
                    f"({_close_detail(raw)}); the session cannot be measured"
                )
            frame = _json_object(raw)
            if frame is not None and frame.get("type") == TTS_ERROR_FRAME:
                raise _synthesis_refusal(frame)
            if frame is None or frame.get("type") != first_audio.BEGIN:
                raise LiveTtsError(
                    "the first synthesis frame was not Begin; the session cannot "
                    "be measured"
                )
        except BaseException:
            self.close()
            raise
        self._begin_at_s = self._clock()
        self._frames = [
            first_audio.Frame(first_audio.BEGIN, at_s=self._begin_at_s)
        ]
        return first_audio.Opening(
            opened_at_s=self._opened_at_s, begin_at_s=self._begin_at_s
        )

    def speak(self, text: str) -> tuple[first_audio.Frame, ...]:
        if self._socket is None:
            raise LiveTtsError("synthesis speak before the session opened")
        if len(text) > assemblyai_tts.GENERATE_CHAR_CAP:
            raise LiveTtsError(
                f"the spike line is {len(text)} characters; a Generate carries "
                f"at most {assemblyai_tts.GENERATE_CHAR_CAP}"
            )
        self._socket.send(json.dumps({"type": first_audio.GENERATE, "text": text}))
        self._frames.append(
            first_audio.Frame(
                first_audio.GENERATE, at_s=self._clock(), detail=text
            )
        )
        self._socket.send(json.dumps({"type": first_audio.FLUSH}))
        self._frames.append(
            first_audio.Frame(first_audio.FLUSH, at_s=self._clock())
        )
        while True:
            raw = _recv(self._socket, self._timeout_s)
            if raw is _TIMEOUT or isinstance(raw, _Closed):
                break
            frame = _json_object(raw)
            if frame is None or frame.get("type") != first_audio.AUDIO:
                continue
            self._frames.append(
                first_audio.Frame(first_audio.AUDIO, at_s=self._clock())
            )
            break
        return tuple(self._frames)

    def close(self) -> None:
        socket, self._socket = self._socket, None
        if socket is not None:
            try:
                socket.close()
            except Exception:  # noqa: BLE001 - a close failure is not a term
                pass


def _caller_turn(
    turns: tuple[endpointing.TurnTerms, ...], transport: Any
) -> endpointing.TurnTerms | None:
    """The caller's turn: the first turn that reported ``speechEnd``."""
    caller_id = getattr(transport, "caller_turn_id", None)
    if caller_id is not None:
        for turn in turns:
            if turn.turn_id == caller_id:
                return turn
    return next(
        (turn for turn in turns if turn.endpointing.value_ms is not None), None
    )


def _effort(
    env: Mapping[str, str],
) -> tuple[first_token.Effort | None, str | None]:
    """The M03-configured effort, or the named blocker; ``"none"`` is never sent.

    The value is the effort M03 fixed for the run, not a live probe of Spark's
    lowest supported value. The row it fills is labelled ``lowest`` by the
    report's closed shape, so its source says configured-not-probed.
    """
    value = str(env.get(REASONING_EFFORT_ENV, "")).strip()
    if not value:
        return (
            None,
            f"{REASONING_EFFORT_ENV} is not set; the configured "
            "reasoning_effort is not guessed",
        )
    if value.lower() == first_token.UNAVAILABLE_EFFORT:
        return (
            None,
            f"reasoning_effort {value!r} is unavailable on Spark (HTTP 400) and "
            "is never sent",
        )
    return (
        first_token.lowest_effort(
            value,
            source=(
                f"{REASONING_EFFORT_ENV} (M03 configured, not probed)"
            ),
        ),
        None,
    )


def _producer_for(effort: first_token.Effort) -> str:
    note = ""
    if effort.label == first_token.LOWEST_LABEL and effort.is_resolved:
        note = (
            f"; {effort.label} row value from {effort.source}: configured, "
            "not probed"
        )
    return (
        f"spike.first_token[{effort.label}] live Spark stream: speechComplete "
        f"receipt -> first content delta (reasoning_content excluded){note}"
    )


def _unmeasured_first_content(
    effort: first_token.Effort,
    reason: str,
    *,
    speech_complete_at_s: float | None = None,
) -> first_token.FirstContentReport:
    """Both effort rows unmeasured, naming this run's real reason."""
    rows = []
    for row_effort in (first_token.DEFAULT_EFFORT, effort):
        rows.append(
            first_token.FirstContentTerm(
                effort=row_effort,
                producer=_producer_for(row_effort),
                unmeasured_reason=f"unmeasured: {reason}",
            )
        )
    return first_token.FirstContentReport(
        speech_complete_at_s=speech_complete_at_s,
        terms=tuple(rows),
    )


def _unmeasured_synthesis(
    reason: str, *, opening: first_audio.Opening | None = None
) -> first_audio.FirstAudio:
    """The first-audio and cushion lines, with the real reason on the term."""
    recorded = opening or first_audio.Opening(opened_at_s=0.0, begin_at_s=None)
    last = recorded.begin_at_s if recorded.begin_at_s is not None else recorded.opened_at_s
    base = first_audio.measure_first_audio(
        opening=recorded,
        turn_at_s=last + 1.0,
        frames=(),
    )
    term = replace(
        base.term,
        producer=(
            f"{first_audio.PRODUCER} — {reason}; producer: "
            f"{first_audio.LIVE_PRODUCER}"
        ),
        detail=reason,
    )
    return replace(base, first_audio_ms=None, term=term)


@dataclass(frozen=True)
class LiveMeasurement:
    """One live run: the five-term report plus the run's own evidence."""

    report: report.Report
    at: str
    keys_present: tuple[str, ...]
    caller: CallerWav
    blockers: tuple[str, ...] = ()
    degraded: tuple[str, ...] = ()

    def exit_code(self) -> int:
        """0 for a fully measured PASS/AT RISK, 1 for FAIL, 3 for incomplete.

        An unmeasured term, a degraded leg or a blocker means the run did not
        measure all five terms, so it outranks a FAIL computed from the terms
        that happened to arrive.
        """
        if (
            self.blockers
            or self.degraded
            or self.report.unmeasured_names
        ):
            return 3
        return 1 if self.report.verdict == report.FAIL else 0

    def metadata(self) -> dict[str, Any]:
        """The run record: timestamp, key *names* and the caller WAV, never a key."""
        return {
            "at": self.at,
            "keys_present": list(self.keys_present),
            "effort": self.report.effort_label,
            "blockers": list(self.blockers),
            "degraded": list(self.degraded),
            "caller_wav": self.caller.metadata(),
            # The synthesis leg speaks this fixed spike line, never the caller's
            # transcript, so the report cannot imply it spoke the caller's words.
            "synthesis_text_source": "canned spike line",
            "synthesis_text": SPIKE_TRANSCRIPT,
        }

    def as_dict(self) -> dict[str, Any]:
        return {"report": self.report.as_dict(), "run": self.metadata()}


def run_live(
    *,
    env: Mapping[str, str],
    caller: CallerWav | None = None,
    stt_factory: Callable[[str], endpointing.MetaSttTransport] | None = None,
    spark_factory: Callable[[str], first_token.StreamingTransport] | None = None,
    tts_factory: Callable[[str, str], LiveSynthesisSession] | None = None,
    clock: Callable[[], float] | None = None,
    wait: Callable[[float], None] | None = None,
    wall_clock: Callable[[], float] | None = None,
) -> LiveMeasurement:
    """Measure the five terms live, or name why a term is unmeasured.

    ``caller`` is the validated real speech WAV the run streams; without it the
    run refuses by name rather than falling back to the synthetic tone fixture.
    """
    missing = missing_keys(env)
    if missing:
        raise MissingKeysError(missing)
    if caller is None:
        raise CallerWavError(
            "spike.run --live requires --wav PATH: a real speech WAV "
            "(24 kHz mono 16-bit PCM); the synthetic ticket 09 tone fixture is "
            "offline-only"
        )

    monotonic = clock or time.monotonic
    sleeper = wait or time.sleep
    wall = wall_clock or time.time
    meta_key = str(env[META_KEY_ENV])
    tts_key = str(env[ASSEMBLYAI_KEY_ENV])
    voice_id = str(env.get(VOICE_ID_ENV, "")).strip() or DEFAULT_VOICE_ID
    blockers: list[str] = []
    degraded: list[str] = []

    def stt_transport(key: str) -> endpointing.MetaSttTransport:
        if stt_factory is not None:
            return stt_factory(key)
        return LiveMetaSttTransport(key, clock=monotonic)

    def spark_transport(key: str) -> first_token.StreamingTransport:
        if spark_factory is not None:
            return spark_factory(key)
        return LiveSparkTransport(key)

    def tts_session(key: str, voice: str) -> LiveSynthesisSession:
        if tts_factory is not None:
            return tts_factory(key, voice)
        return LiveSynthesisSession(key, voice, clock=monotonic)

    # The synthesis session is opened before the turn so the handshake is a
    # call-start cost, never part of the first-audio term.
    session = None
    opening: first_audio.Opening | None = None
    try:
        session = tts_session(tts_key, voice_id)
        opening = session.open()
    except Exception as error:  # noqa: BLE001 - a leg failure is a named term
        degraded.append(first_audio.TERM_NAME)
        synthesis_error: str | None = (
            f"live synthesis session failed: {error}"
        )
        if session is not None:
            try:
                session.close()
            except Exception:  # noqa: BLE001 - a close failure is not a term
                pass
    else:
        synthesis_error = None

    transport = None
    speech_complete_at_s: float | None = None
    speech_complete_missing: str | None = None
    stt_measured = False
    try:
        transport = stt_transport(meta_key)
        turns = endpointing.measure(
            transport,
            pcm=caller.pcm,
            speech_end_sample=caller.speech_end_sample,
            sample_rate=caller.sample_rate,
            clock=monotonic,
            wait=sleeper,
            chunk_ms=LIVE_FRAME_MS,
        )
        caller_turn = _caller_turn(turns, transport)
        if caller_turn is None:
            raise LiveSttError(
                "the Meta STT stream reported no turn with a speechEnd; the "
                "caller's turn was not measured"
            )
        stt_terms = caller_turn
        stt_measured = True
        transcript = getattr(transport, "transcript", "") or SPIKE_TRANSCRIPT
    except Exception as error:  # noqa: BLE001 - a leg failure is a named term
        stt_terms = endpointing.unmeasured_terms(
            f"live Meta STT leg failed: {error}"
        )
        transcript = SPIKE_TRANSCRIPT
        degraded.extend(
            (endpointing.ENDPOINTING_TERM, endpointing.POST_PROCESSING_TERM)
        )

    if stt_measured and transport is not None:
        # The receipt is a declared member of the transport protocol (it is
        # term 3's start), so it is read directly. A transport that does not
        # carry it leaves term 3 unmeasured by name, never as a silent None.
        try:
            speech_complete_at_s = transport.speech_complete_at_s
        except AttributeError:
            speech_complete_missing = (
                "the live Meta STT transport does not expose "
                "speech_complete_at_s (the speechComplete receipt), so term 3 "
                "has no start"
            )
    else:
        speech_complete_missing = (
            "the speechComplete receipt was not recorded because the Meta STT "
            "leg failed"
        )

    effort, effort_blocker = _effort(env)
    if effort is None:
        blockers.append(str(effort_blocker))
        first_content = _unmeasured_first_content(
            first_token.UNRESOLVED_LOWEST_EFFORT,
            str(effort_blocker),
            speech_complete_at_s=speech_complete_at_s,
        )
    elif speech_complete_at_s is None:
        reason = speech_complete_missing or (
            "the speechComplete receipt was not recorded, so term 3 has no "
            "start"
        )
        degraded.append(first_token.TERM)
        first_content = _unmeasured_first_content(
            effort, reason, speech_complete_at_s=None
        )
    else:
        try:
            spark = spark_transport(meta_key)
            first_content = first_token.measure_efforts(
                spark,
                speech_complete_at_s=speech_complete_at_s,
                transcript=transcript,
                efforts=(first_token.DEFAULT_EFFORT, effort),
                clock=monotonic,
            )
            row = first_content.term(effort.label)
            if not row.measured:
                degraded.append(first_token.TERM)
        except Exception as error:  # noqa: BLE001 - a leg failure is a named term
            degraded.append(first_token.TERM)
            first_content = _unmeasured_first_content(
                effort,
                f"live Spark leg failed: {error}",
                speech_complete_at_s=speech_complete_at_s,
            )

    if session is not None and opening is not None and synthesis_error is None:
        turn_at_s = monotonic()
        try:
            frames = session.speak(SPIKE_TRANSCRIPT)
            synthesis = first_audio.measure_first_audio(
                opening=opening, turn_at_s=turn_at_s, frames=frames
            )
            if synthesis.term.ms is None:
                degraded.append(first_audio.TERM_NAME)
        except Exception as error:  # noqa: BLE001 - a leg failure is a named term
            degraded.append(first_audio.TERM_NAME)
            synthesis = _unmeasured_synthesis(
                f"live synthesis leg failed: {error}", opening=opening
            )
        finally:
            session.close()
    else:
        synthesis = _unmeasured_synthesis(
            synthesis_error or "the synthesis session was not opened",
            opening=opening,
        )

    composed = report.from_measurements(
        stt=stt_terms,
        first_content=first_content,
        synthesis=synthesis,
        effort_label=first_token.LOWEST_LABEL,
    )
    return LiveMeasurement(
        report=composed,
        at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(wall())),
        keys_present=keys_present(env),
        caller=caller,
        blockers=tuple(blockers),
        degraded=tuple(dict.fromkeys(degraded)),
    )

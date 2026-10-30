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

The measurement still goes through the ticket 10-12 producers. The live
transports here are thin: they carry the production wire contract (Meta's 24 kHz
handshake, ack and ``endStream``; Spark's SSE request builder; AssemblyAI's
``Begin``/``Generate``/``Flush``/``Audio`` session) and stamp each frame as it
arrives. The synthesis session is opened before the turn, so its handshake is
recorded as a call-start cost and never lands inside the first-audio term.

A failed leg degrades to that term ``UNMEASURED`` with the real reason and the
run exits 3. It never becomes a partial ``PASS``, and this module never records
a gate verdict for the owner: it measures and prints, nothing else.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass, replace
from typing import Any, Protocol
from urllib.parse import urlencode

from cascade import assemblyai_tts, meta_stt, thresholds, voice_binding
from spike import endpointing, first_audio, first_token, report

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

_TIMEOUT = object()


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


class LiveSttError(LiveSpikeError):
    """The live Meta speech session could not be established or read."""


class LiveTtsError(LiveSpikeError):
    """The live synthesis session could not be established or read."""


def missing_keys(env: Mapping[str, str]) -> tuple[str, ...]:
    """Every missing key by name, in refusal order; never a value."""
    return tuple(name for name in KEY_ENVS if not str(env.get(name, "")).strip())


def keys_present(env: Mapping[str, str]) -> tuple[str, ...]:
    """The key names that are present; the values never leave the process."""
    return tuple(name for name in KEY_ENVS if str(env.get(name, "")).strip())


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


def _recv(socket: SyncSocket, timeout_s: float) -> Any:
    """One frame, ``_TIMEOUT``, or ``None`` when the vendor closed."""
    try:
        return socket.recv(timeout=timeout_s)
    except TimeoutError:
        return _TIMEOUT
    except Exception as error:  # noqa: BLE001 - close types are vendor shapes
        if _is_closed(error):
            return None
        raise


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
            if raw is None:
                raise LiveSttError(
                    "Meta STT closed before the acknowledgement; no audio was sent"
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
        turn_id = message.get("turnId")
        turn_id = turn_id if isinstance(turn_id, str) and turn_id else None
        processed = message.get("audioProcessedMs")
        processed = (
            float(processed)
            if isinstance(processed, (int, float)) and not isinstance(processed, bool)
            else None
        )
        text = message.get("text")
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

    def poll(self) -> tuple[endpointing.SttEvent, ...]:
        if self._socket is None:
            return ()
        events: list[endpointing.SttEvent] = []
        while True:
            raw = _recv(self._socket, self._poll_timeout_s)
            if raw is _TIMEOUT or raw is None:
                return tuple(events)
            event = self._event(raw)
            if event is not None:
                events.append(event)

    def end_stream(self) -> None:
        if self._socket is not None:
            self._socket.send(meta_stt.END_STREAM_FRAME)

    def drain(self) -> tuple[endpointing.SttEvent, ...]:
        if self._socket is None:
            return ()
        events: list[endpointing.SttEvent] = []
        while True:
            raw = _recv(self._socket, self._handshake_timeout_s)
            if raw is _TIMEOUT or raw is None:
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
        socket = self._connect(self.url, {"Authorization": self._api_key})
        self._socket = socket
        try:
            raw = _recv(socket, self._timeout_s)
            if raw is _TIMEOUT or raw is None:
                raise LiveTtsError(
                    "AssemblyAI synthesis sent no Begin frame; the session did "
                    "not open"
                )
            frame = _json_object(raw)
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
            if raw is _TIMEOUT or raw is None:
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
    """The fixture's caller turn: the first turn that reported ``speechEnd``."""
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
        """The run record: timestamp and key *names*, never a key value."""
        return {
            "at": self.at,
            "keys_present": list(self.keys_present),
            "effort": self.report.effort_label,
            "blockers": list(self.blockers),
            "degraded": list(self.degraded),
        }

    def as_dict(self) -> dict[str, Any]:
        return {"report": self.report.as_dict(), "run": self.metadata()}


def run_live(
    *,
    env: Mapping[str, str],
    stt_factory: Callable[[str], endpointing.MetaSttTransport] | None = None,
    spark_factory: Callable[[str], first_token.StreamingTransport] | None = None,
    tts_factory: Callable[[str, str], LiveSynthesisSession] | None = None,
    clock: Callable[[], float] | None = None,
    wait: Callable[[float], None] | None = None,
    wall_clock: Callable[[], float] | None = None,
) -> LiveMeasurement:
    """Measure the five terms live, or name why a term is unmeasured."""
    missing = missing_keys(env)
    if missing:
        raise MissingKeysError(missing)

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
            transport, clock=monotonic, wait=sleeper, chunk_ms=LIVE_FRAME_MS
        )
        caller = _caller_turn(turns, transport)
        if caller is None:
            raise LiveSttError(
                "the Meta STT stream reported no turn with a speechEnd; the "
                "fixture's caller turn was not measured"
            )
        stt_terms = caller
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
        blockers=tuple(blockers),
        degraded=tuple(dict.fromkeys(degraded)),
    )

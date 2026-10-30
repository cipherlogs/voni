"""W1 clip regeneration and vendor determinism (ticket 129).

Spec: `.scratch/meta-cascade/spec.md`, M4 "W1 re-point" — the PR test replays a
recorded synthesis fixture and compares the clip's binding, Locale, text, format
and measured level. Byte identity is required only if the determinism
measurement in this ticket shows the render is deterministic; a
voice/locale/level/format difference always fails. A live regeneration is
key-gated and recorded as evidence, never a silent asset swap.

The pieces are the call's own, not copies:

- the voice and vendor language come from :func:`cascade.voice_binding.bind_voice`
  through :func:`cascade.clips.clip_body` and
  :func:`cascade.reference_render.render_reference`;
- the endpoint and model come from :mod:`cascade.assemblyai_tts`;
- the transport format is :func:`cascade.clips.clip_format`, the same 24 kHz
  mono ``pcm_s16le`` the browser call carries;
- the audio is written verbatim, so the measured level is the voice's native
  level with no gain, limiter or normalisation.

A **recorded fixture** is a JSON document under ``cascade/fixtures/clips/``: the
``Begin`` echo, the audio frames and their ``FlushDone`` maths for one clip
line. It pins the PCM hash, the WAV hash and the measured level, and
:func:`load_fixture` recomputes all three from the frames, so a changed frame
fails by fixture name. The audio payloads are repeated-sample tokens, not
recorded speech: the contract under test is the regeneration identity, not the
timbre (a new voice is auditioned in W2, ticket 133).

Determinism is measured, never assumed. :func:`measure_determinism` replays the
fixture at least twice and compares the bytes; only a measured byte-identical
render sets ``byte_identity_required``. A byte difference with matching
binding and level is not a failure.

Live synthesis is key-gated: without ``ASSEMBLYAI_API_KEY`` the module returns
a named blocker and writes nothing at all. A live run records its facts through
:func:`regeneration_document`, so a re-render is evidence rather than a silent
asset swap.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from cascade.assemblyai_tts import MODEL_ID, TTS_BASE_URL, SocketFactory
from cascade.clips import (
    ClipLevel,
    ClipPlan,
    ClipRecord,
    clip_body,
    clip_format,
    clip_record_problems,
    line_sha256,
    measure_wav,
    wav_sha256,
)
from cascade.native_level import NATIVE_GAIN_STAGE
from cascade.reference_render import (
    WAV_HEADER_BYTES,
    ReferenceFormat,
    pcm16_wav,
    render_reference,
)
from cascade.testing import ScriptedSocketFactory

#: The recorded synthesis fixtures: one JSON document per clip voice/Locale.
FIXTURE_DIR = Path(__file__).with_name("fixtures") / "clips"

#: The transport every clip fixture is rendered for (the browser capture leg).
CLIP_TRANSPORT_FOR_FIXTURE = "browser"

#: The one document shape this module reads.
FIXTURE_SCHEMA_VERSION = 1
FIXTURE_KIND = "clip-synthesis"

#: The environment variable a live regeneration needs.
API_KEY_ENV = "ASSEMBLYAI_API_KEY"

_FIXTURE_FIELDS = frozenset(
    {
        "schemaVersion",
        "name",
        "kind",
        "recordedOn",
        "method",
        "voice",
        "locale",
        "language",
        "text",
        "textSha256",
        "transport",
        "endpoint",
        "format",
        "model",
        "begin",
        "frames",
        "expect",
    }
)
_EXPECT_FIELDS = frozenset({"pcmSha256", "wavSha256", "audioBytes", "level"})
_LEVEL_FIELDS = frozenset({"samplePeakDbfs", "rmsDbfs"})


class ClipFixtureError(RuntimeError):
    """A recorded clip fixture is missing, malformed or has drifted."""

    def __init__(self, name: str, reason: str) -> None:
        self.name = name
        self.reason = reason
        super().__init__(f'clip fixture "{name}": {reason}')


class ClipRegenerationError(RuntimeError):
    """A regeneration cannot run honestly; the reason is named."""


@dataclass(frozen=True)
class ClipFixture:
    """One recorded synthesis fixture and the facts it pins."""

    name: str
    recorded_on: str
    method: str
    voice: str
    locale: str
    language: str
    text: str
    text_sha256: str
    transport: str
    endpoint: Mapping[str, str]
    format: Mapping[str, Any]
    model: str
    begin: str
    frames: tuple[str, ...]
    pcm: bytes
    pcm_sha256: str
    wav_sha256: str
    audio_bytes: int
    level: ClipLevel


def _refuse(name: str, reason: str) -> ClipFixtureError:
    return ClipFixtureError(name, reason)


def _required(document: Mapping[str, Any], key: str, name: str) -> Any:
    if key not in document or document[key] in ("", None):
        raise _refuse(name, f'"{key}" is missing; a fixture pins every field it compares')
    return document[key]


def _string(document: Mapping[str, Any], key: str, name: str) -> str:
    value = _required(document, key, name)
    if not isinstance(value, str) or not value.strip():
        raise _refuse(name, f'"{key}" must be a non-empty string')
    return value


def _mapping(document: Mapping[str, Any], key: str, name: str) -> dict[str, Any]:
    value = _required(document, key, name)
    if not isinstance(value, Mapping):
        raise _refuse(name, f'"{key}" must be an object')
    return dict(value)


def _frames(document: Mapping[str, Any], name: str) -> tuple[str, ...]:
    value = _required(document, "frames", name)
    if not isinstance(value, list) or not value:
        raise _refuse(name, '"frames" must be a non-empty list of vendor frames')
    frames: list[str] = []
    for index, frame in enumerate(value):
        if isinstance(frame, str):
            try:
                json.loads(frame)
            except json.JSONDecodeError as error:
                raise _refuse(name, f'"frames[{index}]" is not JSON: {error}') from None
            frames.append(frame)
        elif isinstance(frame, Mapping):
            frames.append(json.dumps(frame))
        else:
            raise _refuse(name, f'"frames[{index}]" must be a frame object or JSON string')
    return tuple(frames)


def _audio_from_frames(frames: Sequence[str], name: str) -> bytes:
    """The PCM the fixture's audio frames carry, in order.

    Recomputed from the frames, so the pinned hash cannot be restated from a
    number that no longer describes them.
    """
    import base64

    pcm = bytearray()
    for index, frame in enumerate(frames):
        document = json.loads(frame)
        if document.get("type") != "Audio":
            continue
        payload = document.get("audio")
        if not isinstance(payload, str):
            raise _refuse(name, f'"frames[{index}]" is an Audio frame with no audio payload')
        try:
            pcm.extend(base64.b64decode(payload, validate=True))
        except ValueError as error:
            raise _refuse(name, f'"frames[{index}]" audio is not base64: {error}') from None
    if not pcm:
        raise _refuse(name, "the fixture carries no audio frames, so it proves nothing")
    return bytes(pcm)


def _level_from(document: Mapping[str, Any], name: str) -> ClipLevel:
    level = _mapping(document, "level", name)
    unknown = set(level) - _LEVEL_FIELDS
    if unknown:
        raise _refuse(name, f'"expect.level" has unknown fields {sorted(unknown)}')
    try:
        return ClipLevel(
            sample_peak_dbfs=float(level["samplePeakDbfs"]),
            rms_dbfs=float(level["rmsDbfs"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise _refuse(name, f'"expect.level" is not a measured level: {error}') from None


def load_fixture(name: str, *, directory: str | os.PathLike[str] | None = None) -> ClipFixture:
    """Read one recorded fixture and re-derive every fact it pins.

    A missing file, a malformed document, an unknown field, a changed frame or
    a stale hash is a named failure. Nothing is skipped: a fixture the gate
    cannot replay is a gate that cannot fail.
    """
    folder = FIXTURE_DIR if directory is None else Path(directory)
    path = folder / f"{name}.json"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        raise _refuse(name, f"no recorded fixture at {path}") from None
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise _refuse(name, f"not readable as JSON: {error}") from None
    if not isinstance(document, Mapping):
        raise _refuse(name, "the document is not an object")

    unknown = set(document) - _FIXTURE_FIELDS
    if unknown:
        raise _refuse(name, f"unknown fields {sorted(unknown)}: a fixture is a pinned contract")
    if document.get("schemaVersion") != FIXTURE_SCHEMA_VERSION:
        raise _refuse(name, f'"schemaVersion" must be {FIXTURE_SCHEMA_VERSION}')
    if document.get("kind") != FIXTURE_KIND:
        raise _refuse(name, f'"kind" must be "{FIXTURE_KIND}", got {document.get("kind")!r}')

    recorded_on = _string(document, "recordedOn", name)
    method = _string(document, "method", name)
    voice = _string(document, "voice", name)
    locale = _string(document, "locale", name)
    language = _string(document, "language", name)
    text = _string(document, "text", name)
    text_sha256 = _string(document, "textSha256", name)
    transport = _string(document, "transport", name)
    model = _string(document, "model", name)
    endpoint = _mapping(document, "endpoint", name)
    fmt = _mapping(document, "format", name)
    begin = _string(document, "begin", name)
    frames = _frames(document, name)

    if f"{voice}-{locale}" != path.stem:
        raise _refuse(
            name,
            f'the document names voice "{voice}" ({locale}), but the file is {path.name}: '
            "a fixture is one voice's recording, never another's",
        )
    if text_sha256 != line_sha256(text):
        raise _refuse(name, '"textSha256" is not the hash of the recorded line')
    if endpoint.get("url") != TTS_BASE_URL or endpoint.get("model") != MODEL_ID:
        raise _refuse(name, f'"endpoint" {endpoint} is not the call\'s {TTS_BASE_URL} / {MODEL_ID}')
    if model != endpoint.get("model"):
        raise _refuse(name, f'"model" "{model}" is not the endpoint\'s "{endpoint.get("model")}"')
    if fmt != clip_format().to_document():
        raise _refuse(name, f'"format" {fmt} is not the call\'s native {clip_format().to_document()}')

    pcm = _audio_from_frames(frames, name)
    pcm_sha256 = hashlib.sha256(pcm).hexdigest()
    try:
        reference_format = ReferenceFormat.for_transport(transport)
    except Exception as error:  # an unknown transport is a named failure, never a skip
        raise _refuse(name, f'"transport" "{transport}" cannot be rendered: {error}') from None
    wav = pcm16_wav(pcm, reference_format)
    expect = _mapping(document, "expect", name)
    unknown_expect = set(expect) - _EXPECT_FIELDS
    if unknown_expect:
        raise _refuse(name, f'"expect" has unknown fields {sorted(unknown_expect)}')
    if expect.get("pcmSha256") != pcm_sha256:
        raise _refuse(
            name,
            f'"expect.pcmSha256" is {expect.get("pcmSha256")}, but the frames carry {pcm_sha256}: '
            "a changed frame is drift",
        )
    wav_sha256 = hashlib.sha256(wav).hexdigest()
    if expect.get("wavSha256") != wav_sha256:
        raise _refuse(
            name,
            f'"expect.wavSha256" is {expect.get("wavSha256")}, but the frames render to {wav_sha256}: '
            "a changed frame is drift",
        )
    if expect.get("audioBytes") != len(pcm):
        raise _refuse(name, f'"expect.audioBytes" is {expect.get("audioBytes")}, not {len(pcm)}')
    level = _level_from(expect, name)
    measured = measure_wav(wav)
    if level.to_document() != measured.to_document():
        raise _refuse(
            name,
            f'"expect.level" is {level.to_document()}, but the bytes measure {measured.to_document()}',
        )

    return ClipFixture(
        name=name,
        recorded_on=recorded_on,
        method=method,
        voice=voice,
        locale=locale,
        language=language,
        text=text,
        text_sha256=text_sha256,
        transport=transport,
        endpoint=endpoint,
        format=fmt,
        model=model,
        begin=begin,
        frames=frames,
        pcm=pcm,
        pcm_sha256=pcm_sha256,
        wav_sha256=wav_sha256,
        audio_bytes=len(pcm),
        level=level,
    )


@dataclass(frozen=True)
class RegeneratedClip:
    """One replay of a fixture through the call's own client."""

    fixture: ClipFixture
    plan: ClipPlan
    wav: bytes
    pcm: bytes
    pcm_sha256: str
    level: ClipLevel
    record: ClipRecord
    sent: tuple[Mapping[str, Any], ...] = field(default_factory=tuple)


async def regenerate(
    plan: ClipPlan,
    fixture: ClipFixture,
    *,
    out_dir: str | os.PathLike[str],
    clock: Any = None,
) -> RegeneratedClip:
    """Replay one fixture through the call's own synthesis client and binding.

    The replay is the PR path: the ticket-01 scripted socket supplies the
    recorded frames, so no key, network or sleep is involved. The bytes are
    written to ``out_dir`` (a working directory) and measured; nothing is
    written to the committed asset root, which only the generator owns.
    """
    if not plan.bound or plan.asset is None:
        raise ClipRegenerationError(
            f'voice "{plan.voice_id}" ({plan.locale}) is open and has no clip to regenerate: '
            f"{plan.reason}"
        )
    if fixture.voice != plan.voice_id:
        raise ClipRegenerationError(
            f'fixture "{fixture.name}" is {fixture.voice}\'s recording, not '
            f'"{plan.voice_id}"\'s: a clip is never regenerated from another voice'
        )

    factory = ScriptedSocketFactory(
        [fixture.begin, *fixture.frames], clock=clock
    )
    rendered = await render_reference(
        clip_body(plan),
        out_dir=out_dir,
        transport=fixture.transport,
        api_key="fixture-replay",
        socket_factory=factory,
        clock=clock,
    )
    wav = Path(rendered.path).read_bytes()
    pcm = wav[WAV_HEADER_BYTES:]
    level = measure_wav(wav)
    record = ClipRecord(
        voice=plan.voice_id,
        locale=plan.locale,
        language=plan.language,
        line=plan.greeting,
        line_sha256=line_sha256(plan.greeting),
        asset=plan.asset,
        sha256=wav_sha256(wav),
        audio_bytes=len(pcm),
        duration_ms=round(len(pcm) / 2 / clip_format().sample_rate * 1000),
        format=clip_format().to_document(),
        endpoint={"url": TTS_BASE_URL, "model": MODEL_ID},
        level=level,
        gain_stage=NATIVE_GAIN_STAGE,
        generated_on=fixture.recorded_on,
    )
    socket = factory.socket
    sent = tuple(json.loads(message) for message in (socket.sent if socket is not None else ()))
    return RegeneratedClip(
        fixture=fixture,
        plan=plan,
        wav=wav,
        pcm=pcm,
        pcm_sha256=hashlib.sha256(pcm).hexdigest(),
        level=level,
        record=record,
        sent=sent,
    )


@dataclass(frozen=True)
class DeterminismMeasurement:
    """Whether the same fixture renders to the same bytes, measured."""

    render_count: int
    sha256s: tuple[str, ...]
    byte_identical: bool
    detail: str


def measure_determinism(renders: Sequence[RegeneratedClip]) -> DeterminismMeasurement:
    """Compare at least two replays' bytes. One render is not a measurement."""
    if len(renders) < 2:
        raise ClipRegenerationError(
            f"determinism needs at least two renders; {len(renders)} supplied. "
            "Byte identity is never assumed from a single take."
        )
    sha256s = tuple(render.pcm_sha256 for render in renders)
    identical = len(set(sha256s)) == 1
    detail = (
        f"{len(renders)} renders are byte-identical ({sha256s[0]})"
        if identical
        else f"{len(renders)} renders differ: {', '.join(sorted(set(sha256s)))}"
    )
    return DeterminismMeasurement(
        render_count=len(renders),
        sha256s=sha256s,
        byte_identical=identical,
        detail=detail,
    )


def determinism_for(renders: Sequence[RegeneratedClip]) -> bool:
    """The one bit the comparison consumes: is a byte pin justified?"""
    return measure_determinism(renders).byte_identical


def fixture_problems(plan: ClipPlan, fixture: ClipFixture) -> list[str]:
    """Every way the fixture is not this plan's recorded render, named."""
    problems: list[str] = []
    if fixture.voice != plan.voice_id:
        problems.append(
            f'fixture binding speaks "{fixture.voice}", but the plan binds "{plan.voice_id}"'
        )
    if fixture.locale != plan.locale:
        problems.append(
            f"fixture Locale is {fixture.locale}, not the voice's own {plan.locale}"
        )
    if fixture.language != plan.language:
        problems.append(
            f'fixture asks the vendor for language "{fixture.language}", not "{plan.language}"'
        )
    if fixture.text != plan.greeting:
        problems.append(
            f'fixture line is "{fixture.text[:40]}…", not the greeting the call speaks '
            f'"{plan.greeting[:40]}…"'
        )
    if fixture.text_sha256 != line_sha256(plan.greeting):
        problems.append(f"fixture line hash is not the {plan.locale} greeting's hash")
    expected_endpoint = {"url": TTS_BASE_URL, "model": MODEL_ID}
    if dict(fixture.endpoint) != expected_endpoint:
        problems.append(
            f"fixture endpoint {dict(fixture.endpoint)} is not the call's {expected_endpoint}"
        )
    if fixture.model != MODEL_ID:
        problems.append(f'fixture model "{fixture.model}" is not the call\'s "{MODEL_ID}"')
    expected_format = clip_format().to_document()
    if dict(fixture.format) != expected_format:
        problems.append(
            f"fixture format {dict(fixture.format)} is not the call's native {expected_format}"
        )
    return problems


def regeneration_problems(
    plan: ClipPlan,
    fixture: ClipFixture,
    regenerated: RegeneratedClip,
    *,
    byte_identity_required: bool,
) -> list[str]:
    """Why a regenerated clip is not the committed clip, or an empty list.

    The record's own identity runs through the shared clip validator (voice,
    Locale, vendor language, line, asset, format, endpoint, native stage), the
    fixture is checked for the same binding and endpoint, and the measured
    level is compared with the level the recorded bytes carry. The byte pin is
    checked only when this ticket measured the render as deterministic: a
    different performance is not a failure by itself.
    """
    problems = [
        f"regenerated: {problem}" for problem in clip_record_problems(plan, regenerated.record)
    ]
    problems.extend(fixture_problems(plan, fixture))
    if regenerated.record.line != fixture.text:
        problems.append(
            f'regenerated line is "{regenerated.record.line[:40]}…", not the fixture\'s '
            f'"{fixture.text[:40]}…"'
        )
    if regenerated.record.level.to_document() != fixture.level.to_document():
        problems.append(
            f"regenerated level {regenerated.record.level.to_document()} is not the fixture's "
            f"{fixture.level.to_document()}: the voice did not speak at its native level"
        )
    if byte_identity_required and regenerated.record.sha256 != fixture.wav_sha256:
        problems.append(
            f'regenerated sha256 is {regenerated.record.sha256}, not fixture "{fixture.name}"\'s '
            f"{fixture.wav_sha256}: the vendor render was measured deterministic, so the bytes "
            "must be identical"
        )
    return problems


def live_regeneration_blocker(api_key: str | None = None) -> str | None:
    """Why a live regeneration cannot run now, or ``None`` when it can.

    A missing key is a named blocker, never a fabricated render and never a
    silent swap of the committed asset.
    """
    configured = (api_key or "").strip() or os.environ.get(API_KEY_ENV, "").strip()
    if configured:
        return None
    return (
        f"{API_KEY_ENV} is not configured: a live regeneration is key-gated, so no clip "
        "is fabricated and no committed asset is swapped. The recorded-fixture replay "
        "needs no key; set the key to record a fresh take."
    )


async def regenerate_live(
    plan: ClipPlan,
    *,
    out_dir: str | os.PathLike[str],
    api_key: str | None = None,
    generated_on: str | None = None,
    clock: Any = None,
) -> RegeneratedClip:
    """Render one clip from live synthesis and record it as evidence.

    Key-gated before a single file is touched: without a key this raises the
    named blocker and leaves ``out_dir`` empty. The caller writes
    :func:`regeneration_document` beside the take; the committed asset is
    never replaced by this function.
    """
    blocker = live_regeneration_blocker(api_key)
    if blocker is not None:
        raise ClipRegenerationError(blocker)
    if not plan.bound or plan.asset is None:
        raise ClipRegenerationError(
            f'voice "{plan.voice_id}" ({plan.locale}) is open and has no clip to regenerate: '
            f"{plan.reason}"
        )
    rendered = await render_reference(
        clip_body(plan),
        out_dir=out_dir,
        transport=CLIP_TRANSPORT_FOR_FIXTURE,
        api_key=api_key,
        clock=clock,
    )
    wav = Path(rendered.path).read_bytes()
    pcm = wav[WAV_HEADER_BYTES:]
    level = measure_wav(wav)
    record = ClipRecord(
        voice=plan.voice_id,
        locale=plan.locale,
        language=plan.language,
        line=plan.greeting,
        line_sha256=line_sha256(plan.greeting),
        asset=plan.asset,
        sha256=wav_sha256(wav),
        audio_bytes=len(pcm),
        duration_ms=round(len(pcm) / 2 / clip_format().sample_rate * 1000),
        format=clip_format().to_document(),
        endpoint={"url": TTS_BASE_URL, "model": MODEL_ID},
        level=level,
        gain_stage=NATIVE_GAIN_STAGE,
        generated_on=generated_on or date.today().isoformat(),
    )
    # A live take has no recorded fixture identity; it is evidence on its own.
    fixture = ClipFixture(
        name=f"{plan.voice_id}-{plan.locale}-live",
        recorded_on=record.generated_on,
        method="live synthesis through the call's own client; the take is evidence, not a swap",
        voice=record.voice,
        locale=record.locale,
        language=record.language,
        text=record.line,
        text_sha256=record.line_sha256,
        transport=CLIP_TRANSPORT_FOR_FIXTURE,
        endpoint={"url": TTS_BASE_URL, "model": MODEL_ID},
        format=record.format,
        model=MODEL_ID,
        begin="",
        frames=(),
        pcm=pcm,
        pcm_sha256=hashlib.sha256(pcm).hexdigest(),
        wav_sha256=record.sha256,
        audio_bytes=len(pcm),
        level=level,
    )
    return RegeneratedClip(
        fixture=fixture,
        plan=plan,
        wav=wav,
        pcm=pcm,
        pcm_sha256=hashlib.sha256(pcm).hexdigest(),
        level=level,
        record=record,
    )


def regeneration_document(
    plan: ClipPlan,
    regenerated: RegeneratedClip,
    *,
    determinism: DeterminismMeasurement,
    generated_on: str | None = None,
) -> dict[str, Any]:
    """The evidence a regeneration records: facts, never audio bytes."""
    record = regenerated.record
    return {
        "schemaVersion": 1,
        "kind": "clip-regeneration",
        "voice": record.voice,
        "locale": record.locale,
        "language": record.language,
        "line": record.line,
        "lineSha256": record.line_sha256,
        "asset": record.asset,
        "endpoint": dict(record.endpoint),
        "format": dict(record.format),
        "sha256": record.sha256,
        "bytes": record.audio_bytes,
        "durationMs": record.duration_ms,
        "level": record.level.to_document(),
        "gainStage": record.gain_stage,
        "determinism": {
            "renders": determinism.render_count,
            "sha256s": list(determinism.sha256s),
            "byteIdentical": determinism.byte_identical,
            "detail": determinism.detail,
        },
        "byteIdentityRequired": determinism.byte_identical,
        "generatedOn": generated_on or record.generated_on,
    }

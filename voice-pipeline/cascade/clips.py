"""W1 clips: each demo voice's greeting, rendered by the call's own synthesis.

A cascade clip is not a preview recorded from another path. It is the sentence
the call opens with, spoken by the voice the call binds, in the format the call
carries, through the same :class:`cascade.assemblyai_tts.AssemblyAIStreamingTTS`
the call uses — and written at the voice's native level, because the cascade has
no ``output.volume``, no client gain and no limiter.

The pieces are the call's own, not copies:

- the voice and the vendor language come from
  :func:`cascade.voice_binding.bind_voice`;
- the sample rate, encoding and model come from
  :mod:`cascade.assemblyai_tts` (the browser transport is the capture leg);
- the line is the app's greeting for that Locale, the same
  ``VONI_GREETINGS[locale]`` the stored body carries;
- the audio is :func:`cascade.reference_render.render_reference`'s verbatim
  synthesis bytes, so no gain, limiter or normalisation can enter the file.

An open Locale is a named row, never a clip: ``juergen``/de is in the catalogue
but unbound at the vendor, so the plan records the binding's own refusal and no
asset is planned, written or kept.

The manifest pins what a clip is, so ``--check`` can prove it later without a
key: endpoint, model, voice, vendor language, Locale, the exact line and its
hash, the native format, the file's sha256 and its measured level. A clip whose
voice, Locale, text, format or level disagrees with its plan fails by name.
"""

from __future__ import annotations

import hashlib
import math
import os
import struct
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from types import MappingProxyType
from typing import Any

from cascade.assemblyai_tts import MODEL_ID, TTS_BASE_URL, SocketFactory
from cascade.body_map import CascadeBody, adapt_body
from cascade.native_level import NATIVE_GAIN_STAGE
from cascade.reference_render import (
    WAV_HEADER_BYTES,
    ReferenceFormat,
    render_reference,
)
from cascade.voice_binding import (
    BINDINGS,
    SPEECH_LANGUAGES,
    UNBOUND_VOICES,
    UnboundVoiceError,
    bind_voice,
)

#: The Locales this demo speaks. One clip Locale each; German is open today.
CLIP_LOCALES: tuple[str, ...] = ("en", "es", "fr", "de", "it", "pt")

#: The app's demo subjects, in its own order. Restated from
#: ``voni/src/lib/demo/voni-agent.ts`` (``DEMO_VOICE_IDS``); the test compares
#: the two so drift is visible.
DEMO_VOICE_IDS: tuple[str, ...] = (
    "anna",
    "lola",
    "estelle",
    "juergen",
    "giovanni",
    "rafael",
)

#: The app's greeting per Locale. Restated from ``VONI_GREETINGS`` in the same
#: file; the test compares the two, so a greeting change fails the plan rather
#: than leaving a stale clip describing a sentence the call never says.
GREETINGS: Mapping[str, str] = MappingProxyType(
    {
        "en": "Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?",
        "es": "¡Hola, soy Voni! Probemos algo genial: te muestro lo que puedo hacer mientras hablamos. ¿Listo?",
        "fr": "Bonjour, ici Voni ! On essaie un truc sympa : je vous montre ce que je sais faire pendant qu'on parle. On y va ?",
        "de": "Hallo, hier ist Voni! Probieren wir etwas Cooles: Ich zeige Ihnen, was ich kann, während wir reden. Bereit?",
        "it": "Ciao, sono Voni! Proviamo una cosa forte: ti mostro cosa so fare mentre parliamo. Pronti?",
        "pt": "Olá, aqui é Voni! Vamos testar algo legal: mostro o que sei fazer enquanto conversamos. Pronto?",
    }
)

#: The transport a clip is rendered for: the browser leg is the W1 capture.
CLIP_TRANSPORT = "browser"

#: Committed cascade clips, one native WAV per bound voice. The managed path's
#: ``public/voices/<voice>.mp3`` stays untouched: a cascade clip is a new
#: native render, never a silent swap of the managed asset.
CLIP_ASSET_DIR = "voni/public/voices/cascade"

#: The committed record of what the script rendered and measured.
CLIP_MANIFEST_PATH = "voni/evidence/cascade-clips/clips.json"

#: The script that is the only producer of the committed clip assets.
CLIP_GENERATOR_COMMAND = "cd voice-pipeline && python scripts/render_clips.py"

CLIP_MANIFEST_SCHEMA_VERSION = 1


class ClipError(RuntimeError):
    """A clip cannot be planned, rendered or audited honestly."""


@dataclass(frozen=True)
class ClipPlan:
    """One demo voice's clip: its Locale, line and native format.

    ``state`` is ``"bound"`` when the voice has a binding, so a clip is
    possible, and ``"open"`` when the binding table refuses it. An open row
    keeps the Locale and the refusal so nothing is dropped or re-cast to
    another Locale.
    """

    voice_id: str
    locale: str
    language: str
    greeting: str
    state: str
    asset: str | None
    reason: str | None = None

    @property
    def bound(self) -> bool:
        return self.state == "bound"


def line_sha256(text: str) -> str:
    """The greeting's hash: the manifest's independent check on the line."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def wav_sha256(wav: bytes) -> str:
    """The clip file's pin."""
    return hashlib.sha256(wav).hexdigest()


def clip_plan_for(voice_id: str) -> ClipPlan:
    """One demo voice's plan, or a usage error for a voice outside the demo."""
    if voice_id not in DEMO_VOICE_IDS:
        raise ClipError(
            f'"{voice_id}" is not a demo subject: clips are the six demo voices '
            f"({', '.join(DEMO_VOICE_IDS)})"
        )
    # The Locale is the catalogue's, not the caller's: the binding table owns it.
    catalogue_locale = _catalogue_locale(voice_id)
    greeting = GREETINGS[catalogue_locale]
    try:
        binding = bind_voice(voice_id)
    except UnboundVoiceError as refusal:
        return ClipPlan(
            voice_id=voice_id,
            locale=catalogue_locale,
            language=SPEECH_LANGUAGES[catalogue_locale],
            greeting=greeting,
            state="open",
            asset=None,
            reason=str(refusal),
        )
    if binding.locale.code != catalogue_locale:
        raise ClipError(
            f'voice "{voice_id}" is bound to {binding.locale.code} but the '
            f'catalogue declares {catalogue_locale}: one of the two is wrong'
        )
    return ClipPlan(
        voice_id=voice_id,
        locale=binding.locale.code,
        language=binding.language,
        greeting=greeting,
        state="bound",
        asset=f"{CLIP_ASSET_DIR}/{voice_id}.wav",
    )


def clip_plan() -> list[ClipPlan]:
    """Every demo voice's plan, in the app's order."""
    plans = [clip_plan_for(voice_id) for voice_id in DEMO_VOICE_IDS]
    unknown = {entry.locale for entry in plans} - set(CLIP_LOCALES)
    if unknown:
        raise ClipError(
            f"the demo voices speak {', '.join(sorted(unknown))}, which the clip "
            f"plan does not cover ({', '.join(CLIP_LOCALES)}): add the Locale's "
            "greeting and a binding before rendering it"
        )
    return plans


def _catalogue_locale(voice_id: str) -> str:
    """The voice's declared Locale, from the binding table's own catalogue.

    The Locale is read from the table rather than guessed from the greeting:
    an unknown voice refuses by name. An unbound voice still carries its Locale
    in ``UNBOUND_VOICES``, which is how German stays visible.
    """
    binding = BINDINGS.get(voice_id)
    if binding is not None:
        return binding.locale.code
    unbound = UNBOUND_VOICES.get(voice_id)
    if unbound is not None:
        return unbound.locale.code
    raise ClipError(f'unknown voice "{voice_id}": not in the voice binding table')


def clip_format() -> ReferenceFormat:
    """The call's native format for the clip transport."""
    return ReferenceFormat.for_transport(CLIP_TRANSPORT)


def clip_body(plan: ClipPlan) -> CascadeBody:
    """The body the clip renders from: this voice, this Locale, this greeting."""
    return adapt_body(
        {
            "system_prompt": "You are Voni, a careful voice agent.",
            "greeting": plan.greeting,
            "voice": {"voice_id": plan.voice_id},
            "input": {"language_codes": [plan.locale]},
            "output": {"voice": plan.voice_id},
            "tools": [],
            "llm": [],
        }
    )


@dataclass(frozen=True)
class ClipLevel:
    """The clip's measured level, read from the committed PCM itself.

    Sample peak and RMS, in dBFS over the full 16-bit scale. There is no
    integrated-LUFS meter in the stdlib; these two are exact, deterministic and
    sufficient for the gate that matters here: a gain stage moves them, a
    hand-edited file moves them, and the verbatim synthesis bytes keep them at
    the level the voice spoke.
    """

    sample_peak_dbfs: float
    rms_dbfs: float

    def to_document(self) -> dict[str, float]:
        return {
            "samplePeakDbfs": self.sample_peak_dbfs,
            "rmsDbfs": self.rms_dbfs,
        }


@dataclass(frozen=True)
class ClipRecord:
    """One committed clip and the facts the manifest pins for it."""

    voice: str
    locale: str
    language: str
    line: str
    line_sha256: str
    asset: str
    sha256: str
    audio_bytes: int
    duration_ms: int
    format: Mapping[str, Any]
    endpoint: Mapping[str, str]
    level: ClipLevel
    gain_stage: str
    generated_on: str

    def to_document(self) -> dict[str, Any]:
        return {
            "voice": self.voice,
            "locale": self.locale,
            "language": self.language,
            "line": self.line,
            "lineSha256": self.line_sha256,
            "asset": self.asset,
            "sha256": self.sha256,
            "bytes": self.audio_bytes,
            "durationMs": self.duration_ms,
            "format": dict(self.format),
            "endpoint": dict(self.endpoint),
            "level": self.level.to_document(),
            "gainStage": self.gain_stage,
            "generatedOn": self.generated_on,
        }


def _wav_header(wav: bytes) -> tuple[bytes, int, int]:
    """``(pcm, sample_rate, channels)`` or a named refusal."""
    if len(wav) <= WAV_HEADER_BYTES:
        raise ClipError(f"clip is {len(wav)} bytes: not a WAV with audio in it")
    try:
        (
            riff,
            riff_size,
            wave,
            fmt,
            fmt_size,
            audio_format,
            channels,
            sample_rate,
            _byte_rate,
            _block_align,
            bits,
            data,
            data_bytes,
        ) = struct.unpack("<4sI4s4sIHHIIHH4sI", wav[:WAV_HEADER_BYTES])
    except struct.error as error:
        raise ClipError(f"clip is not a readable WAV header: {error}") from None
    if riff != b"RIFF" or wave != b"WAVE" or fmt != b"fmt " or data != b"data":
        raise ClipError("clip is not a RIFF/WAVE file with a fmt and data chunk")
    if riff_size != len(wav) - 8 or data_bytes != len(wav) - WAV_HEADER_BYTES:
        raise ClipError("clip sizes disagree with its header: a truncated or padded file")
    if fmt_size != 16 or audio_format != 1 or bits != 16:
        raise ClipError(f"clip is not 16-bit integer PCM (format {audio_format}, {bits} bits)")
    if channels < 1 or sample_rate <= 0:
        raise ClipError(f"clip header claims {channels} channel(s) at {sample_rate} Hz")
    return wav[WAV_HEADER_BYTES:], sample_rate, channels


def measure_wav(wav: bytes) -> ClipLevel:
    """The clip's level, measured from its own PCM samples."""
    pcm_bytes, _rate, _channels = _wav_header(wav)
    if len(pcm_bytes) % 2:
        raise ClipError("clip PCM has an odd byte length: not whole 16-bit samples")
    samples = struct.unpack(f"<{len(pcm_bytes) // 2}h", pcm_bytes)
    if not samples:
        raise ClipError("clip has no samples: silence is not a clip")
    peak = max(abs(sample) for sample in samples)
    if peak == 0:
        raise ClipError("clip is digitally silent: a silent clip would lie about the voice")
    mean_square = sum(sample * sample for sample in samples) / len(samples)
    return ClipLevel(
        sample_peak_dbfs=round(20 * math.log10(peak / 32768), 6),
        rms_dbfs=round(20 * math.log10(math.sqrt(mean_square) / 32768), 6),
    )


async def render_clip(
    plan: ClipPlan,
    *,
    out_dir: str | os.PathLike[str],
    asset_root: str | os.PathLike[str],
    api_key: str | None = None,
    socket_factory: SocketFactory | None = None,
    clock: Callable[[], float] | None = None,
    generated_on: str | None = None,
) -> ClipRecord:
    """Render one clip through the call's own client and write its asset.

    The synthesis is :func:`cascade.reference_render.render_reference`, so the
    endpoint, voice binding, transport format and greeting path are the call's
    and the bytes are written verbatim. An open Locale refuses by name: it has
    no voice to render, and a clip borrowed from another voice would be a lie.
    """
    if not plan.bound or plan.asset is None:
        raise ClipError(
            f'voice "{plan.voice_id}" ({plan.locale}) has no clip: {plan.reason}'
        )
    if not api_key and not os.environ.get("ASSEMBLYAI_API_KEY") and socket_factory is None:
        raise ClipError(
            "ASSEMBLYAI_API_KEY is not configured: a clip is rendered by live "
            "synthesis only, so this voice is blocked rather than fabricated"
        )

    fmt = clip_format()
    rendered = await render_reference(
        clip_body(plan),
        out_dir=out_dir,
        transport=CLIP_TRANSPORT,
        api_key=api_key,
        socket_factory=socket_factory,
        clock=clock,
    )
    if rendered.format.to_document() != fmt.to_document():
        raise ClipError(
            f'the render came back as {rendered.format.to_document()}, not the call\'s '
            f"native {fmt.to_document()}"
        )

    wav = _read_bytes(rendered.path)
    pcm_bytes, sample_rate, channels = _wav_header(wav)
    level = measure_wav(wav)

    asset_path = Path(asset_root) / plan.asset
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    asset_path.write_bytes(wav)
    asset_path.chmod(0o644)

    return ClipRecord(
        voice=plan.voice_id,
        locale=plan.locale,
        language=plan.language,
        line=plan.greeting,
        line_sha256=line_sha256(plan.greeting),
        asset=plan.asset,
        sha256=wav_sha256(wav),
        audio_bytes=len(pcm_bytes),
        duration_ms=round(len(pcm_bytes) / (channels * 2) / sample_rate * 1000),
        format=fmt.to_document(),
        endpoint={"url": TTS_BASE_URL, "model": MODEL_ID},
        level=level,
        gain_stage=NATIVE_GAIN_STAGE,
        generated_on=generated_on or date.today().isoformat(),
    )


def _read_bytes(path: str | os.PathLike[str]) -> bytes:
    try:
        return Path(path).read_bytes()
    except OSError as error:
        raise ClipError(f"the rendered clip at {path} is not readable: {error}") from None


def _clip_endpoint() -> dict[str, str]:
    return {"url": TTS_BASE_URL, "model": MODEL_ID}


@dataclass(frozen=True)
class ClipBlocker:
    """A bound voice that could not be rendered now, with the reason and remedy.

    A blocker is not a clip and not an open Locale: the voice speaks a bound
    Locale but today's render failed, so no asset is kept and the row says why.
    """

    voice: str
    locale: str
    reason: str
    command: str

    def to_document(self) -> dict[str, str]:
        return {
            "voice": self.voice,
            "locale": self.locale,
            "reason": self.reason,
            "command": self.command,
        }


def clip_pending_command(voice_id: str) -> str:
    """The exact command another operator runs to finish this voice."""
    return f"{CLIP_GENERATOR_COMMAND} --voice {voice_id}"


async def render_all(
    root: str | os.PathLike[str],
    *,
    out_dir: str | os.PathLike[str],
    api_key: str | None = None,
    socket_factory: SocketFactory | None = None,
    clock: Callable[[], float] | None = None,
    generated_on: str | None = None,
    render: Callable[..., Any] = render_clip,
    voices: Sequence[str] | None = None,
) -> tuple[list[ClipRecord], list[ClipBlocker]]:
    """Render every bound demo voice into ``root``; keep every row honest.

    Runs before a socket opens: with no key and no injected socket, the whole
    run is blocked by name and writes nothing — no manifest, no asset. A voice
    whose render fails loses its old asset and becomes a blocker row rather
    than standing in as audio nobody can vouch for. An open Locale is never
    rendered, and any old file under its name is retired.
    """
    root_path = Path(root)
    configured = (api_key or "").strip() or os.environ.get("ASSEMBLYAI_API_KEY", "")
    if not configured and socket_factory is None:
        raise ClipError(
            "ASSEMBLYAI_API_KEY is not configured: clips are rendered by live "
            "synthesis only, so every voice is blocked rather than fabricated. "
            "Tests replay recorded synthesis fixtures and need no key."
        )

    requested = None if voices is None else set(voices)
    records: list[ClipRecord] = []
    blockers: list[ClipBlocker] = []
    for plan in clip_plan():
        if not plan.bound or (requested is not None and plan.voice_id not in requested):
            continue
        try:
            record = await render(
                plan,
                out_dir=out_dir,
                asset_root=root_path,
                api_key=configured or None,
                socket_factory=socket_factory,
                clock=clock,
                generated_on=generated_on,
            )
        except Exception as error:  # one voice's failure is a row, not a crash
            if plan.asset is not None:
                (root_path / plan.asset).unlink(missing_ok=True)
            blockers.append(
                ClipBlocker(
                    voice=plan.voice_id,
                    locale=plan.locale,
                    reason=str(error) or error.__class__.__name__,
                    command=clip_pending_command(plan.voice_id),
                )
            )
            continue
        records.append(record)

    # The producer is authoritative: a file no plan asks for is a hand capture,
    # and an open Locale's old clip is retired rather than kept as a fallback.
    # A one-voice run only cleans up after itself; the full run is the sweep.
    planned = {record.asset for record in records} if requested is None else None
    asset_dir = root_path / CLIP_ASSET_DIR
    if planned is not None and asset_dir.is_dir():
        for stale in asset_dir.glob("*.wav"):
            relative = stale.relative_to(root_path).as_posix()
            if relative not in planned:
                stale.unlink(missing_ok=True)
    return records, blockers


def clip_record_problems(plan: ClipPlan, record: ClipRecord) -> list[str]:
    """Every way ``record`` is not this plan's clip, named. Empty means it is.

    The checks are the identity a clip must keep: the voice, its own Locale, the
    vendor language the binding sends, the greeting the call speaks, the call's
    native format, the call's endpoint and model, native level, and the sha256
    of the file the record claims. A clip from another voice can match none of
    these silently.
    """
    if not plan.bound or plan.asset is None:
        return [f'voice "{plan.voice_id}" ({plan.locale}) is open and cannot carry a clip']

    problems: list[str] = []
    if record.voice != plan.voice_id:
        problems.append(f"clip is for voice {record.voice}, not {plan.voice_id}")
    if record.locale != plan.locale:
        problems.append(
            f'clip speaks {record.locale or "no Locale"}, not the voice\'s own Locale {plan.locale}'
        )
    if record.language != plan.language:
        problems.append(
            f'clip asks the vendor for "{record.language}", not "{plan.language}"'
        )
    if record.line != plan.greeting:
        problems.append(
            f'clip line is "{record.line[:40]}…", not the greeting the call speaks '
            f'"{plan.greeting[:40]}…"'
        )
    if record.line_sha256 != line_sha256(plan.greeting):
        problems.append(f"clip line hash is not the {plan.locale} greeting's hash")
    if record.asset != plan.asset:
        problems.append(f"clip asset {record.asset} is not {plan.asset}")

    expected_format = clip_format().to_document()
    if dict(record.format) != expected_format:
        problems.append(
            f"clip format {dict(record.format)} is not the call's native {expected_format}"
        )
    if dict(record.endpoint) != _clip_endpoint():
        problems.append(
            f'clip endpoint {dict(record.endpoint)} is not the call\'s {_clip_endpoint()}'
        )
    if record.gain_stage != NATIVE_GAIN_STAGE:
        problems.append(
            f'clip declares a gain stage "{record.gain_stage}": the cascade carries no '
            "output.volume, gain, limiter or normalisation"
        )
    if not math.isfinite(record.level.sample_peak_dbfs) or not math.isfinite(
        record.level.rms_dbfs
    ):
        problems.append("clip level was not measured, so native level is unproven")
        return problems
    if record.level.sample_peak_dbfs >= 0:
        problems.append(
            f"clip peaks at {record.level.sample_peak_dbfs} dBFS: a native render "
            "does not reach full scale"
        )
    return problems


def manifest_document(
    records: Sequence[ClipRecord],
    *,
    blockers: Sequence["ClipBlocker"] = (),
    generated_on: str | None = None,
) -> dict[str, Any]:
    """The committed manifest: what each clip is, plus every open Locale.

    The header pins the endpoint, model and native format once; each clip
    restates them because a clip is audited on its own. An open Locale is a
    row, not a clip: it carries the binding's refusal and the app's line, so
    the Locale stays visible without audio being borrowed from another voice.
    A voice that could not be rendered now is a blocker row with its reason,
    never a stale clip.
    """
    plan = {entry.voice_id: entry for entry in clip_plan()}
    clips: list[dict[str, Any]] = []
    seen: set[str] = set()
    for record in records:
        if record.voice in seen:
            raise ClipError(
                f'voice "{record.voice}" has two clip records: one voice has one clip'
            )
        seen.add(record.voice)
        if record.voice not in plan:
            raise ClipError(f'clip for "{record.voice}", which is not a demo subject')
        clips.append(record.to_document())

    open_rows = [
        {
            "voice": entry.voice_id,
            "locale": entry.locale,
            "language": entry.language,
            "line": entry.greeting,
            "lineSha256": line_sha256(entry.greeting),
            "state": entry.state,
            "reason": entry.reason,
        }
        for entry in plan.values()
        if not entry.bound
    ]

    return {
        "schemaVersion": CLIP_MANIFEST_SCHEMA_VERSION,
        "generatedOn": generated_on or date.today().isoformat(),
        "command": CLIP_GENERATOR_COMMAND,
        "source": (
            "direct synthesis through the call's own AssemblyAIStreamingTTS and "
            "voice binding (cascade.reference_render), native level: no "
            "output.volume, gain, limiter or normalisation"
        ),
        "endpoint": _clip_endpoint(),
        "format": clip_format().to_document(),
        "gainStage": NATIVE_GAIN_STAGE,
        "clips": clips,
        "open": open_rows,
        "blockers": [blocker.to_document() for blocker in blockers],
    }


@dataclass(frozen=True)
class ManifestAudit:
    """The manifest's named problems and the rows it covers."""

    problems: tuple[str, ...]
    clip_count: int
    open_count: int
    blocker_count: int = 0

    @property
    def ok(self) -> bool:
        return not self.problems


def _as_mapping(value: Any) -> dict[str, Any]:
    """A document field as a mapping; a malformed one is an empty mapping."""
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def clip_record_from_document(document: Mapping[str, Any]) -> ClipRecord:
    """A manifest row as the record type the shared clip validator reads."""
    level = document["level"]
    return ClipRecord(
        voice=document["voice"],
        locale=document["locale"],
        language=document["language"],
        line=document["line"],
        line_sha256=document["lineSha256"],
        asset=document["asset"],
        sha256=document["sha256"],
        audio_bytes=int(document["bytes"]),
        duration_ms=int(document["durationMs"]),
        format=document["format"],
        endpoint=document["endpoint"],
        level=ClipLevel(
            sample_peak_dbfs=float(level["samplePeakDbfs"]),
            rms_dbfs=float(level["rmsDbfs"]),
        ),
        gain_stage=document["gainStage"],
        generated_on=document["generatedOn"],
    )


def _asset_problems(
    plan: ClipPlan, record: ClipRecord, asset_root: str | os.PathLike[str]
) -> list[str]:
    """What only the committed bytes can answer: is this the clip it claims?"""
    path = Path(asset_root) / record.asset
    if not path.is_file():
        return [f"{record.asset} is recorded but not committed"]
    wav = path.read_bytes()
    problems: list[str] = []
    if wav_sha256(wav) != record.sha256:
        problems.append(
            f"{record.asset} sha256 is {wav_sha256(wav)}, not the recorded "
            f"{record.sha256}: the file was edited or swapped"
        )
    try:
        pcm_bytes, sample_rate, channels = _wav_header(wav)
        measured = measure_wav(wav)
    except ClipError as error:
        return [*problems, f"{record.asset} is not a readable native clip: {error}"]
    expected_format = clip_format()
    if sample_rate != expected_format.sample_rate:
        problems.append(
            f"{record.asset} is {sample_rate} Hz, not the recorded {expected_format.sample_rate} Hz"
        )
    if channels != expected_format.channels:
        problems.append(
            f"{record.asset} has {channels} channel(s), not {expected_format.channels}"
        )
    measured_duration_ms = round(
        len(pcm_bytes) / (channels * (expected_format.bits_per_sample // 8)) / sample_rate * 1000
    )
    if measured_duration_ms != record.duration_ms:
        problems.append(
            f"{record.asset} lasts {measured_duration_ms} ms, not the recorded {record.duration_ms} ms"
        )
    if measured.to_document() != record.level.to_document():
        problems.append(
            f"{record.asset} measures {measured.to_document()}, not the recorded "
            f"{record.level.to_document()}: a level stage moved it"
        )
    return problems


def audit_manifest(
    manifest: Mapping[str, Any], *, asset_root: str | os.PathLike[str]
) -> ManifestAudit:
    """Audit a committed manifest against the plan and the committed bytes.

    One gate owns the whole claim: every bound voice has exactly one clip, every
    open Locale is a named row with no clip, no row is for a voice outside the
    plan, and each clip's bytes are the format, level and sha256 it records.
    """
    problems: list[str] = []
    plan = {entry.voice_id: entry for entry in clip_plan()}

    expected_endpoint = _clip_endpoint()
    document_endpoint = manifest.get("endpoint")
    if _as_mapping(document_endpoint) != expected_endpoint:
        problems.append(
            f"manifest endpoint {document_endpoint} is not the call's {expected_endpoint}"
        )
    expected_format = clip_format().to_document()
    document_format = manifest.get("format")
    if _as_mapping(document_format) != expected_format:
        problems.append(
            f"manifest format {document_format} is not the call's native {expected_format}"
        )
    if manifest.get("gainStage") != NATIVE_GAIN_STAGE:
        problems.append(
            f'manifest declares gainStage "{manifest.get("gainStage")}": the cascade '
            "carries no gain stage"
        )

    clips = manifest.get("clips") or []
    open_rows = manifest.get("open") or []
    blocker_rows = manifest.get("blockers") or []
    for name, rows in (("clips", clips), ("open", open_rows), ("blockers", blocker_rows)):
        if not isinstance(rows, list):
            problems.append(f"manifest {name} is not a list of rows")
    if not isinstance(clips, list):
        clips = []
    if not isinstance(open_rows, list):
        open_rows = []
    if not isinstance(blocker_rows, list):
        blocker_rows = []
    covered: dict[str, int] = {}

    for document in clips:
        try:
            record = clip_record_from_document(document)
        except (KeyError, TypeError, ValueError) as error:
            problems.append(f"clip record is missing a pinned field: {error}")
            continue
        covered[record.voice] = covered.get(record.voice, 0) + 1
        entry = plan.get(record.voice)
        if entry is None:
            problems.append(
                f'clip for voice "{record.voice}", which is not one of the six demo voices'
            )
            continue
        if not entry.bound:
            problems.append(
                f'voice "{record.voice}" ({entry.locale}) is open: {entry.reason}; '
                "a clip is never sourced from another voice and never invented"
            )
            continue
        for problem in clip_record_problems(entry, record):
            problems.append(f"{record.voice}: {problem}")
        for problem in _asset_problems(entry, record, asset_root):
            problems.append(f"{record.voice}: {problem}")

    for row in open_rows:
        if not isinstance(row, Mapping):
            problems.append(f"open row {row!r} is not an object")
            continue
        voice = row.get("voice")
        entry = plan.get(voice)
        if entry is None:
            problems.append(f'open row for "{voice}", which is not a demo voice')
            continue
        covered[voice] = covered.get(voice, 0) + 1
        if entry.bound:
            problems.append(
                f'open row for "{voice}", which is bound to {entry.locale}: a bound '
                "voice is a clip, not an open Locale"
            )
            continue
        if row.get("locale") != entry.locale:
            problems.append(
                f'open row for "{voice}" names {row.get("locale")}, not its own Locale {entry.locale}'
            )
        if row.get("language") != entry.language:
            problems.append(
                f'open row for "{voice}" names language "{row.get("language")}", not "{entry.language}"'
            )
        if row.get("line") != entry.greeting:
            problems.append(f'open row for "{voice}" is not the greeting the call speaks')
        if not str(row.get("reason") or "").strip():
            problems.append(f'open row for "{voice}" has no named blocker')
        if (Path(asset_root) / f"{CLIP_ASSET_DIR}/{voice}.wav").exists():
            problems.append(
                f'open row for "{voice}" has a committed asset: an open Locale keeps no clip'
            )

    for row in blocker_rows:
        if not isinstance(row, Mapping):
            problems.append(f"blocker row {row!r} is not an object")
            continue
        voice = row.get("voice")
        entry = plan.get(voice)
        if entry is None:
            problems.append(f'blocker row for "{voice}", which is not a demo voice')
            continue
        covered[voice] = covered.get(voice, 0) + 1
        if not entry.bound:
            problems.append(
                f'blocker row for "{voice}" ({entry.locale}), which is an open Locale: '
                "an open Locale is a plan row, not a render failure"
            )
            continue
        if not str(row.get("reason") or "").strip():
            problems.append(f'blocker row for "{voice}" has no named reason')
        if row.get("command") != clip_pending_command(voice):
            problems.append(
                f'blocker row for "{voice}" is not the exact command to run '
                f"({clip_pending_command(voice)})"
            )
        if entry.asset is not None and (Path(asset_root) / entry.asset).exists():
            problems.append(
                f'blocker row for "{voice}" has a committed asset: a blocked voice '
                "keeps no clip"
            )

    for entry in plan.values():
        if covered.get(entry.voice_id, 0) > 1:
            problems.append(
                f'voice "{entry.voice_id}" is recorded {covered[entry.voice_id]} times: '
                "one voice has one clip"
            )
        if covered.get(entry.voice_id, 0) == 0:
            if entry.bound:
                problems.append(
                    f'voice "{entry.voice_id}" ({entry.locale}) has no clip and no '
                    "named blocker: it is neither rendered nor visibly blocked"
                )
            else:
                problems.append(
                    f'voice "{entry.voice_id}" ({entry.locale}) has no named open row: '
                    "an open Locale is recorded, never dropped"
                )

    return ManifestAudit(
        problems=tuple(problems),
        clip_count=len(clips),
        open_count=len(open_rows),
        blocker_count=len(blocker_rows),
    )

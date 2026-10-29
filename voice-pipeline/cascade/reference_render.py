"""The W0 reference: one line, rendered by the call's own synthesis client.

A cascade call has no platform recording, so W0 judges two captures: a
*reference* and the *delivered* audio. The reference is not a recording of a
call and not a preview: it is a direct synthesis of the one line the call is
supposed to say, through the same client and the same binding table the call
uses, with no STT, no LLM, no browser and no platform in the path.

The pieces are deliberately the call's own, not copies:

- the voice and the vendor language come from
  :func:`cascade.voice_binding.bind_voice`, through the adapted
  :class:`cascade.body_map.CascadeBody`;
- the sample rate and encoding come from the transport table in
  :mod:`cascade.assemblyai_tts`, so the browser reference is 24 kHz
  ``pcm_s16le`` exactly like the call;
- the line is spoken through :class:`cascade.greeting.CallGreeting`, the same
  greeting path the call opens with (one ``Generate`` + ``Flush`` per
  sentence, first sentence flushed immediately).

The default line is the body's greeting, because that is the sentence that
separates "broken from the first word" from "breaks once the model speaks".
``text=`` renders another sentence as its own reference for a mid-call defect.

Native level by construction: the synthesis bytes are written verbatim. There
is no gain, no limiter and no normalisation stage, because a reference with
our processing in it would measure our processing instead of the voice.

The cache is keyed by voice, locale, text and format, so a rerun is free and
byte-identical, and a changed voice, line or format is a new file rather than a
stale hit. ``sha256`` is the pin the artifact carries; the WAV itself is a
gitignored working file and never evidence.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

from cascade.assemblyai_tts import (
    MODEL_ID,
    AssemblyAIStreamingTTS,
    SocketFactory,
    transport_format,
)
from cascade.body_map import CascadeBody
from cascade.greeting import CallGreeting
from metrics import TimingLedger

#: The WAV container every reference uses: standard 44-byte PCM16 header.
WAV_HEADER_BYTES = 44
REFERENCE_CONTAINER = "wav"
REFERENCE_CHANNELS = 1
REFERENCE_BITS_PER_SAMPLE = 16

#: The only encoding the W0 comparison reads. The browser capture is PCM16;
#: a mu-law phone capture has no two-capture profile yet, so it is refused by
#: name rather than written as an asset the comparison cannot read.
COMPARABLE_ENCODING = "pcm_s16le"

#: Domain separator in the cache key, so a cascade reference can never collide
#: with the managed path's voice+text reference cache.
CACHE_TAG = "cascade"


class ReferenceRenderError(RuntimeError):
    """The reference cannot be rendered, and the reason is named."""


class MissingReferenceLine(ReferenceRenderError):
    """There is no line to render: a silent reference would be a lie."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"reference render needs a line to synthesize: {reason}; a silent "
            "or guessed reference would blame the greeting for a sentence it "
            "never spoke"
        )


class UnsupportedReferenceFormat(ReferenceRenderError):
    """The transport's synthesis format is not one the comparison can read."""

    def __init__(self, transport: str, sample_rate: int, encoding: str) -> None:
        self.transport = transport
        self.sample_rate = sample_rate
        self.encoding = encoding
        super().__init__(
            f'reference render refuses transport "{transport}" ({sample_rate} Hz '
            f"{encoding}): the W0 two-capture profile is the browser capture and "
            f"reads {COMPARABLE_ENCODING} only; a {encoding} reference has no "
            "delivered capture to compare against"
        )


class EmptyReference(ReferenceRenderError):
    """The synthesis path completed without a single audio frame."""

    def __init__(self, voice_id: str, text: str) -> None:
        self.voice_id = voice_id
        self.text = text
        super().__init__(
            f'no audio was rendered for voice "{voice_id}" line {text!r}: a '
            "reference that is never flushed is a bug, not a silent reference"
        )


@dataclass(frozen=True)
class ReferenceFormat:
    """The synthesis format the reference was rendered in.

    Every field is part of the cache identity: a reference at another rate,
    encoding, container or model is a different file, never a stale hit.
    """

    transport: str
    sample_rate: int
    encoding: str
    model_id: str
    container: str = REFERENCE_CONTAINER
    channels: int = REFERENCE_CHANNELS
    bits_per_sample: int = REFERENCE_BITS_PER_SAMPLE

    @classmethod
    def for_transport(cls, transport: str) -> "ReferenceFormat":
        """The call's format for this transport, or a named refusal.

        ``transport_format`` is the call's own table (ticket 47), so the
        reference cannot invent a rate or codec the call does not use.
        """
        fmt = transport_format(transport)
        if fmt.encoding != COMPARABLE_ENCODING:
            raise UnsupportedReferenceFormat(
                fmt.transport, fmt.sample_rate, fmt.encoding
            )
        return cls(
            transport=fmt.transport,
            sample_rate=fmt.sample_rate,
            encoding=fmt.encoding,
            model_id=MODEL_ID,
        )

    def to_document(self) -> dict[str, object]:
        return {
            "transport": self.transport,
            "container": self.container,
            "sampleRate": self.sample_rate,
            "encoding": self.encoding,
            "channels": self.channels,
            "bitsPerSample": self.bits_per_sample,
            "model": self.model_id,
        }


@dataclass(frozen=True)
class ReferenceRender:
    """One rendered reference: the line, its format, its file and its pin."""

    voice_id: str
    locale: str
    text: str
    format: ReferenceFormat
    path: str
    sha256: str
    cached: bool
    audio_bytes: int
    duration_ms: int

    def to_document(self) -> dict[str, object]:
        """What the artifact carries: the path and the hash, never the audio."""
        return {
            "voice": self.voice_id,
            "locale": self.locale,
            "text": self.text,
            "format": self.format.to_document(),
            "path": self.path,
            "sha256": self.sha256,
            "bytes": self.audio_bytes,
            "durationMs": self.duration_ms,
            "cached": self.cached,
        }


def reference_key(voice_id: str, text: str, fmt: ReferenceFormat) -> str:
    """Cache identity: voice, locale-bearing text and the whole format."""
    parts = (
        CACHE_TAG,
        voice_id,
        fmt.transport,
        str(fmt.sample_rate),
        fmt.encoding,
        fmt.model_id,
        fmt.container,
        str(fmt.channels),
        str(fmt.bits_per_sample),
        text,
    )
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def reference_path(
    directory: str | os.PathLike[str], voice_id: str, text: str, fmt: ReferenceFormat
) -> Path:
    return Path(directory) / f"{voice_id}-{reference_key(voice_id, text, fmt)[:16]}.wav"


def default_reference_dir() -> Path:
    """``voni/.voice-references/`` — a gitignored working directory."""
    return Path(__file__).resolve().parents[2] / "voni" / ".voice-references"


def pcm16_wav(pcm: bytes, fmt: ReferenceFormat) -> bytes:
    """A standard 44-byte-header PCM16 WAV with the samples written verbatim."""
    if fmt.channels != REFERENCE_CHANNELS:
        raise ValueError(f"reference WAV is mono, got {fmt.channels} channels")
    if fmt.bits_per_sample != REFERENCE_BITS_PER_SAMPLE:
        raise ValueError(
            f"reference WAV is 16-bit, got {fmt.bits_per_sample} bits per sample"
        )
    if len(pcm) % 2:
        raise ValueError(f"PCM16 needs an even byte length, got {len(pcm)}")

    byte_rate = fmt.sample_rate * fmt.channels * (fmt.bits_per_sample // 8)
    block_align = fmt.channels * (fmt.bits_per_sample // 8)
    header = bytearray(WAV_HEADER_BYTES)
    header[0:4] = b"RIFF"
    header[4:8] = (WAV_HEADER_BYTES - 8 + len(pcm)).to_bytes(4, "little")
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    header[16:20] = (16).to_bytes(4, "little")
    header[20:22] = (1).to_bytes(2, "little")  # integer PCM
    header[22:24] = fmt.channels.to_bytes(2, "little")
    header[24:28] = fmt.sample_rate.to_bytes(4, "little")
    header[28:32] = byte_rate.to_bytes(4, "little")
    header[32:34] = block_align.to_bytes(2, "little")
    header[34:36] = fmt.bits_per_sample.to_bytes(2, "little")
    header[36:40] = b"data"
    header[40:44] = len(pcm).to_bytes(4, "little")
    return bytes(header) + pcm


def _line_for(body: CascadeBody, text: str | None) -> str:
    """The line to render: an explicit sentence, or the body's greeting."""
    if text is not None:
        line = text.strip()
        if not line:
            raise MissingReferenceLine("the requested text is blank")
        return line
    line = body.greeting
    if not line.strip():
        raise MissingReferenceLine(
            "the body has no greeting; pass text= to render a mid-call sentence"
        )
    return line


def _cached_reference(path: Path, fmt: ReferenceFormat) -> bytes | None:
    """The cached WAV, or ``None`` when the file is not this reference.

    A truncated, foreign or wrong-format file is not a cache hit: re-render
    rather than hand the comparison audio that is not this line in this voice.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if len(raw) <= WAV_HEADER_BYTES:
        return None
    if raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE" or raw[12:16] != b"fmt ":
        return None
    if raw[36:40] != b"data":
        return None
    if int.from_bytes(raw[4:8], "little") != len(raw) - 8:
        return None
    if int.from_bytes(raw[20:22], "little") != 1:  # integer PCM
        return None
    if int.from_bytes(raw[22:24], "little") != fmt.channels:
        return None
    if int.from_bytes(raw[24:28], "little") != fmt.sample_rate:
        return None
    if int.from_bytes(raw[34:36], "little") != fmt.bits_per_sample:
        return None
    data_bytes = int.from_bytes(raw[40:44], "little")
    if data_bytes == 0 or WAV_HEADER_BYTES + data_bytes != len(raw):
        return None
    return raw


async def render_reference(
    body: CascadeBody,
    *,
    text: str | None = None,
    out_dir: str | os.PathLike[str] | None = None,
    transport: str = "browser",
    api_key: str | None = None,
    socket_factory: SocketFactory | None = None,
    clock: Callable[[], float] | None = None,
) -> ReferenceRender:
    """Render (or reuse) one reference for ``body``'s voice.

    The synthesis is the call's: the same :class:`AssemblyAIStreamingTTS`, the
    same binding, the same greeting path and the same transport format. The
    only injected dependencies are the test kit's socket factory and clock, so
    a test replays recorded frames and never opens a socket.
    """
    line = _line_for(body, text)
    fmt = ReferenceFormat.for_transport(transport)
    directory = default_reference_dir() if out_dir is None else Path(out_dir)
    path = reference_path(directory, body.voice_id, line, fmt)

    existing = _cached_reference(path, fmt)
    if existing is not None:
        pcm = existing[WAV_HEADER_BYTES:]
        return ReferenceRender(
            voice_id=body.voice_id,
            locale=body.language_code,
            text=line,
            format=fmt,
            path=str(path),
            sha256=hashlib.sha256(existing).hexdigest(),
            cached=True,
            audio_bytes=len(pcm),
            duration_ms=round(
                len(pcm) / (fmt.channels * (fmt.bits_per_sample // 8)) / fmt.sample_rate * 1000
            ),
        )

    tts = AssemblyAIStreamingTTS(
        voice_id=body.voice_id,
        transport=fmt.transport,
        api_key=api_key,
        socket_factory=socket_factory,
        clock=clock,
    )
    chunks: list[bytes] = []

    def sink(audio) -> None:
        chunks.append(audio.pcm)

    ledger = TimingLedger(now=clock) if clock is not None else TimingLedger()
    greeting = CallGreeting(voice=tts, ledger=ledger, sink=sink)

    await tts.open()
    try:
        outcome = await greeting.speak(replace(body, greeting=line))
        record = await tts.terminate()
    except BaseException:
        await tts.close()
        raise

    if outcome.sample_rate != fmt.sample_rate:
        raise ReferenceRenderError(
            f"the session spoke at {outcome.sample_rate} Hz, not the requested "
            f"{fmt.sample_rate} Hz: a reference at another rate is a different file"
        )

    pcm = b"".join(chunks) + record.residual_audio
    if not pcm:
        raise EmptyReference(body.voice_id, line)

    wav = pcm16_wav(pcm, fmt)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(wav)
    path.chmod(0o600)
    return ReferenceRender(
        voice_id=body.voice_id,
        locale=body.language_code,
        text=line,
        format=fmt,
        path=str(path),
        sha256=hashlib.sha256(wav).hexdigest(),
        cached=False,
        audio_bytes=len(pcm),
        duration_ms=round(
            len(pcm) / (fmt.channels * (fmt.bits_per_sample // 8)) / fmt.sample_rate * 1000
        ),
    )

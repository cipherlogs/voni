"""The 20 s caller fixture for the latency spike (M00).

One mono 24 kHz 16-bit PCM WAV with a known speech-end sample, plus a sidecar
carrying its sha256, shape and provenance. The WAV is gitignored working data
(``voice-pipeline/.spike/``); the sidecar is the committed artifact, because a
gate that points at an unrecorded regenerated file is a gate that cannot fail.

The audio is synthesized offline with stdlib ``wave`` only: a voiced harmonic
syllable pattern, not human speech. That is enough to exercise endpointing and
keeps the bytes reproducible on any machine; a live run may swap in a human
clip only by regenerating the sidecar from that clip.
"""

from __future__ import annotations

import argparse
import array
import functools
import hashlib
import io
import json
import math
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Union

SAMPLE_RATE = 24_000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2
ENCODING = "pcm_s16le"

DEFAULT_SECONDS = 20.0
DEFAULT_SPEECH_START_S = 0.4
DEFAULT_SPEECH_END_S = 12.4

FIXTURE_NAME = "caller-20s"
SIDECAR_VERSION = 1
WAV_NAME = f"{FIXTURE_NAME}.wav"
AUDIO_DIRNAME = ".spike"

_HERE = Path(__file__).resolve().parent
SIDECAR_PATH = _HERE / "fixtures" / f"{FIXTURE_NAME}.json"

PROVENANCE = {
    "source": (
        "synthesized offline by spike.fixture: voiced harmonic syllable pattern, "
        "no human or vendor audio"
    ),
    "created": "2026-10-29",
    "reproduce": "cd voice-pipeline && python -m spike.fixture --write",
}


class FixtureDrift(RuntimeError):
    """The audio on disk and the committed sidecar disagree."""


@dataclass(frozen=True)
class WavFacts:
    pcm: bytes
    sample_rate: int
    channels: int
    sample_width_bytes: int
    frame_count: int

    @property
    def duration_s(self) -> float:
        return self.frame_count / self.sample_rate


def default_audio_path() -> Path:
    return _HERE.parent / AUDIO_DIRNAME / WAV_NAME


@functools.lru_cache(maxsize=4)
def render_pcm(
    seconds: float = DEFAULT_SECONDS,
    speech_end_s: float = DEFAULT_SPEECH_END_S,
    speech_start_s: float = DEFAULT_SPEECH_START_S,
    sample_rate: int = SAMPLE_RATE,
) -> bytes:
    """Render raw s16le PCM: silence, speech, then silence to the end."""
    frame_count = int(round(seconds * sample_rate))
    start_sample = int(round(speech_start_s * sample_rate))
    end_sample = int(round(speech_end_s * sample_rate))
    if not 0 <= start_sample < end_sample < frame_count:
        raise ValueError(
            "fixture needs 0 <= speech_start < speech_end < seconds; "
            f"got {speech_start_s}/{speech_end_s}/{seconds}"
        )

    samples = array.array("h", [0]) * frame_count
    fundamental = 143.0
    for index in range(start_sample, end_sample + 1):
        t = index / sample_rate
        carrier = (
            math.sin(2 * math.pi * fundamental * t)
            + 0.5 * math.sin(2 * math.pi * 2 * fundamental * t)
            + 0.25 * math.sin(2 * math.pi * 3 * fundamental * t)
        ) / 1.75
        syllable = 0.25 + 0.75 * (0.5 + 0.5 * math.sin(2 * math.pi * 4.0 * t))
        tremolo = 0.55 + 0.45 * math.sin(2 * math.pi * 3.1 * t)
        value = int(round(32_767 * 0.35 * syllable * tremolo * carrier))
        samples[index] = max(-32_768, min(32_767, value))

    if samples[end_sample] == 0:
        # A harmonic carrier passes through zero at some instants. Pin the last
        # speech sample to one LSB (inaudible) so the requested end is always
        # the last non-silent sample, for any --speech-end.
        samples[end_sample] = 1

    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes()


def wav_from_pcm(
    pcm: bytes,
    sample_rate: int = SAMPLE_RATE,
    channels: int = CHANNELS,
    sample_width_bytes: int = SAMPLE_WIDTH_BYTES,
) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(sample_width_bytes)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm)
    return buffer.getvalue()


@functools.lru_cache(maxsize=4)
def build_wav(
    seconds: float = DEFAULT_SECONDS,
    speech_end_s: float = DEFAULT_SPEECH_END_S,
    speech_start_s: float = DEFAULT_SPEECH_START_S,
    sample_rate: int = SAMPLE_RATE,
) -> bytes:
    return wav_from_pcm(
        render_pcm(seconds, speech_end_s, speech_start_s, sample_rate), sample_rate
    )


def unpack_pcm(pcm: bytes) -> array.array:
    samples = array.array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _source_bytes(source: Union[bytes, bytearray, str, Path]) -> bytes:
    if isinstance(source, (bytes, bytearray)):
        return bytes(source)
    return Path(source).read_bytes()


def read_wav(source: Union[bytes, bytearray, str, Path]) -> WavFacts:
    raw = _source_bytes(source)
    with wave.open(io.BytesIO(raw), "rb") as reader:
        channels = reader.getnchannels()
        sample_width_bytes = reader.getsampwidth()
        sample_rate = reader.getframerate()
        frame_count = reader.getnframes()
        pcm = reader.readframes(frame_count)
    return WavFacts(
        pcm=pcm,
        sample_rate=sample_rate,
        channels=channels,
        sample_width_bytes=sample_width_bytes,
        frame_count=frame_count,
    )


def first_speech_sample(pcm: bytes) -> int:
    for index, sample in enumerate(unpack_pcm(pcm)):
        if sample != 0:
            return index
    return -1


def last_speech_sample(pcm: bytes) -> int:
    samples = unpack_pcm(pcm)
    for index in range(len(samples) - 1, -1, -1):
        if samples[index] != 0:
            return index
    return -1


def _speech_end_ms(sample: int, sample_rate: int) -> float:
    return round(sample / sample_rate * 1000.0, 3)


def build_sidecar(wav: bytes) -> dict[str, Any]:
    facts = read_wav(wav)
    end_sample = last_speech_sample(facts.pcm)
    start_sample = first_speech_sample(facts.pcm)
    return {
        "fixture": FIXTURE_NAME,
        "version": SIDECAR_VERSION,
        "sha256": hashlib.sha256(wav).hexdigest(),
        "wav": WAV_NAME,
        "encoding": ENCODING,
        "sample_rate": facts.sample_rate,
        "channels": facts.channels,
        "sample_width_bytes": facts.sample_width_bytes,
        "frame_count": facts.frame_count,
        "duration_s": round(facts.duration_s, 6),
        "speech_start_sample": start_sample,
        "speech_end_sample": end_sample,
        "speech_end_ms": _speech_end_ms(end_sample, facts.sample_rate),
        "provenance": dict(PROVENANCE),
    }


def sidecar_text(sidecar: dict[str, Any]) -> str:
    return json.dumps(sidecar, indent=2, sort_keys=True) + "\n"


def write_fixture(
    out_path: Union[str, Path, None] = None,
    sidecar_path: Union[str, Path, None] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Write the WAV (working data) and, when given, the sidecar (committed)."""
    wav = build_wav(**kwargs)
    destination = Path(out_path) if out_path is not None else default_audio_path()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(wav)

    sidecar = build_sidecar(wav)
    if sidecar_path is not None:
        target = Path(sidecar_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(sidecar_text(sidecar))
    return sidecar


def load_sidecar(path: Union[str, Path] = SIDECAR_PATH) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def _drift(name: str, actual: Any, expected: Any) -> FixtureDrift:
    return FixtureDrift(
        f"fixture drift: {name} on disk is {actual!r}, sidecar says {expected!r}"
    )


def _check(name: str, actual: Any, expected: Any) -> None:
    if isinstance(actual, float) and isinstance(expected, (int, float)):
        if abs(actual - float(expected)) > 1e-6:
            raise _drift(name, actual, expected)
        return
    if actual != expected:
        raise _drift(name, actual, expected)


def verify(
    wav_path: Union[str, Path],
    sidecar_path: Union[str, Path] = SIDECAR_PATH,
) -> dict[str, Any]:
    """Fail by field name when the audio does not match the committed sidecar."""
    sidecar = load_sidecar(sidecar_path)
    raw = Path(wav_path).read_bytes()
    facts = read_wav(raw)
    pcm = facts.pcm
    end_sample = last_speech_sample(pcm)

    checks = (
        ("version", SIDECAR_VERSION),
        ("sha256", hashlib.sha256(raw).hexdigest()),
        ("encoding", ENCODING),
        ("sample_rate", facts.sample_rate),
        ("channels", facts.channels),
        ("sample_width_bytes", facts.sample_width_bytes),
        ("frame_count", facts.frame_count),
        ("duration_s", round(facts.duration_s, 6)),
        ("speech_start_sample", first_speech_sample(pcm)),
        ("speech_end_sample", end_sample),
        ("speech_end_ms", _speech_end_ms(end_sample, facts.sample_rate)),
    )
    for name, actual in checks:
        if name not in sidecar:
            raise FixtureDrift(f"fixture drift: sidecar is missing {name}")
        _check(name, actual, sidecar[name])
    return sidecar


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m spike.fixture",
        description="Generate or verify the 20 s caller fixture.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write the WAV and sidecar")
    mode.add_argument("--verify", action="store_true", help="verify a WAV against its sidecar")
    parser.add_argument("--out", type=Path, default=default_audio_path())
    parser.add_argument("--wav", type=Path, default=None)
    parser.add_argument("--sidecar", type=Path, default=SIDECAR_PATH)
    parser.add_argument("--seconds", type=float, default=DEFAULT_SECONDS)
    parser.add_argument("--speech-end", type=float, default=DEFAULT_SPEECH_END_S)
    args = parser.parse_args(argv)

    if args.write:
        sidecar = write_fixture(
            args.out,
            sidecar_path=args.sidecar,
            seconds=args.seconds,
            speech_end_s=args.speech_end,
        )
        print(f"wrote {args.out} sha256={sidecar['sha256']}")
        print(f"wrote {args.sidecar} speech_end_sample={sidecar['speech_end_sample']}")
        return 0

    try:
        sidecar = verify(args.wav or args.out, args.sidecar)
    except (FixtureDrift, OSError, wave.Error) as drift:
        print(str(drift), file=sys.stderr)
        return 1
    print(f"ok {args.wav or args.out} sha256={sidecar['sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

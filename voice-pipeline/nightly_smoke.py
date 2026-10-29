"""Nightly live smoke and wire-drift canary (ticket 151).

Spec: ``.scratch/meta-cascade/spec.md``, "Fixtures, chaos and live smoke" —
live smoke is key-gated and never in PR CI; nightly, one call per leg, which
re-records the fixtures and alerts on wire drift without committing them. A
vendor outage is an alert, not a red PR. It does not write the production
breaker or counter.

What one night does, when the workflow lets it run:

1. Takes the existing timing lock (``live_lock``, the same file the demo
   scoreboard uses), so no live timing run overlaps another.
2. Calls each provider once with the production adapter: Meta realtime speech,
   Meta Spark chat completions, AssemblyAI synthesis.
3. Writes the raw inbound frames to a throwaway directory (``--out``; CI uses
   ``$RUNNER_TEMP``). The recording is evidence for a human to promote into a
   committed fixture; this process never writes under ``cascade/fixtures`` and
   never commits.
4. Compares what the *adapter* observed on the live wire with what the
   committed fixture suite pins. A vendor rename means the adapter stops
   observing the event, and that is reported by leg and by fixture name.

Honesty rules encoded here:

* No key ⇒ ``SKIPPED`` and exit 2. The workflow skips the job before this, and
  this path can never be read as a live pass.
* No ``META_REASONING_EFFORT`` ⇒ the model leg is ``BLOCKED`` (M03 owns the
  value) and the night exits 3. No number is invented.
* No durable writes at all: no breaker, no counter, no store. The adapters are
  constructed without their recovery sinks, and a test forbids importing them.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from live_lock import TimingLockHeldError, acquire_timing_lock

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).with_name("cascade") / "fixtures"

LEGS = ("stt", "llm", "tts")

#: One key per vendor leg. Rendered into the workflow's key gate in the same
#: order, so the skip label names exactly what is missing.
KEY_ENV = {
    "stt": "META_API_KEY",
    "llm": "META_API_KEY",
    "tts": "ASSEMBLYAI_API_KEY",
}

#: M03 owns this measurement; the nightly never invents one.
REASONING_EFFORT_ENV = "META_REASONING_EFFORT"

#: The committed fixture each leg's live observation is checked against.
BASELINES = {
    "stt": {"fixture": "events-turn", "required": ("ack",), "any_of": (("speechComplete", "transcript"),)},
    "llm": {"fixture": "normal-reply", "required": ("content",), "any_of": ()},
    "tts": {"fixture": "begin-echo", "required": ("Begin", "Audio"), "any_of": ()},
}

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_NO_KEYS = 2
EXIT_BLOCKED = 3


@dataclass(frozen=True)
class KeyState:
    """Which vendor keys are present, by name (never by value)."""

    present: bool
    missing: tuple[str, ...] = ()

    def line(self) -> str:
        if self.present:
            return "nightly live smoke: keys present (" + ", ".join(sorted(set(KEY_ENV.values()))) + ")"
        return (
            "nightly live smoke: SKIPPED — no live keys (missing: "
            + ", ".join(self.missing)
            + "); no live call was made and no live claim is recorded."
        )


@dataclass
class LegRecord:
    """One live leg: the raw wire frames and what the adapter observed."""

    leg: str
    frames: list[dict[str, Any]] = field(default_factory=list)
    observations: list[str] = field(default_factory=list)

    def to_document(self, *, recorded_at: str) -> dict[str, Any]:
        return {
            "kind": "nightly-recording",
            "leg": self.leg,
            "baseline": BASELINES[self.leg]["fixture"],
            "recordedAt": recorded_at,
            "frames": self.frames,
            "observations": self.observations,
        }


def key_state(env: Mapping[str, str]) -> KeyState:
    missing = tuple(
        name for name in KEY_ENV.values() if not str(env.get(name, "")).strip()
    )
    # One name per missing key, in declaration order, without duplicates.
    unique = tuple(dict.fromkeys(missing))
    return KeyState(present=not unique, missing=unique)


def wire_drift(leg: str, recorded: LegRecord) -> list[str]:
    """Name every place the live wire no longer reads as the pinned one.

    The pinned contract is the adapter's observation (ack / final / content /
    Begin+Audio), not a byte-for-byte frame diff: vendor sessions differ in
    text, ids and timing, and an additive unknown event is explicitly allowed.
    """
    baseline = BASELINES[leg]
    label = f"{leg}/{baseline['fixture']}"
    if not recorded.frames and not recorded.observations:
        return [
            f"{label}: no adapter observation — the leg recorded nothing, so a "
            "live pass cannot be claimed"
        ]
    seen = set(recorded.observations)
    drift: list[str] = []
    for required in baseline["required"]:
        if required not in seen:
            drift.append(
                f"{label}: the adapter no longer observes {required!r} on the "
                f"live wire (observed: {sorted(seen) or 'nothing'})"
            )
    for group in baseline["any_of"]:
        if seen.isdisjoint(group):
            drift.append(
                f"{label}: the adapter observes none of {list(group)} on the "
                f"live wire (observed: {sorted(seen) or 'nothing'})"
            )
    return drift


def _refuse_fixture_out(out_dir: Path) -> str | None:
    """A night may not write where a committed fixture lives."""
    try:
        out_dir.resolve().relative_to(FIXTURES.resolve())
    except ValueError:
        return None
    return (
        f"refusing to record into {out_dir}: that is the committed fixture "
        "tree; a nightly recording is a working file, never a commit"
    )


def _write_recording(out_dir: Path, record: LegRecord, *, recorded_at: str) -> Path:
    path = out_dir / f"{record.leg}.json"
    path.write_text(
        json.dumps(record.to_document(recorded_at=recorded_at), indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def run(
    *,
    env: Mapping[str, str],
    out_dir: Path,
    live: Callable[..., LegRecord] | None = None,
    acquire_lock: Callable[..., Any] | None = None,
    recorded_at: str | None = None,
) -> tuple[int, list[str]]:
    """Run one night in-process; returns the exit code and every log line."""
    lines: list[str] = []
    state = key_state(env)
    lines.append(state.line())
    if not state.present:
        return EXIT_NO_KEYS, lines

    refusal = _refuse_fixture_out(out_dir)
    if refusal:
        lines.append(f"nightly live smoke: {refusal}")
        return EXIT_DRIFT, lines
    out_dir.mkdir(parents=True, exist_ok=True)

    if acquire_lock is None:
        acquire_lock = acquire_timing_lock
    try:
        lock = acquire_lock(scenario="nightly-live-smoke")
    except TimingLockHeldError as error:
        lines.append(f"nightly live smoke: {error}")
        return EXIT_DRIFT, lines

    stamp = recorded_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    runner = live or _run_live_leg
    failures = 0
    blocked: list[str] = []
    try:
        for leg in LEGS:
            if leg == "llm" and not str(env.get(REASONING_EFFORT_ENV, "")).strip():
                blocked.append(leg)
                lines.append(
                    "nightly llm: BLOCKED — reasoning_effort is not configured; "
                    "ticket M03 owns the value and the nightly invents none, so no "
                    "live model call was made."
                )
                continue
            key = str(env[KEY_ENV[leg]])
            try:
                record = runner(leg, key=key, env=env)
            except Exception as error:  # a vendor outage is an alert, not a crash
                failures += 1
                lines.append(f"nightly {leg}: FAILED — {error}")
                continue
            _write_recording(out_dir, record, recorded_at=stamp)
            drift = wire_drift(leg, record)
            if drift:
                failures += 1
                lines.extend(f"nightly {leg}: DRIFT — {line}" for line in drift)
            else:
                lines.append(
                    f"nightly {leg}: OK — the adapter observed "
                    f"{', '.join(record.observations)} against "
                    f"{BASELINES[leg]['fixture']}"
                )
    finally:
        lock.release()  # type: ignore[union-attr]

    if failures:
        lines.append(
            f"nightly live smoke: ALERT — {failures} leg(s) drifted or failed; "
            "this is a nightly alert, never a PR check."
        )
        return EXIT_DRIFT, lines
    if blocked:
        lines.append(
            "nightly live smoke: BLOCKED — named blockers: "
            + ", ".join(blocked)
            + " (ticket 03/M03 owns the value). Not a live pass."
        )
        return EXIT_BLOCKED, lines
    lines.append("nightly live smoke: OK — one call per leg, no drift.")
    return EXIT_OK, lines


# --------------------------------------------------------------------------
# The live legs. Every socket/session seam is injectable so the tests above
# never dial; the defaults are the production adapters.
# --------------------------------------------------------------------------


class _RecordingSocket:
    """Tees inbound frames for the recording and counts what was consumed."""

    def __init__(self, socket: Any, record: list[dict[str, Any]]) -> None:
        self._socket = socket
        self._record = record

    async def send(self, message: Any) -> None:
        await self._socket.send(message)

    def __aiter__(self) -> Any:
        return self._frames()

    async def _frames(self) -> Any:
        async for raw in self._socket.__aiter__():
            if isinstance(raw, (bytes, bytearray)):
                continue
            try:
                frame = json.loads(str(raw))
            except ValueError:
                continue
            if isinstance(frame, dict):
                self._record.append(frame)
            yield raw

    async def close(self) -> None:
        await self._socket.close()


async def _connect(url: str, headers: dict[str, str]) -> Any:
    import websockets

    return await websockets.connect(url, additional_headers=headers)


def _recording_socket_factory(frames: list[dict[str, Any]], connect: Callable[..., Any]) -> Callable[..., Any]:
    async def factory(url: str, headers: dict[str, str]) -> Any:
        return _RecordingSocket(await connect(url, headers), frames)

    return factory


def _observations_from_events(events: Sequence[Any]) -> list[str]:
    names: list[str] = []
    for event in events:
        name = type(event).__name__
        if name == "SpeechStart":
            names.append("speechStart")
        elif name in ("PartialTranscript", "FinalTranscript"):
            names.append("transcript")
        elif name == "SpeechEnd":
            names.append("speechEnd")
        elif name == "SpeechComplete":
            names.append("speechComplete")
    return names


def _decode_caller_clip(seconds: float = 4.0) -> bytes:
    """A tracked synthesized caller line, decoded to 24 kHz PCM16.

    Using a committed clip keeps the night's audio identical every time; the
    ffmpeg dependency is installed by the nightly workflow only.
    """
    import subprocess

    source = REPO_ROOT / "voni" / "public" / "voices" / "anna.mp3"
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(source), "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return pcm[: int(24_000 * 2 * seconds)]


async def _live_stt(key: str) -> LegRecord:
    from cascade.meta_stt import SAMPLE_RATE, MetaStreamingSTT

    frames: list[dict[str, Any]] = []
    backend = MetaStreamingSTT(
        call_id=f"nightly-{os.getpid()}",
        api_key=key,
        socket_factory=_recording_socket_factory(frames, _connect),
    )
    observations: list[str] = []
    await backend.open(language_codes=["en-us"], sample_rate=SAMPLE_RATE)
    observations.append("ack")
    pcm = _decode_caller_clip()
    step = 9600  # 200 ms at 24 kHz, the adapter's own frame size
    for at in range(0, len(pcm), step):
        await backend.send_audio(pcm[at : at + step])
    await backend.send_silence(1.0)
    events: list[Any] = []
    try:
        async for event in backend.events():
            events.append(event)
            if type(event).__name__ == "SpeechComplete":
                break
    finally:
        observations.extend(_observations_from_events(events))
        await backend.close()
    return LegRecord(leg="stt", frames=frames, observations=observations)


class _RecordingPost:
    def __init__(self, post: Any, chunks: list[bytes]) -> None:
        self._post = post
        self._chunks = chunks

    async def __aenter__(self) -> Any:
        response = await self._post.__aenter__()
        chunks = self._chunks

        class _Response:
            status = response.status

            async def iter_bytes(self) -> Any:
                async for chunk in response.iter_bytes():
                    chunks.append(chunk)
                    yield chunk

        return _Response()

    async def __aexit__(self, *args: Any) -> bool:
        return await self._post.__aexit__(*args)


class _RecordingSession:
    def __init__(self, session: Any, chunks: list[bytes]) -> None:
        self._session = session
        self._chunks = chunks

    async def __aenter__(self) -> Any:
        active = await self._session.__aenter__()
        chunks = self._chunks

        class _Active:
            def post(self, url: str, *, headers: dict, json: dict) -> Any:
                return _RecordingPost(active.post(url, headers=headers, json=json), chunks)

        return _Active()

    async def __aexit__(self, *args: Any) -> bool:
        return await self._session.__aexit__(*args)


def _sse_frames(chunks: Sequence[bytes]) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    text = b"".join(chunks).decode("utf-8", errors="replace")
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:") :].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            frame = json.loads(payload)
        except ValueError:
            continue
        if isinstance(frame, dict):
            frames.append(frame)
    return frames


async def _live_llm(key: str, env: Mapping[str, str]) -> LegRecord:
    from cascade.meta_llm import MetaLLM

    chunks: list[bytes] = []
    backend = MetaLLM(
        reasoning_effort=str(env.get(REASONING_EFFORT_ENV, "")),
        api_key=key,
        system_prompt="You are a smoke check. Reply with one short sentence.",
        session_factory=lambda timeout_s: _RecordingSession(_Aiohttp(timeout_s), chunks),
    )
    observations: list[str] = []
    async for event in backend.complete(messages=[{"role": "user", "content": "Say hello."}]):
        if type(event).__name__ == "TokenDelta" and getattr(event, "text", ""):
            observations.append("content")
            break
    return LegRecord(leg="llm", frames=_sse_frames(chunks), observations=observations)


def _Aiohttp(timeout_s: float) -> Any:  # noqa: N802 - mirrors the adapter's seam name
    from cascade.meta_llm import _AiohttpSession

    return _AiohttpSession(timeout_s)


async def _live_tts(key: str) -> LegRecord:
    from cascade.assemblyai_tts import AssemblyAIStreamingTTS

    frames: list[dict[str, Any]] = []
    backend = AssemblyAIStreamingTTS(
        voice_id="anna",
        transport="browser",
        api_key=key,
        socket_factory=_recording_socket_factory(frames, _connect),
    )
    observations: list[str] = []
    await backend.open()
    observations.append("Begin")
    try:
        async for _audio in backend.speak("This is the nightly smoke check."):
            observations.append("Audio")
            break
    finally:
        await backend.close()
    return LegRecord(leg="tts", frames=frames, observations=observations)


def _run_live_leg(leg: str, *, key: str, env: Mapping[str, str]) -> LegRecord:
    if leg == "stt":
        return asyncio.run(_live_stt(key))
    if leg == "llm":
        return asyncio.run(_live_llm(key, env))
    if leg == "tts":
        return asyncio.run(_live_tts(key))
    raise ValueError(f"unknown nightly leg {leg!r}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Nightly key-gated live smoke (ticket 151)")
    parser.add_argument("--out", default="", help="throwaway recording dir (never a fixture tree)")
    parser.add_argument("--timing-lock", default="", help="override the shared timing lock path")
    args = parser.parse_args(argv)

    out_dir = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="voni-nightly-"))
    lock_path = Path(args.timing_lock) if args.timing_lock else None

    def acquire(**kwargs: Any) -> Any:
        if lock_path is not None:
            kwargs["path"] = lock_path
        return acquire_timing_lock(**kwargs)

    code, lines = run(env=os.environ, out_dir=out_dir, acquire_lock=acquire)
    for line in lines:
        print(line, flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())

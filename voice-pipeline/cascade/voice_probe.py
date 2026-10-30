"""Ticket 130: probe which German voice ids the synthesis endpoint actually serves.

German is open because ``juergen`` comes back ``422 voice_not_found`` from
``/v1/speech``. The probe is the recorded evidence the owner needs before the
re-cast: one request per candidate, and the response's own account of what it
spoke (status, ``X-Request-Id``, ``X-TTS-Voice-Id``, ``X-TTS-Language``,
``X-TTS-Model``) or the endpoint's parsed refusal.

The probe never binds a voice and never edits :mod:`cascade.voice_binding`. A
successful candidate yields a *suggested* ``VoiceBinding`` line for the owner to
review; the old clip and the unbound row stay exactly as they are until a human
records the gate.

Candidates are the two known German ids and any explicit ``--voice-id``. The
app catalogue contributes only ids whose own ``languageCode`` is ``"de"`` — a
UUID is never guessed. Worth stating plainly: a bare id such as ``juergen`` is
read at the vendor as the slug of one of the account's own voices, so
``aai-juergen`` is the library slug spelling under test.

Live requests are key-gated. Without ``ASSEMBLYAI_API_KEY`` the run raises
:class:`MissingProbeKey` before a socket exists; the CLI reports ``SKIPPED`` and
exits 2. Tests inject a poster and need no key.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

#: The one HTTP route this probe uses: buffered synthesis, one clip per request.
ENDPOINT = "https://tts.us.assemblyai.com/v1/speech"

#: A short German sentence a German voice can speak and a listener can audition.
PROBE_SENTENCE = "Hallo, hier ist Voni. Ich spreche Deutsch."

#: The two ids this ticket names: the catalogue id and its library-slug spelling.
DEFAULT_CANDIDATES: tuple[str, ...] = ("juergen", "aai-juergen")

#: The app catalogue, read rather than restated, so no UUID is guessed.
DEFAULT_CATALOGUE_PATH = (
    Path(__file__).resolve().parents[2] / "voni" / "src" / "lib" / "agents" / "voices.ts"
)

#: The manifest the probe writes next to the clips it saves.
PROBE_MANIFEST_NAME = "probe.json"
PROBE_SCHEMA_VERSION = 1

#: ``(url, headers, body) -> response``. The seam every test replaces; the
#: default poster is the only thing that opens a socket.
Poster = Callable[[str, dict[str, str], bytes], "ProbeResponse"]


class VoiceProbeError(RuntimeError):
    """The probe cannot run honestly, and the reason is named."""


class MissingProbeKey(VoiceProbeError):
    """No credential, so nothing was sent and no evidence exists."""

    def __init__(self) -> None:
        super().__init__(
            "ASSEMBLYAI_API_KEY is not configured: the German probe is live "
            "synthesis only, so this run is SKIPPED rather than fabricated"
        )


class ProbeCatalogueError(VoiceProbeError):
    """The app catalogue could not be read, so its German ids are unknown."""

    def __init__(self, path: Path, reason: str) -> None:
        self.path = path
        super().__init__(
            f'the app catalogue "{path}" is not readable as evidence: {reason}; '
            "run without --catalogue-de or name the ids with --voice-id"
        )


@dataclass(frozen=True)
class ProbeResponse:
    """One HTTP response as the poster saw it.

    ``transport_error`` is a request that never produced an HTTP status. It is
    kept separate from a refusal so a network failure is never read as a 4xx
    the vendor did not send.
    """

    status: int
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""
    transport_error: str | None = None


@dataclass(frozen=True)
class ProbeError:
    """The endpoint's parsed refusal: its stable code, field and message."""

    error_type: str | None
    param: str | None
    message: str | None

    def to_document(self) -> dict[str, object]:
        return {
            "errorType": self.error_type,
            "param": self.param,
            "message": self.message,
        }


@dataclass(frozen=True)
class VoiceProbe:
    """One candidate's request and what the endpoint answered.

    ``rendered`` is only true for a 2xx that carried audio: a 200 with an empty
    body is named ``empty_audio``, and a 422 is never an empty success.
    """

    voice_id: str
    status: int
    request_id: str | None
    response_voice_id: str | None
    language: str | None
    model: str | None
    audio: bytes
    sha256: str | None
    error: ProbeError | None

    @property
    def rendered(self) -> bool:
        return self.error is None and bool(self.audio) and 200 <= self.status < 300

    @property
    def audio_bytes(self) -> int:
        return len(self.audio)

    def to_document(self, *, audio_file: str | None = None) -> dict[str, object]:
        return {
            "voiceId": self.voice_id,
            "status": self.status,
            "rendered": self.rendered,
            "requestId": self.request_id,
            "responseVoiceId": self.response_voice_id,
            "language": self.language,
            "model": self.model,
            "audioBytes": self.audio_bytes,
            "sha256": self.sha256,
            "audioFile": audio_file if self.rendered else None,
            "error": None if self.error is None else self.error.to_document(),
        }


@dataclass(frozen=True)
class ProbeRun:
    """Every candidate's outcome, and the one exit code the caller reports."""

    probes: tuple[VoiceProbe, ...]
    sentence: str
    probed_on: str
    out_dir: str | None = None

    @property
    def rendered(self) -> tuple[VoiceProbe, ...]:
        return tuple(probe for probe in self.probes if probe.rendered)

    @property
    def exit_code(self) -> int:
        """0 when at least one candidate renders, 1 when every candidate refuses."""
        return 0 if self.rendered else 1

    def suggested_bindings(self) -> tuple[str, ...]:
        return tuple(
            binding_suggestion(probe) for probe in self.rendered
        )

    def to_document(
        self, audio_files: Mapping[str, str] | None = None
    ) -> dict[str, object]:
        """The record; ``audio_files`` maps a rendered candidate to its saved name."""
        names = audio_files or {}
        return {
            "schemaVersion": PROBE_SCHEMA_VERSION,
            "probedOn": self.probed_on,
            "endpoint": ENDPOINT,
            "sentence": self.sentence,
            "keyPresent": True,
            "candidates": [
                probe.to_document(audio_file=names.get(probe.voice_id))
                for probe in self.probes
            ],
            "suggestedBinding": list(self.suggested_bindings()),
        }


def binding_suggestion(probe: VoiceProbe) -> str:
    """The *suggested* table row; applying it is the owner's act, not the probe's."""
    return f"VoiceBinding({json.dumps(probe.voice_id)}, LOCALES[\"de\"]),"


def german_candidates(extra: Iterable[str] = ()) -> tuple[str, ...]:
    """The named defaults plus explicit extras, in order, without duplicates."""
    candidates: list[str] = []
    for voice_id in (*DEFAULT_CANDIDATES, *extra):
        cleaned = voice_id.strip()
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)
    return tuple(candidates)


def catalogue_german_ids(source: str) -> tuple[str, ...]:
    """Every ``voice id`` whose own catalogue row declares ``languageCode: "de"``."""
    entries = re.finditer(
        r'\{\s*id:\s*"([^"]+)"[^}]*?languageCode:\s*"de"', source
    )
    ids: list[str] = []
    for match in entries:
        voice_id = match.group(1)
        if voice_id not in ids:
            ids.append(voice_id)
    return tuple(ids)


def read_catalogue_german_ids(path: Path) -> tuple[str, ...]:
    """Read the app catalogue's German ids, or refuse by path and reason."""
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ProbeCatalogueError(path, str(error)) from None
    return catalogue_german_ids(source)


def safe_voice_filename(voice_id: str) -> str:
    """A WAV filename that cannot escape the out directory or hide a dotfile."""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", voice_id).strip(".-")
    return f"{stem or 'voice'}.wav"


def _header(headers: Mapping[str, str], name: str) -> str | None:
    """Case-insensitive header lookup; the vendor's spelling is not fixed."""
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value.strip() or None
    return None


def _parsed_error(status: int, body: bytes) -> ProbeError:
    """The endpoint's JSON error, or a named unreadable refusal — never silence."""
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        detail = body.decode("utf-8", "replace").strip()
        message = detail[:500] or f"HTTP {status} carried no error body"
        return ProbeError(error_type=None, param=None, message=message)
    if not isinstance(document, Mapping):
        return ProbeError(
            error_type=None,
            param=None,
            message=f"HTTP {status} error body is not a JSON object",
        )
    code = document.get("code") or document.get("error_type")
    message = document.get("message") or document.get("error")
    param = document.get("param")
    return ProbeError(
        error_type=str(code) if code is not None else None,
        param=str(param) if param is not None else None,
        message=str(message) if message is not None else None,
    )


def _default_poster(url: str, headers: dict[str, str], body: bytes) -> ProbeResponse:
    """The one live seam: one buffered POST, refusing no status as a success."""
    import urllib.error
    import urllib.request

    request = urllib.request.Request(
        url, data=body, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return ProbeResponse(
                status=response.status,
                headers=dict(response.headers.items()),
                body=response.read(),
            )
    except urllib.error.HTTPError as error:
        return ProbeResponse(
            status=error.code,
            headers=dict(error.headers.items()) if error.headers else {},
            body=error.read(),
        )
    except urllib.error.URLError as error:
        return ProbeResponse(
            status=0,
            transport_error=f"POST {url} produced no HTTP response: {error.reason}",
        )


def request_body(voice_id: str, sentence: str) -> dict[str, object]:
    """The one request shape: a buffered WAV for exactly this candidate.

    No ``language`` override is sent: the response's ``X-TTS-Language`` is then
    the voice's own language, which is the fact the probe exists to record. The
    retired ``voice`` field is never sent.
    """
    return {
        "text": sentence,
        "voice_id": voice_id,
        "container": "wav",
        "stream": False,
    }


def probe_voice(
    voice_id: str,
    *,
    api_key: str | None,
    sentence: str = PROBE_SENTENCE,
    poster: Poster | None = None,
) -> VoiceProbe:
    """One candidate, one ``POST``, and the endpoint's own record of it."""
    if not api_key:
        raise MissingProbeKey()
    post = poster or _default_poster
    payload = json.dumps(request_body(voice_id, sentence)).encode("utf-8")
    response = post(
        ENDPOINT,
        {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        payload,
    )

    if response.transport_error is not None:
        return VoiceProbe(
            voice_id=voice_id,
            status=0,
            request_id=None,
            response_voice_id=None,
            language=None,
            model=None,
            audio=b"",
            sha256=None,
            error=ProbeError(
                error_type="transport_error", param=None, message=response.transport_error
            ),
        )

    request_id = _header(response.headers, "X-Request-Id")
    response_voice_id = _header(response.headers, "X-TTS-Voice-Id")
    language = _header(response.headers, "X-TTS-Language")
    model = _header(response.headers, "X-TTS-Model")

    if 200 <= response.status < 300:
        if not response.body:
            return VoiceProbe(
                voice_id=voice_id,
                status=response.status,
                request_id=request_id,
                response_voice_id=response_voice_id,
                language=language,
                model=model,
                audio=b"",
                sha256=None,
                error=ProbeError(
                    error_type="empty_audio",
                    param=None,
                    message=(
                        "HTTP 2xx carried no audio: text with nothing to speak is "
                        "not a rendered voice and is never recorded as one"
                    ),
                ),
            )
        return VoiceProbe(
            voice_id=voice_id,
            status=response.status,
            request_id=request_id,
            response_voice_id=response_voice_id,
            language=language,
            model=model,
            audio=response.body,
            sha256=hashlib.sha256(response.body).hexdigest(),
            error=None,
        )

    return VoiceProbe(
        voice_id=voice_id,
        status=response.status,
        request_id=request_id,
        response_voice_id=response_voice_id,
        language=language,
        model=model,
        audio=b"",
        sha256=None,
        error=_parsed_error(response.status, response.body),
    )


def _audio_names(probes: Iterable[VoiceProbe]) -> dict[str, str]:
    """One safe filename per rendered candidate, disambiguated on collision."""
    names: dict[str, str] = {}
    used: set[str] = set()
    for probe in probes:
        if not probe.rendered:
            continue
        candidate = safe_voice_filename(probe.voice_id)
        name = candidate
        suffix = 2
        while name in used:
            stem = candidate.removesuffix(".wav")
            name = f"{stem}-{suffix}.wav"
            suffix += 1
        used.add(name)
        names[probe.voice_id] = name
    return names


def write_probe(run: ProbeRun, directory: str | os.PathLike[str]) -> Path:
    """Save each rendered WAV and ``probe.json``; a refusal writes no audio."""
    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    names = _audio_names(run.probes)
    for probe in run.probes:
        name = names.get(probe.voice_id)
        if name is None:
            continue
        path = out / name
        path.write_bytes(probe.audio)
        path.chmod(0o600)
    document = run.to_document(names)
    manifest = out / PROBE_MANIFEST_NAME
    manifest.write_text(f"{json.dumps(document, indent=2)}\n", encoding="utf-8")
    return manifest


def probe_voices(
    voice_ids: Iterable[str],
    *,
    api_key: str | None,
    sentence: str = PROBE_SENTENCE,
    poster: Poster | None = None,
    out_dir: str | os.PathLike[str] | None = None,
    sent_on: date | str | None = None,
) -> ProbeRun:
    """Probe every candidate, then (optionally) save the evidence that exists."""
    if not api_key:
        raise MissingProbeKey()
    probes = tuple(
        probe_voice(voice_id, api_key=api_key, sentence=sentence, poster=poster)
        for voice_id in voice_ids
    )
    probed_on = (
        sent_on.isoformat()
        if isinstance(sent_on, date)
        else sent_on or date.today().isoformat()
    )
    run = ProbeRun(
        probes=probes,
        sentence=sentence,
        probed_on=probed_on,
        out_dir=None if out_dir is None else str(out_dir),
    )
    if out_dir is not None:
        write_probe(run, out_dir)
    return run

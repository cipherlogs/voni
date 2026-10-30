#!/usr/bin/env python3
"""Ticket 130: probe German voice ids and record the endpoint's answer.

    cd voice-pipeline
    python scripts/probe_voices.py                       # juergen, aai-juergen
    python scripts/probe_voices.py --voice-id acct-de-1  # add one candidate
    python scripts/probe_voices.py --catalogue-de        # add Locale=de ids
    python scripts/probe_voices.py --out /tmp/de-probe   # save WAVs + probe.json

One buffered ``POST /v1/speech`` per candidate, with a short German sentence and
``container: "wav"``. The row records the HTTP status, ``X-Request-Id``,
``X-TTS-Voice-Id``, ``X-TTS-Language``, ``X-TTS-Model``, the parsed refusal for a
non-2xx (``voice_not_found`` is not an empty success), and the audio's size and
sha256. A successful clip is saved as ``<safe-id>.wav`` for audition; a refusal
saves no audio.

This probe never binds a voice: it prints a *suggested* ``VoiceBinding`` line
for the owner to review, and leaves ``cascade/voice_binding.py`` and ticket 130
untouched. Without ``ASSEMBLYAI_API_KEY`` it prints ``SKIPPED`` and exits 2
before any request. Exit 0 when at least one candidate renders, 1 when every
candidate refuses, 2 for the key gate, an unreadable catalogue, or a bad write.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Run as a script from `voice-pipeline/`; the flat module names live there.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cascade.voice_probe import (  # noqa: E402
    DEFAULT_CANDIDATES,
    DEFAULT_CATALOGUE_PATH,
    ENDPOINT,
    PROBE_SENTENCE,
    MissingProbeKey,
    Poster,
    VoiceProbeError,
    probe_voices,
    read_catalogue_german_ids,
)

USAGE = """Probe which German voice ids the synthesis endpoint serves."""


def fail(message: str) -> int:
    print(f"voice probe failed: {message}", file=sys.stderr)
    return 2


def print_table(run) -> None:
    print(f"\nGerman voice probe: POST {ENDPOINT}")
    print(f'  sentence "{run.sentence}"\n')
    header = (
        f"{'voice':<20} {'status':>6}  {'served as':<18} {'language':<9} "
        f"{'model':<18} {'bytes':>7}  evidence"
    )
    print(header)
    print("-" * len(header))
    for probe in run.probes:
        served = probe.response_voice_id or "-"
        language = probe.language or "-"
        model = probe.model or "-"
        if probe.rendered:
            evidence = f"request {probe.request_id or '-'} sha256 {probe.sha256}"
        elif probe.error is None:
            evidence = "refused"
        else:
            code = probe.error.error_type or "unreadable"
            param = f" param {probe.error.param}" if probe.error.param else ""
            message = f": {probe.error.message}" if probe.error.message else ""
            evidence = f"{code}{param}{message}"
        print(
            f"{probe.voice_id:<20} {probe.status:>6}  {served:<18} {language:<9} "
            f"{model:<18} {probe.audio_bytes:>7}  {evidence}"
        )


def print_suggestion(run) -> None:
    bindings = run.suggested_bindings()
    if not bindings:
        print(
            "\nno candidate rendered: German stays open. Do not re-cast to another "
            "Locale and do not keep the old clip as a silent fallback."
        )
        return
    print(
        "\nsuggested binding line (review, then add it by hand; this probe does "
        "not bind or edit voice_binding.py):"
    )
    for line in bindings:
        print(f"  {line}")


def main(
    argv: list[str] | None = None,
    *,
    poster: Poster | None = None,
    environ: dict[str, str] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=USAGE)
    parser.add_argument(
        "--voice-id",
        action="append",
        default=None,
        help="add a candidate id (repeatable); defaults are juergen and aai-juergen",
    )
    parser.add_argument(
        "--catalogue-de",
        nargs="?",
        const=str(DEFAULT_CATALOGUE_PATH),
        default=None,
        metavar="PATH",
        help=(
            "also probe ids the app catalogue declares languageCode de "
            f"(default {DEFAULT_CATALOGUE_PATH})"
        ),
    )
    parser.add_argument(
        "--out",
        default=None,
        help="save rendered WAVs as <safe-id>.wav plus probe.json in this directory",
    )
    args = parser.parse_args(argv)

    env = os.environ if environ is None else environ
    key = env.get("ASSEMBLYAI_API_KEY")
    if not key:
        # The key gate comes first: SKIPPED is not a measurement, and no
        # catalogue read or request happens without a credential.
        print(
            "SKIPPED: ASSEMBLYAI_API_KEY is not configured, so no German voice "
            "id was probed and no clip was fabricated.",
            file=sys.stderr,
        )
        return 2

    # An explicit --voice-id is the candidate list; --catalogue-de adds to it.
    # Without either, the two ids ticket 130 names are the defaults.
    candidates = list(args.voice_id) if args.voice_id else list(DEFAULT_CANDIDATES)
    if args.catalogue_de is not None:
        try:
            candidates.extend(
                read_catalogue_german_ids(Path(args.catalogue_de))
            )
        except VoiceProbeError as error:
            return fail(str(error))
    candidates = list(dict.fromkeys(cid.strip() for cid in candidates if cid.strip()))

    try:
        run = probe_voices(
            candidates,
            api_key=key,
            sentence=PROBE_SENTENCE,
            poster=poster,
            out_dir=args.out,
        )
    except MissingProbeKey as error:
        print(f"SKIPPED: {error}", file=sys.stderr)
        return 2
    except (VoiceProbeError, OSError) as error:
        return fail(str(error))

    print_table(run)
    print_suggestion(run)
    if args.out is not None:
        print(f"\nwrote {Path(args.out).resolve()}")
    return run.exit_code


if __name__ == "__main__":
    sys.exit(main())

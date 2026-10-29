#!/usr/bin/env python3
"""W0 reference render — one line in one voice, by direct synthesis.

    cd voice-pipeline
    python scripts/render_reference.py --body body.json
    python scripts/render_reference.py --body body.json --text "Otra frase."
    python scripts/render_reference.py --body body.json --out-dir /tmp/refs

The body is the stored agent body: its ``greeting`` is the default line, its
``voice.voice_id`` selects the binding, and the transport selects the format.
The render is the call's own synthesis client (no STT, no LLM, no browser, no
platform), written at the voice's native level with no gain stage.

Live synthesis is key-gated. ``ASSEMBLYAI_API_KEY`` must be set; without it
this script refuses by name instead of fabricating a file. The unit tests
replay recorded synthesis frames through ``cascade.testing`` and need no key.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# Run as a script from `voice-pipeline/`; the flat module names live there.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cascade.body_map import adapt_body  # noqa: E402
from cascade.reference_render import (  # noqa: E402
    default_reference_dir,
    render_reference,
)

USAGE = """Render one W0 reference line through the call's direct synthesis."""


def fail(message: str) -> int:
    print(f"reference render failed: {message}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=USAGE)
    parser.add_argument("--body", required=True, help="stored agent body JSON")
    parser.add_argument(
        "--text",
        default=None,
        help="render this sentence instead of the body's greeting (a mid-call defect)",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help=f"reference cache directory (default {default_reference_dir()})",
    )
    parser.add_argument(
        "--transport",
        default="browser",
        help="the call's transport; W0 is the browser capture (default browser)",
    )
    args = parser.parse_args(argv)

    body_path = Path(args.body)
    if not body_path.is_file():
        return fail(f"body file not found: {body_path}")
    try:
        body = json.loads(body_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return fail(f"body file is not valid JSON: {error}")

    if not os.environ.get("ASSEMBLYAI_API_KEY"):
        return fail(
            "ASSEMBLYAI_API_KEY is not configured: the reference is rendered by "
            "live synthesis only, so this step is blocked rather than fabricated. "
            "Tests replay recorded synthesis fixtures and need no key."
        )

    try:
        rendered = asyncio.run(
            render_reference(
                adapt_body(body),
                text=args.text,
                out_dir=args.out_dir,
                transport=args.transport,
            )
        )
    except Exception as error:  # noqa: BLE001 - one named CLI failure, no traceback
        return fail(str(error))

    print(
        f"reference {'cached' if rendered.cached else 'rendered'}: {rendered.path} "
        f"({rendered.audio_bytes / 1024:.1f} KiB, sha256 {rendered.sha256})"
    )
    print(
        f"  {rendered.voice_id}, {rendered.locale}, {rendered.format.sample_rate} Hz "
        f"{rendered.format.encoding}, {rendered.duration_ms} ms, native level "
        "(no gain, no limiter)"
    )
    print(f'  line "{rendered.text}"')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

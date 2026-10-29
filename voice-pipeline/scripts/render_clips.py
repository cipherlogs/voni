#!/usr/bin/env python3
"""W1 clips — the only producer of `voni/public/voices/cascade/*.wav`.

    cd voice-pipeline
    python scripts/render_clips.py                    # render every bound voice
    python scripts/render_clips.py --voice lola       # finish one voice
    python scripts/render_clips.py --check            # no key: plan vs evidence vs bytes
    python scripts/render_clips.py --check --strict   # fail while a Locale is open

Each clip is the demo voice's real greeting, in its own Locale, at native
level, rendered by the call's own synthesis client and binding table
(`cascade.reference_render` over `cascade.assemblyai_tts`). The managed path's
`public/voices/<voice>.mp3` is untouched: a cascade clip is a new native
render, never a silent swap.

Live synthesis is key-gated. Without `ASSEMBLYAI_API_KEY` this script refuses
by name and writes nothing at all — no manifest, no placeholder, no stale file.
`--check` is the credentialless gate: it audits the committed manifest against
the committed bytes.

`juergen`/de is an open Locale: the vendor does not serve the voice, so the
plan keeps it as a named open row with no clip. `--strict` exits non-zero while
it stays open. Ticket 130 owns the re-cast; the old clip is retired, never kept
as a silent fallback.
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

from cascade.clips import (  # noqa: E402
    CLIP_MANIFEST_PATH,
    ClipBlocker,
    ClipError,
    audit_manifest,
    clip_pending_command,
    clip_plan,
    clip_plan_for,
    clip_record_from_document,
    manifest_document,
    render_all,
)

USAGE = """Render or audit the cascade's native clips."""


def fail(message: str) -> int:
    print(f"clip render failed: {message}", file=sys.stderr)
    return 1


def manifest_path(root: Path) -> Path:
    return root / CLIP_MANIFEST_PATH


def read_manifest(root: Path) -> dict:
    path = manifest_path(root)
    if not path.is_file():
        raise ClipError(f"{CLIP_MANIFEST_PATH} is missing: run the clips command first")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ClipError(f"{CLIP_MANIFEST_PATH} is not readable as evidence: {error}") from None
    if not isinstance(document, dict):
        raise ClipError(f"{CLIP_MANIFEST_PATH} is not an object: not a clip manifest")
    return document


def write_manifest(root: Path, document: dict) -> None:
    path = manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(document, indent=2)}\n", encoding="utf-8")


def report(document: dict) -> None:
    print(
        f"\ncascade clips: {len(document.get('clips') or [])} committed, "
        f"{len(document.get('open') or [])} open, "
        f"{len(document.get('blockers') or [])} blocked"
    )
    for row in document.get("open") or []:
        print(f"  OPEN {row.get('voice')} ({row.get('locale')}): {row.get('reason')}")
    for row in document.get("blockers") or []:
        print(f"  BLOCKED {row.get('voice')} ({row.get('locale')}): {row.get('reason')}")
        print(f"    run: {row.get('command')}")


def check(root: Path, *, strict: bool) -> int:
    try:
        document = read_manifest(root)
    except ClipError as error:
        return fail(str(error))

    audit = audit_manifest(document, asset_root=root)
    if not audit.ok:
        for problem in audit.problems:
            print(f"  {problem}", file=sys.stderr)
        return fail(f"{len(audit.problems)} problem(s) in the cascade clips")
    report(document)

    if strict:
        open_rows = document.get("open") or []
        blocked = document.get("blockers") or []
        if open_rows or blocked:
            names = [f"{row.get('voice')}/{row.get('locale')}" for row in open_rows + blocked]
            return fail(f"{len(names)} voice(s) without a clip: {', '.join(names)}")
    return 0


def blockers_for_unrendered(records, blockers) -> list[ClipBlocker]:
    """A one-voice run does not claim the other voices were rendered now."""
    covered = {record.voice for record in records} | {blocker.voice for blocker in blockers}
    missing: list[ClipBlocker] = []
    for plan in clip_plan():
        if not plan.bound or plan.voice_id in covered:
            continue
        missing.append(
            ClipBlocker(
                voice=plan.voice_id,
                locale=plan.locale,
                reason="not rendered in this run: run the full clips command",
                command=clip_pending_command(plan.voice_id),
            )
        )
    return missing


def merge_previous(root: Path, only: str, records, blockers):
    """Keep every other voice's committed row so a one-voice run stays complete."""
    try:
        previous = read_manifest(root)
    except ClipError:
        return records, blockers

    try:
        kept_records = [
            clip_record_from_document(row)
            for row in previous.get("clips") or []
            if row.get("voice") != only
        ]
        kept_blockers = [
            ClipBlocker(
                voice=row["voice"],
                locale=row["locale"],
                reason=row["reason"],
                command=row["command"],
            )
            for row in previous.get("blockers") or []
            if row.get("voice") != only
        ]
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise ClipError(
            f"{CLIP_MANIFEST_PATH} has a malformed row, so this one-voice run "
            f"cannot keep the other voices honest: {error}"
        ) from None
    return [*kept_records, *records], [*kept_blockers, *blockers]


async def generate(root: Path, *, only: str | None) -> int:
    if only is not None:
        try:
            plan = clip_plan_for(only)
        except ClipError as error:
            return fail(str(error))
        if not plan.bound:
            return fail(
                f'voice "{plan.voice_id}" ({plan.locale}) is open: {plan.reason}; '
                "there is no voice to render and a clip is never borrowed from another Locale"
            )
        voices = [only]
    else:
        voices = None

    try:
        records, blockers = await render_all(
            root,
            out_dir=root / "voni/.voice-references",
            voices=voices,
        )
    except ClipError as error:
        return fail(str(error))

    if only is not None:
        try:
            records, blockers = merge_previous(root, only, records, blockers)
        except ClipError as error:
            return fail(str(error))
        blockers = [*blockers, *blockers_for_unrendered(records, blockers)]

    document = manifest_document(records, blockers=blockers)
    audit = audit_manifest(document, asset_root=root)
    if not audit.ok:
        # Never write a manifest the gate would reject: a partial run must not
        # look like a rendered one.
        for problem in audit.problems:
            print(f"  {problem}", file=sys.stderr)
        return fail(f"{len(audit.problems)} problem(s): the manifest was not written")

    write_manifest(root, document)
    report(document)
    if document.get("blockers"):
        print(
            "BLOCKED — no clip committed, no audio fabricated.",
            file=sys.stderr,
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=USAGE)
    parser.add_argument(
        "--root",
        default=str(Path(__file__).resolve().parents[2]),
        help="repo root to write into (default: this checkout)",
    )
    parser.add_argument(
        "--voice",
        default=None,
        help="render only this demo voice",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the plan, evidence and committed bytes (no credentials)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero while any voice is open or blocked",
    )
    args = parser.parse_args(argv)
    root = Path(args.root)

    if args.check:
        if args.voice is not None:
            return fail("--check audits the whole manifest; it does not take --voice")
        return check(root, strict=args.strict)

    if args.voice is not None:
        # Usage and open-Locale refusals need no key: they are true regardless.
        try:
            plan = clip_plan_for(args.voice)
        except ClipError as error:
            return fail(str(error))
        if not plan.bound:
            return fail(
                f'voice "{plan.voice_id}" ({plan.locale}) is open: {plan.reason}; '
                "there is no voice to render and a clip is never borrowed from another Locale"
            )

    if not os.environ.get("ASSEMBLYAI_API_KEY"):
        # Fail before a file is touched: a keyless run must leave no trace that
        # could be mistaken for rendered evidence.
        return fail(
            "ASSEMBLYAI_API_KEY is not configured: clips are rendered by live "
            "synthesis only, so every voice is blocked rather than fabricated. "
            "Tests replay recorded synthesis fixtures and need no key."
        )
    return asyncio.run(generate(root, only=args.voice))


if __name__ == "__main__":
    sys.exit(main())

"""Offline entry point for the M00 spike report.

``python -m spike.run --offline`` composes the five terms from the ticket 10-12
producers *without* a network or a key, prints the report, and exits. It is the
honest no-key run: with no live transport every vendor term is unmeasured and
the verdict is ``AT RISK`` with those terms named — never ``PASS`` and never a
blank. A live run is owner-gated (spec M0 and ticket 151) and is refused here by
name rather than half-implemented.

There is no measurement arithmetic in this module: it wires the producers to
:func:`spike.report.from_measurements`, so a report produced here is the same
shape as the one a live run produces.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cascade import thresholds
from spike import endpointing, first_audio, first_token, report


def offline_report(
    *,
    registry: thresholds.Registry | None = None,
    cushion_registry: thresholds.Registry | None = None,
) -> report.Report:
    """The no-key report: five named terms, four (or five) unmeasured.

    The producers are called with an empty environment on purpose: ``--offline``
    means "do not attempt a live call", even on a machine that happens to have
    the vendor keys exported.
    """
    turns = endpointing.measure_live(transport=None, env={})
    first_content = first_token.measure_efforts(None, speech_complete_at_s=None)
    synthesis = first_audio.measure_first_audio(
        opening=first_audio.Opening(opened_at_s=0.0, begin_at_s=0.25),
        turn_at_s=1.0,
        frames=(),
        registry=cushion_registry,
    )
    return report.from_measurements(
        stt=turns[0],
        first_content=first_content,
        synthesis=synthesis,
        registry=registry,
        cushion_registry=cushion_registry,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spike.run",
        description=(
            "M00 latency spike: the five terms, their sum and the verdict. "
            "Offline only; the live run is owner-gated."
        ),
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="compose the report from the no-key producers (no network)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="refused: the live run requires owner-gated keys and a timing lock",
    )
    parser.add_argument(
        "--json", action="store_true", help="print the report as JSON"
    )
    parser.add_argument(
        "--out", metavar="PATH", help="also write the report to PATH"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)

    if args.live:
        print(
            "spike.run --live is owner-gated: it needs META_API_KEY, "
            "ASSEMBLYAI_API_KEY and the spike timing lock (spec M0; ticket 151). "
            "Use --offline for the key-free report."
        )
        return 2
    if not args.offline:
        print(
            "choose --offline (key-free report) or --live (owner-gated, not "
            "available from this entry point)",
            file=sys.stderr,
        )
        return 2

    result = offline_report()
    payload = result.as_dict()
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(result.render())
    if args.out:
        target = Path(args.out)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    return 0 if result.verdict != report.FAIL else 1


if __name__ == "__main__":
    raise SystemExit(main())

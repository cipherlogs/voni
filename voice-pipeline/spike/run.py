"""Entry point for the M00 spike report.

``python -m spike.run --offline`` composes the five terms from the ticket 10-12
producers *without* a network or a key, prints the report, and exits. It is the
honest no-key run: with no live transport every vendor term is unmeasured and
the verdict is ``AT RISK`` with those terms named — never ``PASS`` and never a
blank.

``python -m spike.run --live`` is the owner-gated measurement (spec M0 and
ticket 151). The CLI names every missing key before it takes the lock or dials,
and the live runner refuses by name too; the CLI catches that refusal. It takes
the shared timing lock for the
whole run and measures terms 1-4 through the live transports in
:mod:`spike.live`. A failed leg stays unmeasured with its real reason; the run
never records a gate verdict for the owner.

Exit codes for ``--live``: 0 for a fully measured PASS or five-term AT RISK, 1
for a fully measured FAIL, 2 for a missing key or a held timing lock, and 3 when
any term is unmeasured, a leg degraded or a blocker was recorded. ``--offline``
keeps its old contract: 0 for PASS/AT RISK, 1 for FAIL, 2 for usage.

There is no measurement arithmetic in this module: it wires the producers to
:func:`spike.report.from_measurements`, so a report produced here is the same
shape as the one a live run produces.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from cascade import thresholds
from live_lock import TimingLockHeldError, acquire_timing_lock
from spike import endpointing, first_audio, first_token, live, report


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
            "--offline is key-free; --live is owner-gated."
        ),
        epilog=(
            "--live exit codes: 0 fully measured PASS/AT RISK; 1 fully measured "
            "FAIL; 2 missing META_API_KEY/ASSEMBLYAI_API_KEY or a held timing "
            "lock; 3 any unmeasured term, degraded leg or blocker. "
            "--offline exit codes: 0 PASS/AT RISK, 1 FAIL, 2 usage."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="compose the report from the no-key producers (no network)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help=(
            "measure the five terms live: owner-gated, needs META_API_KEY and "
            "ASSEMBLYAI_API_KEY and the shared timing lock"
        ),
    )
    parser.add_argument(
        "--json", action="store_true", help="print the report as JSON"
    )
    parser.add_argument(
        "--out", metavar="PATH", help="also write the report to PATH"
    )
    return parser


def _write_payload(path: str, payload: Mapping[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _render_live(measurement: live.LiveMeasurement) -> str:
    """The report, then the run's own record; no key value is ever printed."""
    lines = [measurement.report.render(), "", "  live run"]
    lines.append(f"  {'run at':<28} {measurement.at}")
    lines.append(
        f"  {'keys present':<28} {', '.join(measurement.keys_present)}"
    )
    lines.append(f"  {'reasoning effort row':<28} {measurement.report.effort_label}")
    for blocker in measurement.blockers:
        lines.append(f"  {'blocked':<28} {blocker}")
    for term in measurement.degraded:
        lines.append(f"  {'unmeasured (failed leg)':<28} {term}")
    return "\n".join(lines)


def _live_main(
    args: argparse.Namespace,
    *,
    env: Mapping[str, str] | None = None,
    live_runner: Callable[..., live.LiveMeasurement] | None = None,
    acquire_lock: Callable[..., Any] | None = None,
) -> int:
    environment = os.environ if env is None else env

    # Name every missing key before touching the lock: a key-less run is a key
    # refusal, never "the lock is held by someone else".
    missing = live.missing_keys(environment)
    if missing:
        print(live.MissingKeysError(missing), file=sys.stderr)
        return 2

    acquire = acquire_lock or acquire_timing_lock
    try:
        lock = acquire(scenario="m00-spike")
    except TimingLockHeldError as error:
        print(f"spike.run --live refused: {error}", file=sys.stderr)
        return 2
    try:
        runner = live_runner or live.run_live
        try:
            measurement = runner(env=environment)
        except live.MissingKeysError as error:
            print(error, file=sys.stderr)
            return 2
    finally:
        if lock is not None:
            lock.release()

    payload = measurement.as_dict()
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(_render_live(measurement))
    if args.out:
        _write_payload(args.out, payload)
    return measurement.exit_code()


def main(
    argv: list[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    live_runner: Callable[..., live.LiveMeasurement] | None = None,
    acquire_lock: Callable[..., Any] | None = None,
) -> int:
    args = _parser().parse_args(argv)

    if args.live:
        return _live_main(
            args, env=env, live_runner=live_runner, acquire_lock=acquire_lock
        )
    if not args.offline:
        print(
            "choose --offline (key-free report) or --live (owner-gated live "
            "measurement)",
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
        _write_payload(args.out, payload)
    return 0 if result.verdict != report.FAIL else 1


if __name__ == "__main__":
    raise SystemExit(main())

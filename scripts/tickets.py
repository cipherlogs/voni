#!/usr/bin/env python3
"""Ticket graph operations for the local markdown tracker.

The tracker is one markdown file per ticket under ``.scratch/<effort>/issues``.
This tool is the single implementation of "blocked by", "frontier" and
"resolved", so a parallel fan-out does not have to re-parse the files by hand.

    python scripts/tickets.py validate --effort meta-cascade
    python scripts/tickets.py frontier --effort meta-cascade
    python scripts/tickets.py map --effort meta-cascade
    python scripts/tickets.py close 42 --answer /tmp/42.md

``--root`` and ``--effort`` are accepted before or after the subcommand.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

STATUSES = {
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "claimed",
    "resolved",
    "wontfix",
}
OPEN_STATUSES = {"needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "claimed"}
FILE_RE = re.compile(r"^(\d{1,3})-(.+)\.md$")
STATUS_RE = re.compile(r"^\*\*Status:\*\*\s*(\S+)\s*$", re.MULTILINE)
BLOCKED_RE = re.compile(r"^\*\*Blocked by:\*\*\s*(.*)$", re.MULTILINE)
ANSWER_RE = re.compile(r"^## Answer\s*$", re.MULTILINE)


def effort_dir(root: str | Path, effort: str | None) -> Path:
    base = Path(root)
    if effort:
        directory = base / effort
        if not (directory / "spec.md").is_file():
            raise SystemExit(f"no spec.md under {directory}")
        return directory
    candidates = [
        path
        for path in base.iterdir()
        if path.is_dir() and (path / "spec.md").is_file() and (path / "issues").is_dir()
    ]
    if len(candidates) != 1:
        names = ", ".join(sorted(path.name for path in candidates)) or "none"
        raise SystemExit(f"choose --effort (found: {names})")
    return candidates[0]


def parse_ticket(path: Path) -> dict:
    match = FILE_RE.match(path.name)
    if not match:
        raise SystemExit(f"ticket file does not match NN-slug.md: {path}")
    number = int(match.group(1))
    text = path.read_text(encoding="utf-8")
    title = next(
        (line[2:].strip() for line in text.splitlines() if line.startswith("# ")),
        match.group(2),
    )
    status_match = STATUS_RE.search(text)
    if not status_match:
        raise SystemExit(f"ticket {number} has no **Status:** line: {path}")
    blocked_match = BLOCKED_RE.search(text)
    blocked: list[int] = []
    if blocked_match:
        raw = blocked_match.group(1)
        # "41 (Message assembly), 03 (Threshold registry)" — only a number
        # followed by its title is a blocker; numbers inside titles are not.
        blocked = [int(value) for value in re.findall(r"(?:^|,)\s*(\d{1,3})\s*\(", raw)]
        if not blocked and raw.strip().lower() not in {"none", "none (can start immediately)"}:
            leading = re.match(r"\s*(\d{1,3})", raw)
            if leading:
                blocked = [int(leading.group(1))]
    return {
        "number": number,
        "title": title,
        "status": status_match.group(1),
        "blocked_by": blocked,
        "answer": bool(ANSWER_RE.search(text)),
        "path": str(path),
    }


def load_tickets(directory: Path) -> dict[int, dict]:
    tickets: dict[int, dict] = {}
    for path in sorted((directory / "issues").glob("*.md")):
        ticket = parse_ticket(path)
        if ticket["number"] in tickets:
            raise SystemExit(f"duplicate ticket number {ticket['number']}: {path}")
        tickets[ticket["number"]] = ticket
    return tickets


def validate(tickets: dict[int, dict]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    for ticket in tickets.values():
        number = ticket["number"]
        status = ticket["status"]
        if status not in STATUSES:
            errors.append(f"{number}: unknown status {status!r}")
        for blocker in ticket["blocked_by"]:
            if blocker not in tickets:
                errors.append(f"{number}: blocked by missing ticket {blocker}")
            elif blocker == number:
                errors.append(f"{number}: blocked by itself")
            elif status == "resolved" and tickets[blocker]["status"] != "resolved":
                errors.append(
                    f"{number}: resolved while blocker {blocker} is {tickets[blocker]['status']}"
                )
        if status == "resolved" and not ticket["answer"]:
            errors.append(f"{number}: resolved without a ## Answer section")
        if status != "resolved" and ticket["answer"]:
            warnings.append(f"{number}: has an answer but status is {status}")

    # Cycles: a cycle is never a valid frontier.
    colour: dict[int, int] = {}

    def visit(number: int, trail: list[int]) -> None:
        if colour.get(number) == 1:
            cycle = " -> ".join(str(item) for item in trail + [number])
            errors.append(f"blocked-by cycle: {cycle}")
            return
        if colour.get(number) == 2:
            return
        colour[number] = 1
        for blocker in tickets.get(number, {}).get("blocked_by", []):
            if blocker in tickets:
                visit(blocker, trail + [number])
        colour[number] = 2

    for number in tickets:
        visit(number, [])
    return errors, warnings


def frontier(tickets: dict[int, dict]) -> list[dict]:
    ready = []
    for ticket in sorted(tickets.values(), key=lambda item: item["number"]):
        if ticket["status"] not in OPEN_STATUSES:
            continue
        if all(tickets[blocker]["status"] == "resolved" for blocker in ticket["blocked_by"]):
            ready.append(ticket)
    return ready


def render_map(directory: Path, tickets: dict[int, dict], ready: list[dict]) -> str:
    lines = [
        f"# {directory.name} — ticket map",
        "",
        "Generated by `scripts/tickets.py map`. Do not edit by hand.",
        "",
        "## Frontier",
        "",
    ]
    if ready:
        for ticket in ready:
            lines.append(f"- **{ticket['number']:03d}** {ticket['title']} — {ticket['status']}")
    else:
        lines.append("- (none)")
    lines += ["", "## All tickets", "", "| # | Status | Blocked by | Title |", "|---|---|---|---|"]
    for ticket in sorted(tickets.values(), key=lambda item: item["number"]):
        blocked = ", ".join(f"{value:03d}" for value in ticket["blocked_by"]) or "—"
        lines.append(
            f"| {ticket['number']:03d} | {ticket['status']} | {blocked} | {ticket['title']} |"
        )
    lines.append("")
    return "\n".join(lines)


def close_ticket(directory: Path, number: int, answer_path: Path) -> None:
    tickets = load_tickets(directory)
    if number not in tickets:
        raise SystemExit(f"no ticket {number} in {directory}")
    path = Path(tickets[number]["path"])
    text = path.read_text(encoding="utf-8")
    answer = answer_path.read_text(encoding="utf-8").strip()
    if not answer:
        raise SystemExit(f"answer file is empty: {answer_path}")
    text = STATUS_RE.sub("**Status:** resolved", text, count=1)
    if not ANSWER_RE.search(text):
        text = text.rstrip() + f"\n\n## Answer\n\n{answer}\n"
    path.write_text(text, encoding="utf-8")
    print(f"closed {number}: {path}")


def _normalise(argv: list[str]) -> list[str]:
    """Move the two global flags ahead of the subcommand, wherever typed."""
    leading: list[str] = []
    rest: list[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in {"--root", "--effort"} and index + 1 < len(argv):
            leading.extend((token, argv[index + 1]))
            index += 2
        elif token.startswith(("--root=", "--effort=")):
            leading.append(token)
            index += 1
        else:
            rest.append(token)
            index += 1
    return leading + rest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".scratch", help="tracker root (default: .scratch)")
    parser.add_argument("--effort", default=None, help="feature directory name")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("validate", help="fail on graph errors")
    frontier_parser = commands.add_parser("frontier", help="list open, unblocked tickets")
    frontier_parser.add_argument("--json", action="store_true")
    map_parser = commands.add_parser("map", help="write map.md")
    map_parser.add_argument("--output", default=None)
    close_parser = commands.add_parser("close", help="mark a ticket resolved")
    close_parser.add_argument("number", type=int)
    close_parser.add_argument("--answer", required=True)

    args = parser.parse_args(_normalise(list(argv) if argv is not None else sys.argv[1:]))
    directory = effort_dir(args.root, args.effort)
    tickets = load_tickets(directory)

    if args.command == "validate":
        errors, warnings = validate(tickets)
        for warning in warnings:
            print(f"warning: {warning}")
        for error in errors:
            print(f"error: {error}")
        if errors:
            return 1
        print(f"ok: {len(tickets)} tickets, no graph errors")
        return 0

    if args.command == "frontier":
        ready = frontier(tickets)
        if args.json:
            print(json.dumps([{key: value for key, value in ticket.items() if key != "path"} for ticket in ready], indent=2))
        else:
            for ticket in ready:
                print(f"{ticket['number']:03d}  {ticket['status']:<16} {ticket['title']}")
        return 0

    if args.command == "map":
        output = Path(args.output) if args.output else directory / "map.md"
        output.write_text(render_map(directory, tickets, frontier(tickets)), encoding="utf-8")
        print(f"wrote {output}")
        return 0

    if args.command == "close":
        close_ticket(directory, args.number, Path(args.answer))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())

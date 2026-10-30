"""Contract tests for the ticket-graph tool (scripts/tickets.py)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("tickets_tool", ROOT / "scripts" / "tickets.py")
tickets_tool = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(tickets_tool)


def make_effort(tmp: str, tickets: dict[int, dict]) -> Path:
    directory = Path(tmp) / "effort"
    (directory / "issues").mkdir(parents=True)
    (directory / "spec.md").write_text("# spec\n", encoding="utf-8")
    for number, ticket in tickets.items():
        blocked = ", ".join(f"{value:02d} (blocker)" for value in ticket.get("blocked", []))
        blocked = blocked or "None (can start immediately)"
        body = [
            f"# {number:02d}: {ticket.get('title', 'ticket')}",
            "",
            f"**Blocked by:** {blocked}",
            f"**Status:** {ticket.get('status', 'ready-for-agent')}",
            "",
        ]
        if ticket.get("answer"):
            body += ["## Answer", "", ticket["answer"], ""]
        (directory / "issues" / f"{number:02d}-t{number}.md").write_text(
            "\n".join(body), encoding="utf-8"
        )
    return directory


class ParseTests(unittest.TestCase):
    def test_blockers_are_numbers_not_numbers_inside_titles(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(
                tmp,
                {
                    1: {},
                    2: {"blocked": [1], "title": "At 80% of the daily cap"},
                },
            )
            loaded = tickets_tool.load_tickets(directory)
            self.assertEqual(loaded[1]["blocked_by"], [])
            self.assertEqual(loaded[2]["blocked_by"], [1])


class FrontierTests(unittest.TestCase):
    def test_only_open_unblocked_tickets_are_frontier(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(
                tmp,
                {
                    1: {"status": "resolved", "answer": "done"},
                    2: {"blocked": [1]},
                    3: {"blocked": [2]},
                    4: {"status": "resolved", "answer": "done"},
                },
            )
            ready = tickets_tool.frontier(tickets_tool.load_tickets(directory))
            self.assertEqual([ticket["number"] for ticket in ready], [2])


class ValidateTests(unittest.TestCase):
    def test_a_clean_graph_has_no_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(
                tmp, {1: {"status": "resolved", "answer": "done"}, 2: {"blocked": [1]}}
            )
            errors, _ = tickets_tool.validate(tickets_tool.load_tickets(directory))
            self.assertEqual(errors, [])

    def test_dangling_blocker_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(tmp, {1: {"blocked": [99]}})
            errors, _ = tickets_tool.validate(tickets_tool.load_tickets(directory))
            self.assertTrue(any("missing ticket 99" in error for error in errors), errors)

    def test_resolved_before_a_blocker_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(
                tmp,
                {
                    1: {},
                    2: {"status": "resolved", "answer": "done", "blocked": [1]},
                },
            )
            errors, _ = tickets_tool.validate(tickets_tool.load_tickets(directory))
            self.assertTrue(any("resolved while blocker 1" in error for error in errors), errors)

    def test_resolved_without_an_answer_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(tmp, {1: {"status": "resolved"}})
            errors, _ = tickets_tool.validate(tickets_tool.load_tickets(directory))
            self.assertTrue(any("without a ## Answer" in error for error in errors), errors)

    def test_a_cycle_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(tmp, {1: {"blocked": [2]}, 2: {"blocked": [1]}})
            errors, _ = tickets_tool.validate(tickets_tool.load_tickets(directory))
            self.assertTrue(any("cycle" in error for error in errors), errors)


class CloseTests(unittest.TestCase):
    def test_close_sets_resolved_and_appends_the_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(tmp, {1: {}})
            answer = Path(tmp) / "answer.md"
            answer.write_text("The answer.\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                tickets_tool.close_ticket(directory, 1, answer)
            text = (directory / "issues" / "01-t1.md").read_text(encoding="utf-8")
            self.assertIn("**Status:** resolved", text)
            self.assertIn("## Answer", text)
            self.assertIn("The answer.", text)


class MapTests(unittest.TestCase):
    def test_map_names_the_frontier_and_every_ticket(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = make_effort(
                tmp, {1: {"status": "resolved", "answer": "done"}, 2: {"blocked": [1]}}
            )
            loaded = tickets_tool.load_tickets(directory)
            rendered = tickets_tool.render_map(directory, loaded, tickets_tool.frontier(loaded))
            self.assertIn("002", rendered)
            self.assertIn("ready-for-agent", rendered)


if __name__ == "__main__":
    unittest.main()

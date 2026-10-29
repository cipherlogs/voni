"""Naming invariant: commit is not cascade vocabulary.

The spec is explicit ("Contracts and vocabulary"): the provider owns the Turn
boundary, and the orchestrator takes the floor, yields or waits. A code path,
ledger mark, event or test helper named commit is a naming bug even when the
behaviour is right, so this test fails if the word returns to the cascade
surface.

The scan covers every Python file under `voice-pipeline/` (including tests and
the future `cascade/` package) except the documented exemptions below:

- `providers.py` — shared contract module, out of this ticket's write scope;
  its docstrings still point at the old gate name (ticket 05 renames the call
  sites, not the contract prose).
- `backends/`, `scripts/` — vendor adapters and dev tooling; upstream
  docstrings are not ours to rewrite.
- `server.py` — the one hit is "env never committed", the git sense, not a
  turn decision.

This file is exempt from its own scan because it names the banned word to ban
it; the guard test below proves the scan is not vacuous.
"""

import unittest
from pathlib import Path

PIPELINE_ROOT = Path(__file__).resolve().parent
SELF = Path(__file__).resolve()

# Whole trees that are not the cascade decision surface.
SKIP_DIRS = frozenset({"backends", "scripts"})

# Individual files allowed to contain the word, with the reason pinned so a
# later reader does not have to guess.
EXEMPT = {
    "providers.py": "shared contract module; prose rename is out of scope",
    "server.py": "the hit is the git sense ('env never committed')",
}

BANNED = "commit"


def surface_files() -> list[Path]:
    """Every cascade-surface Python file the naming rule guards."""
    files = []
    for path in sorted(PIPELINE_ROOT.rglob("*.py")):
        relative = path.relative_to(PIPELINE_ROOT)
        if relative.parts[0] in SKIP_DIRS:
            continue
        if path.resolve() == SELF or relative.as_posix() in EXEMPT:
            continue
        files.append(path)
    return files


class CascadeVocabularyTests(unittest.TestCase):
    def test_no_cascade_source_says_commit(self):
        offenders = []
        for path in surface_files():
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if BANNED in line.lower():
                    relative = path.relative_to(PIPELINE_ROOT)
                    offenders.append(f"{relative}:{number}: {line.strip()}")
        self.assertEqual(
            offenders,
            [],
            "commit is not cascade vocabulary — take the floor, yield or wait:\n"
            + "\n".join(offenders),
        )

    def test_scan_covers_the_floor_decision_modules(self):
        # Anti-vacuity: a broken glob must not turn the ban into a no-op.
        guarded = {path.name for path in surface_files()}
        self.assertLessEqual(
            {"turns.py", "orchestrator.py", "metrics.py", "test_turns.py"}, guarded
        )


if __name__ == "__main__":
    unittest.main()

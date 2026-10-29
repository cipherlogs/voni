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

import io
import tokenize
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


def banned_tokens(path: Path) -> list[tuple[int, str]]:
    """Identifiers and event names that use the banned word.

    Prose is not a name: "committed sidecar" and SQL ``COMMIT`` are allowed.
    The ban is on a code path, ledger mark, event or test helper — a NAME token
    built from the word, or a lowercase string literal used as a mark/event.
    """
    hits = []
    source = path.read_text()
    try:
        tokens = tokenize.generate_tokens(io.StringIO(source).readline)
        for token in tokens:
            if token.type == tokenize.NAME:
                name = token.string.lower()
                if name == BANNED or name.startswith(BANNED + "_") or name.endswith("_" + BANNED):
                    hits.append((token.start[0], token.string))
            elif token.type == tokenize.STRING:
                literal = token.string.lstrip("fFrRbBuU")
                if literal in {'"commit"', "'commit'"}:
                    hits.append((token.start[0], token.string))
    except (tokenize.TokenError, IndentationError):
        return []
    return hits


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
            for number, token in banned_tokens(path):
                relative = path.relative_to(PIPELINE_ROOT)
                offenders.append(f"{relative}:{number}: {token}")
        self.assertEqual(
            offenders,
            [],
            "commit is not cascade vocabulary — take the floor, yield or wait:\n"
            + "\n".join(offenders),
        )

    def test_guard_recognises_a_reintroduced_name(self):
        # Anti-vacuity: the token scan must still catch a real code path/event.
        import tempfile

        source = 'def commit_decision():\n    mark = "commit"\n# committed is prose\n'
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
            handle.write(source)
            path = Path(handle.name)
        try:
            hits = [token for _, token in banned_tokens(path)]
        finally:
            path.unlink()
        self.assertIn("commit_decision", hits)
        self.assertIn('"commit"', hits)

    def test_scan_covers_the_floor_decision_modules(self):
        # Anti-vacuity: a broken glob must not turn the ban into a no-op.
        guarded = {path.name for path in surface_files()}
        self.assertLessEqual(
            {"turns.py", "orchestrator.py", "metrics.py", "test_turns.py"}, guarded
        )


if __name__ == "__main__":
    unittest.main()

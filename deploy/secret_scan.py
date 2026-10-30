"""The repository scan: a committed credential fails, a test fake does not (141).

Secrets come from the host environment only. The deployment configs are checked
by :mod:`deploy.topology` (a ``NAME=value`` in a config or the names example);
this module is the second guard and the wider one: it walks the committed tree
and fails on a credential *value* — a key-shaped token, a URL with userinfo, or
a secret-looking assignment — wherever a deployed artifact could carry it.

Two deliberate limits:

* **A test fixture may hold a fake credential.** ``test_*.py``, ``*_vectors.json``
  and ``fixtures/`` exist to exercise a refusal with a string that looks like a
  key; flagging them would make the scan unusable and hide the real findings.
  A key pasted into production code, a config, a doc or a script still fails.
* **The scan never echoes the credential.** A violation names the file, the line
  and the kind (``key-shaped value``), never the value: the report is the same
  material a log would leak, so it is redacted by construction.

The URL rule is :mod:`cascade.sanitizer`'s (ticket 07/111 owns the one rule
source). The key rule is deliberately narrower than the log gate's: a log line
may over-redact ("Bearer auth" in prose is harmless), but a repository scan that
failed on prose would be turned off. So this pattern needs a vendor prefix, a
separator and a long random body — a value a real key has and an English
sentence does not. An assignment must also carry a long value: ``KEY =
"routing:switch"`` is a constant, not a credential.

Only **committed** files are scanned (``git ls-files`` when the root is a
checkout); a developer's untracked ``.env`` is not in the repository and is
already covered by ``.gitignore`` and the image's ``.dockerignore``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# The sanitizer lives in the service package; import it rather than copying it.
_SERVICE_ROOT = Path(__file__).resolve().parent.parent / "voice-pipeline"
if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))

from cascade.sanitizer import URL_CREDENTIAL

#: A vendor-prefixed credential: the prefix, a separator and a long random body.
#: Case-sensitive on purpose — ``Token`` in prose is not a token.
KEY_SHAPED = re.compile(r"\b(?:sk|pk|api|tok)[_-][A-Za-z0-9_-]{16,}\b", re.ASCII)

#: Directories that never carry a deployed artifact (or are third-party trees).
SKIP_DIRS = frozenset(
    {
        ".git",
        ".next",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "build",
        "coverage",
        "dist",
        "graphify-out",
        "node_modules",
        "venv",
    }
)

#: Binary or generated files nothing here can read as a credential.
SKIP_SUFFIXES = frozenset(
    {
        ".gif",
        ".ico",
        ".jpeg",
        ".jpg",
        ".lock",
        ".mp3",
        ".pdf",
        ".png",
        ".ttf",
        ".wav",
        ".webp",
        ".woff",
        ".woff2",
        ".zip",
    }
)

#: Paths whose fake credentials are the point (a refusal test needs a key).
FIXTURE_PATH = re.compile(
    r"(^|/)(?:test_[^/]*\.py|[^/]*_vectors\.json|fixtures/|testing/"
    r"|[^/]*\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts))",
    re.ASCII,
)

#: A production assignment of a value to a secret-looking name.
SECRET_ASSIGNMENT = re.compile(
    r"^\s*(?:export\s+)?"
    r"(?P<name>[A-Z0-9_]*(?:KEY|SECRET|SALT|TOKEN|PASSWORD)|DATABASE_URL)"
    r"\s*=\s*[\"']?(?P<value>[^\"'\s#]+)",
    re.ASCII,
)

#: A value that is a placeholder, not a credential.
PLACEHOLDER_PREFIXES = ("$", "<", "%", "[", "...", "***")

#: Documentation's stock userinfo in a sample connection URL.
PLACEHOLDER_USERINFO = frozenset(
    {"user:password", "user:pass", "username:password", "user:pw", "user:secret"}
)

#: A value shorter than this is a constant or a placeholder, not a credential
#: (``KEY = "routing:switch"``, ``TEST_KEY = "test-meta-key"``).
MIN_VALUE_LENGTH = 20

#: The report's kinds, named not quoted.
KEY_SHAPED_KIND = "key-shaped value"
URL_USERINFO_KIND = "credential in a URL"
SECRET_VALUE_KIND = "secret assignment"

#: Files larger than this are generated or vendored, not hand-written config.
MAX_BYTES = 2_000_000


def _url_credential(line: str) -> bool:
    """A URL with real userinfo, not documentation's ``user:password``."""
    for match in URL_CREDENTIAL.finditer(line):
        userinfo = match.group(0)
        scheme, _, rest = userinfo.partition("://")
        if rest.rstrip("@").lower() in PLACEHOLDER_USERINFO:
            continue
        return True
    return False


def _key_shaped(line: str) -> bool:
    """A prefixed key, not a hyphenated identifier that starts with the prefix.

    ``api-services-user-data-policy`` begins like a key; a credential body
    carries a digit (or mixed case beyond the prefix), that path does not.
    """
    for match in KEY_SHAPED.finditer(line):
        candidate = match.group(0)
        if any(character.isdigit() for character in candidate):
            return True
        body = candidate.split("-", 1)[-1].split("_", 1)[-1]
        if body != body.lower() and body != body.upper():
            return True
    return False


def _line_violation(line: str) -> str | None:
    """The kind of credential this line carries, or None. Never the value."""
    if _url_credential(line):
        return URL_USERINFO_KIND
    if _key_shaped(line):
        return KEY_SHAPED_KIND
    assignment = SECRET_ASSIGNMENT.match(line)
    if assignment is not None:
        value = assignment.group("value")
        if len(value) >= MIN_VALUE_LENGTH and not value.startswith(PLACEHOLDER_PREFIXES):
            return SECRET_VALUE_KIND
    return None


def _is_fixture(relative: Path) -> bool:
    return bool(FIXTURE_PATH.search(relative.as_posix()))


def scan_text(text: str, *, label: str) -> list[str]:
    """Every credential in one file's text, named by line and kind."""
    return [
        f"{label}:{number}: {kind}"
        for number, line in enumerate(text.splitlines(), start=1)
        if (kind := _line_violation(line)) is not None
    ]


def _committed_files(root: Path) -> list[Path]:
    """The repository's tracked files, or every file when root is not a checkout."""
    if (root / ".git").exists():
        import subprocess

        listed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        return [
            root / relative
            for relative in sorted(entry for entry in listed.split("\0") if entry)
        ]
    return sorted(path for path in root.rglob("*") if path.is_file())


def scan_repository(root: Path | str) -> list[str]:
    """Name every credential in the committed tree, file and line, never value."""
    root = Path(root)
    violations: list[str] = []
    for path in _committed_files(root):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in SKIP_DIRS for part in relative.parts):
            continue
        if path.suffix.lower() in SKIP_SUFFIXES or _is_fixture(relative):
            continue
        try:
            if path.stat().st_size > MAX_BYTES:
                continue
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        violations.extend(scan_text(text, label=relative.as_posix()))
    return violations


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    root = Path(args[0]) if args else Path(__file__).resolve().parent.parent
    violations = scan_repository(root)
    for violation in violations:
        # The credential itself is never printed: file, line and kind only.
        print(violation, file=sys.stderr)
    if violations:
        print(
            f"secret scan: {len(violations)} credential(s) committed; "
            "secrets come from the host environment only",
            file=sys.stderr,
        )
        return 1
    print("secret scan: ok (no committed credential)")
    return 0


__all__ = [
    "KEY_SHAPED",
    "KEY_SHAPED_KIND",
    "SECRET_VALUE_KIND",
    "URL_USERINFO_KIND",
    "main",
    "scan_repository",
    "scan_text",
]


if __name__ == "__main__":
    raise SystemExit(main())

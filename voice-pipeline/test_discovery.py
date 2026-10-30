"""Every test file must actually be discovered.

`unittest discover` skips a directory without `__init__.py` and still exits 0,
so a new package can look green with zero tests. This guard compares the files
on disk with the suites the loader found.
"""

from __future__ import annotations

import unittest
from pathlib import Path

PIPELINE_ROOT = Path(__file__).resolve().parent


def test_files() -> list[Path]:
    return sorted(
        path
        for path in PIPELINE_ROOT.rglob("test_*.py")
        if "__pycache__" not in path.parts
    )


def discovered_modules() -> set[str]:
    loader = unittest.TestLoader()
    suite = loader.discover(str(PIPELINE_ROOT), pattern="test_*.py", top_level_dir=str(PIPELINE_ROOT))
    modules: set[str] = set()

    def walk(item: unittest.TestSuite) -> None:
        for test in item:
            if isinstance(test, unittest.TestSuite):
                walk(test)
            else:
                modules.add(test.__class__.__module__)

    walk(suite)
    return modules


class DiscoveryTests(unittest.TestCase):
    def test_every_test_directory_is_a_package(self):
        for path in test_files():
            if path.parent == PIPELINE_ROOT:
                continue
            self.assertTrue(
                (path.parent / "__init__.py").is_file(),
                f"{path.parent.name}/test_*.py is not discoverable without __init__.py",
            )

    def test_every_test_file_is_discovered(self):
        expected = {
            ".".join(path.relative_to(PIPELINE_ROOT).with_suffix("").parts)
            for path in test_files()
        }
        found = discovered_modules()
        missing = sorted(expected - found)
        self.assertEqual(missing, [], f"undiscovered test modules: {missing}")

    def test_discovery_is_not_vacuous(self):
        self.assertGreater(len(discovered_modules()), 20)


if __name__ == "__main__":
    unittest.main()

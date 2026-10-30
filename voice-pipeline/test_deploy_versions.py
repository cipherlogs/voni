"""The deploy artifact records both versions, and a committed key fails (141).

Seams:

* ``deploy.versions`` — the committed record of the app's and the service's
  versions and the protocol version each speaks. ``deploy.topology`` reads it
  next to the two code copies of the protocol number, so a mismatch is a named
  deploy error before a cutover claim rather than a surprise mid-call.
* ``deploy.secret_scan`` — the repository scan: a credential value anywhere a
  deployed artifact could carry it fails, and a test file's deliberate fake is
  exempt. The scan reports the file and line, never the value.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from deploy import secret_scan, topology

APP_CONFIG = topology.APP_CONFIG
SERVICE_CONFIG = topology.SERVICE_CONFIG


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class ArtifactTests(unittest.TestCase):
    def test_the_artifact_records_the_app_and_the_service_versions(self):
        record = load(REPO_ROOT / topology.VERSIONS_RECORD)

        self.assertEqual(record["app"]["name"], "voni-app")
        self.assertEqual(record["service"]["name"], "voni-voice-pipeline")
        for party in ("app", "service"):
            entry = record[party]
            self.assertTrue(entry["version"], f"{party} version is unrecorded")
            self.assertTrue(entry["source"], f"{party} version source is unrecorded")

    def test_the_app_version_is_the_package_version(self):
        record = load(REPO_ROOT / topology.VERSIONS_RECORD)
        package = load(REPO_ROOT / "voni/package.json")

        self.assertEqual(record["app"]["version"], package["version"])
        self.assertEqual(record["app"]["source"], "voni/package.json#version")

    def test_both_parties_speak_the_one_protocol_version(self):
        record = load(REPO_ROOT / topology.VERSIONS_RECORD)
        protocol = topology.protocol_versions(REPO_ROOT)

        self.assertEqual(
            record["app"]["protocolVersion"], record["service"]["protocolVersion"]
        )
        self.assertEqual(record["service"]["protocolVersion"], protocol["service"])
        self.assertEqual(record["app"]["protocolVersion"], protocol["app"])

    def test_the_committed_artifact_validates(self):
        self.assertEqual(topology.validate_versions(REPO_ROOT), [])

    def test_a_protocol_mismatch_is_a_named_deploy_error(self):
        root = _temp_tree(self)
        record = load(root / topology.VERSIONS_RECORD)
        record["service"]["protocolVersion"] += 1
        (root / topology.VERSIONS_RECORD).write_text(json.dumps(record))

        errors = topology.validate_versions(root)

        self.assertTrue(
            any("protocol" in error and "service" in error for error in errors), errors
        )

    def test_an_artifact_without_both_parties_is_refused(self):
        root = _temp_tree(self)
        record = load(root / topology.VERSIONS_RECORD)
        del record["service"]
        (root / topology.VERSIONS_RECORD).write_text(json.dumps(record))

        errors = topology.validate_versions(root)

        self.assertTrue(any("service" in error for error in errors), errors)


class SecretScanTests(unittest.TestCase):
    def test_the_committed_repository_carries_no_credential(self):
        self.assertEqual(secret_scan.scan_repository(REPO_ROOT), [])

    def test_a_key_in_a_deployed_file_fails_the_scan(self):
        root = _temp_tree(self)
        target = root / "voice-pipeline" / "config.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('META_API_KEY = "sk-live-abc123def456"\n')

        violations = secret_scan.scan_repository(root)

        self.assertTrue(any("config.py" in entry for entry in violations), violations)

    def test_a_database_url_with_a_password_fails_the_scan(self):
        root = _temp_tree(self)
        target = root / "deploy" / "compose.yml"
        target.write_text("DATABASE_URL=postgres://voni:hunter2@db.internal/voni\n")

        violations = secret_scan.scan_repository(root)

        self.assertTrue(any("DATABASE_URL" in entry or "compose.yml" in entry for entry in violations), violations)

    def test_the_scan_never_echoes_the_credential(self):
        root = _temp_tree(self)
        credential = "sk-live-abc123def456"
        (root / "voice-pipeline" / "leak.py").write_text(f'KEY = "{credential}"\n')

        violations = secret_scan.scan_repository(root)

        self.assertTrue(violations)
        self.assertNotIn(credential, "\n".join(violations))

    def test_a_test_fixture_is_exempt_but_production_code_is_not(self):
        root = _temp_tree(self)
        credential = "sk-live-abc123def456"
        (root / "voice-pipeline" / "test_fixture.py").write_text(f'KEY = "{credential}"\n')
        (root / "voice-pipeline" / "server.py").write_text(f'KEY = "{credential}"\n')

        violations = secret_scan.scan_repository(root)

        self.assertTrue(any("server.py" in entry for entry in violations), violations)
        self.assertFalse(
            any("test_fixture.py" in entry for entry in violations), violations
        )

    def test_the_scan_exits_non_zero_and_names_the_file(self):
        import contextlib
        import io

        root = _temp_tree(self)
        (root / "voice-pipeline" / "leak.py").write_text('KEY = "sk-live-abc123def456"\n')

        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            self.assertEqual(secret_scan.main([str(root)]), 1)
            self.assertEqual(secret_scan.main([str(REPO_ROOT)]), 0)

        self.assertIn("leak.py", captured.getvalue())


def _temp_tree(case: unittest.TestCase) -> Path:
    """A copy of the deployment artifact inputs, small enough to mutate."""
    root = Path(tempfile.mkdtemp(prefix="deploy-versions-"))
    case.addCleanup(shutil.rmtree, root, True)
    for relative in (
        topology.VERSIONS_RECORD,
        topology.SERVICE_CONFIG,
        topology.APP_CONFIG,
        "voice-pipeline/cascade/token.py",
        "voni/src/lib/voice/cascade-session.ts",
    ):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / relative, target)
    return root


if __name__ == "__main__":
    unittest.main()

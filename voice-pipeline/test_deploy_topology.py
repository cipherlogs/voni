"""Deployment topology (ticket 135): Fly.io, two instances, rolling, WebSocket.

The artifact this ticket ships is a deployment config, so that is the seam:
these tests parse the committed files and ask ``deploy/topology.py`` to name
every violation. Nothing here inspects a Fly API — the config is the claim, and
the validator is what a deploy (or a reviewer) runs before trusting it.

The two load-bearing assertions are the ticket's ACs: dropping the instance
count to one, or removing the health check, must fail. Both are exercised here
against the real file (copied, then mutated), so a check deleted from the
validator fails a test rather than silently passing.
"""

from __future__ import annotations

import contextlib
import io
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# The drain wait is an operational bound with a stated source (ticket 04), so
# the test reads it from the registry rather than restating 30 s here.
from cascade.thresholds import require_bound
from deploy import topology

DRAIN_MAX_WAIT_MS = int(require_bound("deploy.drain_max_wait_ms"))

# Every file the topology claim depends on; a temp copy lets a test mutate one
# without touching the worktree.
TOPOLOGY_FILES = (
    topology.SERVICE_CONFIG,
    topology.APP_CONFIG,
    topology.COMPOSE_CONFIG,
    topology.DOCKERFILE,
    topology.DOCKERIGNORE,
    topology.SECRETS_EXAMPLE,
    topology.DEPLOYMENT_RECORD,
    topology.HOST_DECISION,
    topology.RUNTIME_REQUIREMENTS,
    topology.CI_REQUIREMENTS,
    "voice-pipeline/cascade/thresholds.json",
)


class CommittedTopologyTest(unittest.TestCase):
    def test_the_committed_topology_is_valid(self) -> None:
        errors = topology.validate(REPO_ROOT, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertEqual(errors, [], "\n".join(errors))

    def test_the_cli_is_green_on_the_committed_topology(self) -> None:
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            self.assertEqual(topology.main([str(REPO_ROOT)]), 0, captured.getvalue())

    def test_the_registry_reader_agrees_with_the_threshold_registry(self) -> None:
        # The validator reads thresholds.json without importing the cascade
        # package; that shortcut must not drift from the real loader.
        self.assertEqual(
            topology.drain_max_wait_ms_from_registry(REPO_ROOT), DRAIN_MAX_WAIT_MS
        )


class TwoInstanceTest(unittest.TestCase):
    def test_the_service_runs_at_least_two_machines(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        self.assertGreaterEqual(
            doc["http_service"]["min_machines_running"], topology.MIN_INSTANCES
        )

    def test_one_instance_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["http_service"]["min_machines_running"] = 1
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(
            any("min_machines_running" in error for error in errors),
            errors,
        )

    def test_a_missing_instance_count_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        del doc["http_service"]["min_machines_running"]
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("min_machines_running" in error for error in errors), errors)

    def test_the_app_also_runs_at_least_two_machines(self) -> None:
        app = topology.load_config(REPO_ROOT, topology.APP_CONFIG)
        app["http_service"]["min_machines_running"] = 1
        service = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        errors = topology.validate_app(app, service_doc=service)
        self.assertTrue(any("min_machines_running" in error for error in errors), errors)

    def test_an_auto_stopping_machine_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["http_service"]["auto_stop_machines"] = True
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("auto_stop_machines" in error for error in errors), errors)

    def test_a_multi_worker_command_is_refused(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text() + "\n# --workers 4\n"
        port = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)["http_service"][
            "internal_port"
        ]
        errors = topology.validate_dockerfile(text, internal_port=port)
        self.assertTrue(any("--workers" in error for error in errors), errors)


class HealthCheckTest(unittest.TestCase):
    def test_the_committed_service_probes_healthz(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        paths = [check["path"] for check in doc["http_service"]["checks"]]
        self.assertIn("/healthz", paths)

    def test_removing_the_health_check_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        del doc["http_service"]["checks"]
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("checks" in error for error in errors), errors)

    def test_an_empty_health_check_list_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["http_service"]["checks"] = []
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("checks" in error for error in errors), errors)

    def test_readiness_is_not_the_platform_probe(self) -> None:
        # /readyz fails while draining (ticket 139); a platform probe on it
        # would kill a machine that is still finishing live calls.
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["http_service"]["checks"][0]["path"] = "/readyz"
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("/healthz" in error for error in errors), errors)

    def test_a_check_missing_its_timing_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        del doc["http_service"]["checks"][0]["interval"]
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("interval" in error for error in errors), errors)

    def test_removing_the_app_health_check_is_refused(self) -> None:
        app = topology.load_config(REPO_ROOT, topology.APP_CONFIG)
        del app["http_service"]["checks"]
        service = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        errors = topology.validate_app(app, service_doc=service)
        self.assertTrue(any("checks" in error for error in errors), errors)


class RollingAndDrainTest(unittest.TestCase):
    def test_a_non_rolling_strategy_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["deploy"]["strategy"] = "immediate"
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("rolling" in error for error in errors), errors)

    def test_a_drain_timeout_shorter_than_the_recorded_bound_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["kill_timeout"] = DRAIN_MAX_WAIT_MS // 1000 - 1
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("kill_timeout" in error for error in errors), errors)

    def test_a_missing_sigterm_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["kill_signal"] = "SIGKILL"
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("kill_signal" in error for error in errors), errors)

    def test_the_committed_kill_timeout_covers_the_registry_bound(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        self.assertGreaterEqual(doc["kill_timeout"] * 1000, DRAIN_MAX_WAIT_MS)


class SeparationTest(unittest.TestCase):
    def test_the_app_and_the_service_are_different_fly_apps(self) -> None:
        service = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        app = topology.load_config(REPO_ROOT, topology.APP_CONFIG)
        self.assertNotEqual(service["app"], app["app"])

    def test_the_service_image_is_not_the_app_image(self) -> None:
        service = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        app = topology.load_config(REPO_ROOT, topology.APP_CONFIG)
        self.assertNotEqual(
            service["build"].get("dockerfile"), app["build"].get("dockerfile")
        )

    def test_sharing_the_service_app_name_is_refused(self) -> None:
        service = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        app = topology.load_config(REPO_ROOT, topology.APP_CONFIG)
        app["app"] = service["app"]
        errors = topology.validate_app(app, service_doc=service)
        self.assertTrue(any("separately" in error for error in errors), errors)

    def test_sharing_the_service_port_is_refused(self) -> None:
        service = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        app = topology.load_config(REPO_ROOT, topology.APP_CONFIG)
        app["http_service"]["internal_port"] = service["http_service"]["internal_port"]
        errors = topology.validate_app(app, service_doc=service)
        self.assertTrue(any("internal_port" in error for error in errors), errors)

    def test_the_service_image_carries_no_app(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text() + "\nCOPY voni/ /srv/voni/\n"
        port = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)["http_service"][
            "internal_port"
        ]
        errors = topology.validate_dockerfile(text, internal_port=port)
        self.assertTrue(any("voni/" in error for error in errors), errors)


class SecretsTest(unittest.TestCase):
    def test_every_secret_the_service_reads_is_named_without_a_value(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        self.assertEqual(topology.validate_secrets_example(text), [])

    def test_a_committed_secret_value_is_refused(self) -> None:
        doc = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        doc["env"]["META_API_KEY"] = "not-a-real-key-but-a-value"
        errors = topology.validate_service(doc, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertTrue(any("META_API_KEY" in error for error in errors), errors)

    def test_the_secret_value_scan_catches_a_dotenv_assignment(self) -> None:
        self.assertEqual(
            topology.secret_values("ASSEMBLYAI_API_KEY=0123456789"), ["ASSEMBLYAI_API_KEY"]
        )
        self.assertEqual(topology.secret_values("ASSEMBLYAI_API_KEY="), [])

    def test_an_unread_secret_name_is_refused(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        errors = topology.validate_secrets_example(text + "\nANTHROPIC_API_KEY=\n")
        self.assertTrue(any("ANTHROPIC_API_KEY" in error for error in errors), errors)

    def test_a_value_in_the_names_file_is_refused(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        polluted = text.replace("META_API_KEY=", "META_API_KEY=abc")
        errors = topology.validate_secrets_example(polluted)
        self.assertTrue(any("META_API_KEY" in error for error in errors), errors)


class ImageAndPinsTest(unittest.TestCase):
    def test_the_image_pins_match_ci(self) -> None:
        runtime = (REPO_ROOT / topology.RUNTIME_REQUIREMENTS).read_text()
        ci = (REPO_ROOT / topology.CI_REQUIREMENTS).read_text()
        self.assertEqual(topology.validate_requirements(runtime, ci), [])

    def test_a_drifted_pin_is_refused(self) -> None:
        runtime = (REPO_ROOT / topology.RUNTIME_REQUIREMENTS).read_text()
        ci = (REPO_ROOT / topology.CI_REQUIREMENTS).read_text()
        drifted = runtime.replace("aiohttp==3.14.3", "aiohttp==9.9.9")
        errors = topology.validate_requirements(drifted, ci)
        self.assertTrue(any("aiohttp" in error for error in errors), errors)

    def test_the_exposed_port_matches_the_proxy(self) -> None:
        port = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)["http_service"][
            "internal_port"
        ]
        text = (REPO_ROOT / topology.DOCKERFILE).read_text()
        self.assertEqual(topology.validate_dockerfile(text, internal_port=port), [])

    def test_a_missing_expose_is_refused(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text().replace("EXPOSE 8766", "")
        errors = topology.validate_dockerfile(text, internal_port=8766)
        self.assertTrue(any("EXPOSE" in error for error in errors), errors)

    def test_the_image_carries_the_budget_record_it_cannot_start_without(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text()
        text = text.replace(
            "COPY voni/src/lib/demo/scoreboard-budgets.json /srv/scoreboard-budgets.json",
            "",
        )
        errors = topology.validate_dockerfile(text, internal_port=8766)
        self.assertTrue(any("scoreboard-budgets.json" in error for error in errors), errors)

    def test_the_build_context_keeps_the_budget_record(self) -> None:
        text = (REPO_ROOT / topology.DOCKERIGNORE).read_text()
        text = text.replace("!voni/src/lib/demo/scoreboard-budgets.json", "")
        errors = topology.validate_dockerignore(text)
        self.assertTrue(any("scoreboard-budgets.json" in error for error in errors), errors)


class RecordAndRehearsalTest(unittest.TestCase):
    def test_the_host_and_the_exclusion_are_recorded(self) -> None:
        service = topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)
        app = topology.load_config(REPO_ROOT, topology.APP_CONFIG)
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text()
        self.assertEqual(
            topology.validate_record(
                record, service_app=service["app"], app_name=app["app"]
            ),
            [],
        )

    def test_a_record_without_the_excluded_runtime_is_refused(self) -> None:
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text()
        errors = topology.validate_record(
            record.replace("Cloudflare Workers", "some runtime"),
            service_app="voni-voice-pipeline",
            app_name="voni-app",
        )
        self.assertTrue(any("Cloudflare Workers" in error for error in errors), errors)

    def test_the_compose_rehearsal_keeps_two_replicas(self) -> None:
        text = (REPO_ROOT / topology.COMPOSE_CONFIG).read_text()
        self.assertEqual(topology.validate_compose(text, internal_port=8766), [])

    def test_a_single_replica_rehearsal_is_refused(self) -> None:
        text = (REPO_ROOT / topology.COMPOSE_CONFIG).read_text().replace(
            "replicas: 2", "replicas: 1"
        )
        errors = topology.validate_compose(text, internal_port=8766)
        self.assertTrue(any("replicas" in error for error in errors), errors)


class ValidatorWiringTest(unittest.TestCase):
    """The file-level entry point, not only the per-config functions."""

    def _temp_topology(self) -> Path:
        directory = Path(tempfile.mkdtemp(prefix="deploy-topology-"))
        self.addCleanup(shutil.rmtree, directory, True)
        for relative in TOPOLOGY_FILES:
            target = directory / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO_ROOT / relative, target)
        return directory

    def test_a_copied_topology_validates(self) -> None:
        self.assertEqual(topology.validate(self._temp_topology()), [])

    def test_validate_reports_a_one_instance_file(self) -> None:
        root = self._temp_topology()
        config = root / topology.SERVICE_CONFIG
        config.write_text(
            config.read_text().replace("min_machines_running = 2", "min_machines_running = 1")
        )
        errors = topology.validate(root)
        self.assertTrue(any("min_machines_running" in error for error in errors), errors)

    def test_validate_reports_a_removed_health_check(self) -> None:
        root = self._temp_topology()
        config = root / topology.SERVICE_CONFIG
        text = config.read_text()
        start = text.index("  [[http_service.checks]]")
        end = text.index("[[vm]]")
        config.write_text(text[:start] + text[end:])
        errors = topology.validate(root)
        self.assertTrue(any("checks" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()

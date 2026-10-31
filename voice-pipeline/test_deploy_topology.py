"""Deployment topology (ticket 19): one Northflank service, one instance.

The artifact this ticket ships is a deployment descriptor, so that is the seam:
these tests parse the committed Northflank descriptor and ask
``deploy/topology.py`` to name every violation. Nothing here calls the
Northflank API — the descriptor is the claim, and the validator is what a
deploy (or a reviewer) runs before trusting it.

Every load-bearing rule has a test that mutates the committed file and fails
when the rule is violated: one service, one instance, one Postgres addon, one
single-read/write volume, the HTTP liveness probe on 8766, a grace period equal
to the recorded drain bound, no Fly descriptor, and exactly one envelope
secret. A rule deleted from the validator fails a test here rather than
silently passing.
"""

from __future__ import annotations

import contextlib
import io
import json
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
    topology.VERSIONS_RECORD,
    topology.COMPOSE_CONFIG,
    topology.DOCKERFILE,
    topology.DOCKERIGNORE,
    topology.SECRETS_EXAMPLE,
    topology.DEPLOYMENT_RECORD,
    topology.HOST_DECISION,
    topology.RUNTIME_REQUIREMENTS,
    topology.CI_REQUIREMENTS,
    topology.TOKEN_MODULE,
    topology.APP_PROTOCOL_CLIENT,
    "voice-pipeline/cascade/thresholds.json",
)


def load_service() -> dict:
    return topology.load_config(REPO_ROOT, topology.SERVICE_CONFIG)


def validate_service(doc: dict, *, drain_max_wait_ms: int = DRAIN_MAX_WAIT_MS) -> list[str]:
    return topology.validate_service(doc, drain_max_wait_ms=drain_max_wait_ms)


class CommittedTopologyTest(unittest.TestCase):
    def test_the_committed_topology_is_valid(self) -> None:
        errors = topology.validate(REPO_ROOT, drain_max_wait_ms=DRAIN_MAX_WAIT_MS)
        self.assertEqual(errors, [], "\n".join(errors))

    def test_the_cli_is_green_on_the_committed_topology(self) -> None:
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            self.assertEqual(topology.main([str(REPO_ROOT)]), 0, captured.getvalue())

    def test_the_cli_names_the_northflank_one_instance_shape(self) -> None:
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            self.assertEqual(topology.main([str(REPO_ROOT)]), 0, captured.getvalue())
        message = captured.getvalue().lower()
        self.assertIn("northflank", message)
        self.assertIn("one instance", message)
        self.assertNotIn("fly", message)

    def test_the_registry_reader_agrees_with_the_threshold_registry(self) -> None:
        # The validator reads thresholds.json without importing the cascade
        # package; that shortcut must not drift from the real loader.
        self.assertEqual(
            topology.drain_max_wait_ms_from_registry(REPO_ROOT), DRAIN_MAX_WAIT_MS
        )


class OneServiceTest(unittest.TestCase):
    def test_the_descriptor_names_one_service(self) -> None:
        doc = load_service()
        self.assertEqual(doc["host"], "northflank")
        self.assertTrue(doc["service"]["name"])
        self.assertNotIn("services", doc)

    def test_the_service_runs_exactly_one_instance(self) -> None:
        self.assertEqual(topology.MIN_INSTANCES, 1)
        self.assertEqual(topology.MAX_INSTANCES, 1)
        doc = load_service()
        self.assertEqual(doc["service"]["deploy"]["instances"], 1)

    def test_a_second_service_is_refused(self) -> None:
        for key in ("services", "app"):
            with self.subTest(key=key):
                doc = load_service()
                doc[key] = [{"name": "voni-app"}] if key == "services" else "voni-app"
                errors = validate_service(doc)
                self.assertTrue(any("one service" in error for error in errors), errors)

    def test_two_instances_are_refused(self) -> None:
        doc = load_service()
        doc["service"]["deploy"]["instances"] = 2
        errors = validate_service(doc)
        self.assertTrue(any("instances" in error for error in errors), errors)

    def test_zero_instances_are_refused(self) -> None:
        doc = load_service()
        doc["service"]["deploy"]["instances"] = 0
        errors = validate_service(doc)
        self.assertTrue(any("instances" in error for error in errors), errors)

    def test_a_missing_instance_count_is_refused(self) -> None:
        doc = load_service()
        del doc["service"]["deploy"]["instances"]
        errors = validate_service(doc)
        self.assertTrue(any("instances" in error for error in errors), errors)

    def test_a_missing_service_block_is_refused(self) -> None:
        doc = load_service()
        del doc["service"]
        errors = validate_service(doc)
        self.assertTrue(any("service" in error for error in errors), errors)


class PostgresAddonTest(unittest.TestCase):
    def test_the_descriptor_has_one_postgres_addon(self) -> None:
        doc = load_service()
        database = doc["database"]
        self.assertEqual(database["type"], "postgres")
        self.assertTrue(database["name"])
        self.assertEqual(database["env"], "DATABASE_URL")

    def test_a_missing_addon_is_refused(self) -> None:
        doc = load_service()
        del doc["database"]
        errors = validate_service(doc)
        self.assertTrue(any("postgres" in error.lower() for error in errors), errors)

    def test_a_non_postgres_addon_is_refused(self) -> None:
        doc = load_service()
        doc["database"]["type"] = "mysql"
        errors = validate_service(doc)
        self.assertTrue(any("postgres" in error.lower() for error in errors), errors)

    def test_an_addon_that_does_not_inject_database_url_is_refused(self) -> None:
        doc = load_service()
        doc["database"]["env"] = "STORE_URL"
        errors = validate_service(doc)
        self.assertTrue(any("DATABASE_URL" in error for error in errors), errors)


class SingleVolumeTest(unittest.TestCase):
    def test_the_descriptor_has_one_single_writer_volume(self) -> None:
        doc = load_service()
        self.assertEqual(len(doc["volumes"]), 1)
        volume = doc["volumes"][0]
        self.assertEqual(volume["accessMode"], "ReadWriteOnce")
        self.assertEqual(volume["mountPath"], "/var/lib/voni")

    def test_no_volume_is_refused(self) -> None:
        doc = load_service()
        doc["volumes"] = []
        errors = validate_service(doc)
        self.assertTrue(any("volume" in error.lower() for error in errors), errors)

    def test_two_volumes_are_refused(self) -> None:
        doc = load_service()
        doc["volumes"].append(
            {
                "name": "voice-second",
                "mountPath": "/var/lib/other",
                "sizeGb": 1,
                "accessMode": "ReadWriteOnce",
            }
        )
        errors = validate_service(doc)
        self.assertTrue(any("volume" in error.lower() for error in errors), errors)

    def test_a_multi_writer_volume_is_refused(self) -> None:
        doc = load_service()
        doc["volumes"][0]["accessMode"] = "ReadWriteMany"
        errors = validate_service(doc)
        self.assertTrue(any("ReadWriteOnce" in error for error in errors), errors)

    def test_the_volume_holds_the_events_directory(self) -> None:
        doc = load_service()
        events_dir = doc["env"]["VOICE_PIPELINE_EVENTS_DIR"]
        self.assertEqual(doc["volumes"][0]["mountPath"], "/var/lib/voni")
        self.assertTrue(events_dir.startswith("/var/lib/voni/"), events_dir)


class LivenessProbeTest(unittest.TestCase):
    def test_the_probe_is_http_healthz_on_the_service_port(self) -> None:
        doc = load_service()
        probe = doc["healthCheck"]
        port = doc["ports"][0]["internalPort"]
        self.assertEqual(probe["type"], "liveness")
        self.assertEqual(probe["method"], "GET")
        self.assertEqual(probe["path"], "/healthz")
        self.assertEqual(probe["port"], port)
        self.assertEqual(port, 8766)

    def test_readiness_is_not_the_platform_probe(self) -> None:
        doc = load_service()
        doc["healthCheck"]["path"] = "/readyz"
        errors = validate_service(doc)
        self.assertTrue(any("/healthz" in error for error in errors), errors)

    def test_a_readiness_typed_probe_is_refused(self) -> None:
        doc = load_service()
        doc["healthCheck"]["type"] = "readiness"
        errors = validate_service(doc)
        self.assertTrue(any("liveness" in error for error in errors), errors)

    def test_a_probe_on_another_port_is_refused(self) -> None:
        doc = load_service()
        doc["healthCheck"]["port"] = 8080
        errors = validate_service(doc)
        self.assertTrue(any("port" in error.lower() for error in errors), errors)

    def test_a_missing_probe_is_refused(self) -> None:
        doc = load_service()
        del doc["healthCheck"]
        errors = validate_service(doc)
        self.assertTrue(any("health" in error.lower() for error in errors), errors)

    def test_a_probe_missing_its_timing_is_refused(self) -> None:
        doc = load_service()
        del doc["healthCheck"]["periodSeconds"]
        errors = validate_service(doc)
        self.assertTrue(any("periodSeconds" in error for error in errors), errors)


class DrainGraceTest(unittest.TestCase):
    def test_the_grace_period_equals_the_recorded_drain_bound(self) -> None:
        doc = load_service()
        self.assertEqual(
            doc["terminationGracePeriodSeconds"] * 1000, DRAIN_MAX_WAIT_MS
        )

    def test_a_shorter_grace_period_is_refused(self) -> None:
        doc = load_service()
        doc["terminationGracePeriodSeconds"] = DRAIN_MAX_WAIT_MS // 1000 - 1
        errors = validate_service(doc)
        self.assertTrue(
            any("terminationGracePeriodSeconds" in error for error in errors), errors
        )

    def test_a_longer_grace_period_is_refused(self) -> None:
        # Equality is the rule: the platform bound is the drain bound, not a
        # second, longer policy that a deploy could hide behind.
        doc = load_service()
        doc["terminationGracePeriodSeconds"] = DRAIN_MAX_WAIT_MS // 1000 + 1
        errors = validate_service(doc)
        self.assertTrue(
            any("terminationGracePeriodSeconds" in error for error in errors), errors
        )

    def test_a_missing_grace_period_is_refused(self) -> None:
        doc = load_service()
        del doc["terminationGracePeriodSeconds"]
        errors = validate_service(doc)
        self.assertTrue(
            any("terminationGracePeriodSeconds" in error for error in errors), errors
        )

    def test_the_committed_drain_bound_is_thirty_seconds(self) -> None:
        self.assertEqual(DRAIN_MAX_WAIT_MS, 30_000)


class FlyRemovedTest(unittest.TestCase):
    def test_the_fly_descriptors_are_deleted(self) -> None:
        for relative in topology.FLY_CONFIGS:
            self.assertFalse((REPO_ROOT / relative).exists(), relative)
        self.assertEqual(
            sorted((REPO_ROOT / "deploy").glob("fly.*.toml")), []
        )

    def test_a_reintroduced_fly_descriptor_is_refused(self) -> None:
        root = _temp_topology(self)
        (root / topology.FLY_CONFIGS[0]).write_text('app = "voni-voice-pipeline"\n')
        errors = topology.validate(root)
        self.assertTrue(
            any("fly" in error.lower() for error in errors), errors
        )

    def test_the_validator_reads_no_fly_descriptor(self) -> None:
        self.assertNotIn("fly", topology.SERVICE_CONFIG.lower())
        for relative in topology.FLY_CONFIGS:
            self.assertNotEqual(topology.SERVICE_CONFIG, relative)

    def test_the_deployment_record_is_not_a_fly_record(self) -> None:
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text().lower()
        self.assertNotIn("fly.io", record)


class EnvelopeSecretTest(unittest.TestCase):
    def test_the_example_lists_one_envelope_secret_with_no_value(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        names = topology._parse_dotenv_names(text)
        lines = [
            line
            for line in text.splitlines()
            if line.strip().startswith(f"{topology.ENVELOPE_SECRET_NAME}=")
        ]
        self.assertEqual(len(lines), 1, lines)
        self.assertEqual(lines[0].strip(), f"{topology.ENVELOPE_SECRET_NAME}=")
        self.assertEqual(names[topology.ENVELOPE_SECRET_NAME], "")
        self.assertEqual(topology.validate_secrets_example(text), [])

    def test_a_second_envelope_secret_name_is_refused(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        errors = topology.validate_secrets_example(
            text + "\nVOICE_PIPELINE_SIGNING_SECRET=\n"
        )
        self.assertTrue(
            any("envelope secret" in error.lower() for error in errors), errors
        )

    def test_a_duplicate_envelope_secret_line_is_refused(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        errors = topology.validate_secrets_example(
            text + f"\n{topology.ENVELOPE_SECRET_NAME}=\n"
        )
        self.assertTrue(
            any("envelope secret" in error.lower() for error in errors), errors
        )

    def test_an_envelope_secret_value_is_refused(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        polluted = text.replace(
            f"{topology.ENVELOPE_SECRET_NAME}=",
            f"{topology.ENVELOPE_SECRET_NAME}=not-a-real-secret-value",
        )
        errors = topology.validate_secrets_example(polluted)
        self.assertTrue(
            any(topology.ENVELOPE_SECRET_NAME in error for error in errors), errors
        )

    def test_the_tool_base_url_is_the_app_public_origin(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        names = topology._parse_dotenv_names(text)
        self.assertEqual(
            names["VOICE_PIPELINE_TOOL_BASE_URL"], topology.APP_PUBLIC_ORIGIN
        )
        self.assertTrue(topology.APP_PUBLIC_ORIGIN.startswith("https://"))

    def test_a_wrong_tool_base_url_is_refused(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        broken = text.replace(
            f"VOICE_PIPELINE_TOOL_BASE_URL={topology.APP_PUBLIC_ORIGIN}",
            "VOICE_PIPELINE_TOOL_BASE_URL=http://localhost:3000",
        )
        errors = topology.validate_secrets_example(broken)
        self.assertTrue(
            any("VOICE_PIPELINE_TOOL_BASE_URL" in error for error in errors), errors
        )


class SecretsTest(unittest.TestCase):
    def test_every_secret_the_service_reads_is_named_without_a_value(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        self.assertEqual(topology.validate_secrets_example(text), [])

    def test_a_committed_secret_value_is_refused(self) -> None:
        doc = load_service()
        doc["env"]["META_API_KEY"] = "not-a-real-key-but-a-value"
        errors = validate_service(doc)
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


class RequiredEnvTest(unittest.TestCase):
    """Every required host name is deployed, and an empty one is a deploy error.

    ``META_REASONING_EFFORT`` has no default (Spark refuses construction), and
    an empty ``VOICE_PIPELINE_TOOL_BASE_URL`` silently drops every tool call.
    A deploy file may delegate a required setting to the host's secret or env
    file, but it may never set an empty value: a blank entry is the blank
    runtime value, and Compose gives ``environment`` precedence over
    ``env_file``. The name itself is recorded in the example and the deployment
    record.
    """

    def test_the_committed_service_descriptor_never_sets_a_required_setting_empty(
        self,
    ) -> None:
        doc = load_service()
        self.assertEqual(validate_service(doc), [])
        for name in topology.REQUIRED_SETTINGS:
            if name in doc["env"]:
                self.assertTrue(str(doc["env"][name]).strip(), name)

    def test_an_empty_required_setting_is_refused(self) -> None:
        for name in topology.REQUIRED_SETTINGS:
            with self.subTest(name=name):
                broken = load_service()
                broken["env"][name] = ""
                errors = validate_service(broken)
                self.assertTrue(any(name in error for error in errors), errors)

    def test_the_example_names_every_required_name(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        self.assertEqual(topology.validate_secrets_example(text), [])

    def test_a_missing_name_in_the_example_is_refused(self) -> None:
        text = (REPO_ROOT / topology.SECRETS_EXAMPLE).read_text()
        for name in topology.REQUIRED_ENV_NAMES:
            with self.subTest(name=name):
                broken = "\n".join(
                    line
                    for line in text.splitlines()
                    if not line.startswith(f"{name}=")
                )
                errors = topology.validate_secrets_example(broken)
                self.assertTrue(any(name in error for error in errors), errors)

    def test_the_compose_rehearsal_names_every_required_setting(self) -> None:
        text = (REPO_ROOT / topology.COMPOSE_CONFIG).read_text()
        self.assertEqual(topology.validate_compose(text, internal_port=8766), [])

    def test_an_empty_required_setting_in_compose_is_refused(self) -> None:
        text = (REPO_ROOT / topology.COMPOSE_CONFIG).read_text()
        for name in topology.REQUIRED_ENV_NAMES:
            with self.subTest(name=name):
                # The first environment block is the voice-pipeline service's.
                broken = text.replace(
                    "    environment:\n",
                    f'    environment:\n      {name}: ""\n',
                    1,
                )
                errors = topology.validate_compose(broken, internal_port=8766)
                self.assertTrue(any(name in error for error in errors), errors)

    def test_a_delegated_setting_needs_an_env_file(self) -> None:
        text = (REPO_ROOT / topology.COMPOSE_CONFIG).read_text()
        broken = "\n".join(
            line
            for line in text.splitlines()
            if not any(
                line.strip().startswith(f"{name}:")
                for name in topology.REQUIRED_SETTINGS
            )
        ).replace("./voice-pipeline.env", "./other.env")
        errors = topology.validate_compose(broken, internal_port=8766)
        self.assertTrue(any("env_file" in error for error in errors), errors)

    def test_the_record_names_every_required_name(self) -> None:
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text()
        for name in topology.REQUIRED_ENV_NAMES:
            self.assertIn(name, record, name)


class DrainAwareEntrypointTest(unittest.TestCase):
    """The image must run main(), not uvicorn's server:app (ticket 140).

    ``uvicorn server:app`` never installs the drain supervisor, so SIGTERM
    exits and every live call dies with the instance. The entrypoint is
    therefore part of the topology claim, and deleting it must fail the
    validator.
    """

    def _port(self) -> int:
        return load_service()["ports"][0]["internalPort"]

    def test_the_committed_command_runs_the_drain_aware_entrypoint(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text()
        cmd = [
            line for line in text.splitlines() if line.strip().upper().startswith("CMD")
        ]
        self.assertTrue(cmd, "the image declares no CMD")
        self.assertIn("server.py", " ".join(cmd))
        self.assertNotIn("server:app", " ".join(cmd))
        self.assertEqual(topology.validate_dockerfile(text, internal_port=self._port()), [])

    def test_a_uvicorn_server_app_command_is_refused(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text()
        start = text.index('CMD ["python", "server.py"]')
        end = text.index("\n", start)
        broken = text[:start] + (
            'CMD ["python", "-m", "uvicorn", "server:app", "--host", '
            '"0.0.0.0", "--port", "8766"]'
        ) + text[end:]
        errors = topology.validate_dockerfile(broken, internal_port=self._port())
        self.assertTrue(any("server.py" in error for error in errors), errors)

    def test_deleting_the_drain_aware_entrypoint_is_refused(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text()
        broken = "\n".join(
            line
            for line in text.splitlines()
            if not line.strip().upper().startswith("CMD")
        )
        errors = topology.validate_dockerfile(broken, internal_port=self._port())
        self.assertTrue(any("server.py" in error for error in errors), errors)

    def test_a_multi_worker_command_is_refused(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text() + "\n# --workers 4\n"
        errors = topology.validate_dockerfile(text, internal_port=self._port())
        self.assertTrue(any("--workers" in error for error in errors), errors)


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

    def test_the_exposed_port_matches_the_descriptor(self) -> None:
        port = load_service()["ports"][0]["internalPort"]
        text = (REPO_ROOT / topology.DOCKERFILE).read_text()
        self.assertEqual(topology.validate_dockerfile(text, internal_port=port), [])

    def test_a_missing_expose_is_refused(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text().replace("EXPOSE 8766", "")
        errors = topology.validate_dockerfile(text, internal_port=8766)
        self.assertTrue(any("EXPOSE" in error for error in errors), errors)

    def test_the_image_carries_no_app(self) -> None:
        text = (REPO_ROOT / topology.DOCKERFILE).read_text() + "\nCOPY voni/ /srv/voni/\n"
        errors = topology.validate_dockerfile(text, internal_port=8766)
        self.assertTrue(any("voni/" in error for error in errors), errors)

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
        service = load_service()
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text()
        self.assertEqual(
            topology.validate_record(
                record,
                service_name=service["service"]["name"],
                app_name="voni-app",
            ),
            [],
        )

    def test_a_record_without_the_excluded_runtime_is_refused(self) -> None:
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text()
        errors = topology.validate_record(
            record.replace("Cloudflare Workers", "some runtime"),
            service_name="voice-pipeline",
            app_name="voni-app",
        )
        self.assertTrue(any("Cloudflare Workers" in error for error in errors), errors)

    def test_a_record_that_names_fly_as_the_host_is_refused(self) -> None:
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text()
        errors = topology.validate_record(
            record.replace("Northflank", "Fly.io"),
            service_name="voice-pipeline",
            app_name="voni-app",
        )
        self.assertTrue(any("Northflank" in error for error in errors), errors)

    def test_a_record_without_the_one_instance_shape_is_refused(self) -> None:
        record = (REPO_ROOT / topology.DEPLOYMENT_RECORD).read_text()
        broken = record.replace("one instance", "several instances").replace(
            "One instance", "Several instances"
        )
        errors = topology.validate_record(
            broken,
            service_name="voice-pipeline",
            app_name="voni-app",
        )
        self.assertTrue(any("one instance" in error for error in errors), errors)

    def test_the_compose_rehearsal_keeps_the_one_instance_shape(self) -> None:
        text = (REPO_ROOT / topology.COMPOSE_CONFIG).read_text()
        self.assertEqual(topology.validate_compose(text, internal_port=8766), [])

    def test_two_replicas_in_the_rehearsal_are_refused(self) -> None:
        text = (REPO_ROOT / topology.COMPOSE_CONFIG).read_text().replace(
            "replicas: 1", "replicas: 2"
        )
        errors = topology.validate_compose(text, internal_port=8766)
        self.assertTrue(any("replicas" in error for error in errors), errors)


class ValidatorWiringTest(unittest.TestCase):
    """The file-level entry point, not only the per-config functions."""

    def _temp_topology(self) -> Path:
        return _temp_topology(self)

    def test_a_copied_topology_validates(self) -> None:
        self.assertEqual(topology.validate(self._temp_topology()), [])

    def test_validate_reports_a_two_instance_file(self) -> None:
        root = self._temp_topology()
        config = root / topology.SERVICE_CONFIG
        doc = json.loads(config.read_text())
        doc["service"]["deploy"]["instances"] = 2
        config.write_text(json.dumps(doc))
        errors = topology.validate(root)
        self.assertTrue(any("instances" in error for error in errors), errors)

    def test_validate_reports_a_removed_probe(self) -> None:
        root = self._temp_topology()
        config = root / topology.SERVICE_CONFIG
        doc = json.loads(config.read_text())
        del doc["healthCheck"]
        config.write_text(json.dumps(doc))
        errors = topology.validate(root)
        self.assertTrue(any("health" in error.lower() for error in errors), errors)


def _temp_topology(case: unittest.TestCase) -> Path:
    directory = Path(tempfile.mkdtemp(prefix="deploy-topology-"))
    case.addCleanup(shutil.rmtree, directory, True)
    for relative in TOPOLOGY_FILES:
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / relative, target)
    return directory


if __name__ == "__main__":
    unittest.main()

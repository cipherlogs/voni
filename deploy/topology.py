"""The deployment topology as a checked artifact (ticket 19).

The acceptance criteria are properties of the files a deploy reads, not of a
Python object, so this module reads those files and returns a list of named
violations (the house style: an empty list means valid, the same shape as
``config.validate_pipeline_config``). ``python deploy/topology.py`` prints them
and exits non-zero; ``voice-pipeline/test_deploy_topology.py`` asserts the
committed topology validates and that each load-bearing rule can fail.

What is checked:

* the host is Northflank and the shape is **one** combined service running
  **one** instance, a single Postgres addon and one single-read/write volume
  (``deploy/northflank/service.json`` is the committed topology record);
* the platform probe is HTTP liveness ``GET /healthz`` on 8766; readiness is
  not the platform probe, because a draining instance must stay reachable to
  finish live calls;
* the platform grace period equals the recorded 30-second drain bound, so a
  deploy drains live calls and refuses new ones for exactly that window;
* the Fly descriptors are deleted and no topology rule resurrects them;
* no secret value is committed anywhere, only names, and the environment
  example carries exactly one envelope secret, blank;
* the artifact records both parties' versions and they speak one protocol
  version: a mismatch is a deploy error;
* the image's pinned runtime dependencies agree with ``requirements-ci.txt``
  and the exposed port agrees with the descriptor and the command.

Nothing here calls the Northflank API. The descriptor is the claim; a deploy
reads the same file.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

try:  # imported as ``deploy.topology`` (tests) or run as a script (deploy/topology.py)
    from . import secret_scan
except ImportError:  # pragma: no cover - the script path
    import secret_scan  # type: ignore[no-redef]

#: One instance, and no more: the token registry and the delivered-body channel
#: are in-process, so a second instance would break single use and hold return.
MIN_INSTANCES = 1
MAX_INSTANCES = 1

#: The committed Northflank descriptor. It is the topology record a deploy
#: reads; the setup path next to it explains how the resources are created.
SERVICE_CONFIG = "deploy/northflank/service.json"
COMPOSE_CONFIG = "deploy/docker-compose.yml"
DOCKERFILE = "voice-pipeline/Dockerfile"
DOCKERIGNORE = ".dockerignore"
SECRETS_EXAMPLE = "deploy/voice-pipeline.env.example"
DEPLOYMENT_RECORD = "docs/deploy/README.md"
HOST_DECISION = "docs/deploy/meta-cascade-host.md"
VERSIONS_RECORD = "deploy/versions.json"
TOKEN_MODULE = "voice-pipeline/cascade/token.py"
APP_PROTOCOL_CLIENT = "voni/src/lib/voice/cascade-session.ts"
RUNTIME_REQUIREMENTS = "voice-pipeline/requirements.txt"
CI_REQUIREMENTS = "requirements-ci.txt"

#: The Fly descriptors this ticket deleted. The glob is the rule: a descriptor
#: reintroduced under any name fails the validator, not only these two.
FLY_CONFIGS: tuple[str, ...] = (
    "deploy/fly.voice-pipeline.toml",
    "deploy/fly.voni.toml",
)
FLY_DESCRIPTOR_GLOB = "deploy/fly.*.toml"

#: The one envelope secret. One value on both sides (the app signs, the service
#: verifies); the environment example names it once and carries no value.
ENVELOPE_SECRET_NAME = "VOICE_PIPELINE_ENVELOPE_SECRET"

#: The app's public origin is the pipeline's tool base URL. It is not a secret
#: and it is not the pipeline host: the service calls the app's tool route.
APP_PUBLIC_ORIGIN = "https://app.voni.cc"

#: The liveness path and the one port the public proxy forwards to.
LIVENESS_PATH = "/healthz"
SERVICE_PORT = 8766

#: Where the single-read/write volume is mounted, and the events directory under
#: it. The image creates both for uid 10001.
VOLUME_MOUNT = "/var/lib/voni"

#: Every secret the service reads from its host environment, by name only.
#: Sources: meta_stt API_KEY_ENV, meta_llm IDENTIFIER_SALT_ENV, tools
#: TOOL_SECRET_ENV, server VOICE_PIPELINE_ENVELOPE_SECRET and DATABASE_URL
#: (the Postgres addon), plus the managed-path keys the dev browser route still
#: constructs. A value for any of these is never committed.
REQUIRED_SECRET_NAMES: tuple[str, ...] = (
    "META_API_KEY",
    "META_IDENTIFIER_SALT",
    "ASSEMBLYAI_API_KEY",
    "AI_GATEWAY_API_KEY",
    "VONI_TOOL_SECRET",
    "VOICE_PIPELINE_ENVELOPE_SECRET",
    "DATABASE_URL",
)

#: Non-secret host settings the service requires and may not invent.
#: META_REASONING_EFFORT is M03's measured value: Spark has no default, so a
#: default-rung call refuses construction without it. VOICE_PIPELINE_TOOL_BASE_URL
#: is the app origin the tool route calls; empty silently drops every tool call.
#: Both are host-supplied. A deploy file may omit a name (the host's secret or
#: env file supplies it) but may never set it to an empty value: Compose gives
#: ``environment`` precedence over ``env_file``, and a blank descriptor env entry
#: is a blank runtime value.
REQUIRED_SETTINGS: tuple[str, ...] = (
    "META_REASONING_EFFORT",
    "VOICE_PIPELINE_TOOL_BASE_URL",
)

#: Every name the deployment must carry, secret or not. The example file lists
#: them; the descriptor names the non-secret ones; the record explains them.
REQUIRED_ENV_NAMES: tuple[str, ...] = REQUIRED_SECRET_NAMES + REQUIRED_SETTINGS

#: The one non-secret environment setting the topology itself depends on.
PORT_ENV = "VOICE_PIPELINE_PORT"

#: A name whose *value* may never be committed: anything that reads like an
#: API key, a signing secret, a salt, a password or a connection string.
_SECRET_NAME_PARTS = ("KEY", "SECRET", "SALT", "TOKEN", "PASSWORD", "DATABASE_URL")

#: A second envelope/signing secret name is a typo the deploy would never
#: notice; the example carries exactly one.
_ENVELOPE_SECRET_MARKERS = ("ENVELOPE", "SIGNING", "HMAC")


def _read(repo_root: Path, relative: str) -> str | None:
    path = repo_root / relative
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8")


def load_config(repo_root: Path, relative: str) -> dict[str, Any]:
    """Read the one committed topology descriptor, raising when it is broken."""
    path = Path(repo_root) / relative
    with path.open("rb") as handle:
        document = json.load(handle)
    if not isinstance(document, dict):
        raise ValueError(f"{relative}: the descriptor must be an object")
    return document


def _load_descriptor(repo_root: Path, relative: str, errors: list[str]) -> dict[str, Any] | None:
    text = _read(repo_root, relative)
    if text is None:
        errors.append(f"missing {relative}: the topology cannot be checked without it")
        return None
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:  # pragma: no cover - a broken file
        errors.append(f"{relative}: not valid JSON ({exc})")
        return None
    if not isinstance(document, dict):
        errors.append(f"{relative}: the descriptor must be an object")
        return None
    return document


def looks_secret(name: str) -> bool:
    """True when a setting name reads like a credential."""
    upper = name.upper()
    return any(part in upper for part in _SECRET_NAME_PARTS)


def secret_values(text: str) -> list[str]:
    """Non-empty ``NAME=value`` assignments whose name reads like a credential.

    Covers dotenv lines and simple shell/Dockerfile assignments; a name with an
    empty value (a placeholder in the example file) is not a value.
    """
    hits: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "//")):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line or ":" in line.split("=", 1)[0]:
            continue
        name, _, value = line.partition("=")
        name = name.strip().strip('"').strip("'")
        value = value.strip().strip('"').strip("'")
        if not name or not value:
            continue
        if looks_secret(name):
            hits.append(name)
    return hits


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _check_env(doc: Mapping[str, Any], *, label: str, errors: list[str]) -> dict[str, str]:
    env = doc.get("env")
    if not isinstance(env, dict):
        return {}
    for name, value in env.items():
        if looks_secret(name) and str(value).strip():
            errors.append(
                f"{label}: env sets {name} to a value; secrets are host-only "
                "(the Northflank secret group), never committed"
            )
    return {str(name): str(value) for name, value in env.items()}


def validate_service(
    doc: Mapping[str, Any],
    *,
    drain_max_wait_ms: int,
    config: str = SERVICE_CONFIG,
) -> list[str]:
    """Every rule the one Northflank service must satisfy, named per line."""
    errors: list[str] = []
    label = config

    if doc.get("recordVersion") != 1:
        errors.append(
            f"{label}: recordVersion is {doc.get('recordVersion')!r}; this reader "
            "supports 1"
        )
    if doc.get("host") != "northflank":
        errors.append(
            f"{label}: host is {doc.get('host')!r}; the committed host is Northflank"
        )
    for key in ("services", "app"):
        if key in doc:
            errors.append(
                f"{label}: names {key!r}; the topology is one service "
                "(`service`), and the app is a separate deploy"
            )

    service = _mapping(doc.get("service"))
    if not service:
        errors.append(
            f"{label}: missing `service`; the topology is one combined service"
        )
    else:
        if not str(service.get("name") or "").strip():
            errors.append(f"{label}: service.name is unset; the service must be named")
        if service.get("type") != "combined":
            errors.append(
                f"{label}: service.type is {service.get('type')!r}; a combined "
                "service builds and deploys in one resource"
            )
    deploy = _mapping(service.get("deploy"))
    instances = deploy.get("instances")
    if isinstance(instances, bool) or not isinstance(instances, int):
        errors.append(
            f"{label}: service.deploy.instances is {instances!r}; the topology runs "
            "exactly one instance"
        )
    elif not (MIN_INSTANCES <= instances <= MAX_INSTANCES):
        errors.append(
            f"{label}: service.deploy.instances is {instances}; the topology runs "
            "exactly one instance. The token registry and the delivered-body "
            "channel are in-process, so a second instance breaks single use"
        )

    ports = doc.get("ports")
    port: int | None = None
    if not isinstance(ports, list) or len(ports) != 1:
        count = len(ports) if isinstance(ports, list) else ports
        errors.append(
            f"{label}: ports is {count!r}; the service publishes exactly one "
            f"public port and the proxy forwards to {SERVICE_PORT}"
        )
    else:
        entry = _mapping(ports[0])
        port = entry.get("internalPort") if _positive_int(entry.get("internalPort")) else None
        if port is None:
            errors.append(
                f"{label}: ports[0].internalPort is {entry.get('internalPort')!r}; "
                f"expected {SERVICE_PORT}"
            )
        if entry.get("protocol") != "HTTP":
            errors.append(
                f"{label}: ports[0].protocol is {entry.get('protocol')!r}; the "
                "public port must be HTTP/1.1. The service is uvicorn (h11), so an "
                "HTTP/2 ingress port answers every request with a 502 protocol "
                "error; Northflank's HTTP/1.1 ports carry WebSockets (measured "
                "2026-11-03 on the voice-pipeline deployment)"
            )
        if entry.get("public") is not True:
            errors.append(
                f"{label}: ports[0].public is {entry.get('public')!r}; the call "
                "socket must be reachable from the browser"
            )

    database = _mapping(doc.get("database"))
    if not database:
        errors.append(
            f"{label}: missing `database`; the durable store is one Postgres addon "
            "that injects DATABASE_URL"
        )
    else:
        if database.get("type") != "postgres":
            errors.append(
                f"{label}: database.type is {database.get('type')!r}; the durable "
                "store is a Postgres addon"
            )
        if not str(database.get("name") or "").strip():
            errors.append(f"{label}: database.name is unset; the addon must be named")
        if database.get("env") != "DATABASE_URL":
            errors.append(
                f"{label}: database.env is {database.get('env')!r}; the addon must "
                "inject DATABASE_URL, the one name the service reads"
            )

    volumes = doc.get("volumes")
    if not isinstance(volumes, list) or len(volumes) != 1:
        count = len(volumes) if isinstance(volumes, list) else volumes
        errors.append(
            f"{label}: volumes is {count!r}; the artifact dir is one "
            f"single-read/write volume at {VOLUME_MOUNT}"
        )
    else:
        volume = _mapping(volumes[0])
        if volume.get("accessMode") != "ReadWriteOnce":
            errors.append(
                f"{label}: volumes[0].accessMode is {volume.get('accessMode')!r}; "
                "the events volume is single read/write (ReadWriteOnce), which is "
                "the one-instance shape"
            )
        if volume.get("mountPath") != VOLUME_MOUNT:
            errors.append(
                f"{label}: volumes[0].mountPath is {volume.get('mountPath')!r}; the "
                f"image writes under {VOLUME_MOUNT}"
            )
        if not str(volume.get("name") or "").strip():
            errors.append(f"{label}: volumes[0].name is unset; the volume must be named")
        if not _positive_int(volume.get("sizeGb")):
            errors.append(
                f"{label}: volumes[0].sizeGb is {volume.get('sizeGb')!r}; expected "
                "a positive size"
            )

    env = _check_env(doc, label=label, errors=errors)
    for name in REQUIRED_SETTINGS:
        if name in env and not env[name].strip():
            errors.append(
                f"{label}: env sets {name} to an empty value; the host-supplied "
                "setting is then blank at runtime. Remove the key and let the "
                "Northflank environment supply the value"
            )
    tool_base = env.get("VOICE_PIPELINE_TOOL_BASE_URL")
    if tool_base is not None and tool_base.strip() and tool_base != APP_PUBLIC_ORIGIN:
        errors.append(
            f"{label}: env VOICE_PIPELINE_TOOL_BASE_URL is {tool_base!r}; it must be "
            f"the app's public origin {APP_PUBLIC_ORIGIN!r}"
        )
    if port is not None and env.get(PORT_ENV) != str(port):
        errors.append(
            f"{label}: env {PORT_ENV} is {env.get(PORT_ENV)!r} but the public port "
            f"forwards to {port}; the server would listen on the wrong port"
        )
    events_dir = env.get("VOICE_PIPELINE_EVENTS_DIR")
    if events_dir is not None and events_dir.strip() and not events_dir.startswith(
        f"{VOLUME_MOUNT}/"
    ):
        errors.append(
            f"{label}: env VOICE_PIPELINE_EVENTS_DIR is {events_dir!r}; the events "
            f"artifact must live under the mounted volume {VOLUME_MOUNT}"
        )

    probe = _mapping(doc.get("healthCheck"))
    if not probe:
        errors.append(
            f"{label}: missing `healthCheck`; the platform probe is HTTP "
            f"liveness GET {LIVENESS_PATH}"
        )
    else:
        if probe.get("type") != "liveness":
            errors.append(
                f"{label}: healthCheck.type is {probe.get('type')!r}; the platform "
                "probe is liveness, not readiness. A draining instance must stay "
                "reachable to finish live calls"
            )
        if probe.get("method") != "GET":
            errors.append(
                f"{label}: healthCheck.method is {probe.get('method')!r}; expected GET"
            )
        if probe.get("path") != LIVENESS_PATH:
            errors.append(
                f"{label}: healthCheck.path is {probe.get('path')!r}; the platform "
                f"probe must GET {LIVENESS_PATH}. Readiness (/readyz) is not the "
                "platform probe"
            )
        probe_port = probe.get("port")
        if probe_port != port:
            errors.append(
                f"{label}: healthCheck.port is {probe_port!r} but the service port "
                f"is {port!r}; the probe must hit the process the proxy forwards to"
            )
        for field in (
            "initialDelaySeconds",
            "periodSeconds",
            "timeoutSeconds",
            "failureThreshold",
        ):
            if not _positive_int(probe.get(field)):
                errors.append(
                    f"{label}: healthCheck.{field} is {probe.get(field)!r}; expected "
                    "a positive whole number"
                )

    grace = doc.get("terminationGracePeriodSeconds")
    if isinstance(grace, bool) or not isinstance(grace, int):
        errors.append(
            f"{label}: terminationGracePeriodSeconds is {grace!r}; expected the "
            "recorded deploy.drain_max_wait_ms"
        )
    elif grace * 1000 != drain_max_wait_ms:
        errors.append(
            f"{label}: terminationGracePeriodSeconds is {grace}s but the recorded "
            f"deploy.drain_max_wait_ms is {drain_max_wait_ms} ms; the platform grace "
            "period must equal the drain bound, not be shorter (a killed call) or "
            "longer (a second policy)"
        )
    return errors


def validate_dockerfile(text: str, *, internal_port: int, config: str = DOCKERFILE) -> list[str]:
    """One container for the Python service, and nothing of the app in it."""
    errors: list[str] = []
    label = config
    lowered = text.lower()

    if f"expose {internal_port}" not in lowered:
        errors.append(
            f"{label}: EXPOSE {internal_port} is missing but the proxy forwards to "
            f"{internal_port}"
        )
    # The image must run the service's ``main()``: that is where the SIGTERM
    # drain supervisor is installed. ``uvicorn server:app`` skips it, so a
    # deploy would exit on SIGTERM and end a live call (ticket 140).
    commands = [
        line.strip()
        for line in text.splitlines()
        if line.strip().upper().startswith("CMD")
    ]
    command = " ".join(commands).lower()
    if not commands:
        errors.append(
            f"{label}: no CMD; the image must run `python server.py` so the "
            "drain supervisor (ticket 140) is installed"
        )
    else:
        if "server.py" not in command:
            errors.append(
                f"{label}: the command must run `python server.py` (main()), "
                "which installs the SIGTERM drain supervisor; without it a "
                "deploy exits and ends a live call"
            )
        if "server:app" in command:
            errors.append(
                f"{label}: the command runs uvicorn's server:app; the drain "
                "supervisor lives in main(), so SIGTERM would end a live call"
            )
    if "voice-pipeline/requirements.txt" not in text:
        errors.append(
            f"{label}: the image must install voice-pipeline/requirements.txt so the "
            "runtime pins have one source"
        )
    # cascade.thresholds refuses to import without the frozen budget record, so
    # the image must carry that one file and name the override. It is the only
    # app artifact allowed in the image; the app tree itself is not.
    if text.count("scoreboard-budgets.json") < 2:
        errors.append(
            f"{label}: must copy voni/src/lib/demo/scoreboard-budgets.json and set "
            "VONI_SCOREBOARD_BUDGETS_JSON to it; cascade.thresholds refuses to import "
            "without the budget record, so the container would not start"
        )
    for line in text.splitlines():
        instruction = line.strip().upper()
        if (
            instruction.startswith(("COPY", "ADD"))
            and "voni/" in line
            and "scoreboard-budgets.json" not in line
        ):
            errors.append(
                f"{label}: copies {line.strip()!r} from the app; the app is its own "
                "image and separate deploy, and only the budget record belongs here"
            )
    if "--workers" in lowered:
        errors.append(
            f"{label}: runs the --workers flag; a call is one WebSocket on one "
            "process, and the one instance is one process"
        )
    for forbidden, reason in (
        ("node_modules", "the app's dependencies are not the service's"),
        ("npm ", "the service has no Node build"),
    ):
        if forbidden in lowered:
            errors.append(f"{label}: contains {forbidden!r}; {reason}")
    for name in secret_values(text):
        errors.append(f"{label}: assigns {name} a value; secrets come from the host env")
    return errors


def _dotenv_name(line: str) -> str:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return ""
    return stripped.partition("=")[0].strip().strip('"').strip("'")


def _parse_dotenv_names(text: str) -> dict[str, str]:
    names: dict[str, str] = {}
    for raw in text.splitlines():
        name = _dotenv_name(raw)
        if not name:
            continue
        _, _, value = raw.strip().partition("=")
        names[name] = value.strip().strip('"').strip("'")
    return names


def validate_secrets_example(text: str, config: str = SECRETS_EXAMPLE) -> list[str]:
    """Names only: one envelope secret, blank; the app origin for tool calls."""
    errors: list[str] = []
    names = _parse_dotenv_names(text)
    for required in REQUIRED_ENV_NAMES:
        if required not in names:
            errors.append(
                f"{config}: {required} is not listed; the deployment record must name "
                "every host environment variable the service reads"
            )
        elif required in REQUIRED_SECRET_NAMES and names[required]:
            errors.append(
                f"{config}: {required} has a value; this file records names only"
            )
    envelope_lines = [
        line for line in text.splitlines() if _dotenv_name(line) == ENVELOPE_SECRET_NAME
    ]
    if len(envelope_lines) != 1:
        errors.append(
            f"{config}: lists the envelope secret {len(envelope_lines)} times; the "
            f"deployment carries exactly one envelope secret ({ENVELOPE_SECRET_NAME}), "
            "named once and blank"
        )
    for name in names:
        upper = name.upper()
        if name != ENVELOPE_SECRET_NAME and any(
            marker in upper for marker in _ENVELOPE_SECRET_MARKERS
        ):
            errors.append(
                f"{config}: {name} is a second envelope secret name; the "
                f"deployment carries exactly one ({ENVELOPE_SECRET_NAME})"
            )
        if looks_secret(name) and name not in REQUIRED_SECRET_NAMES:
            errors.append(
                f"{config}: {name} is not a secret the service reads; an unread secret "
                "name is a typo the deploy would never notice"
            )
    tool_base = names.get("VOICE_PIPELINE_TOOL_BASE_URL", "")
    if tool_base != APP_PUBLIC_ORIGIN:
        errors.append(
            f"{config}: VOICE_PIPELINE_TOOL_BASE_URL is {tool_base!r}; it must be the "
            f"app's public origin {APP_PUBLIC_ORIGIN!r}, the host whose tool route the "
            "pipeline calls"
        )
    return errors


def validate_requirements(runtime: str, ci: str) -> list[str]:
    """The image's pins are the CI pins; the image carries no bridge server."""
    errors: list[str] = []
    ci_pins = _parse_requirements(ci)
    runtime_pins = _parse_requirements(runtime)
    if not runtime_pins:
        errors.append(f"{RUNTIME_REQUIREMENTS}: no pinned dependencies")
    for name, version in runtime_pins.items():
        if name not in ci_pins:
            errors.append(
                f"{RUNTIME_REQUIREMENTS}: {name} is not in {CI_REQUIREMENTS}; the "
                "container would install a version CI never ran"
            )
        elif ci_pins[name] != version:
            errors.append(
                f"{RUNTIME_REQUIREMENTS}: {name}=={version} but {CI_REQUIREMENTS} pins "
                f"{ci_pins[name]}; one version, tested once"
            )
    if "pipecat-ai" in runtime_pins:
        errors.append(
            f"{RUNTIME_REQUIREMENTS}: pipecat-ai is the PSTN bridge server's stack; the "
            "cascade container runs voice-pipeline only"
        )
    return errors


def _parse_requirements(text: str) -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, version = line.partition("==")
        if not sep:
            continue
        pins[name.strip().lower()] = version.strip().split(";")[0].strip()
    return pins


def fly_descriptors(repo_root: Path) -> list[str]:
    """Every Fly descriptor still present under ``deploy/``, by relative path."""
    root = Path(repo_root)
    deploy_dir = root / "deploy"
    if not deploy_dir.is_dir():
        return []
    return sorted(path.relative_to(root).as_posix() for path in deploy_dir.glob("fly.*.toml"))


def validate_no_fly_descriptors(repo_root: Path) -> list[str]:
    """The Fly shape is deleted, not left as history in the checked artifact."""
    return [
        f"{relative}: the Fly descriptor is deleted; the committed topology is "
        f"{SERVICE_CONFIG}"
        for relative in fly_descriptors(repo_root)
    ]


def validate_record(text: str, *, service_name: str, app_name: str) -> list[str]:
    """The host and the one-instance shape are recorded; Fly is not the host."""
    errors: list[str] = []
    label = DEPLOYMENT_RECORD
    lowered = text.lower()
    if "northflank" not in lowered:
        errors.append(
            f"{label}: does not name Northflank as the committed host"
        )
    if "fly" in lowered:
        errors.append(
            f"{label}: still names Fly; the host moved to Northflank and the "
            "descriptor is deleted"
        )
    if "cloudflare workers" not in lowered:
        errors.append(
            f"{label}: does not name Cloudflare Workers as the excluded runtime"
        )
    elif "excluded" not in lowered:
        errors.append(
            f"{label}: names Cloudflare Workers but not why it is excluded; a host "
            "choice without a reason is not a decision"
        )
    for app in (service_name, app_name):
        if app and app not in text:
            errors.append(f"{label}: does not name the deployed service {app!r}")
    for phrase in ("one instance", "no sticky"):
        if phrase not in lowered:
            errors.append(f"{label}: {phrase!r} is not recorded")
    for name in REQUIRED_ENV_NAMES:
        if name not in text:
            errors.append(
                f"{label}: does not name the required host variable {name}; the "
                "record must list every name the deploy reads"
            )
    return errors


def _compose_environment(text: str) -> dict[str, str]:
    """The service's ``environment`` mapping, names to raw (unquoted) values.

    A deliberately tiny reader, because the validator runs from a checkout with
    no YAML dependency. It reads the first ``environment:`` block (the
    voice-pipeline service) in either the mapping form this repository uses or
    the list form (``- NAME=value``). No value is interpreted, only compared to
    the empty string, so a placeholder is never mistaken for a setting.
    """
    lines = text.splitlines()
    start = None
    for index, raw in enumerate(lines):
        stripped = raw.strip()
        if stripped == "environment:":
            start = index
            break
    if start is None:
        return {}
    base = len(lines[start]) - len(lines[start].lstrip())
    values: dict[str, str] = {}
    for raw in lines[start + 1 :]:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        if indent <= base:
            break
        if stripped.startswith("- "):
            name, sep, value = stripped[2:].strip().partition("=")
        else:
            name, sep, value = stripped.partition(":")
        if sep:
            # A duplicate key is invalid Compose anyway; keep the first so a
            # shadowing empty entry is the one the check names.
            values.setdefault(
                name.strip().strip('"').strip("'"),
                value.strip().strip('"').strip("'"),
            )
    return values


def validate_compose(text: str, *, internal_port: int) -> list[str]:
    """The local rehearsal keeps the same shape: one instance, one volume."""
    errors: list[str] = []
    label = COMPOSE_CONFIG
    for needle, reason in (
        ("voice-pipeline:", "the service is not a compose service"),
        ("voni:", "the app is not a compose service"),
        ("healthcheck:", "compose has no health check to wait on"),
        ("/healthz", "compose does not probe the liveness path"),
        ("SIGTERM", "compose does not send the drain signal"),
        ("stop_grace_period: 30s", "compose does not give the drain its 30 s bound"),
        ("/var/lib/voni", "compose does not mount the events volume"),
        (str(internal_port), "compose does not name the service port"),
    ):
        if needle not in text:
            errors.append(f"{label}: {needle!r} missing; {reason}")
    if not re.search(r"^\s*replicas:\s*1\s*$", text, re.M):
        errors.append(
            f"{label}: replicas is not 1; the deployed topology is one instance, "
            "and the token registry is in-process"
        )
    env = _compose_environment(text)
    for name in REQUIRED_ENV_NAMES:
        if name in env and not env[name]:
            # Compose merges `environment` over `env_file`: an empty committed
            # value wins and the host-supplied one never reaches the process.
            errors.append(
                f"{label}: {name} is set to an empty value in the service "
                "environment; Compose gives environment precedence over env_file, "
                "so the host-supplied value can never arrive. Remove the key and "
                "let env_file supply it"
            )
    if (
        any(name not in env for name in REQUIRED_SETTINGS)
        and "path: ./voice-pipeline.env" not in text
    ):
        errors.append(
            f"{label}: a required host setting is delegated away from the "
            "environment but no env_file is declared; the rehearsal would start "
            "without the measured value"
        )
    for name in secret_values(text):
        errors.append(f"{label}: assigns {name} a value; secrets stay in the host env")
    return errors


def validate_dockerignore(text: str) -> list[str]:
    errors: list[str] = []
    for needle, reason in (
        (".git", "the repository history is not build context"),
        ("node_modules", "the app's dependencies would be sent to the daemon"),
        ("voni/", "the app is a separate image"),
        (
            "!voni/src/lib/demo/scoreboard-budgets.json",
            (
                "the budget record must stay in context; cascade.thresholds cannot "
                "import without it and Dockerfile copies it"
            ),
        ),
        (".env*", "a local secret file must never enter an image"),
    ):
        if needle not in text:
            errors.append(f"{DOCKERIGNORE}: {needle!r} missing; {reason}")
    return errors


def protocol_versions(repo_root: Path) -> dict[str, int]:
    """The protocol number each half of the deploy actually speaks.

    Read textually from the two sources that own it — the service's
    ``PROTOCOL_VERSION`` and the app's ``CASCADE_PROTOCOL_VERSION`` — so this
    validator does not import the cascade package (it is run from a checkout,
    not from the container).
    """
    root = Path(repo_root)
    service_text = _read(root, TOKEN_MODULE)
    app_text = _read(root, APP_PROTOCOL_CLIENT)
    if service_text is None:
        raise ValueError(f"cannot read {TOKEN_MODULE}; the service version is unknown")
    if app_text is None:
        raise ValueError(
            f"cannot read {APP_PROTOCOL_CLIENT}; the app version is unknown"
        )
    service = re.search(r"^PROTOCOL_VERSION\s*=\s*(\d+)\s*$", service_text, re.M)
    app = re.search(
        r"export const CASCADE_PROTOCOL_VERSION\s*=\s*(\d+)\s*;", app_text
    )
    if service is None:
        raise ValueError(f"{TOKEN_MODULE} declares no PROTOCOL_VERSION")
    if app is None:
        raise ValueError(
            f"{APP_PROTOCOL_CLIENT} exports no CASCADE_PROTOCOL_VERSION"
        )
    return {"service": int(service.group(1)), "app": int(app.group(1))}


def validate_versions(
    repo_root: Path,
    *,
    service_app: str | None = None,
    app_name: str | None = None,
) -> list[str]:
    """The artifact records both versions, and the protocol versions agree.

    A mismatch here is a deploy error: a cutover must not be claimed while the
    app and the service name different protocols (ticket 141).
    """
    root = Path(repo_root)
    label = VERSIONS_RECORD
    errors: list[str] = []
    text = _read(root, label)
    if text is None:
        return [f"missing {label}: the app and service versions are unrecorded"]
    try:
        record = json.loads(text)
    except json.JSONDecodeError as exc:
        return [f"{label}: not valid JSON ({exc})"]
    if not isinstance(record, dict):
        return [f"{label}: must be an object"]

    if record.get("recordVersion") != 1:
        errors.append(
            f"{label}: recordVersion is {record.get('recordVersion')!r}; this "
            "reader supports 1"
        )

    if service_app is None:
        try:
            descriptor = load_config(root, SERVICE_CONFIG)
        except (OSError, ValueError):
            descriptor = {}
        service_app = str(
            _mapping(_mapping(descriptor).get("service")).get("name") or ""
        )

    entries: dict[str, Mapping[str, Any]] = {}
    for party, expected_name in (("app", app_name), ("service", service_app)):
        entry = record.get(party)
        if not isinstance(entry, dict):
            errors.append(
                f"{label}: {party} is not recorded; the artifact must name the "
                f"{party}'s version"
            )
            continue
        entries[party] = entry
        for field in ("name", "version", "source"):
            value = entry.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{label}: {party} does not record its {field}")
        if expected_name and entry.get("name") != expected_name:
            errors.append(
                f"{label}: {party} is {entry.get('name')!r} but the deploy config "
                f"names {expected_name!r}; the artifact is stale"
            )

    try:
        code = protocol_versions(root)
    except ValueError as exc:
        errors.append(f"{label}: {exc}")
        return errors

    parties = {"app": code["app"], "service": code["service"]}
    recorded: dict[str, Any] = {}
    for party, entry in entries.items():
        version = entry.get("protocolVersion")
        if isinstance(version, bool) or not isinstance(version, int):
            errors.append(
                f"{label}: {party} does not record an integer protocolVersion"
            )
            continue
        recorded[party] = version
        if version != parties[party]:
            errors.append(
                f"{label}: {party} records protocol {version} but its code speaks "
                f"{parties[party]}; a protocol version mismatch is a deploy error, "
                "not a guessed compatibility"
            )
    if len(recorded) == 2 and recorded["app"] != recorded["service"]:
        errors.append(
            f"{label}: the app speaks protocol {recorded['app']} and the service "
            f"speaks protocol {recorded['service']}; do not claim a cutover while "
            "the two halves disagree"
        )
    return errors


def drain_max_wait_ms_from_registry(repo_root: Path) -> int:
    """Read the recorded drain bound without importing the cascade package."""
    path = repo_root / "voice-pipeline/cascade/thresholds.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    bound = data["bounds"]["deploy.drain_max_wait_ms"]
    value = bound.get("value")
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(
            "deploy.drain_max_wait_ms has no value; ticket 04 records it before the "
            "topology can size the grace period"
        )
    return value


def validate(repo_root: Path, *, drain_max_wait_ms: int | None = None) -> list[str]:
    """The whole topology: every file, every rule, one list of named errors."""
    repo_root = Path(repo_root)
    errors: list[str] = []
    if drain_max_wait_ms is None:
        drain_max_wait_ms = drain_max_wait_ms_from_registry(repo_root)

    descriptor = _load_descriptor(repo_root, SERVICE_CONFIG, errors)
    service_name = ""
    port = 0
    if descriptor is not None:
        errors.extend(
            validate_service(descriptor, drain_max_wait_ms=drain_max_wait_ms)
        )
        service_name = str(_mapping(descriptor.get("service")).get("name") or "")
        ports = descriptor.get("ports")
        if isinstance(ports, list) and ports:
            raw_port = _mapping(ports[0]).get("internalPort")
            port = raw_port if _positive_int(raw_port) else 0
    errors.extend(validate_no_fly_descriptors(repo_root))
    errors.extend(validate_versions(repo_root, service_app=service_name))

    dockerfile = _read(repo_root, DOCKERFILE)
    if dockerfile is None:
        errors.append(f"missing {DOCKERFILE}: the service has no container image")
    else:
        errors.extend(validate_dockerfile(dockerfile, internal_port=port))

    dockerignore = _read(repo_root, DOCKERIGNORE)
    if dockerignore is None:
        errors.append(f"missing {DOCKERIGNORE}: the build context is unchecked")
    else:
        errors.extend(validate_dockerignore(dockerignore))

    secrets_example = _read(repo_root, SECRETS_EXAMPLE)
    if secrets_example is None:
        errors.append(f"missing {SECRETS_EXAMPLE}: the secret names are unrecorded")
    else:
        errors.extend(validate_secrets_example(secrets_example))

    runtime = _read(repo_root, RUNTIME_REQUIREMENTS)
    ci = _read(repo_root, CI_REQUIREMENTS)
    if runtime is None:
        errors.append(f"missing {RUNTIME_REQUIREMENTS}: the image has no pinned deps")
    elif ci is None:
        errors.append(f"missing {CI_REQUIREMENTS}: cannot check the pins")
    else:
        errors.extend(validate_requirements(runtime, ci))

    compose = _read(repo_root, COMPOSE_CONFIG)
    if compose is None:
        errors.append(f"missing {COMPOSE_CONFIG}: the one-instance rehearsal is gone")
    else:
        errors.extend(validate_compose(compose, internal_port=port))

    record = _read(repo_root, DEPLOYMENT_RECORD)
    if record is None:
        errors.append(f"missing {DEPLOYMENT_RECORD}: the host choice is unrecorded")
    elif descriptor is not None:
        errors.extend(
            validate_record(record, service_name=service_name, app_name="voni-app")
        )
    if _read(repo_root, HOST_DECISION) is None:
        errors.append(f"missing {HOST_DECISION}: the host decision record is gone")
    # Ticket 141: the second guard on secrets. The config checks above name a
    # value in a deploy file; the scan catches a credential committed anywhere
    # else in the tree (production code, a doc, a script).
    errors.extend(secret_scan.scan_repository(repo_root))
    return errors


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    repo_root = Path(args[0]) if args else Path(__file__).resolve().parent.parent
    errors = validate(repo_root)
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        print(f"deployment topology: {len(errors)} problem(s)", file=sys.stderr)
        return 1
    print(
        "deployment topology: ok (Northflank, one service, one instance, "
        "Postgres addon, one volume, GET /healthz on 8766, 30s drain)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

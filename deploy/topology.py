"""The deployment topology as a checked artifact (ticket 135).

The ticket's acceptance criteria are properties of the files a deploy reads, not
of a Python object, so this module reads those files and returns a list of
named violations (the house style: an empty list means valid, the same shape as
``config.validate_pipeline_config``). ``python deploy/topology.py`` prints them
and exits non-zero; ``voice-pipeline/test_deploy_topology.py`` asserts the
committed topology validates and that each load-bearing rule can fail.

What is checked:

* the host is Fly.io and the shape is one container, two machines, rolling
  deploys with a liveness health check (host record: ticket 04);
* the sockets are treated as connections, machines never auto-stop under a live
  call, and a SIGTERM waits at least the recorded drain bound;
* the app and the service are separate Fly apps, separate images and separate
  secret sets;
* the artifact records both parties' versions and they speak one protocol
  version (ticket 141): a mismatch is a deploy error;
* no secret value is committed anywhere, only names, and every name is one the
  code actually reads; the repository scan (``deploy/secret_scan.py``) is the
  wider guard, reporting a committed credential by file, line and kind — never
  its value;
* the image's pinned runtime dependencies agree with ``requirements-ci.txt`` and
  the exposed port agrees with the proxy and the command.

Nothing here calls the Fly API. The config is the claim; a deploy reads the
same files.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

try:  # imported as ``deploy.topology`` (tests) or run as a script (deploy/topology.py)
    from . import secret_scan
except ImportError:  # pragma: no cover - the script path
    import secret_scan  # type: ignore[no-redef]

#: Two machines minimum: a rolling deploy must never remove the last one while
#: a live call is pinned to it (spec "Deployment / Topology").
MIN_INSTANCES = 2

SERVICE_CONFIG = "deploy/fly.voice-pipeline.toml"
APP_CONFIG = "deploy/fly.voni.toml"
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

#: Every secret the service reads from its host environment, by name only.
#: Sources: meta_stt API_KEY_ENV, meta_llm IDENTIFIER_SALT_ENV, tools
#: TOOL_SECRET_ENV, server VOICE_PIPELINE_ENVELOPE_SECRET and DATABASE_URL
#: (the shared breaker/counter store), plus the managed-path keys the dev
#: browser route still constructs. A value for any of these is never committed.
REQUIRED_SECRET_NAMES: tuple[str, ...] = (
    "META_API_KEY",
    "META_IDENTIFIER_SALT",
    "ASSEMBLYAI_API_KEY",
    "AI_GATEWAY_API_KEY",
    "VONI_TOOL_SECRET",
    "VOICE_PIPELINE_ENVELOPE_SECRET",
    "DATABASE_URL",
)

#: The one non-secret environment setting the topology itself depends on.
PORT_ENV = "VOICE_PIPELINE_PORT"

#: A name whose *value* may never be committed: anything that reads like an
#: API key, a signing secret, a salt, a password or a connection string.
_SECRET_NAME_PARTS = ("KEY", "SECRET", "SALT", "TOKEN", "PASSWORD", "DATABASE_URL")


def _read(repo_root: Path, relative: str) -> str | None:
    path = repo_root / relative
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8")


def _load_toml(repo_root: Path, relative: str, errors: list[str]) -> dict[str, Any] | None:
    text = _read(repo_root, relative)
    if text is None:
        errors.append(f"missing {relative}: the topology cannot be checked without it")
        return None
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:  # pragma: no cover - a broken file
        errors.append(f"{relative}: not valid TOML ({exc})")
        return None


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


def load_config(repo_root: Path, relative: str) -> dict[str, Any]:
    """Read one TOML config, raising when it is missing or malformed."""
    path = Path(repo_root) / relative
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _check_http_service(
    doc: Mapping[str, Any],
    *,
    label: str,
    errors: list[str],
    liveness_path: str = "/healthz",
) -> dict[str, Any]:
    """Shared checks for either app's proxy service. Returns the block."""
    service = doc.get("http_service")
    if not isinstance(service, dict):
        errors.append(f"{label}: missing [http_service]; a Fly app needs a proxy service")
        return {}

    machines = service.get("min_machines_running")
    if isinstance(machines, bool) or not isinstance(machines, int):
        errors.append(
            f"{label}: min_machines_running is {machines!r}; the topology needs an "
            f"integer of at least {MIN_INSTANCES} so a rolling deploy never removes "
            "the last machine"
        )
    elif machines < MIN_INSTANCES:
        errors.append(
            f"{label}: min_machines_running is {machines}; the topology needs at "
            f"least {MIN_INSTANCES} machines so a live call is never the machine "
            "that was removed"
        )

    if service.get("auto_stop_machines") is not False:
        errors.append(
            f"{label}: auto_stop_machines must be false; a machine that stops to "
            "save money cannot hold a long-lived WebSocket"
        )

    concurrency = service.get("concurrency")
    if not isinstance(concurrency, dict) or concurrency.get("type") != "connections":
        errors.append(
            f"{label}: [http_service.concurrency] type must be \"connections\"; a "
            "cascade call is one WebSocket, not a request-per-CPU workload"
        )

    checks = service.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append(
            f"{label}: no [[http_service.checks]]; a rolling deploy needs a health "
            "check before it drains the old machine"
        )
    else:
        paths = {check.get("path") for check in checks if isinstance(check, dict)}
        if liveness_path and liveness_path not in paths:
            errors.append(
                f"{label}: the health check must GET {liveness_path} "
                f"(found {sorted(p for p in paths if p)}); a rolling deploy reads "
                "this probe, so it must be the liveness path"
            )
        for check in checks:
            if not isinstance(check, dict):
                continue
            for field in ("interval", "timeout", "grace_period", "path"):
                if not check.get(field):
                    errors.append(f"{label}: health check is missing {field!r}")

    strategy = doc.get("deploy", {}).get("strategy") if isinstance(doc.get("deploy"), dict) else None
    if strategy != "rolling":
        errors.append(
            f"{label}: [deploy] strategy is {strategy!r}; it must be \"rolling\" so a "
            "new machine is healthy before an old one is drained (an immediate "
            "deploy kills live calls)"
        )

    if "services" in doc:
        errors.append(
            f"{label}: [[services]] is the old shape; use [http_service] plus "
            "WebSocket-aware concurrency (one port, no sticky sessions)"
        )
    return service


def _check_env(doc: Mapping[str, Any], *, label: str, errors: list[str]) -> dict[str, str]:
    env = doc.get("env")
    if not isinstance(env, dict):
        return {}
    for name, value in env.items():
        if looks_secret(name) and str(value).strip():
            errors.append(
                f"{label}: [env] sets {name} to a value; secrets are host-only "
                "(`fly secrets set NAME=...`), never committed"
            )
    return {str(name): str(value) for name, value in env.items()}


def validate_service(
    doc: Mapping[str, Any],
    *,
    drain_max_wait_ms: int,
    config: str = SERVICE_CONFIG,
) -> list[str]:
    """Every rule the service deployment must satisfy, named one per line."""
    errors: list[str] = []
    label = config

    if not doc.get("app"):
        errors.append(f"{label}: app is unset; the service is its own Fly app")

    service = _check_http_service(doc, label=label, errors=errors)

    port = service.get("internal_port")
    if isinstance(port, bool) or not isinstance(port, int) or port <= 0:
        errors.append(f"{label}: http_service.internal_port is {port!r}; expected a port")
    env = _check_env(doc, label=label, errors=errors)
    if port is not None and env.get(PORT_ENV) != str(port):
        errors.append(
            f"{label}: [env] {PORT_ENV} is {env.get(PORT_ENV)!r} but the proxy "
            f"forwards to {port}; the server would listen on the wrong port"
        )

    if doc.get("kill_signal") != "SIGTERM":
        errors.append(
            f"{label}: kill_signal must be SIGTERM; the drain supervisor (ticket 140) "
            "starts on SIGTERM and a live call is never killed by the drain"
        )
    kill_timeout = doc.get("kill_timeout")
    if isinstance(kill_timeout, bool) or not isinstance(kill_timeout, int):
        errors.append(f"{label}: kill_timeout is {kill_timeout!r}; expected whole seconds")
    elif kill_timeout * 1000 < drain_max_wait_ms:
        errors.append(
            f"{label}: kill_timeout is {kill_timeout}s, shorter than the recorded "
            f"deploy.drain_max_wait_ms ({drain_max_wait_ms} ms); the machine would be "
            "removed while the drain is still waiting for a live call"
        )
    return errors


def validate_app(
    doc: Mapping[str, Any],
    *,
    service_doc: Mapping[str, Any],
    config: str = APP_CONFIG,
) -> list[str]:
    """The app's own deployment: same host, separate app, own secret set."""
    errors: list[str] = []
    label = config
    app_name = doc.get("app")
    if not app_name:
        errors.append(f"{label}: app is unset; the app is its own Fly app")
    elif app_name == service_doc.get("app"):
        errors.append(
            f"{label}: app is {app_name!r}, the same Fly app as the service; the app "
            "and the Python service deploy separately (spec, operational notes)"
        )

    service = _check_http_service(
        doc, label=label, errors=errors, liveness_path="/"
    )
    app_port = service.get("internal_port")
    service_port = (service_doc.get("http_service") or {}).get("internal_port")
    if app_port == service_port:
        errors.append(
            f"{label}: internal_port is {app_port}, the service's port; two separate "
            "Fly apps cannot share a port and still be separate deploys"
        )

    env = _check_env(doc, label=label, errors=errors)
    shared = sorted(set(env) & set(REQUIRED_SECRET_NAMES))
    if shared:
        errors.append(
            f"{label}: [env] names {shared[0]}, a service secret; the app's secrets "
            "are its own and the service's secret set is injected by its own app"
        )

    build = doc.get("build") if isinstance(doc.get("build"), dict) else {}
    service_build = (
        service_doc.get("build") if isinstance(service_doc.get("build"), dict) else {}
    )
    if build.get("dockerfile") and build.get("dockerfile") == service_build.get("dockerfile"):
        errors.append(
            f"{label}: build.dockerfile is the service image; the app and the service "
            "are separate images"
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
    if "server:app" not in text or "uvicorn" not in lowered:
        errors.append(
            f"{label}: the command must run uvicorn's server:app; that is the one "
            "process this container holds"
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
        if "voni/" in line and "scoreboard-budgets.json" not in line:
            errors.append(
                f"{label}: copies {line.strip()!r} from the app; the app is its own "
                "image (deploy/fly.voni.toml) and only the budget record belongs here"
            )
    if "--workers" in lowered:
        errors.append(
            f"{label}: runs the --workers flag; a call is one WebSocket on one "
            "process, and the two Fly machines are the two instances"
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


def _parse_dotenv_names(text: str) -> dict[str, str]:
    names: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        names[name.strip()] = value.strip().strip('"').strip("'")
    return names


def validate_secrets_example(text: str, config: str = SECRETS_EXAMPLE) -> list[str]:
    """Names only: every secret the service reads is listed with an empty value."""
    errors: list[str] = []
    names = _parse_dotenv_names(text)
    for required in REQUIRED_SECRET_NAMES:
        if required not in names:
            errors.append(
                f"{config}: {required} is not listed; the deployment record must name "
                "every secret the service reads"
            )
        elif names[required]:
            errors.append(
                f"{config}: {required} has a value; this file records names only"
            )
    for name in names:
        if looks_secret(name) and name not in REQUIRED_SECRET_NAMES:
            errors.append(
                f"{config}: {name} is not a secret the service reads; an unread secret "
                "name is a typo the deploy would never notice"
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


def validate_record(text: str, *, service_app: str, app_name: str) -> list[str]:
    """The host is recorded, Workers is excluded with a reason, both apps named."""
    errors: list[str] = []
    label = DEPLOYMENT_RECORD
    lowered = text.lower()
    if "fly.io" not in lowered:
        errors.append(f"{label}: does not name Fly.io as the container host")
    if "cloudflare workers" not in lowered:
        errors.append(
            f"{label}: does not name Cloudflare Workers as the excluded runtime"
        )
    elif "excluded" not in lowered:
        errors.append(
            f"{label}: names Cloudflare Workers but not why it is excluded; a host "
            "choice without a reason is not a decision"
        )
    for app in (service_app, app_name):
        if app and app not in text:
            errors.append(f"{label}: does not name the Fly app {app!r}")
    for phrase in ("two machines", "no sticky"):
        if phrase not in lowered:
            errors.append(f"{label}: {phrase!r} is not recorded")
    return errors


def validate_compose(text: str, *, internal_port: int) -> list[str]:
    """The local rehearsal keeps the same shape: two replicas, a health check."""
    errors: list[str] = []
    label = COMPOSE_CONFIG
    for needle, reason in (
        ("voice-pipeline:", "the service is not a compose service"),
        ("voni:", "the app is not a compose service"),
        ("replicas: 2", f"compose runs fewer than {MIN_INSTANCES} service replicas"),
        ("healthcheck:", "compose has no health check to wait on"),
        ("/healthz", "compose does not probe the liveness path"),
        ("SIGTERM", "compose does not send the drain signal"),
        (str(internal_port), "compose does not name the service port"),
    ):
        if needle not in text:
            errors.append(f"{label}: {needle!r} missing; {reason}")
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

    if service_app is None or app_name is None:
        try:
            service_doc = load_config(root, SERVICE_CONFIG)
            app_doc = load_config(root, APP_CONFIG)
        except (OSError, ValueError):
            service_doc, app_doc = {}, {}
        service_app = service_app or str(service_doc.get("app") or "")
        app_name = app_name or str(app_doc.get("app") or "")

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
            "topology can size kill_timeout"
        )
    return value


def validate(repo_root: Path, *, drain_max_wait_ms: int | None = None) -> list[str]:
    """The whole topology: every file, every rule, one list of named errors."""
    repo_root = Path(repo_root)
    errors: list[str] = []
    if drain_max_wait_ms is None:
        drain_max_wait_ms = drain_max_wait_ms_from_registry(repo_root)

    service_doc = _load_toml(repo_root, SERVICE_CONFIG, errors)
    app_doc = _load_toml(repo_root, APP_CONFIG, errors)
    if service_doc is not None:
        errors.extend(validate_service(service_doc, drain_max_wait_ms=drain_max_wait_ms))
    if app_doc is not None and service_doc is not None:
        errors.extend(validate_app(app_doc, service_doc=service_doc))
    errors.extend(
        validate_versions(
            repo_root,
            service_app=(
                str(service_doc.get("app") or "") if service_doc is not None else None
            ),
            app_name=str(app_doc.get("app") or "") if app_doc is not None else None,
        )
    )

    port = 0
    if service_doc is not None:
        port = int((service_doc.get("http_service") or {}).get("internal_port") or 0)

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
        errors.append(f"missing {COMPOSE_CONFIG}: the two-instance rehearsal is gone")
    else:
        errors.extend(validate_compose(compose, internal_port=port))

    record = _read(repo_root, DEPLOYMENT_RECORD)
    if record is None:
        errors.append(f"missing {DEPLOYMENT_RECORD}: the host choice is unrecorded")
    elif service_doc is not None and app_doc is not None:
        errors.extend(
            validate_record(
                record,
                service_app=str(service_doc.get("app") or ""),
                app_name=str(app_doc.get("app") or ""),
            )
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
    print("deployment topology: ok (Fly.io, two machines, rolling, /healthz)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

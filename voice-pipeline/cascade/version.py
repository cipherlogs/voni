"""What this build is, reported so a half-deployed pair is visible (141).

The spec's M17 rule: the service reports its **code version** and its
**protocol version** in the end message and in ``/healthz``, and a version
mismatch must be visible before a cutover claim.

Two deliberate limits:

* The protocol version is **not** restated here. :data:`PROTOCOL_VERSION` is
  imported from :mod:`cascade.token`, where ticket 138 owns the one number and
  its named refusal; a second copy is exactly the drift this module exists to
  expose.
* The build version is read from the host environment at call time. Fly injects
  ``FLY_IMAGE_REF`` for the machine's image, so a deploy can report the image it
  actually runs; ``VOICE_PIPELINE_BUILD_VERSION`` takes precedence for a host
  that names builds itself. When neither is set the answer is
  :data:`UNVERSIONED` — an honest "no version supplied", never a guessed one.

Secrets are not part of this document. A health or end report carries versions,
not credentials (ticket 137's log gate and ticket 141's repository scan are the
two guards).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from cascade.token import PROTOCOL_VERSION

#: The service's name in every report, one copy.
SERVICE_NAME = "voice-pipeline"

#: A host that names its own builds sets this first.
BUILD_VERSION_ENV = "VOICE_PIPELINE_BUILD_VERSION"

#: Fly's per-machine image reference, injected at boot.
IMAGE_REF_ENV = "FLY_IMAGE_REF"

#: The named absence of a build version. Never fabricate one.
UNVERSIONED = "unversioned"

#: Where a build version comes from, in precedence order.
BUILD_SOURCES = (BUILD_VERSION_ENV, IMAGE_REF_ENV)


def _environment(environ: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if environ is None else environ


def build_version(environ: Mapping[str, str] | None = None) -> str:
    """The build this process runs, or :data:`UNVERSIONED`."""
    env = _environment(environ)
    for name in BUILD_SOURCES:
        value = env.get(name, "")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return UNVERSIONED


def build_source(environ: Mapping[str, str] | None = None) -> str:
    """The env name the build version came from, or ``"none"``."""
    env = _environment(environ)
    for name in BUILD_SOURCES:
        value = env.get(name, "")
        if isinstance(value, str) and value.strip():
            return name
    return "none"


def version_document(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The service's report: what it is, and which protocol it speaks."""
    return {
        "service": SERVICE_NAME,
        "buildVersion": build_version(environ),
        "buildSource": build_source(environ),
        "protocolVersion": PROTOCOL_VERSION,
    }


__all__ = [
    "BUILD_SOURCES",
    "BUILD_VERSION_ENV",
    "IMAGE_REF_ENV",
    "PROTOCOL_VERSION",
    "SERVICE_NAME",
    "UNVERSIONED",
    "build_source",
    "build_version",
    "version_document",
]

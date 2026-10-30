"""Liveness is the process; readiness is the promise to take a new call (139).

The two questions have different answers and must never be conflated:

* **Liveness** (``/healthz``) says the process is up. It reads no store, no
  vendor and no key; a store outage must not restart a machine that is serving
  live calls.
* **Readiness** (``/readyz``) says *this instance may accept a new call*. It
  needs the durable store, the daily counter and the breaker record to be
  readable, and it must not be draining. Any unreadable dependency fails
  closed: the instance reports not-ready, the platform stops sending it new
  calls, and calls already running are untouched.

A missing breaker record is not an outage — a fresh deploy has none — but a
record that cannot be read or parsed is. Every check is probed separately so
the report names the dependency that failed, and a refusal is redacted before
it is returned (a driver error can quote the database URL).

Readiness never opens a vendor socket: the checks below touch the store only.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from cascade.breaker import LEGS, BreakerRecordMissing
from cascade.log_redaction import redact_text
from cascade.token import PROTOCOL_VERSION

#: The checks a readiness report carries, in the order they are evaluated.
CHECK_NAMES = ("drain", "store", "counter", "breaker")

#: A check's success value; anything else is the named reason it failed.
OK = "ok"


class DrainState:
    """Whether this instance is draining, and why.

    Ticket 140's SIGTERM supervisor owns *when* this flips; this module owns
    what the answer means: a draining instance finishes live calls and accepts
    no new one.
    """

    def __init__(self) -> None:
        self._reason = ""

    def start(self, reason: str = "deploy") -> None:
        """Stop accepting new calls; live calls continue."""
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("a drain needs a non-empty reason")
        self._reason = reason

    def stop(self) -> None:
        """Return to accepting new calls (a cancelled drain)."""
        self._reason = ""

    @property
    def draining(self) -> bool:
        return bool(self._reason)

    @property
    def reason(self) -> str:
        return self._reason


@dataclass(frozen=True)
class ReadinessReport:
    """One readiness answer: the verdict, the version and each dependency."""

    ready: bool
    protocol_version: int
    draining: bool
    drain_reason: str
    checks: Mapping[str, str] = field(default_factory=dict)

    def to_document(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "protocolVersion": self.protocol_version,
            "draining": self.draining,
            "drainReason": self.drain_reason,
            "checks": dict(self.checks),
        }


def _reason(text: Any) -> str:
    """A named failure, with any credential in a driver error redacted."""
    return str(redact_text(str(text)))


async def _probe(name: str, probe: Callable[[], Any], checks: dict[str, str]) -> None:
    try:
        await probe()
    except BreakerRecordMissing:
        # No record yet is a readable store, not an outage.
        checks[name] = OK
    except Exception as exc:
        checks[name] = _reason(f"unreadable: {type(exc).__name__}: {exc}")
    else:
        checks[name] = OK


async def readiness(
    *,
    drain: DrainState,
    store: Any,
    counter: Any,
    breaker: Any,
    configuration_errors: Mapping[str, str] | None = None,
) -> ReadinessReport:
    """Probe every dependency once and answer whether a new call may start.

    ``configuration_errors`` names a dependency that could not even be built
    (no ``DATABASE_URL``, an unset budget bound); it fails readiness instead of
    being swallowed. Nothing here opens a vendor socket.
    """
    errors = dict(configuration_errors or {})
    checks: dict[str, str] = {}

    if drain.draining:
        checks["drain"] = _reason(f"draining: {drain.reason}")
    else:
        checks["drain"] = OK

    for name, dependency in (
        ("store", store),
        ("counter", counter),
        ("breaker", breaker),
    ):
        if name in errors:
            checks[name] = _reason(errors[name])
            continue
        if dependency is None:
            checks[name] = _reason(
                f"not configured: {name} has no durable adapter"
            )
            continue

    if "store" not in errors and store is not None:
        await _probe("store", store.ping, checks)
    if "counter" not in errors and counter is not None:
        await _probe("counter", counter.snapshot, checks)
    if "breaker" not in errors and breaker is not None:

        async def _breaker_probe() -> None:
            for leg in LEGS:
                try:
                    await breaker.read(leg)
                except BreakerRecordMissing:
                    # An absent record is readable; keep checking the others.
                    continue

        await _probe("breaker", _breaker_probe, checks)

    ordered = {name: checks[name] for name in CHECK_NAMES if name in checks}
    return ReadinessReport(
        ready=bool(ordered) and all(value == OK for value in ordered.values()),
        protocol_version=PROTOCOL_VERSION,
        draining=drain.draining,
        drain_reason=drain.reason,
        checks=ordered,
    )

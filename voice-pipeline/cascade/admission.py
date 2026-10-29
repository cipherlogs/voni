"""The one admission seam between a routing decision and a cascade socket.

The routing switch (ticket 24) freezes a decision before the first frame, but a
decision is not a connection. This module is the one place a *new* call's
decision becomes an open socket, so ``routing=off`` is observable as a real
connection count of zero (M1 AC5, M18 anti-lie): the opener is never called
when the decision routes managed, and deleting that check makes the socket
factory record a connection instead of nothing.

Two properties are deliberate:

* **One read, one decision, one socket.** The switch is read exactly once by
  :meth:`cascade.routing.RoutingSwitch.decide`; this module never re-reads it.
  A live call therefore keeps the decision it was admitted with — a later flip
  cannot move it (ticket 148).
* **A refusal is not an error.** Routing, eligibility or a body refusal returns
  an :class:`Admission` with ``connections == 0`` and the reason the call
  routes managed. Only a real opener failure propagates.

The opener is injected, so the production service passes its vendor connector
and tests pass a recording socket factory.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from cascade.routing import CallSubject, RoutingDecision, RoutingSwitch

#: Opens one cascade connection for a call the decision permitted.
ConnectionOpener = Callable[[], Awaitable[Any]]


@dataclass(frozen=True)
class Admission:
    """One new call's frozen routing decision and the socket it opened.

    ``connections`` is the number of real sockets opened for the call: one when
    routing permitted cascade, zero when it routed managed. ``connection`` is
    the opened socket, or ``None``; neither can disagree with the decision.
    """

    decision: RoutingDecision
    connection: Any | None = None
    connections: int = 0

    def __post_init__(self) -> None:
        if not isinstance(self.decision, RoutingDecision):
            raise ValueError(f"decision must be a RoutingDecision, got {self.decision!r}")
        if self.connections not in (0, 1):
            raise ValueError(f"a call opens at most one cascade socket, got {self.connections!r}")
        if (self.connection is not None) != (self.connections == 1):
            raise ValueError(
                "an admission opens exactly one connection or none; "
                f"connection={self.connection!r} connections={self.connections!r}"
            )
        if self.decision.permitted and self.connections != 1:
            raise ValueError(
                "a cascade decision must have opened its one socket before admission"
            )
        if not self.decision.permitted and self.connections != 0:
            raise ValueError(
                "a managed decision opens no cascade socket"
            )


async def admit_new_call(
    switch: RoutingSwitch,
    subject: CallSubject,
    *,
    open_cascade: ConnectionOpener,
    refusal: str = "",
) -> Admission:
    """Freeze the routing decision, then open a socket only if it permits one.

    ``refusal`` is the first failing eligibility predicate the caller already
    knows about; routing's own refusal takes precedence inside
    :func:`cascade.routing.decide`. A managed decision returns before
    ``open_cascade`` is reached, so routing off means zero connections even
    when the opener would happily connect.
    """
    if not isinstance(switch, RoutingSwitch):
        raise ValueError(f"switch must be a RoutingSwitch, got {switch!r}")
    decision = await switch.decide(subject, refusal=refusal)
    if not decision.opens_cascade_connection:
        return Admission(decision=decision, connection=None, connections=0)
    connection = await open_cascade()
    return Admission(decision=decision, connection=connection, connections=1)

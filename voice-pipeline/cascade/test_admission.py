"""Anti-lie: routing=off opens zero cascade sockets (M18 / ticket 147).

The routing decision alone can say "managed" while a caller ignores it and
connects, so this test drives the one admission seam that turns a decision into
a connection. ``open_cascade`` is a real :class:`ScriptedSocketFactory`, and the
assertions read ``factory.connections`` — the sockets that actually opened —
never a log line or a mock's expectation.

Expected values are independent of the implementation: the mode is stored in a
durable :class:`MemoryStore`, and the connection count is whatever the socket
factory recorded.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.admission import admit_new_call
from cascade.routing import CallSubject, RoutingSwitch
from cascade.store import MemoryStore
from cascade.testing.socket_factory import Frame, ScriptedSocketFactory

DEMO = CallSubject("demo-call-1", "demo")
TENANT = CallSubject("tenant-call-1", "tenant")
CASCADE_URL = "wss://cascade.invalid/v1/call"


def run(coro):
    return asyncio.run(coro)


class FixedClock:
    def __init__(self, at: float) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at


def opener(factory: ScriptedSocketFactory):
    """The production-shaped opener: one real socket, at the cascade URL."""

    async def open_cascade():
        return await factory(CASCADE_URL)

    return open_cascade


class OffOpensNoSocketTest(unittest.TestCase):
    def test_off_opens_zero_cascade_sockets_for_every_new_call(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(1.0))
        run(switch.set_mode("off", actor="ops@voni", reason="rollback"))
        factory = ScriptedSocketFactory([Frame("{}")])

        for subject in (DEMO, TENANT, DEMO):
            admission = run(
                admit_new_call(switch, subject, open_cascade=opener(factory))
            )
            self.assertEqual(admission.decision.disposition, "managed")
            self.assertIsNone(admission.connection)
            self.assertEqual(admission.connections, 0)

        self.assertEqual(factory.connections, [])

    def test_a_missing_switch_opens_zero_cascade_sockets(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(1.0))
        factory = ScriptedSocketFactory([Frame("{}")])

        admission = run(admit_new_call(switch, DEMO, open_cascade=opener(factory)))

        self.assertEqual(admission.decision.disposition, "managed")
        self.assertEqual(factory.connections, [])

    def test_off_names_the_reason_it_refused_cascade(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(1.0))
        factory = ScriptedSocketFactory([Frame("{}")])
        run(switch.set_mode("off", actor="ops@voni"))

        admission = run(admit_new_call(switch, DEMO, open_cascade=opener(factory)))

        self.assertIn("off", admission.decision.reason)


class TheCountIsLiveTest(unittest.TestCase):
    def test_demo_opens_exactly_one_real_socket(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(1.0))
        run(switch.set_mode("demo", actor="ops@voni"))
        factory = ScriptedSocketFactory([Frame("{}")])

        admission = run(admit_new_call(switch, DEMO, open_cascade=opener(factory)))

        self.assertEqual(admission.decision.disposition, "cascade")
        self.assertEqual(admission.connections, 1)
        self.assertEqual(len(factory.connections), 1)
        self.assertEqual(factory.connections[0]["url"], CASCADE_URL)
        self.assertIs(admission.connection, factory.connections[0]["socket"])

    def test_the_opener_is_not_called_at_all_when_routing_is_off(self):
        switch = RoutingSwitch(MemoryStore(), now=FixedClock(1.0))
        run(switch.set_mode("off", actor="ops@voni"))
        calls: list[str] = []

        async def must_not_open():
            calls.append("opened")
            raise AssertionError("routing off must not reach the socket opener")

        admission = run(admit_new_call(switch, TENANT, open_cascade=must_not_open))

        self.assertEqual(calls, [])
        self.assertEqual(admission.connections, 0)


if __name__ == "__main__":
    unittest.main()

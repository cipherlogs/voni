"""Rollback: flipping routing off is a runtime switch, not a deploy (ticket 148).

One live call is admitted while routing is ``demo``, then the switch is flipped
to ``off`` through the same durable store while that call is still streaming.
New calls must route managed and open zero cascade sockets; the live call keeps
its frozen decision and finishes on the socket it already has.

The assertions read the sockets the injected factory actually opened, so a
new-call path that ignores the switch fails here even though the decision
object says "managed". Deleting the routing read makes the after-flip calls
connect, and this test goes red.
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


class Clock:
    """A clock the test moves, so the audit trail has real timestamps."""

    def __init__(self, at: float = 1.0) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at


def opener(factory: ScriptedSocketFactory):
    async def open_cascade():
        return await factory(CASCADE_URL)

    return open_cascade


async def live_call(connection, first_chunk_read: asyncio.Event, release: asyncio.Event):
    """One call already on the wire: one chunk, wait, then finish its stream."""
    chunks: list[object] = []
    stream = connection.__aiter__()
    chunks.append(await stream.__anext__())
    first_chunk_read.set()
    await release.wait()
    async for chunk in stream:
        chunks.append(chunk)
    return chunks


class RollbackTest(unittest.TestCase):
    def test_flipping_off_routes_new_calls_managed_and_live_calls_finish(self):
        async def scenario():
            clock = Clock(10.0)
            store = MemoryStore()
            switch = RoutingSwitch(store, now=clock)
            await switch.set_mode("demo", actor="ops@voni", reason="cutover")
            factory = ScriptedSocketFactory([Frame("hello"), Frame("goodbye")])

            # The live call is admitted and starts streaming before the flip.
            live = await admit_new_call(
                switch, DEMO, open_cascade=opener(factory)
            )
            self.assertEqual(live.decision.disposition, "cascade")
            self.assertEqual(len(factory.connections), 1)

            first_chunk_read = asyncio.Event()
            release = asyncio.Event()
            task = asyncio.create_task(
                live_call(live.connection, first_chunk_read, release)
            )
            await first_chunk_read.wait()

            # The rollback: one durable write, the same switch object, no deploy.
            clock.at = 20.0
            await switch.set_mode(
                "off", actor="ops@voni", reason="rollback rehearsal"
            )

            after = []
            for subject in (DEMO, TENANT, DEMO):
                after.append(
                    await admit_new_call(
                        switch, subject, open_cascade=opener(factory)
                    )
                )

            release.set()
            chunks = await task
            await live.connection.close()

            return switch, store, factory, live, after, chunks

        switch, store, factory, live, after, chunks = asyncio.run(scenario())

        # New calls route managed and open zero *new* sockets.
        for admission in after:
            self.assertEqual(admission.decision.mode, "off")
            self.assertEqual(admission.decision.disposition, "managed")
            self.assertEqual(admission.connections, 0)
            self.assertIsNone(admission.connection)
        self.assertEqual(len(factory.connections), 1)

        # The live call finished on the socket it was admitted with.
        self.assertEqual(chunks, ["hello", "goodbye"])
        self.assertEqual(live.decision.disposition, "cascade")
        self.assertEqual(live.connection.closed, True)

        # The flip is a runtime switch: durable, audited, no new instance.
        record = asyncio.run(switch.read())
        self.assertEqual(record.mode, "off")
        self.assertEqual(record.record_version, 2)
        self.assertEqual(len(record.changes), 2)
        self.assertEqual(record.changes[-1].from_mode, "demo")
        self.assertEqual(record.changes[-1].to_mode, "off")
        self.assertEqual(record.changes[-1].actor, "ops@voni")
        self.assertEqual(record.changes[-1].reason, "rollback rehearsal")
        self.assertIs(store.rows["routing:switch"].document["mode"], "off")

    def test_zero_new_cascade_sockets_after_the_flip_over_many_calls(self):
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=Clock(1.0))
            await switch.set_mode("demo", actor="ops@voni")
            factory = ScriptedSocketFactory([Frame("{}")])

            await switch.set_mode("off", actor="ops@voni", reason="rollback")
            before = len(factory.connections)
            for index in range(10):
                subject = DEMO if index % 2 == 0 else TENANT
                await admit_new_call(
                    switch, subject, open_cascade=opener(factory)
                )
            return before, factory.connections

        before, connections = asyncio.run(scenario())

        self.assertEqual(before, 0)
        self.assertEqual(connections, [])

    def test_a_live_call_keeps_the_decision_it_was_admitted_with(self):
        async def scenario():
            store = MemoryStore()
            switch = RoutingSwitch(store, now=Clock(1.0))
            await switch.set_mode("demo", actor="ops@voni")
            factory = ScriptedSocketFactory([Frame("{}")])

            live = await admit_new_call(
                switch, DEMO, open_cascade=opener(factory)
            )
            await switch.set_mode("off", actor="ops@voni", reason="rollback")
            return live

        live = asyncio.run(scenario())

        self.assertEqual(live.decision.mode, "demo")
        self.assertEqual(live.decision.disposition, "cascade")
        self.assertTrue(live.decision.opens_cascade_connection)
        self.assertEqual(live.connections, 1)


if __name__ == "__main__":
    unittest.main()

"""Drain on deploy: readiness fails, new calls are refused, live calls finish (140).

Seams:

* ``cascade.drain.DrainSupervisor`` and ``LiveCalls`` — what the process wires a
  SIGTERM to. It flips the :class:`cascade.health.DrainState` the server reads,
  counts the calls being served, waits for them and only then asks the process
  to exit.
* ``server.create_app`` — the routes that must answer differently once the
  supervisor has flipped the state: ``/readyz`` 503, the call-body route 503, a
  new browser socket refused with the named ``draining`` error, and a call that
  was already live finishing untouched.

No test sleeps: a live call is finished by the scenario itself, so the finish
path costs nothing, and the bound is injected, so reaching
``deploy.drain_max_wait_ms`` is proved in microseconds instead of 30 s.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.drain import DrainSupervisor, LiveCalls, drain_then_exit
from cascade.health import DrainState


class SignalTests(unittest.TestCase):
    def test_sigterm_flips_the_drain_state_and_names_the_reason(self):
        drain = DrainState()
        supervisor = DrainSupervisor(drain=drain, live_calls=LiveCalls())

        self.assertFalse(drain.draining)

        supervisor.start("deploy")

        self.assertTrue(drain.draining)
        self.assertEqual(drain.reason, "deploy")


class LiveCallsTests(unittest.TestCase):
    def test_a_call_is_counted_while_it_is_served(self):
        calls = LiveCalls()
        self.assertTrue(calls.idle)

        calls.started()
        calls.started()
        self.assertEqual(calls.count, 2)
        self.assertFalse(calls.idle)

        calls.finished()
        self.assertEqual(calls.count, 1)
        self.assertFalse(calls.idle)

        calls.finished()
        self.assertEqual(calls.count, 0)
        self.assertTrue(calls.idle)

    def test_a_call_that_never_started_cannot_finish(self):
        with self.assertRaises(ValueError):
            LiveCalls().finished()


class FinishPathTests(unittest.TestCase):
    def test_a_live_call_finishes_before_the_drain_returns(self):
        drain = DrainState()
        calls = LiveCalls()
        seconds = [10.0]
        supervisor = DrainSupervisor(
            drain=drain, live_calls=calls, now=lambda: seconds[0]
        )
        calls.started()

        async def scenario():
            supervisor.start()
            waiting = asyncio.create_task(supervisor.wait())
            await asyncio.sleep(0)
            self.assertFalse(waiting.done(), "the drain must still be waiting")
            seconds[0] = 10.25
            calls.finished()
            return await waiting

        outcome = asyncio.run(scenario())

        self.assertTrue(outcome.finished)
        self.assertFalse(outcome.timed_out)
        self.assertEqual(outcome.live_calls_at_start, 1)
        self.assertEqual(outcome.remaining, 0)
        self.assertEqual(outcome.waited_ms, 250)

    def test_the_process_exits_only_after_the_call_finishes(self):
        calls = LiveCalls()
        supervisor = DrainSupervisor(drain=DrainState(), live_calls=calls)
        exited: list[bool] = []
        calls.started()

        async def scenario():
            task = asyncio.create_task(
                drain_then_exit(supervisor, request_exit=lambda: exited.append(True))
            )
            await asyncio.sleep(0)
            self.assertEqual(exited, [], "exit before the live call finished")
            calls.finished()
            return await task

        outcome = asyncio.run(scenario())

        self.assertTrue(outcome.finished)
        self.assertEqual(exited, [True])

    def test_waiting_before_the_signal_is_refused_by_name(self):
        supervisor = DrainSupervisor(drain=DrainState(), live_calls=LiveCalls())
        with self.assertRaises(RuntimeError):
            asyncio.run(supervisor.wait())


class BoundTests(unittest.TestCase):
    def test_the_wait_is_the_recorded_bound_never_a_local_constant(self):
        from cascade.thresholds import require_bound

        supervisor = DrainSupervisor(drain=DrainState(), live_calls=LiveCalls())

        self.assertEqual(
            supervisor.max_wait_ms, int(require_bound("deploy.drain_max_wait_ms"))
        )

    def test_reaching_the_bound_is_reported_and_the_call_is_not_killed(self):
        calls = LiveCalls()
        calls.started()
        timeouts: list[float] = []

        async def bound_reached(awaitable, *, timeout):
            # The injected bound runner: close the idle wait un-awaited and
            # report the bound instead of sleeping 30 s.
            awaitable.close()
            timeouts.append(timeout)
            raise TimeoutError

        seconds = [100.0]
        supervisor = DrainSupervisor(
            drain=DrainState(),
            live_calls=calls,
            max_wait_ms=30_000,
            now=lambda: seconds[0],
            wait_for=bound_reached,
        )
        supervisor.start()
        seconds[0] = 130.0

        with self.assertLogs("cascade.drain", level="WARNING") as logged:
            outcome = asyncio.run(supervisor.wait())

        self.assertEqual(timeouts, [30.0])
        self.assertTrue(outcome.timed_out)
        self.assertFalse(outcome.finished)
        self.assertEqual(outcome.waited_ms, 30_000)
        self.assertEqual(outcome.remaining, 1, "the live call is left running")
        self.assertEqual(calls.count, 1, "the drain never ends a live call")
        self.assertIn("deploy.drain_max_wait_ms", logged.output[0])
        self.assertIn("30000", logged.output[0])

    def test_a_drain_that_was_cancelled_is_not_ready_state(self):
        # start() then stop() is a cancelled deploy: the drain state returns to
        # accepting calls, and the supervisor is not silently "finished".
        drain = DrainState()
        supervisor = DrainSupervisor(drain=drain, live_calls=LiveCalls())
        supervisor.start()
        drain.stop()
        self.assertFalse(drain.draining)
        self.assertTrue(supervisor.started)


class ServerDrainTests(unittest.TestCase):
    """The server reads the state the supervisor flips; nothing else does."""

    def app(self):
        from server import create_app

        drain = DrainState()
        calls = LiveCalls()
        return (
            create_app(envelope_secret="", clock=lambda: 1_000_000.0, drain=drain, live_calls=calls),
            drain,
            calls,
        )

    def test_a_draining_instance_refuses_a_new_call_and_counts_nothing(self):
        from fastapi.testclient import TestClient

        app, drain, calls = self.app()
        supervisor = DrainSupervisor(drain=drain, live_calls=calls)

        with TestClient(app) as http:
            supervisor.start("deploy")

            self.assertEqual(http.get("/readyz").status_code, 503)
            self.assertIn("draining", http.get("/readyz").json()["checks"]["drain"])

            body = http.post(
                "/v1/call-body",
                json={"call_token": "t", "call_id": "c", "signed_body": {}},
            )
            self.assertEqual(body.status_code, 503)
            self.assertIn("draining", body.json()["detail"])

            with http.websocket_connect("/v1/browser-call") as ws:
                ws.send_json(
                    {
                        "type": "config",
                        "protocolVersion": 1,
                        "agentId": "a",
                        "callToken": "ct1.x.y",
                    }
                )
                message = ws.receive_json()

        self.assertEqual(message["type"], "error")
        self.assertEqual(message["code"], "draining")
        self.assertEqual(calls.count, 0, "a refused call is not a live call")

    def test_a_live_call_finishes_across_the_drain_and_the_count_follows_it(self):
        import threading
        from unittest import mock

        from fastapi.testclient import TestClient

        app, drain, calls = self.app()
        supervisor = DrainSupervisor(drain=drain, live_calls=calls)
        in_call = threading.Event()
        release = threading.Event()

        async def in_flight(websocket, **kwargs):
            in_call.set()
            while not release.is_set():
                await asyncio.sleep(0.01)
            await websocket.send_json(
                {"type": "end", "turns": 1, "metrics": {}, "protocolVersion": 1}
            )

        with mock.patch("server.handle_browser_call", in_flight):
            with TestClient(app) as http:
                with http.websocket_connect("/v1/browser-call") as ws:
                    self.assertTrue(in_call.wait(5), "the call never started")
                    self.assertEqual(calls.count, 1)

                    supervisor.start("deploy")
                    self.assertTrue(drain.draining)
                    self.assertEqual(calls.count, 1, "the drain must not end it")

                    release.set()
                    message = ws.receive_json()

        self.assertEqual(message["type"], "end")
        self.assertEqual(message["turns"], 1)
        self.assertEqual(calls.count, 0)


if __name__ == "__main__":
    unittest.main()

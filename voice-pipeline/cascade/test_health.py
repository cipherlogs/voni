"""Liveness and readiness are different questions (ticket 139).

Seam: ``cascade.health.readiness`` for the dependency report and
``server.create_app`` for the two HTTP routes and the drain refusal.

Liveness is the process: it touches no store, no vendor and no key. Readiness
is the promise to serve a *new* call: the durable store, the daily counter and
the breaker record must be readable, the instance must not be draining, and the
report names the protocol version. A dependency that cannot be read fails
closed — the instance is not ready, and no new call is accepted — while a call
already running is not asked.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.breaker import Breaker, breaker_key
from cascade.counter import DailyCounter, record_key
from cascade.health import DrainState, readiness
from cascade.store import DurableStore, MemoryStore, StoredDocument
from cascade.token import PROTOCOL_VERSION
from server import create_app

NOW = 1_000_000.0


def dependencies():
    store = MemoryStore()
    counter = DailyCounter(
        store,
        cap=10,
        managed_ratio=0.8,
        refuse_ratio=1.0,
        boundary="UTC",
        now=lambda: NOW,
    )
    breaker = Breaker.from_registry(store, now=lambda: NOW)
    return store, counter, breaker


def report(drain=None, store=None, counter=None, breaker=None, errors=None):
    if store is None:
        store, counter, breaker = dependencies()
    return asyncio.run(
        readiness(
            drain=drain if drain is not None else DrainState(),
            store=store,
            counter=counter,
            breaker=breaker,
            configuration_errors=errors,
        )
    )


class ReadinessTests(unittest.TestCase):
    def test_a_healthy_instance_is_ready_and_reports_the_protocol_version(self):
        result = report()

        self.assertTrue(result.ready)
        self.assertFalse(result.draining)
        self.assertEqual(result.protocol_version, PROTOCOL_VERSION)
        self.assertEqual(
            result.checks,
            {"drain": "ok", "store": "ok", "counter": "ok", "breaker": "ok"},
        )
        self.assertEqual(result.to_document()["protocolVersion"], PROTOCOL_VERSION)

    def test_an_unreadable_store_fails_readiness_closed(self):
        store, counter, breaker = dependencies()
        store.fail_pings = True

        result = report(store=store, counter=counter, breaker=breaker)

        self.assertFalse(result.ready)
        self.assertEqual(result.checks["drain"], "ok")
        self.assertIn("unreadable", result.checks["store"])

    def test_an_unreadable_counter_fails_readiness_closed(self):
        store, counter, breaker = dependencies()
        store.fail_reads = True

        result = report(store=store, counter=counter, breaker=breaker)

        self.assertFalse(result.ready)
        self.assertIn("unreadable", result.checks["counter"])

    def test_a_corrupt_counter_record_fails_readiness_closed(self):
        store, counter, breaker = dependencies()
        store.rows[record_key(counter.day_key(NOW))] = StoredDocument(
            version=1, document={"recordVersion": 99}
        )

        result = report(store=store, counter=counter, breaker=breaker)

        self.assertFalse(result.ready)
        self.assertIn("unreadable", result.checks["counter"])

    def test_an_unreadable_breaker_record_fails_readiness_closed(self):
        store, counter, breaker = dependencies()
        store.rows[breaker_key("stt")] = StoredDocument(
            version=1, document={"recordVersion": 1}
        )

        result = report(store=store, counter=counter, breaker=breaker)

        self.assertFalse(result.ready)
        self.assertIn("unreadable", result.checks["breaker"])

    def test_a_missing_breaker_record_is_readable_not_ready_state(self):
        # A fresh deploy has no record yet; the store answered, so readiness
        # must not report the instance store-blind because of an absent row.
        result = report()
        self.assertEqual(result.checks["breaker"], "ok")

    def test_a_draining_instance_is_not_ready_and_names_the_reason(self):
        drain = DrainState()
        drain.start("deploy")

        result = report(drain=drain)

        self.assertFalse(result.ready)
        self.assertTrue(result.draining)
        self.assertEqual(result.drain_reason, "deploy")
        self.assertIn("draining", result.checks["drain"])
        # The dependencies are still reported: draining is not an outage.
        self.assertEqual(result.checks["store"], "ok")

    def test_no_store_configured_fails_readiness_closed(self):
        result = asyncio.run(
            readiness(
                drain=DrainState(),
                store=None,
                counter=None,
                breaker=None,
                configuration_errors={
                    "store": "no durable store configured; set DATABASE_URL"
                },
            )
        )

        self.assertFalse(result.ready)
        self.assertIn("DATABASE_URL", result.checks["store"])

    def test_a_configuration_error_is_named_not_swallowed(self):
        store, counter, breaker = dependencies()
        result = report(
            store=store,
            counter=counter,
            breaker=breaker,
            errors={"counter": "budget.daily_cap is unset"},
        )
        self.assertFalse(result.ready)
        self.assertIn("budget.daily_cap", result.checks["counter"])

    def test_a_dependency_refusal_never_echoes_a_database_url(self):
        store, counter, breaker = dependencies()
        store.fail_pings = True

        class LeakyStore(MemoryStore):
            async def ping(self) -> None:
                raise RuntimeError(
                    "connect failed: postgres://cascade:hunter2@db.internal/voni"
                )

        leaky = LeakyStore()
        result = report(store=leaky, counter=counter, breaker=breaker)
        self.assertFalse(result.ready)
        self.assertNotIn("hunter2", result.checks["store"])


class ServerHealthTests(unittest.TestCase):
    def client(self, **kwargs):
        from fastapi.testclient import TestClient

        return TestClient(create_app(envelope_secret="", clock=lambda: NOW, **kwargs))

    def test_healthz_is_liveness_and_touches_no_store(self):
        store, counter, breaker = dependencies()
        store.fail_pings = True
        store.fail_reads = True
        app = create_app(
            envelope_secret="", clock=lambda: NOW, store=store,
            counter=counter, breaker=breaker,
        )
        from fastapi.testclient import TestClient

        response = TestClient(app).get("/healthz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["protocolVersion"], PROTOCOL_VERSION)

    def test_readyz_is_ready_when_the_dependencies_are_readable(self):
        store, counter, breaker = dependencies()
        response = self.client(store=store, counter=counter, breaker=breaker).get(
            "/readyz"
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ready"])
        self.assertEqual(body["protocolVersion"], PROTOCOL_VERSION)
        self.assertEqual(body["checks"]["breaker"], "ok")

    def test_readyz_fails_closed_without_a_durable_store(self):
        response = self.client(store=None, counter=None, breaker=None).get("/readyz")

        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json()["ready"])
        self.assertIn("DATABASE_URL", response.json()["checks"]["store"])

    def test_readyz_fails_closed_when_the_store_is_unreadable(self):
        store, counter, breaker = dependencies()
        store.fail_pings = True
        response = self.client(store=store, counter=counter, breaker=breaker).get(
            "/readyz"
        )

        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json()["ready"])

    def test_a_draining_instance_refuses_a_new_call_and_says_why(self):
        store, counter, breaker = dependencies()
        drain = DrainState()
        app = create_app(
            envelope_secret="",
            clock=lambda: NOW,
            store=store,
            counter=counter,
            breaker=breaker,
            drain=drain,
        )
        from fastapi.testclient import TestClient

        with TestClient(app) as http:
            app.state.drain.start("deploy")

            ready = http.get("/readyz")
            self.assertEqual(ready.status_code, 503)
            self.assertIn("draining", ready.json()["checks"]["drain"])

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
                        "protocolVersion": PROTOCOL_VERSION,
                        "agentId": "a",
                        "callToken": "ct1.x.y",
                    }
                )
                message = ws.receive_json()
            self.assertEqual(message["type"], "error")
            self.assertEqual(message["code"], "draining")

    def test_a_call_already_running_survives_the_drain(self):
        store, counter, breaker = dependencies()
        drain = DrainState()
        app = create_app(
            envelope_secret="",
            clock=lambda: NOW,
            store=store,
            counter=counter,
            breaker=breaker,
            drain=drain,
        )

        async def in_flight(websocket, **kwargs):
            # The deploy drains while this call is live: it must still finish.
            app.state.drain.start("deploy")
            await websocket.send_json(
                {
                    "type": "end",
                    "turns": 1,
                    "metrics": {},
                    "protocolVersion": PROTOCOL_VERSION,
                }
            )

        from unittest import mock

        with mock.patch("server.handle_browser_call", in_flight):
            from fastapi.testclient import TestClient

            with TestClient(app) as http:
                with http.websocket_connect("/v1/browser-call") as ws:
                    message = ws.receive_json()

        self.assertEqual(message["type"], "end")
        self.assertEqual(message["turns"], 1)
        self.assertTrue(drain.draining)

    def test_readiness_never_opens_a_vendor(self):
        store, counter, breaker = dependencies()
        from unittest import mock

        with mock.patch(
            "transport.default_backends",
            side_effect=AssertionError("readiness opened a vendor backend"),
        ):
            response = self.client(store=store, counter=counter, breaker=breaker).get(
                "/readyz"
            )
        self.assertEqual(response.status_code, 200)

    def test_liveness_and_readiness_need_no_vendor_key(self):
        # create_app with an empty environment serves both routes; only the
        # durable store is a readiness dependency, never a vendor.
        import os
        from unittest import mock

        store, counter, breaker = dependencies()
        with mock.patch.dict(os.environ, {}, clear=True):
            http = self.client(store=store, counter=counter, breaker=breaker)
            self.assertEqual(http.get("/healthz").status_code, 200)
            self.assertEqual(http.get("/readyz").status_code, 200)


class StoreProtocolTests(unittest.TestCase):
    def test_the_postgres_adapter_is_a_durable_store_and_needs_a_dsn(self):
        from cascade.pg_store import PostgresStore

        self.assertIsInstance(PostgresStore("postgres://localhost/voni"), DurableStore)
        with self.assertRaises(ValueError):
            PostgresStore("")


if __name__ == "__main__":
    unittest.main()

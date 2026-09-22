"""Tests for the voice-pipeline service runner.

No sockets opened, no vendors touched: route registration plus the health
endpoint over an in-process TestClient.
"""

import unittest

from server import create_app


class ServerTests(unittest.TestCase):
    def test_browser_call_route_registered(self):
        app = create_app()
        ws_routes = [
            route.path
            for route in app.routes
            if getattr(route, "path", "").startswith("/v1/")
        ]
        self.assertIn("/v1/browser-call", ws_routes)

    def test_health_endpoint_ok(self):
        from fastapi.testclient import TestClient

        client = TestClient(create_app())
        response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertIn("service", response.json())


if __name__ == "__main__":
    unittest.main()

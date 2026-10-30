"""Tests for the voice-pipeline service runner.

No sockets opened, no vendors touched: route registration, the health endpoint
and the app -> service stored-body handoff (ticket 65) over an in-process
TestClient.
"""

import json
import unittest

from cascade.body_map import body_fingerprint
from cascade.envelope import sign_body
from cascade.testing import FakeClock
from cascade.token import PROTOCOL_VERSION, mint_call_token
from server import create_app

SECRET = "test-only-server-secret"
ACCOUNT = "acct_test_server_65"
CALL_ID = "call_server_65"
AGENT_ID = "agent_server_65"
CLOCK = FakeClock(1_000_000.0)
TOKEN = mint_call_token(
    secret=SECRET,
    call_id=CALL_ID,
    subject=AGENT_ID,
    clock=CLOCK,
    nonce="server-token-136",
)

BODY = {
    "name": "server-agent",
    "system_prompt": "You are the signed body's agent.",
    "greeting": "Hola.",
    "voice": {"voice_id": "lola"},
    "input": {
        "format": "pcm_24000",
        "language_codes": ["es"],
        "transcription_mode": "accurate",
        "transcription_prompt": "",
        "keyterms": ["Voni"],
        "voice_focus": "near-field",
        "voice_focus_threshold": 0.4,
        "turn_detection": None,
    },
    "output": {"voice": "lola", "format": "pcm_24000", "volume": 0.851},
    "tools": [],
    "llm": [],
}


def browser_config() -> dict:
    return {
        "type": "config",
        "protocolVersion": PROTOCOL_VERSION,
        "agentId": AGENT_ID,
        "callToken": TOKEN,
    }


def signed_message(body=None, *, call_id: str = CALL_ID, agent_id: str = AGENT_ID) -> dict:
    served = BODY if body is None else body
    signed = sign_body(
        body=served,
        minted_fingerprint=body_fingerprint(served, account_salt=ACCOUNT),
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=call_id,
        agent_id=agent_id,
        ttl_ms=60_000,
        clock=CLOCK,
    )
    return json.loads(json.dumps(signed.message()))


def delivery(**overrides) -> dict:
    payload = {
        "call_token": TOKEN,
        "call_id": CALL_ID,
        "signed_body": signed_message(),
    }
    payload.update(overrides)
    return payload


def client(secret: str = SECRET):
    from fastapi.testclient import TestClient

    return TestClient(create_app(envelope_secret=secret, clock=CLOCK))


class ServerTests(unittest.TestCase):
    def test_browser_call_route_registered(self):
        app = create_app()
        ws_routes = [
            route.path
            for route in app.routes
            if getattr(route, "path", "").startswith("/v1/")
        ]
        self.assertIn("/v1/browser-call", ws_routes)
        self.assertIn("/v1/call-body", ws_routes)

    def test_health_endpoint_ok(self):
        from fastapi.testclient import TestClient

        response = TestClient(create_app()).get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertIn("service", response.json())

    def test_health_reports_the_protocol_version_it_speaks(self):
        response = client().get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["protocolVersion"], PROTOCOL_VERSION)


class StoredBodyChannelTests(unittest.TestCase):
    def test_the_app_delivers_the_signed_body_over_the_service_channel(self):
        http = client()
        response = http.post("/v1/call-body", json=delivery())

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["agent_id"], AGENT_ID)
        self.assertEqual(
            response.json()["body_hash"], delivery()["signed_body"]["envelope"]["body_hash"]
        )

    def test_a_body_that_does_not_match_its_hash_is_refused_by_name(self):
        payload = delivery()
        payload["signed_body"]["body"]["system_prompt"] = "You are someone else."

        response = client().post("/v1/call-body", json=payload)

        self.assertEqual(response.status_code, 400)
        self.assertIn("body hash", response.json()["detail"])
        self.assertIn(CALL_ID, response.json()["detail"])

    def test_a_body_signed_for_another_call_is_refused_by_name(self):
        response = client().post(
            "/v1/call-body", json=delivery(call_id="some_other_call")
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("minted for call", response.json()["detail"])

    def test_an_unknown_delivery_field_is_refused_by_name(self):
        response = client().post("/v1/call-body", json=delivery(system_prompt="hi"))
        self.assertEqual(response.status_code, 400)
        self.assertIn('"system_prompt"', response.json()["detail"])

    def test_a_missing_delivery_field_is_refused_by_name(self):
        payload = delivery()
        del payload["signed_body"]
        response = client().post("/v1/call-body", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn('"signed_body"', response.json()["detail"])

    def test_the_channel_refuses_to_run_without_a_secret(self):
        http = client(secret="")
        response = http.post("/v1/call-body", json=delivery())
        self.assertEqual(response.status_code, 503)
        self.assertIn("VOICE_PIPELINE_ENVELOPE_SECRET", response.json()["detail"])

    def test_an_expired_call_token_is_refused_at_connect_by_name(self):
        from fastapi.testclient import TestClient

        expired = mint_call_token(
            secret=SECRET,
            call_id=CALL_ID,
            subject=AGENT_ID,
            clock=FakeClock(1_000_000.0 - 120.0),
            nonce="server-expired-136",
        )
        app = create_app(envelope_secret=SECRET, clock=CLOCK)
        with TestClient(app) as http:
            with http.websocket_connect("/v1/browser-call") as ws:
                ws.send_json(browser_config() | {"callToken": expired})
                message = ws.receive_json()

        self.assertEqual(message["type"], "error")
        self.assertIn("expired", message["message"])
        self.assertNotIn(expired, message["message"])

    def test_the_browser_socket_claims_the_body_the_app_delivered(self):
        from fastapi.testclient import TestClient

        app = create_app(envelope_secret=SECRET, clock=CLOCK)
        with TestClient(app) as http:
            posted = http.post("/v1/call-body", json=delivery())
            self.assertEqual(posted.status_code, 202)

            # The token now has a verified body: the socket finds it (and then
            # refuses the wrong agent id) instead of reporting an unknown token.
            with http.websocket_connect("/v1/browser-call") as ws:
                ws.send_json(browser_config() | {"agentId": "not_the_envelope_agent"})
                message = ws.receive_json()

        self.assertEqual(message["type"], "error")
        self.assertIn("not_the_envelope_agent", message["message"])
        self.assertIn(AGENT_ID, message["message"])


if __name__ == "__main__":
    unittest.main()

"""One protocol version, and a named refusal for anything else (ticket 138).

Seam: ``cascade.token.parse_browser_config`` for the config frame's
``protocolVersion``, and ``transport.handle_browser_call`` for the frame the
service sends back. A half-deployed pair fails on the version, by name, before
any body is claimed or any vendor socket opens.

The app's copy of the number lives in
``voni/src/lib/voice/cascade-session.ts``; the parity test reads it from there,
so the two deploys cannot silently speak different versions.
"""

from __future__ import annotations

import asyncio
import re
import unittest
from pathlib import Path

from cascade.token import (
    PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    UnknownProtocolVersion,
    parse_browser_config,
)
from transport import handle_browser_call

REPO_ROOT = Path(__file__).resolve().parents[2]
TS_CLIENT = REPO_ROOT / "voni/src/lib/voice/cascade-session.ts"


def config(**overrides) -> dict:
    frame = {
        "type": "config",
        "protocolVersion": PROTOCOL_VERSION,
        "agentId": "agent-138",
        "callToken": "ct1.payload.signature",
    }
    frame.update(overrides)
    return frame


class SingleVersionTests(unittest.TestCase):
    def test_the_app_and_the_service_speak_one_protocol_version(self):
        source = TS_CLIENT.read_text(encoding="utf-8")
        match = re.search(
            r"export const CASCADE_PROTOCOL_VERSION\s*=\s*(\d+)\s*;", source
        )
        self.assertIsNotNone(
            match, "the app must export one CASCADE_PROTOCOL_VERSION"
        )
        self.assertEqual(int(match.group(1)), PROTOCOL_VERSION)
        self.assertEqual(SUPPORTED_PROTOCOL_VERSIONS, (PROTOCOL_VERSION,))

    def test_a_missing_version_is_refused_by_name(self):
        frame = config()
        del frame["protocolVersion"]
        with self.assertRaises(UnknownProtocolVersion) as caught:
            parse_browser_config(frame)
        self.assertEqual(caught.exception.code, "protocol_version")
        self.assertIn("missing", str(caught.exception))

    def test_a_mismatched_version_asserts_the_named_refusal(self):
        for version in (0, PROTOCOL_VERSION + 1, 99, True):
            with self.subTest(version=version):
                with self.assertRaises(UnknownProtocolVersion) as caught:
                    parse_browser_config(config(protocolVersion=version))
                self.assertEqual(caught.exception.code, "protocol_version")
                self.assertEqual(caught.exception.version, version)
                self.assertIn(
                    "update the app or the service together", str(caught.exception)
                )


class FakeWebSocket:
    def __init__(self, inbound: list[dict]) -> None:
        self._inbound = list(inbound)
        self.sent: list[dict] = []

    async def receive_json(self) -> dict:
        await asyncio.sleep(0)
        if not self._inbound:
            raise RuntimeError("closed")
        return self._inbound.pop(0)

    async def send_json(self, message: dict) -> None:
        await asyncio.sleep(0)
        self.sent.append(message)


def run(frame: dict) -> tuple[list[dict], list[object]]:
    async def scenario():
        ws = FakeWebSocket([frame, {"type": "stop"}])
        opened: list[object] = []
        await handle_browser_call(
            ws,
            config_message=frame,
            backend_factory=lambda config: opened.append(config) or (None, None, None),
            body_channel=None,
            call_tokens=None,
            pipeline_factory=lambda body: (_ for _ in ()).throw(RuntimeError("opened")),
        )
        return ws.sent, opened

    return asyncio.run(scenario())


class RefusalTests(unittest.TestCase):
    def test_a_mismatched_version_is_named_and_opens_nothing(self):
        sent, opened = run(config(protocolVersion=PROTOCOL_VERSION + 1))

        errors = [m for m in sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], "protocol_version")
        self.assertIn("protocol version", errors[0]["message"])
        self.assertEqual(opened, [], "no backend may open on a version mismatch")

    def test_a_missing_version_is_named_and_opens_nothing(self):
        frame = config()
        del frame["protocolVersion"]
        sent, opened = run(frame)

        errors = [m for m in sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], "protocol_version")
        self.assertIn("missing", errors[0]["message"])
        self.assertEqual(opened, [])


if __name__ == "__main__":
    unittest.main()

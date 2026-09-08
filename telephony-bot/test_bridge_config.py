import os
import unittest
from unittest.mock import patch

from bridge_config import BridgeConfig, BridgeConfigClient


CONFIG = BridgeConfig(
    assemblyai_api_key="assembly-secret",
    telnyx_api_key="telnyx-secret",
    organization_id="org-1",
    agent_id="agent-1",
    assemblyai_agent_id="remote-1",
    telnyx_connection_id="connection-1",
    caller_number="+971500000000",
    human_transfer_configured=True,
)


class FakeClient(BridgeConfigClient):
    def __init__(self):
        super().__init__(ttl_seconds=30)
        self.fetches = 0

    async def _fetch(self):
        self.fetches += 1
        return CONFIG


class BridgeConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_cache_and_forced_refresh(self):
        with patch.dict(
            os.environ,
            {"VONI_API_URL": "http://localhost:3000", "VONI_TOOL_SECRET": "shared"},
            clear=False,
        ):
            client = FakeClient()
            self.assertEqual(await client.get(), CONFIG)
            self.assertEqual(await client.get(), CONFIG)
            self.assertEqual(client.fetches, 1)
            await client.get(force=True)
            self.assertEqual(client.fetches, 2)

    async def test_missing_bootstrap_is_rejected(self):
        with patch.dict(os.environ, {}, clear=True):
            client = BridgeConfigClient()
            with self.assertRaisesRegex(RuntimeError, "VONI_API_URL"):
                await client.get()

    async def test_non_https_remote_origin_is_rejected(self):
        with patch.dict(
            os.environ,
            {"VONI_API_URL": "http://example.com", "VONI_TOOL_SECRET": "shared"},
            clear=True,
        ):
            client = BridgeConfigClient()
            with self.assertRaisesRegex(RuntimeError, "HTTPS"):
                await client.get()


if __name__ == "__main__":
    unittest.main()

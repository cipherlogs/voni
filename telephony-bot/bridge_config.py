"""Short-lived Voni bridge configuration fetched before each call."""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from urllib.parse import urlparse

import aiohttp


@dataclass(frozen=True)
class BridgeConfig:
    assemblyai_api_key: str
    telnyx_api_key: str
    organization_id: str
    agent_id: str
    assemblyai_agent_id: str
    telnyx_connection_id: str
    caller_number: str
    human_transfer_configured: bool


class BridgeConfigClient:
    def __init__(self, ttl_seconds: float = 30.0) -> None:
        self.api_url = os.environ.get("VONI_API_URL", "").rstrip("/")
        self.secret = os.environ.get("VONI_TOOL_SECRET", "")
        self.ttl_seconds = ttl_seconds
        self._cached: BridgeConfig | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    def _validate_bootstrap(self) -> None:
        if not self.api_url or not self.secret:
            raise RuntimeError("VONI_API_URL and VONI_TOOL_SECRET are required.")
        parsed = urlparse(self.api_url)
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
            raise RuntimeError("VONI_API_URL must use HTTPS, except for local development.")

    async def get(self, force: bool = False) -> BridgeConfig:
        self._validate_bootstrap()
        now = time.monotonic()
        if not force and self._cached and now < self._expires_at:
            return self._cached
        async with self._lock:
            now = time.monotonic()
            if not force and self._cached and now < self._expires_at:
                return self._cached
            value = await self._fetch()
            self._cached = value
            self._expires_at = time.monotonic() + self.ttl_seconds
            return value

    async def _fetch(self) -> BridgeConfig:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                f"{self.api_url}/api/internal/bridge-config",
                headers={"Authorization": f"Bearer {self.secret}"},
            ) as response:
                try:
                    body = await response.json()
                except Exception as error:
                    raise RuntimeError("Voni returned an invalid bridge configuration.") from error
                if response.status != 200 or not body.get("ok"):
                    message = body.get("error") if isinstance(body, dict) else None
                    raise RuntimeError(message or "Voni bridge configuration is unavailable.")
            credentials = body["credentials"]
            defaults = body["defaults"]
            return BridgeConfig(
                assemblyai_api_key=credentials["assemblyaiApiKey"],
                telnyx_api_key=credentials["telnyxApiKey"],
                organization_id=defaults["organizationId"],
                agent_id=defaults["agentId"],
                assemblyai_agent_id=defaults["assemblyaiAgentId"],
                telnyx_connection_id=defaults["telnyxConnectionId"],
                caller_number=defaults["callerNumber"],
                human_transfer_configured=bool(defaults["humanTransferConfigured"]),
            )


bridge_config = BridgeConfigClient()

"""Read one stored agent's served body, for the settings a call must honour.

The phone bridge sends only `agent_id` to the platform, so before this module
its turn-taking was whatever the bridge guessed. The body is the one place the
Turn preset (or a demo experiment's windows) is expressed; reading it is what
lets the bridge restore something other than a hardcoded object.

The read is deliberately narrow: only `input.turn_detection`, which is `null`
for the Turn preset and an object only for the demo latency experiment. It runs
while the greeting plays and is awaited at the first sensitive-capture turn, so
it never sits between the caller's answer and the agent's question.

A failed or unreadable body is the Turn preset, not a guessed window pair: every
production body serves `null`, and the capture floor does not depend on a
successful read. The failure is logged so a silently unread body is visible.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable
from urllib.parse import quote

import aiohttp
from loguru import logger

AGENTS_URL = "https://agents.assemblyai.com/v1/agents"
READ_TIMEOUT_SECONDS = 5

TurnDetection = dict[str, Any] | None
FetchBody = Callable[[str, dict[str, str]], Awaitable[Any]]


def turn_detection_from_body(payload: Any) -> TurnDetection:
    """The body's `input.turn_detection`, verbatim.

    `null` (or an absent key) is the Turn preset. A payload with no readable
    `input` object is refused rather than treated as a body that happens to
    serve the preset.
    """
    if not isinstance(payload, dict):
        raise ValueError("stored agent body must be an object")
    input_body = payload.get("input")
    if not isinstance(input_body, dict):
        raise ValueError("stored agent body served no input object")
    turn_detection = input_body.get("turn_detection")
    if turn_detection is None:
        return None
    if not isinstance(turn_detection, dict):
        raise ValueError("stored agent body served an unreadable turn_detection")
    return dict(turn_detection)


async def _fetch_body(url: str, headers: dict[str, str]) -> Any:
    timeout = aiohttp.ClientTimeout(total=READ_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers) as response:
            if response.status != 200:
                detail = await response.text()
                raise RuntimeError(
                    f"stored agent read failed {response.status}: {detail[:200]}"
                )
            return await response.json(content_type=None)


async def read_turn_detection(
    api_key: str,
    agent_id: str | None,
    fetch: FetchBody | None = None,
) -> TurnDetection:
    """Read `input.turn_detection` for the agent this call serves.

    Never fatal: a call must not ring out or fail a sensitive question because
    a settings read failed. `None` is the Turn preset, which every production
    body serves today.
    """
    if not api_key or not agent_id:
        return None
    url = f"{AGENTS_URL}/{quote(agent_id, safe='')}"
    try:
        payload = await (fetch or _fetch_body)(
            url, {"Authorization": f"Bearer {api_key}"}
        )
        return turn_detection_from_body(payload)
    except Exception as error:
        logger.warning(f"could not read stored agent {agent_id}; Turn preset used: {error}")
        return None

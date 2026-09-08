"""Place one explicitly confirmed outbound call using Voni bridge defaults."""

from __future__ import annotations

import argparse
import asyncio
import os

import aiohttp

from bridge_config import bridge_config


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", help="E.164 destination, for example +447512345678")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="confirm that the destination owner approved this live call",
    )
    return parser.parse_args()


async def place(destination: str, approved: bool) -> None:
    if not approved:
        raise SystemExit("Refusing to dial without --yes confirming user approval.")
    public_host = os.environ.get("PUBLIC_HOST", "").strip().removeprefix("https://")
    if not public_host or "/" in public_host:
        raise SystemExit("Set PUBLIC_HOST to the current tunnel hostname, with no scheme or path.")

    runtime = await bridge_config.get(force=True)
    if destination == runtime.caller_number:
        raise SystemExit("Refusing to dial: the caller and destination numbers are identical.")

    payload = {
        "connection_id": runtime.telnyx_connection_id,
        "to": destination,
        "from": runtime.caller_number,
        "stream_url": f"wss://{public_host}/media-stream",
        "stream_track": "inbound_track",
        "stream_bidirectional_mode": "rtp",
        "stream_bidirectional_codec": "PCMA",
    }
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            "https://api.telnyx.com/v2/calls",
            headers={
                "Authorization": f"Bearer {runtime.telnyx_api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as response:
            body = await response.json()
            if response.status < 200 or response.status >= 300 or not body.get("data"):
                raise SystemExit(f"Telnyx rejected the call with HTTP {response.status}.")
            call_control_id = str(body["data"].get("call_control_id", ""))
            print(f"DIALING {call_control_id[:32]}...")


if __name__ == "__main__":
    args = arguments()
    asyncio.run(place(args.destination, args.yes))

"""Outbound campaign dialer (plan Day 7-8).

Runs beside `server.py`, not inside it. The split follows the media path: Telnyx
needs `stream_url: wss://<PUBLIC_HOST>/media-stream`, and PUBLIC_HOST is this
machine's tunnel hostname, which Voni never learns — so Voni owns the queue and
the policy, and this process owns the dialling.

**This is dry-run by default and dials only with `--live`.** Every other safety
property follows from that: the whole loop — queue order, calling window,
consent, backoff, attempt caps — can be proven against real campaign data
without placing a call or spending anything, and the preview asks Voni the same
question the live run does, so it cannot quietly disagree with it.

    python campaign_runner.py                 # preview; places no calls
    python campaign_runner.py --live --yes    # actually dials
    python campaign_runner.py --once          # one poll, then exit

Outcomes are *not* reported from here. `server.py` sees `call.hangup` with the
carrier's hangup cause and reports it, because this process has already moved on
by then. The two are joined by `client_state`, which Telnyx echoes back on every
webhook for the call.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os

import aiohttp
from loguru import logger

from bridge_config import bridge_config

POLL_SECONDS_DEFAULT = 20.0

# Telnyx caps client_state at 512 bytes of base64. We send two ids, so this is
# far under it, but the encode is asserted rather than assumed — a silently
# truncated state means an unattributable call.
CLIENT_STATE_LIMIT = 512


def encode_client_state(campaign_lead_id: str, campaign_id: str) -> str:
    """Pack the campaign linkage Telnyx will echo back on every webhook."""
    raw = json.dumps(
        {"campaign_lead_id": campaign_lead_id, "campaign_id": campaign_id},
        separators=(",", ":"),
    ).encode()
    encoded = base64.b64encode(raw).decode()
    if len(encoded) > CLIENT_STATE_LIMIT:
        raise ValueError("client_state exceeds the Telnyx limit")
    return encoded


def decode_client_state(value: str | None) -> dict[str, str]:
    """Inverse of `encode_client_state`; never raises on junk input."""
    if not value:
        return {}
    try:
        decoded = json.loads(base64.b64decode(value))
    except Exception:
        return {}
    return decoded if isinstance(decoded, dict) else {}


class DispatchClient:
    """Voni's dispatch API — the queue, the policy, and the outcome log."""

    def __init__(self) -> None:
        self.api_url = os.environ.get("VONI_API_URL", "").rstrip("/")
        self.secret = os.environ.get("VONI_TOOL_SECRET", "")

    def _require_config(self) -> None:
        if not self.api_url or not self.secret:
            raise SystemExit(
                "Set VONI_API_URL and VONI_TOOL_SECRET (the same secret Voni holds)."
            )

    async def next_target(
        self, session: aiohttp.ClientSession, mode: str
    ) -> dict:
        self._require_config()
        async with session.post(
            f"{self.api_url}/api/internal/dispatch",
            headers={"Authorization": f"Bearer {self.secret}"},
            json={"mode": mode},
        ) as response:
            body = await response.json(content_type=None)
            if response.status != 200 or not body.get("ok"):
                message = body.get("error") if isinstance(body, dict) else None
                raise RuntimeError(message or f"dispatch failed with HTTP {response.status}")
            return body

    async def report(
        self,
        session: aiohttp.ClientSession,
        campaign_lead_id: str,
        outcome: str,
        call_id: str | None = None,
    ) -> None:
        self._require_config()
        async with session.post(
            f"{self.api_url}/api/internal/dispatch/outcome",
            headers={"Authorization": f"Bearer {self.secret}"},
            json={
                "campaignLeadId": campaign_lead_id,
                "outcome": outcome,
                "callId": call_id,
            },
        ) as response:
            if response.status != 200:
                logger.warning(
                    f"outcome report rejected with HTTP {response.status} "
                    f"for campaign_lead={campaign_lead_id}"
                )


dispatch = DispatchClient()


async def place_campaign_call(
    session: aiohttp.ClientSession, target: dict, public_host: str
) -> bool:
    """Dial one lead. Returns True if Telnyx accepted the call."""
    runtime = await bridge_config.get()

    if target["phone"] == runtime.caller_number:
        # Dialling our own caller ID connects the bridge to itself and burns
        # both legs' minutes. Cheap to check, confusing to debug.
        logger.error("refusing to dial: destination equals the caller number")
        return False

    payload = {
        "connection_id": runtime.telnyx_connection_id,
        "to": target["phone"],
        "from": runtime.caller_number,
        "stream_url": f"wss://{public_host}/media-stream",
        "stream_track": "inbound_track",
        "stream_bidirectional_mode": "rtp",
        "stream_bidirectional_codec": "PCMA",
        "client_state": encode_client_state(
            target["campaignLeadId"], target["campaignId"]
        ),
    }
    async with session.post(
        "https://api.telnyx.com/v2/calls",
        headers={
            "Authorization": f"Bearer {runtime.telnyx_api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
    ) as response:
        body = await response.json(content_type=None)
        if response.status < 200 or response.status >= 300 or not body.get("data"):
            logger.error(f"Telnyx rejected the call with HTTP {response.status}: {body}")
            return False
        control_id = str(body["data"].get("call_control_id", ""))
        logger.info(f"DIALING {target['phone']} control_id={control_id[:32]}...")
        return True


def describe(target: dict) -> str:
    name = target.get("leadName") or "unnamed lead"
    return (
        f"{target['phone']} ({name}) for campaign \"{target['campaignName']}\" — "
        f"attempt {target['attempt']} of {target['maxAttempts']}"
    )


async def run(live: bool, once: bool, interval: float) -> None:
    public_host = os.environ.get("PUBLIC_HOST", "").strip().removeprefix("https://")
    if live and (not public_host or "/" in public_host):
        raise SystemExit(
            "Set PUBLIC_HOST to the current tunnel hostname, with no scheme or path."
        )

    mode = "claim" if live else "preview"
    logger.info(
        "campaign runner starting in "
        + ("LIVE mode — real calls will be placed" if live else "PREVIEW mode — no calls will be placed")
    )

    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        while True:
            try:
                result = await dispatch.next_target(session, mode)
            except Exception as error:
                # Voni being briefly unreachable is not fatal; the queue is
                # durable and the next poll picks up where this one failed.
                logger.warning(f"dispatch unavailable: {error}")
                if once:
                    return
                await asyncio.sleep(interval)
                continue

            if result.get("requeued"):
                logger.info(f"requeued {result['requeued']} stalled dial(s)")

            if result.get("status") == "idle":
                logger.info(f"idle: {result.get('reason')}")
            else:
                target = result["target"]
                if not live:
                    logger.info(f"WOULD DIAL {describe(target)}")
                else:
                    logger.info(f"dialing {describe(target)}")
                    accepted = await place_campaign_call(session, target, public_host)
                    if not accepted:
                        # The lead was claimed and an attempt consumed, but no
                        # call reached the carrier. `cancelled` hands the
                        # attempt back rather than burning it on our own failure.
                        await dispatch.report(
                            session, target["campaignLeadId"], "cancelled"
                        )

            if once:
                return
            await asyncio.sleep(interval)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="place real calls; without this the runner only previews",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="required with --live, confirming that dialling these leads is approved",
    )
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    parser.add_argument(
        "--interval",
        type=float,
        default=POLL_SECONDS_DEFAULT,
        help=f"seconds between polls (default {POLL_SECONDS_DEFAULT:g})",
    )
    args = parser.parse_args()
    if args.live and not args.yes:
        # Matches place_call.py: going live is two deliberate flags, not one, so
        # that a shell-history recall of the preview command cannot start
        # dialling strangers.
        raise SystemExit("Refusing to dial: pass --yes with --live to confirm approval.")
    return args


if __name__ == "__main__":
    options = arguments()
    try:
        asyncio.run(run(options.live, options.once, options.interval))
    except KeyboardInterrupt:
        logger.info("campaign runner stopped")

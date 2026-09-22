"""Smoke a full cascade call over the wire against real vendors.

Starts nothing itself: point it at a running service (see scripts/local_server.sh),
it sends one mp3 as paced mic frames and prints captions, audio stats, and the
ledger gaps. Keys come from host env (or ../voni/.dev.vars as a dev fallback),
voice auto-picks an English Cartesia voice when --voice-id is absent.

    ../telephony-bot/.venv/bin/python scripts/smoke_call.py [--url ...] [--audio ...]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent


def load_dev_vars(*names: str) -> None:
    wanted = set(names)
    try:
        text = (REPO / "voni" / ".dev.vars").read_text()
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("'\"")
        if key in wanted and value and not os.environ.get(key):
            os.environ[key] = value


async def pick_english_voice() -> tuple[str, str]:
    import aiohttp

    key = os.environ.get("CARTESIA_API_KEY", "")
    headers = {"X-API-Key": key, "Cartesia-Version": "2024-06-10"}
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get("https://api.cartesia.ai/voices", headers=headers) as resp:
            resp.raise_for_status()
            voices = await resp.json()
            items = voices if isinstance(voices, list) else voices.get("data", [])
            english = [v for v in items if (v.get("language") or "").startswith("en")]
            chosen = (english or items)[0]
            print(f"voice: {chosen.get('name')}")
            return chosen["id"], "sonic-2"


def decode_mp3(path: str) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:8766/v1/browser-call")
    parser.add_argument("--audio", default=str(REPO / "voni/public/voices/anna.mp3"))
    parser.add_argument("--llm-model", default="alibaba/qwen3.5-flash")
    parser.add_argument("--voice-id", default="")
    args = parser.parse_args()

    load_dev_vars("CARTESIA_API_KEY")
    voice_id, voice_model = (
        (args.voice_id, "sonic-2")
        if args.voice_id
        else (await pick_english_voice())
    )

    import websockets

    pcm = decode_mp3(args.audio)
    print(f"audio_bytes={len(pcm)}")
    t0 = time.monotonic()
    async with websockets.connect(args.url, max_size=8 * 1024 * 1024) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "config",
                    "pipeline": {
                        "llm_model": args.llm_model,
                        "tts_voice": voice_id,
                        "tts_model": voice_model,
                        "fallback_mode": "cascade",
                        "language_codes": ["en"],
                    },
                    "system_prompt": "You are Voni, a friendly sales assistant. Keep every reply to one short sentence.",
                    "tools": [],
                    "agent_name": "smoke",
                }
            )
        )
        step = 9600
        for i in range(0, len(pcm), step):
            await ws.send(
                json.dumps({"type": "audio", "data": base64.b64encode(pcm[i : i + step]).decode()})
            )
            await asyncio.sleep(0.15)
        # Trailing silence so the turn can finalize.
        silence = b"\x00" * 9600
        for _ in range(8):
            await ws.send(json.dumps({"type": "audio", "data": base64.b64encode(silence).decode()}))
            await asyncio.sleep(0.15)
        audio_chunks = 0
        audio_bytes = 0
        stop_sent = False
        while True:
            try:
                message = json.loads(await asyncio.wait_for(ws.recv(), timeout=45))
            except asyncio.TimeoutError:
                print("TIMEOUT waiting for server messages")
                break
            kind = message.get("type")
            if kind == "caption":
                dt = time.monotonic() - t0
                print(f"[{dt:5.2f}s] caption {message['role']} final={message['final']}: {message['text'][:80]!r}")
                if message["role"] == "agent" and message["final"] and not stop_sent:
                    # Let playout audio arrive, then hang up so the server
                    # sends the end-of-call metrics.
                    stop_sent = True
                    await asyncio.sleep(3)
                    await ws.send(json.dumps({"type": "stop"}))
            elif kind == "audio":
                audio_chunks += 1
                audio_bytes += len(base64.b64decode(message["data"]))
            elif kind == "interrupted":
                print("interrupted notice")
            elif kind == "end":
                print(f"audio_chunks={audio_chunks} audio_bytes={audio_bytes}")
                print(f"turns={message.get('turns')} gaps_ms={message.get('metrics', {}).get('gaps_ms')}")
                if message.get("error"):
                    print(f"end-error: {message['error'][:200]}")
                break
            elif kind == "error":
                print(f"server error: {message.get('message', '')[:200]}")
                break


asyncio.run(main())

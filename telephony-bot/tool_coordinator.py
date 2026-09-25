"""AssemblyAI client-side tool sequencing for the Telnyx bridge.

Tool work runs in independent tasks. The audio-forwarding coroutine only
handles small state transitions and WebSocket sends, never an HTTP request.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any

import aiohttp
from loguru import logger

from voice_judge import allow_tool_call

SENSITIVE_CAPTURE_TOOL = "prepare_sensitive_capture"
END_CALL_TOOL = "end_call"
HOLD_TOOLS = {
    "book_viewing",
    "schedule_follow_up",
    "update_lead",
    "transfer_to_human",
    SENSITIVE_CAPTURE_TOOL,
    END_CALL_TOOL,
}


@dataclass
class PendingTool:
    call_id: str
    name: str
    reply_id: str | None
    mode: str
    result: dict[str, Any] | None = None


class ToolCoordinator:
    def __init__(self, agent_ws: Any, voni_call_id: str | None) -> None:
        self.agent_ws = agent_ws
        self.voni_call_id = voni_call_id
        self.api_url = os.environ.get("VONI_API_URL", "").rstrip("/")
        self.secret = os.environ.get("VONI_TOOL_SECRET")
        self.current_reply_id: str | None = None
        self.latest_event: str | None = None
        self.pending: dict[str, PendingTool] = {}
        self.discarded: set[str] = set()
        self.tasks: set[asyncio.Task] = set()
        self.send_lock = asyncio.Lock()
        self.update_waiter: asyncio.Future | None = None
        self.restore_fast_pacing = False
        # Agent-initiated hangup, armed by an end_call result and acted on
        # at the next settled reply — the spoken closing line finishes
        # first. Disarmed the moment the caller speaks again.
        self.end_call_armed = False

    def take_hangup_request(self) -> bool:
        """Consume an armed agent hangup (one-shot)."""
        armed, self.end_call_armed = self.end_call_armed, False
        return armed

    def disarm_hangup(self) -> None:
        self.end_call_armed = False

    async def handle_event(self, event: dict[str, Any]) -> bool:
        """Update sequencing state. True means a session.error was tool-local."""
        event_type = event.get("type")
        if event_type == "reply.started":
            self.current_reply_id = event.get("reply_id")
            self.latest_event = event_type
        elif event_type == "input.speech.started":
            self.latest_event = event_type
        elif event_type == "reply.done":
            self.latest_event = event_type
            if event.get("status") == "interrupted":
                for call_id, item in list(self.pending.items()):
                    self.pending.pop(call_id, None)
                    self.discarded.add(call_id)
                # A caller talking over the goodbye takes the floor back.
                self.disarm_hangup()
            else:
                await self._flush_interactive()
        elif event_type == "tool.call":
            self._start_tool(event)
        elif event_type == "session.updated":
            if self.update_waiter and not self.update_waiter.done():
                self.update_waiter.set_result(None)
        elif event_type == "session.error":
            if self.update_waiter and not self.update_waiter.done():
                self.update_waiter.set_exception(
                    RuntimeError(event.get("message", "Call setting update failed."))
                )
                return True
        elif event_type == "transcript.user" and self.restore_fast_pacing:
            self.restore_fast_pacing = False
            task = asyncio.create_task(self._restore_pacing())
            self._track(task)
        return False

    def _start_tool(self, event: dict[str, Any]) -> None:
        call_id = event.get("call_id")
        name = event.get("name")
        if not isinstance(call_id, str) or not isinstance(name, str):
            logger.warning(f"invalid tool.call event: {event}")
            return
        # Verify-before-apply (fail-closed): malformed tool names never
        # execute. Mirrors the browser judge gate.
        allowed, prob = allow_tool_call(name)
        if not allowed:
            logger.warning(f"tool.call denied by judge (p={prob:.2f}): {event}")
            return
        self.pending[call_id] = PendingTool(
            call_id=call_id,
            name=name,
            reply_id=self.current_reply_id,
            mode="hold" if name in HOLD_TOOLS else "interactive",
        )
        task = asyncio.create_task(self._execute(event))
        self._track(task)

    def _track(self, task: asyncio.Task) -> None:
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _execute(self, event: dict[str, Any]) -> None:
        call_id = event["call_id"]
        name = event["name"]
        try:
            arguments = event.get("arguments", {})
            if isinstance(arguments, str):
                arguments = json.loads(arguments)
            if not isinstance(arguments, dict):
                raise ValueError("Tool arguments must be a JSON object.")
            if name == SENSITIVE_CAPTURE_TOOL:
                result = await self._prepare_sensitive_capture()
            else:
                result = await self._call_voni(call_id, name, arguments)
        except Exception as error:
            result = {"ok": False, "error": str(error), "retryable": False}

        if call_id in self.discarded:
            self.discarded.discard(call_id)
            return
        item = self.pending.get(call_id)
        if item is None:
            return
        item.result = result
        if item.mode == "hold":
            await self._send_result(item)
        else:
            await self._flush_interactive()

    async def _call_voni(
        self, call_id: str, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        if not self.api_url or not self.secret or not self.voni_call_id:
            return {
                "ok": False,
                "error": "Live call tools are not configured.",
                "retryable": True,
            }
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.api_url}/api/tools/{name}",
                headers={
                    "Authorization": f"Bearer {self.secret}",
                    "Content-Type": "application/json",
                },
                json={
                    "toolCallId": call_id,
                    "arguments": arguments,
                    "context": {"kind": "call", "callId": self.voni_call_id},
                },
            ) as response:
                try:
                    body = await response.json()
                except Exception:
                    body = None
                if not isinstance(body, dict) or "ok" not in body:
                    return {
                        "ok": False,
                        "error": "The tool server returned an invalid response.",
                        "retryable": response.status >= 500,
                    }
                return body

    async def _prepare_sensitive_capture(self) -> dict[str, Any]:
        try:
            await self._update_session(
                {"input": {"turn_detection": {"min_silence": 500, "max_silence": 2000}}}
            )
        except Exception:
            return {
                "ok": False,
                "error": "Could not prepare sensitive capture. Ask the caller to repeat slowly.",
                "retryable": True,
            }
        self.restore_fast_pacing = True
        return {
            "ok": True,
            "data": {"ready": True, "instruction": "Ask for the sensitive field now."},
        }

    async def _restore_pacing(self) -> None:
        try:
            await self._update_session(
                {"input": {"turn_detection": {"min_silence": 100, "max_silence": 500}}}
            )
        except Exception as error:
            logger.warning(f"could not restore fast call pacing: {error}")

    async def _update_session(self, session: dict[str, Any]) -> None:
        if self.update_waiter and not self.update_waiter.done():
            raise RuntimeError("Another call setting is still updating.")
        loop = asyncio.get_running_loop()
        self.update_waiter = loop.create_future()
        await self._send({"type": "session.update", "session": session})
        try:
            await asyncio.wait_for(self.update_waiter, timeout=3)
        finally:
            self.update_waiter = None

    async def _flush_interactive(self) -> None:
        if self.latest_event != "reply.done":
            return
        for item in list(self.pending.values()):
            if (
                item.mode == "interactive"
                and item.result is not None
            ):
                await self._send_result(item)

    async def _send_result(self, item: PendingTool) -> None:
        if item.result is None:
            return
        await self._send(
            {
                "type": "tool.result",
                "call_id": item.call_id,
                "result": json.dumps(item.result),
                "is_error": not item.result.get("ok", False),
            }
        )
        if (
            item.name == END_CALL_TOOL
            and item.result.get("ok") is True
            and item.result.get("hangup") is True
        ):
            logger.info("agent requested hangup; arming for the settled reply")
            self.end_call_armed = True
        self.pending.pop(item.call_id, None)

    async def _send(self, message: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.agent_ws.send(json.dumps(message))

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        self.pending.clear()
        if self.update_waiter and not self.update_waiter.done():
            self.update_waiter.cancel()

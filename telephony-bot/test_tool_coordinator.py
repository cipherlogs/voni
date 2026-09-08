import asyncio
import json
import unittest

from tool_coordinator import ToolCoordinator


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send(self, raw):
        self.messages.append(json.loads(raw))


class StubCoordinator(ToolCoordinator):
    def __init__(self, websocket, result):
        super().__init__(websocket, "00000000-0000-0000-0000-000000000001")
        self.stub_result = result

    async def _call_voni(self, call_id, name, arguments):
        if isinstance(self.stub_result, asyncio.Future):
            return await self.stub_result
        return self.stub_result


class ToolCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_interactive_waits_for_reply_done(self):
        websocket = FakeWebSocket()
        coordinator = StubCoordinator(
            websocket, {"ok": True, "data": {"properties": []}}
        )
        await coordinator.handle_event({"type": "reply.started", "reply_id": "r1"})
        await coordinator.handle_event(
            {
                "type": "tool.call",
                "call_id": "t1",
                "name": "search_properties",
                "arguments": {},
            }
        )
        await asyncio.sleep(0)
        self.assertEqual(websocket.messages, [])
        await coordinator.handle_event(
            {"type": "reply.done", "reply_id": "r1", "status": "completed"}
        )
        self.assertEqual(websocket.messages[0]["type"], "tool.result")
        self.assertFalse(websocket.messages[0]["is_error"])
        await coordinator.close()

    async def test_slow_result_flushes_after_reply_done(self):
        websocket = FakeWebSocket()
        result = asyncio.get_running_loop().create_future()
        coordinator = StubCoordinator(websocket, result)
        await coordinator.handle_event({"type": "reply.started", "reply_id": "r2"})
        await coordinator.handle_event(
            {
                "type": "tool.call",
                "call_id": "t2",
                "name": "check_calendar",
                "arguments": {"date": "2026-09-06"},
            }
        )
        await coordinator.handle_event(
            {"type": "reply.done", "reply_id": "r2", "status": "completed"}
        )
        result.set_result({"ok": True, "data": {"slots": []}})
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(websocket.messages), 1)
        await coordinator.close()

    async def test_interrupted_reply_discards_result(self):
        websocket = FakeWebSocket()
        result = asyncio.get_running_loop().create_future()
        coordinator = StubCoordinator(websocket, result)
        await coordinator.handle_event({"type": "reply.started", "reply_id": "r3"})
        await coordinator.handle_event(
            {
                "type": "tool.call",
                "call_id": "t3",
                "name": "search_properties",
                "arguments": {},
            }
        )
        await coordinator.handle_event(
            {"type": "reply.done", "reply_id": "r3", "status": "interrupted"}
        )
        result.set_result({"ok": True, "data": {"count": 1}})
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(websocket.messages, [])
        await coordinator.close()

    async def test_hold_error_returns_immediately_with_is_error(self):
        websocket = FakeWebSocket()
        coordinator = StubCoordinator(
            websocket, {"ok": False, "error": "occupied", "retryable": False}
        )
        await coordinator.handle_event({"type": "reply.started", "reply_id": "r4"})
        await coordinator.handle_event(
            {
                "type": "tool.call",
                "call_id": "t4",
                "name": "book_viewing",
                "arguments": {},
            }
        )
        await asyncio.sleep(0)
        self.assertTrue(websocket.messages[0]["is_error"])
        await coordinator.close()

    async def test_sensitive_pacing_failure_becomes_tool_error(self):
        websocket = FakeWebSocket()
        coordinator = StubCoordinator(websocket, {"ok": True, "data": {}})
        await coordinator.handle_event({"type": "reply.started", "reply_id": "r5"})
        await coordinator.handle_event(
            {
                "type": "tool.call",
                "call_id": "t5",
                "name": "prepare_sensitive_capture",
                "arguments": {"field_key": "budget"},
            }
        )
        await asyncio.sleep(0)
        self.assertEqual(websocket.messages[0]["type"], "session.update")
        handled = await coordinator.handle_event(
            {"type": "session.error", "message": "update rejected"}
        )
        self.assertTrue(handled)
        await asyncio.sleep(0)
        self.assertEqual(websocket.messages[1]["type"], "tool.result")
        self.assertTrue(websocket.messages[1]["is_error"])
        await coordinator.close()


if __name__ == "__main__":
    unittest.main()

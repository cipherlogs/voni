"""Tests for the gateway LLM backend (SSE token streaming + prefetch).

HTTP is injected, so no network or credentials are needed: the fake session
replays scripted SSE byte chunks (including splits mid-JSON to prove
reassembly) and records the request for auth/payload assertions.
"""

import asyncio
import json
import os
import unittest
from unittest.mock import patch

from backends.gateway_llm import GatewayLLM


def sse(*payloads: object) -> list[bytes]:
    return [(("data: " + json.dumps(p) + "\n\n").encode()) for p in payloads]


def chunk_text(content: str) -> dict:
    return {"choices": [{"delta": {"content": content}, "finish_reason": None}]}


DONE_CHUNK = {"choices": [{"delta": {}, "finish_reason": "stop"}]}


class FakeResponse:
    def __init__(self, status: int, chunks: list[bytes]) -> None:
        self.status = status
        self._chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def iter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class FakeSession:
    instances: list = []

    def __init__(self, response: FakeResponse) -> None:
        self._response = response
        self.posts: list[dict] = []
        FakeSession.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def post(self, url, *, headers=None, json=None):
        self.posts.append({"url": url, "headers": headers, "json": json})
        return self._response

    def closed(self):
        return True


def make_llm(chunks: list[bytes], status: int = 200, **kwargs):
    holder: dict = {}

    def factory(*, timeout_s: float):
        assert timeout_s > 0
        session = FakeSession(FakeResponse(status, chunks))
        holder["session"] = session
        return session

    kwargs.setdefault("api_key", "test-key")
    kwargs.setdefault("model", "test-model")
    return GatewayLLM(session_factory=factory, **kwargs), holder


class GatewayLLMTests(unittest.TestCase):
    def setUp(self):
        FakeSession.instances.clear()

    def test_bearer_auth_and_stream_payload(self):
        async def run():
            llm, holder = make_llm(sse(chunk_text("hi"), DONE_CHUNK))
            out = [e async for e in llm.complete(messages=[{"role": "user", "content": "hi"}])]
            return holder["session"], out

        session, out = asyncio.run(run())
        post = session.posts[0]
        self.assertTrue(post["url"].endswith("/chat/completions"))
        self.assertEqual(post["headers"].get("authorization"), "Bearer test-key")
        self.assertEqual(post["json"]["model"], "test-model")
        self.assertTrue(post["json"]["stream"])
        self.assertEqual(len(out), 1)

    def test_missing_key_raises(self):
        async def run():
            llm, _ = make_llm(sse(DONE_CHUNK), api_key=None)
            [e async for e in llm.complete(messages=[])]

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                asyncio.run(run())

    def test_reassembles_json_split_across_chunks(self):
        full = sse(chunk_text("hello world"), DONE_CHUNK)
        raw = b"".join(full)
        split = [raw[:17], raw[17:40], raw[40:]]

        async def run():
            llm, _ = make_llm(split)
            return [e async for e in llm.complete(messages=[])]

        from providers import TokenDelta

        out = asyncio.run(run())
        texts = [e.text for e in out if isinstance(e, TokenDelta)]
        self.assertEqual("".join(texts), "hello world")

    def test_empty_deltas_skipped(self):
        async def run():
            llm, _ = make_llm(
                sse({"choices": [{"delta": {}, "finish_reason": None}]}, DONE_CHUNK)
            )
            return [e async for e in llm.complete(messages=[])]

        self.assertEqual(asyncio.run(run()), [])

    def test_http_error_raises(self):
        async def run():
            llm, _ = make_llm([], status=429)
            [e async for e in llm.complete(messages=[])]

        with self.assertRaises(RuntimeError):
            asyncio.run(run())

    def test_failed_prefetch_then_diverged_complete_raises_cleanly(self):
        async def run():
            llm, _ = make_llm([], status=500)
            llm.prefetch(messages=[{"role": "user", "content": "old"}])
            await asyncio.sleep(0.05)
            [e async for e in llm.complete(messages=[{"role": "user", "content": "new"}])]

        with self.assertRaises(RuntimeError):
            asyncio.run(run())

    def test_tool_calls_accumulated_and_emitted(self):
        from providers import ToolCallRequest, TokenDelta

        tool_delta_1 = {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "c1",
                                "function": {"name": "lookup", "arguments": '{"q":'},
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ]
        }
        tool_delta_2 = {
            "choices": [
                {
                    "delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"x"}'}}]},
                    "finish_reason": None,
                }
            ]
        }
        tool_done = {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}

        async def run():
            llm, _ = make_llm(sse(chunk_text("ok "), tool_delta_1, tool_delta_2, tool_done))
            return [e async for e in llm.complete(messages=[])]

        out = asyncio.run(run())
        self.assertIsInstance(out[0], TokenDelta)
        self.assertIsInstance(out[1], ToolCallRequest)
        assert isinstance(out[1], ToolCallRequest)
        self.assertEqual(out[1].name, "lookup")
        self.assertEqual(out[1].call_id, "c1")
        self.assertEqual(out[1].arguments, {"q": "x"})

    def test_prefetch_warms_then_complete_replays(self):
        from providers import TokenDelta

        async def run():
            llm, holder = make_llm(sse(chunk_text("ab"), chunk_text("cd"), DONE_CHUNK))
            messages = [{"role": "user", "content": "hi"}]
            handle = llm.prefetch(messages=messages)
            await asyncio.sleep(0.05)
            out = [e async for e in llm.complete(messages=messages)]
            handle.cancel()
            return holder["session"], out

        session, out = asyncio.run(run())
        # One HTTP request total: complete() adopted the prefetch, no refetch.
        self.assertEqual(len(session.posts), 1)
        texts = [e.text for e in out if isinstance(e, TokenDelta)]
        self.assertEqual("".join(texts), "abcd")

    def test_real_adapter_constructs_post(self):
        # Guards the injected-seam signatures: fakes accept anything, so a
        # kwarg rename here would otherwise only explode against live HTTP.
        from backends.gateway_llm import _AiohttpSession

        async def run():
            session = _AiohttpSession(timeout_s=5)
            async with session:
                post = session.post("https://x", headers={}, json={})
                self.assertIsNotNone(post)

        asyncio.run(run())

    def test_prefetch_cancel_starts_fresh(self):
        async def run():
            llm, _ = make_llm(sse(chunk_text("zz"), DONE_CHUNK))
            handle = llm.prefetch(messages=[{"role": "user", "content": "old"}])
            handle.cancel()
            await asyncio.sleep(0)
            out = [e async for e in llm.complete(messages=[{"role": "user", "content": "new"}])]
            posts = [p for s in FakeSession.instances for p in s.posts]
            return posts, out

        posts, out = asyncio.run(run())
        # Complete posted with the NEW messages — the cancelled prefetch was
        # not reused. (Whether the prefetch got a request out before the
        # cancel won the race is timing; either is correct.)
        self.assertGreaterEqual(len(posts), 1)
        self.assertEqual(posts[-1]["json"]["messages"], [{"role": "user", "content": "new"}])
        from providers import TokenDelta

        self.assertEqual(
            "".join(e.text for e in out if isinstance(e, TokenDelta)), "zz"
        )


if __name__ == "__main__":
    unittest.main()

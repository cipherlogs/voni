"""Tests for the Cartesia streaming TTS backend.

HTTP is injected: the fake session replays scripted SSE byte chunks per
sentence request and records posts for auth/payload/order assertions.
Wire-format assumptions are marked LIVE-VERIFY in backends/cartesia_tts.py.
"""

import asyncio
import base64
import json
import os
import unittest
from unittest.mock import patch

from backends.cartesia_tts import CartesiaTTS, split_sentences


def sse_audio(b64: str) -> bytes:
    return (("data: " + json.dumps({"type": "chunk", "data": b64}) + "\n\n").encode())


def sse_done() -> bytes:
    return b"data: [DONE]\n\n"


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
    call_counter = 0

    def __init__(self, chunks_by_call: list[list[bytes]], status: int = 200) -> None:
        self._chunks_by_call = chunks_by_call
        self._status = status
        self.posts: list[dict] = []
        FakeSession.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def post(self, url, *, headers=None, json=None):
        # Route across ALL sessions in call order: sentence N gets script N
        # no matter which session object serves it.
        call_index = FakeSession.call_counter
        FakeSession.call_counter += 1
        self.posts.append({"url": url, "headers": headers, "json": json})
        chunks = self._chunks_by_call[min(call_index, len(self._chunks_by_call) - 1)]
        return FakeResponse(self._status, chunks)


AUDIO_A = base64.b64encode(b"\x01" * 320).decode()
AUDIO_B = base64.b64encode(b"\x02" * 320).decode()


def make_tts(chunks_by_call, **kwargs):
    def factory(*, timeout_s: float):
        assert timeout_s > 0
        return FakeSession(chunks_by_call)

    kwargs.setdefault("api_key", "test-key")
    kwargs.setdefault("voice_id", "v1")
    kwargs.setdefault("model_id", "m1")
    return CartesiaTTS(session_factory=factory, **kwargs)


class SentenceSplitTests(unittest.TestCase):
    def test_splits_on_sentence_end(self):
        self.assertEqual(
            split_sentences("Hello there. How can I help?"),
            ["Hello there.", "How can I help?"],
        )

    def test_single_sentence_unchanged(self):
        self.assertEqual(split_sentences("Hi there"), ["Hi there"])

    def test_empty_text_yields_nothing(self):
        self.assertEqual(split_sentences("   "), [])

    def test_exclamation_and_ellipsis(self):
        self.assertEqual(
            split_sentences("Wait! Really... yes."),
            ["Wait!", "Really...", "yes."],
        )


class CartesiaTTSTests(unittest.TestCase):
    def setUp(self):
        FakeSession.instances.clear()
        FakeSession.call_counter = 0

    def test_auth_and_payload(self):
        async def run():
            tts = make_tts([[sse_audio(AUDIO_A), sse_done()]])
            out = [e async for e in tts.speak("Hello there.")]
            posts = [p for s in FakeSession.instances for p in s.posts]
            return posts, out

        posts, out = asyncio.run(run())
        self.assertEqual(len(posts), 1)
        post = posts[0]
        self.assertIn("/tts/sse", post["url"])
        self.assertEqual(post["headers"].get("X-API-Key"), "test-key")
        self.assertIn("Cartesia-Version", post["headers"])
        self.assertEqual(post["json"]["transcript"], "Hello there.")
        self.assertEqual(post["json"]["voice"]["id"], "v1")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].text, "Hello there.")
        self.assertEqual(out[0].sample_rate, 24000)

    def test_audio_bytes_decoded(self):
        async def run():
            tts = make_tts([[sse_audio(AUDIO_A), sse_done()]])
            return [e async for e in tts.speak("Hi.")]

        out = asyncio.run(run())
        self.assertEqual(out[0].pcm, b"\x01" * 320)

    def test_one_request_per_sentence_in_order(self):
        async def run():
            tts = make_tts(
                [[sse_audio(AUDIO_A), sse_done()], [sse_audio(AUDIO_B), sse_done()]]
            )
            return [e async for e in tts.speak("First sentence. Second here.")]

        out = asyncio.run(run())
        posts = [p for s in FakeSession.instances for p in s.posts]
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["json"]["transcript"], "First sentence.")
        self.assertEqual(posts[1]["json"]["transcript"], "Second here.")
        self.assertEqual([c.text for c in out], ["First sentence.", "Second here."])
        self.assertEqual(out[0].pcm, b"\x01" * 320)
        self.assertEqual(out[1].pcm, b"\x02" * 320)

    def test_real_adapter_constructs_post(self):
        from backends.cartesia_tts import _AiohttpSession

        async def run():
            session = _AiohttpSession(timeout_s=5)
            async with session:
                post = session.post("https://x", headers={}, json={})
                self.assertIsNotNone(post)

        asyncio.run(run())

    def test_missing_key_or_voice_raises(self):
        async def run_missing_key():
            tts = make_tts([[sse_audio(AUDIO_A)]], api_key=None)
            [e async for e in tts.speak("Hi.")]

        async def run_missing_voice():
            tts = make_tts([[sse_audio(AUDIO_A)]], voice_id="")
            [e async for e in tts.speak("Hi.")]

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                asyncio.run(run_missing_key())
            with self.assertRaises(RuntimeError):
                asyncio.run(run_missing_voice())

    def test_http_error_raises(self):
        async def run():
            tts = make_tts([[]], **{})
            # Force error status via fresh factory
            def err_factory(*, timeout_s: float):
                assert timeout_s > 0
                return FakeSession([[]], status=402)

            tts_err = CartesiaTTS(
                session_factory=err_factory, api_key="k", voice_id="v", model_id="m"
            )
            [e async for e in tts_err.speak("Hi.")]

        with self.assertRaises(RuntimeError):
            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

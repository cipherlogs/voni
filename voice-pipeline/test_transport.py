"""Tests for the browser transport (WebSocket <-> orchestrator).

Ticket 65: the browser's config frame carries only a call token, the agent id
and the protocol version. The prompt and the tool list arrive from the app,
verified out of the signed body envelope (ticket 64), and the transport reads
them from there — never from the frame.

The socket is faked (send_json recorded, receive_json scripted); backends are
faked per call. No network, no credentials, no server required.
"""

import asyncio
import base64
import json
import unittest

from cascade.body_map import body_fingerprint
from cascade.envelope import sign_body
from cascade.testing import FakeClock
from cascade.token import (
    PROTOCOL_VERSION,
    CallTokenRegistry,
    StoredBodyChannel,
    mint_call_token,
)
from config import PipelineConfig
from providers import FinalTranscript, PartialTranscript, SentenceAudio, TokenDelta
from transport import handle_browser_call, pipeline_config_for_body

SECRET = "test-only-transport-secret"
ACCOUNT = "acct_test_65"
CALL_ID = "call_transport_65"
AGENT_ID = "agent_transport_65"
CLOCK = FakeClock(1_000_000.0)
TOKEN = mint_call_token(
    secret=SECRET,
    call_id=CALL_ID,
    subject=AGENT_ID,
    clock=CLOCK,
    nonce="transport-token-136",
)

BODY = {
    "name": "transport-agent",
    "system_prompt": "You are the signed body's agent.",
    "greeting": "Hola.",
    "voice": {"voice_id": "lola"},
    "input": {
        "format": "pcm_24000",
        "language_codes": ["es"],
        "transcription_mode": "accurate",
        "transcription_prompt": "",
        "keyterms": ["Voni"],
        "voice_focus": "near-field",
        "voice_focus_threshold": 0.4,
        "turn_detection": None,
    },
    "output": {"voice": "lola", "format": "pcm_24000", "volume": 0.851},
    "tools": [
        {
            "name": "check_email",
            "description": "Check the visitor's inbox.",
            "parameters": {"properties": {"code": {"type": "string"}}},
        }
    ],
    "llm": [],
}


class FakeDisconnect(Exception):
    pass


class FakeWebSocket:
    def __init__(self, inbound: list[dict]) -> None:
        self._inbound = list(inbound)
        self.sent: list[dict] = []

    async def receive_json(self) -> dict:
        # A real socket always yields on recv; without this the orchestrator
        # task starves and the test proves nothing about concurrency.
        await asyncio.sleep(0)
        if not self._inbound:
            raise FakeDisconnect()
        return self._inbound.pop(0)

    async def send_json(self, message: dict) -> None:
        await asyncio.sleep(0)
        self.sent.append(message)


class FakeSTT:
    def __init__(self, events: list) -> None:
        self._events = events

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        pass

    async def send_audio(self, pcm: bytes) -> None:
        pass

    async def events(self):
        for event in self._events:
            yield event

    async def close(self) -> None:
        pass


class FakeLLM:
    def __init__(self) -> None:
        self.messages_seen: list[list[dict]] = []
        self.tools_seen: list[list[dict] | None] = []

    async def complete(self, *, messages, tools=None):
        self.messages_seen.append(messages)
        self.tools_seen.append(tools)
        yield TokenDelta(text="Hey there.")

    def prefetch(self, *, messages, tools=None):
        class Handle:
            def cancel(self) -> None:
                pass

        return Handle()


class FakeTTS:
    async def speak(self, text: str):
        yield SentenceAudio(pcm=text.encode(), sample_rate=24000, text=text)


def browser_config(**overrides) -> dict:
    config = {
        "type": "config",
        "protocolVersion": PROTOCOL_VERSION,
        "agentId": AGENT_ID,
        "callToken": TOKEN,
    }
    config.update(overrides)
    return config


def old_client_config() -> dict:
    """The pre-65 frame: a client-assembled pipeline, prompt and tool list."""
    return {
        "type": "config",
        "pipeline": {
            "llm_model": "m",
            "tts_model": "t",
            "fallback_mode": "cascade",
        },
        "system_prompt": "Be brief.",
        "tools": [],
        "agent_name": "Test",
    }


def signed_message(
    body=None,
    *,
    call_id: str = CALL_ID,
    agent_id: str = AGENT_ID,
) -> dict:
    served = BODY if body is None else body
    signed = sign_body(
        body=served,
        minted_fingerprint=body_fingerprint(served, account_salt=ACCOUNT),
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=call_id,
        agent_id=agent_id,
        ttl_ms=60_000,
        clock=CLOCK,
    )
    # The service channel carries JSON, not dataclasses.
    return json.loads(json.dumps(signed.message()))


def delivered_channel(body=None, *, token: str = TOKEN) -> StoredBodyChannel:
    channel = StoredBodyChannel(secret=SECRET, clock=CLOCK)
    channel.deliver(call_token=token, call_id=CALL_ID, message=signed_message(body))
    return channel


def test_pipeline(body) -> PipelineConfig:
    return PipelineConfig(
        llm_model="service-model",
        tts_model="service-tts",
        tts_voice=body.voice_id,
        transport="browser",
        language_codes=(body.language_code,),
        keyterms_prompt=body.keyterms,
        agent_context=body.greeting,
        fallback_mode="cascade",
    )


def audio_message() -> dict:
    return {"type": "audio", "data": base64.b64encode(b"\x00" * 320).decode()}


def token_registry(clock: float = 1_000_001.0) -> CallTokenRegistry:
    return CallTokenRegistry(secret=SECRET, clock=FakeClock(clock))


def run_call(
    inbound,
    stt_events,
    *,
    channel=None,
    pipeline_factory=test_pipeline,
    call_tokens=None,
    token: str = TOKEN,
):
    async def run():
        ws = FakeWebSocket(inbound)
        pipelines: list[PipelineConfig] = []

        def backend_factory(config):
            pipelines.append(config)
            return (
                FakeSTT(stt_events),
                FakeLLM(),
                FakeTTS(),
            )

        await handle_browser_call(
            ws,
            config_message=inbound[0] if inbound and inbound[0].get("type") == "config" else None,
            backend_factory=backend_factory,
            body_channel=channel if channel is not None else delivered_channel(token=token),
            pipeline_factory=pipeline_factory,
            call_tokens=call_tokens if call_tokens is not None else token_registry(),
        )
        return ws, pipelines

    return asyncio.run(run())


class BrowserCallTests(unittest.TestCase):
    def test_a_token_only_config_runs_the_signed_body(self):
        inbound = [browser_config()] + [audio_message() for _ in range(40)]
        ws, pipelines = run_call(
            inbound,
            [PartialTranscript(text="hi"), FinalTranscript(text="hi there")],
        )

        # The browser payload is identity only; the prompt/tools came from the
        # body the app signed.
        self.assertEqual(
            set(inbound[0]),
            {"type", "protocolVersion", "agentId", "callToken"},
        )
        self.assertEqual(
            len(pipelines), 1, "the signed body reached the backend factory once"
        )
        self.assertEqual(pipelines[0].tts_voice, "lola")
        self.assertEqual(pipelines[0].language_codes, ("es",))

        by_type: dict[str, list[dict]] = {}
        for message in ws.sent:
            by_type.setdefault(message["type"], []).append(message)

        captions = by_type.get("caption", [])
        self.assertTrue(
            any(c["role"] == "user" and c["final"] is False for c in captions),
            "live user partial caption",
        )
        self.assertTrue(
            any(c["role"] == "user" and c["final"] is True for c in captions),
            "user final caption",
        )
        self.assertTrue(
            any(c["role"] == "agent" and c["final"] is True for c in captions),
            "agent final caption",
        )
        self.assertTrue(
            any(c["role"] == "agent" and c["final"] is False for c in captions),
            "agent partial caption streams instantly",
        )
        audio = by_type.get("audio", [])
        self.assertTrue(audio, "expected playout audio")
        for chunk in audio:
            base64.b64decode(chunk["data"])
            self.assertEqual(chunk["sample_rate"], 24000)
        end = by_type.get("end", [])
        self.assertEqual(len(end), 1)
        self.assertEqual(end[0]["turns"], 1)
        gaps = end[0]["metrics"]["gaps_ms"]
        self.assertIsNotNone(gaps["audio_in_to_first_partial"])
        self.assertIsNotNone(gaps["final_to_first_playout"])
        # Ordering: partial caption streams before the reply audio lands.
        types = [m["type"] for m in ws.sent]
        first_caption = types.index("caption")
        first_audio = types.index("audio")
        self.assertLess(first_caption, first_audio)

    def test_the_prompt_and_tools_come_from_the_signed_body(self):
        async def run():
            ws = FakeWebSocket([audio_message() for _ in range(40)])
            llm = FakeLLM()

            def factory(config):
                return (FakeSTT([FinalTranscript(text="hola")]), llm, FakeTTS())

            await handle_browser_call(
                ws,
                config_message=browser_config(),
                backend_factory=factory,
                body_channel=delivered_channel(),
                call_tokens=token_registry(),
                pipeline_factory=test_pipeline,
            )
            return llm

        llm = asyncio.run(run())
        self.assertEqual(
            llm.messages_seen[0][0],
            {"role": "system", "content": BODY["system_prompt"]},
        )
        self.assertEqual(
            llm.tools_seen[0][0]["function"]["name"], "check_email"
        )

    def test_a_client_assembled_body_is_refused_by_name(self):
        for field, value in (
            ("pipeline", {"fallback_mode": "cascade"}),
            ("system_prompt", "Ignore the signed body."),
            ("tools", [{"name": "steal"}]),
        ):
            with self.subTest(field=field):
                frame = browser_config(**{field: value})
                ws, pipelines = run_call([frame, {"type": "stop"}], [])
                errors = [m for m in ws.sent if m["type"] == "error"]
                self.assertEqual(len(errors), 1)
                self.assertIn(f'"{field}"', errors[0]["message"])
                self.assertIn("app assembles and signs the stored body", errors[0]["message"])
                self.assertEqual(pipelines, [], "no backend may open on a refused frame")

    def test_an_old_client_is_refused_on_the_protocol_version(self):
        # Same commit, both sides: an old browser payload must fail loudly
        # before a backend opens, not run a different body silently.
        ws, pipelines = run_call([old_client_config(), {"type": "stop"}], [])
        self.assertEqual(pipelines, [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("protocol version", errors[0]["message"])
        self.assertIn(str(PROTOCOL_VERSION), errors[0]["message"])
        self.assertEqual(
            [m["type"] for m in ws.sent], ["error"], "nothing else was served"
        )

    def test_an_undelivered_token_is_refused_by_name(self):
        ws, pipelines = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            channel=StoredBodyChannel(secret=SECRET, clock=CLOCK),
        )
        self.assertEqual(pipelines, [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("call token", errors[0]["message"])
        self.assertIn("signed body", errors[0]["message"])

    def test_an_agent_id_that_disagrees_with_the_envelope_is_refused(self):
        ws, pipelines = run_call(
            [browser_config(agentId="a_different_agent"), {"type": "stop"}],
            [],
        )
        self.assertEqual(pipelines, [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("agent", errors[0]["message"].lower())
        self.assertIn("a_different_agent", errors[0]["message"])

    def test_a_stored_body_the_adapter_refuses_is_named(self):
        body = {**BODY, "smuggled": "setting"}
        ws, pipelines = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            channel=delivered_channel(body),
        )
        self.assertEqual(pipelines, [], "no vendor socket before the body is readable")
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("smuggled", errors[0]["message"])

    def test_stop_mid_turn_ends_call_with_end_message(self):
        ws, _ = run_call(
            [browser_config(), audio_message(), {"type": "stop"}],
            [PartialTranscript(text="hi"), FinalTranscript(text="hi there")],
        )
        end = [m for m in ws.sent if m["type"] == "end"]
        self.assertEqual(len(end), 1)
        self.assertIn("metrics", end[0])

    def test_the_end_message_reports_the_protocol_version(self):
        ws, _ = run_call(
            [browser_config(), {"type": "stop"}],
            [],
        )
        end = [m for m in ws.sent if m["type"] == "end"]
        self.assertEqual(len(end), 1)
        self.assertEqual(end[0]["protocolVersion"], PROTOCOL_VERSION)

    def test_backend_failure_surfaces_in_end_message(self):
        async def run():
            ws = FakeWebSocket([audio_message() for _ in range(40)])

            class BrokenLLM:
                async def complete(self, *, messages, tools=None):
                    raise RuntimeError("gateway exploded")
                    yield

                def prefetch(self, *, messages, tools=None):
                    class Handle:
                        def cancel(self) -> None:
                            pass

                    return Handle()

            def factory(config):
                return (
                    FakeSTT([FinalTranscript(text="hi")]),
                    BrokenLLM(),
                    FakeTTS(),
                )

            await handle_browser_call(
                ws,
                config_message=browser_config(),
                backend_factory=factory,
                body_channel=delivered_channel(),
                call_tokens=token_registry(),
                pipeline_factory=test_pipeline,
            )
            return ws

        ws = asyncio.run(run())
        # The failure surfaces mid-call as an error message (turn_failed);
        # the call still ends normally with metrics.
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertTrue(errors, "expected a failure error message")
        self.assertIn("gateway exploded", errors[0].get("message", ""))
        end = [m for m in ws.sent if m["type"] == "end"]
        self.assertEqual(len(end), 1)

    def test_first_message_must_be_config(self):
        ws, _ = run_call([audio_message()], [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)

    def test_context_is_accepted_after_config_and_not_captioned(self):
        async def run():
            ws = FakeWebSocket(
                [
                    {
                        "type": "context",
                        "role": "system",
                        "content": "The user's microphone is muted.",
                    },
                    audio_message(),
                ]
                + [audio_message() for _ in range(40)]
            )
            llm = FakeLLM()

            def factory(config):
                return (
                    FakeSTT([FinalTranscript(text="next turn")]),
                    llm,
                    FakeTTS(),
                )

            await handle_browser_call(
                ws,
                config_message=browser_config(),
                backend_factory=factory,
                body_channel=delivered_channel(),
                call_tokens=token_registry(),
                pipeline_factory=test_pipeline,
            )
            return ws, llm

        ws, llm = asyncio.run(run())
        self.assertEqual(
            llm.messages_seen[0][1],
            {"role": "system", "content": "The user's microphone is muted."},
        )
        self.assertFalse(
            any(
                message.get("type") == "caption"
                and "microphone is muted" in message.get("text", "")
                for message in ws.sent
            )
        )


class CallTokenAtConnectTests(unittest.TestCase):
    """Ticket 136: the token is verified before a body claim or a vendor socket."""

    def test_a_valid_token_is_claimed_and_released_with_the_socket(self):
        registry = token_registry()
        ws, pipelines = run_call(
            [browser_config(), {"type": "stop"}], [], call_tokens=registry
        )
        self.assertEqual(len(pipelines), 1)
        # The call ended: the live-socket slot is free, the token stays spent.
        self.assertEqual(registry.live_call_ids(), ())

    def test_an_expired_token_is_refused_by_name_before_any_backend(self):
        expired = mint_call_token(
            secret=SECRET,
            call_id=CALL_ID,
            subject=AGENT_ID,
            clock=FakeClock(1_000_000.0 - 120.0),
            nonce="expired-136",
        )
        ws, pipelines = run_call(
            [browser_config(callToken=expired), {"type": "stop"}],
            [],
            channel=delivered_channel(token=expired),
            token=expired,
        )

        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("expired", errors[0]["message"])
        self.assertIn("refused at connect", errors[0]["message"])
        self.assertNotIn(expired, errors[0]["message"])
        self.assertEqual(pipelines, [], "no backend may open on an expired token")

    def test_a_token_for_another_call_is_refused_by_name(self):
        other = mint_call_token(
            secret=SECRET,
            call_id="another_call_136",
            subject=AGENT_ID,
            clock=CLOCK,
            nonce="other-call-136",
        )
        ws, pipelines = run_call(
            [browser_config(callToken=other), {"type": "stop"}],
            [],
            channel=delivered_channel(token=other),
            token=other,
        )

        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("another_call_136", errors[0]["message"])
        self.assertIn(CALL_ID, errors[0]["message"])
        self.assertEqual(pipelines, [])

    def test_a_token_for_another_subject_is_refused_by_name(self):
        other = mint_call_token(
            secret=SECRET,
            call_id=CALL_ID,
            subject="another_subject_136",
            clock=CLOCK,
            nonce="other-subject-136",
        )
        ws, pipelines = run_call(
            [browser_config(callToken=other), {"type": "stop"}],
            [],
            channel=delivered_channel(token=other),
            token=other,
        )

        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("another_subject_136", errors[0]["message"])
        self.assertEqual(pipelines, [])

    def test_a_replayed_token_is_refused(self):
        registry = token_registry()
        registry.claim(TOKEN, call_id=CALL_ID, subject=AGENT_ID)

        ws, pipelines = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            call_tokens=registry,
        )
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("already claimed", errors[0]["message"])
        self.assertEqual(pipelines, [])

    def test_a_second_concurrent_socket_is_refused_until_the_first_closes(self):
        registry = token_registry()
        first = registry.claim(TOKEN, call_id=CALL_ID, subject=AGENT_ID)
        second = mint_call_token(
            secret=SECRET,
            call_id=CALL_ID,
            subject=AGENT_ID,
            clock=CLOCK,
            nonce="second-socket-136",
        )

        ws, pipelines = run_call(
            [browser_config(callToken=second), {"type": "stop"}],
            [],
            channel=delivered_channel(token=second),
            token=second,
            call_tokens=registry,
        )
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("already has a live socket", errors[0]["message"])
        self.assertEqual(pipelines, [])

        registry.release(first)
        reconnect = mint_call_token(
            secret=SECRET,
            call_id=CALL_ID,
            subject=AGENT_ID,
            clock=CLOCK,
            nonce="reconnect-136",
        )
        ws, pipelines = run_call(
            [browser_config(callToken=reconnect), {"type": "stop"}],
            [],
            channel=delivered_channel(token=reconnect),
            token=reconnect,
            call_tokens=registry,
        )
        self.assertEqual(len(pipelines), 1, "a reconnect with a new token is served")
        self.assertEqual(registry.live_call_ids(), ())

    def test_a_service_without_a_token_verifier_refuses_the_call(self):
        async def run():
            ws = FakeWebSocket([browser_config(), {"type": "stop"}])
            opened = []
            await handle_browser_call(
                ws,
                config_message=browser_config(),
                backend_factory=lambda config: opened.append(config) or (None, None, None),
                body_channel=delivered_channel(),
                pipeline_factory=test_pipeline,
                call_tokens=None,
            )
            return ws, opened

        ws, opened = asyncio.run(run())
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("no call-token verifier", errors[0]["message"])
        self.assertEqual(opened, [])


class PipelineSettingsTests(unittest.TestCase):
    def test_missing_service_settings_are_named(self):
        from cascade.body_map import adapt_body

        body = adapt_body(BODY)
        with self.assertRaises(ValueError) as caught:
            pipeline_config_for_body(body, environ={})
        message = str(caught.exception)
        self.assertIn("VOICE_PIPELINE_LLM_MODEL", message)
        self.assertIn("VOICE_PIPELINE_TTS_MODEL", message)

    def test_the_pipeline_comes_from_service_settings_and_the_body(self):
        from cascade.body_map import adapt_body

        body = adapt_body(BODY)
        pipeline = pipeline_config_for_body(
            body,
            environ={
                "VOICE_PIPELINE_LLM_MODEL": "service-model",
                "VOICE_PIPELINE_TTS_MODEL": "service-tts",
            },
        )
        self.assertEqual(pipeline.llm_model, "service-model")
        self.assertEqual(pipeline.tts_model, "service-tts")
        self.assertEqual(pipeline.tts_voice, "lola")
        self.assertEqual(pipeline.language_codes, ("es",))
        self.assertEqual(pipeline.keyterms_prompt, ("Voni",))
        self.assertEqual(pipeline.agent_context, "Hola.")
        self.assertTrue(pipeline.routes_to_cascade)


if __name__ == "__main__":
    unittest.main()

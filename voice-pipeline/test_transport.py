"""Browser transport: the browser socket served by the cascade call lifecycle.

Ticket 65's token-only config frame and ticket 136's token bindings are still
verified before anything vendor-facing exists. What changed is what runs after
that: the browser call is now served by :class:`cascade.call.CallLifecycle` and
:class:`cascade.turn_stream.CascadeTurnStream`, not by ``TurnOrchestrator``.
The routing switch is read exactly once for the new call; a refusal opens no
leg factory at all and answers with ``code: "managed"``.

The socket is faked (send_json recorded, receive_json scripted); legs are faked
per call. No network, no credentials, no server required.
"""

import asyncio
import base64
import json
import logging
import unittest
from unittest import mock

from cascade.body_map import adapt_body, body_fingerprint
from cascade.call import CallLifecycle
from cascade.envelope import sign_body
from cascade.meta_llm import MetaLLMTurn, TurnUsage
from cascade.meta_stt import SpeechComplete, SpeechStart
from cascade.routing import KEY as ROUTING_KEY
from cascade.routing import RoutingRecord, RoutingSwitch
from cascade.store import MemoryStore, StoredDocument
from cascade.testing import FakeClock
from cascade.token import (
    PROTOCOL_VERSION,
    CallTokenRegistry,
    StoredBodyChannel,
    mint_call_token,
)
from cascade.voice_binding import bind_voice
from providers import SentenceAudio, TokenDelta
from transport import build_cascade_legs, handle_browser_call

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

AUTO_DETECT_BODY = json.loads(json.dumps(BODY))
AUTO_DETECT_BODY["input"]["language_codes"] = []

BYO_BODY = json.loads(json.dumps(BODY))
BYO_BODY["llm"] = [
    {
        "base_url": "https://tenant.example/v1",
        "model": "tenant-model",
        "api_key": "byo-key-never-logged",
    }
]


class FakeDisconnect(Exception):
    pass


class FakeWebSocket:
    def __init__(self, inbound: list[dict]) -> None:
        self._inbound = list(inbound)
        self.sent: list[dict] = []

    async def receive_json(self) -> dict:
        await asyncio.sleep(0)
        if not self._inbound:
            raise FakeDisconnect()
        return self._inbound.pop(0)

    async def send_json(self, message: dict) -> None:
        await asyncio.sleep(0)
        self.sent.append(message)


class FakeSpeech:
    def __init__(self, events: list) -> None:
        self._events = events
        self.open_languages: list[str] | None = None
        self.audio: list[bytes] = []
        self.closed = False

    async def open(self, *, language_codes: list[str], sample_rate: int) -> None:
        self.open_languages = list(language_codes)

    async def send_audio(self, pcm: bytes) -> None:
        self.audio.append(pcm)

    async def events(self):
        for event in self._events:
            yield event

    async def close(self) -> None:
        self.closed = True


class FakeVoice:
    def __init__(self) -> None:
        self.binding = bind_voice("lola")
        self.closed = False
        self.greeted: list[str] = []
        self.spoken: list[str] = []
        self.cancels = 0

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        yield SentenceAudio(pcm=b"\x10\x00" * 4, sample_rate=24000, text=text)

    async def speak(self, text: str):
        self.spoken.append(text)
        yield SentenceAudio(pcm=text.encode("utf-8")[:16], sample_rate=24000, text=text)

    async def cancel(self) -> None:
        self.cancels += 1

    async def close(self) -> None:
        self.closed = True


class FakeModel:
    def __init__(self) -> None:
        self.requests: list[list[dict]] = []
        self.tools_seen: list[list[dict] | None] = []

    async def complete(self, *, messages, tools=None, turn=None):
        self.requests.append(messages)
        self.tools_seen.append(tools)
        record = turn if turn is not None else MetaLLMTurn()
        text = "Hola, claro que sí."
        record.content_text = text
        record.finish_reason = "stop"
        record.usage = TurnUsage(prompt_tokens=3, completion_tokens=4)
        record.finished = True
        yield TokenDelta(text=text)


class FakeLegs:
    """Constructed-but-unopened legs, the shape the transport consumes."""

    def __init__(self, events: list) -> None:
        self.speech = FakeSpeech(events)
        self.voice = FakeVoice()
        self.model = FakeModel()
        self.opened: list[str] = []

    async def open_speech(self, body):
        from cascade.call import OpenedLeg

        self.opened.append("stt")
        await self.speech.open(language_codes=[], sample_rate=24000)
        return OpenedLeg("stt", "meta", "primary", "speech rung", self.speech)

    async def open_voice(self, body):
        from cascade.call import OpenedLeg

        self.opened.append("tts")
        return OpenedLeg("tts", "assemblyai", "primary", "voice rung", self.voice)

    async def open_model(self, body):
        from cascade.call import OpenedLeg

        self.opened.append("llm")
        return OpenedLeg("llm", "spark", "primary", "model rung", self.model)


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


def audio_message() -> dict:
    return {"type": "audio", "data": base64.b64encode(b"\x00" * 320).decode()}


def token_registry(clock: float = 1_000_001.0) -> CallTokenRegistry:
    return CallTokenRegistry(secret=SECRET, clock=FakeClock(clock))


async def open_switch() -> RoutingSwitch:
    """A durable switch pinned to ``all`` so a test call is admitted."""
    store = MemoryStore()
    record = RoutingRecord.seeded("all", actor="transport-test", at=CLOCK())
    await store.compare_and_set(
        ROUTING_KEY, None, StoredDocument(version=1, document=record.to_document())
    )
    return RoutingSwitch(store, now=CLOCK)


class RecordingLifecycle(CallLifecycle):
    """The real lifecycle, with the fact that it ran recorded for the test."""

    instances: list["RecordingLifecycle"] = []

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.ran = False
        type(self).instances.append(self)

    async def run(self):
        self.ran = True
        return await super().run()


def run_call(
    inbound,
    stt_events,
    *,
    channel=None,
    legs=None,
    leg_builder=None,
    switch=None,
    counter=None,
    call_tokens=None,
    token: str = TOKEN,
    envelope_clock=CLOCK,
):
    async def run():
        RecordingLifecycle.instances = []
        ws = FakeWebSocket(inbound)
        built: list[FakeLegs] = []

        def default_leg_builder(body, raw):
            built.append(FakeLegs(stt_events) if legs is None else legs)
            return built[-1]

        chosen = leg_builder if leg_builder is not None else default_leg_builder

        with mock.patch("transport.CallLifecycle", RecordingLifecycle):
            await handle_browser_call(
                ws,
                config_message=(
                    inbound[0]
                    if inbound and inbound[0].get("type") == "config"
                    else None
                ),
                body_channel=(
                    channel if channel is not None else delivered_channel(token=token)
                ),
                call_tokens=(
                    call_tokens if call_tokens is not None else token_registry()
                ),
                switch=switch if switch is not None else await open_switch(),
                counter=counter,
                secret=SECRET,
                envelope_clock=envelope_clock,
                leg_builder=chosen,
                clock=FakeClock(),
            )
        return ws, built, list(RecordingLifecycle.instances)

    return asyncio.run(run())


class BrowserCallTests(unittest.TestCase):
    def test_a_token_only_config_runs_the_cascade_lifecycle(self):
        inbound = [browser_config(), audio_message(), {"type": "stop"}]
        ws, built, instances = run_call(
            inbound, [SpeechStart("t1"), SpeechComplete("hola", turn_id="t1")]
        )

        # The browser payload is identity only; the prompt/tools came from the
        # body the app signed.
        self.assertEqual(
            set(inbound[0]),
            {"type", "protocolVersion", "agentId", "callToken"},
        )
        self.assertEqual(1, len(built), "the signed body reached the leg builder once")
        self.assertEqual(["stt", "tts", "llm"], built[0].opened)
        self.assertEqual(1, len(instances), "one call, one lifecycle")
        self.assertTrue(instances[0].ran)
        self.assertEqual("greeting", instances[0].audio_frames[0].kind)

        by_type: dict[str, list[dict]] = {}
        for message in ws.sent:
            by_type.setdefault(message["type"], []).append(message)

        captions = by_type.get("caption", [])
        self.assertTrue(
            any(c["role"] == "user" and c["final"] is True for c in captions),
            "user final caption",
        )
        self.assertTrue(
            any(c["role"] == "agent" and c["final"] is False for c in captions),
            "agent caption streams while speaking",
        )
        audio = by_type.get("audio", [])
        self.assertTrue(audio, "expected playout audio")
        for chunk in audio:
            base64.b64decode(chunk["data"])
            self.assertEqual(chunk["sample_rate"], 24000)
        self.assertEqual(
            list(range(1, len(audio) + 1)), [chunk["seq"] for chunk in audio]
        )
        end = by_type.get("end", [])
        self.assertEqual(len(end), 1)
        self.assertEqual(end[0]["turns"], 1)
        self.assertEqual(end[0]["endedBy"], "stop")
        self.assertEqual(end[0]["providers"]["stt"]["provider"], "meta")
        self.assertEqual(end[0]["providers"]["tts"]["provider"], "assemblyai")
        self.assertEqual(end[0]["protocolVersion"], PROTOCOL_VERSION)
        # The caller heard the greeting before the reply.
        self.assertEqual(["Hola."], built[0].voice.greeted)
        self.assertEqual(["Hola, claro que sí."], built[0].voice.spoken)

    def test_the_lifecycle_ran_and_the_old_orchestrator_did_not(self):
        with mock.patch(
            "orchestrator.TurnOrchestrator",
            side_effect=AssertionError("the browser call must not run TurnOrchestrator"),
        ), mock.patch(
            "transport.TurnOrchestrator",
            create=True,
            side_effect=AssertionError("the browser call must not run TurnOrchestrator"),
        ):
            _ws, _built, instances = run_call(
                [browser_config(), {"type": "stop"}],
                [SpeechStart("t1"), SpeechComplete("hi", turn_id="t1")],
            )
        self.assertEqual(1, len(instances))
        self.assertTrue(instances[0].ran)

    def test_the_prompt_and_tools_come_from_the_signed_body(self):
        _ws, built, _instances = run_call(
            [browser_config(), {"type": "stop"}],
            [SpeechStart("t1"), SpeechComplete("hola", turn_id="t1")],
        )
        # The model client owns the body's system prompt; the turn layer sends
        # only the conversation, and the tools are the adapted body's.
        self.assertEqual(
            built[0].model.requests[0][0], {"role": "user", "content": "hola"}
        )
        self.assertEqual(
            built[0].model.tools_seen[0][0]["function"]["name"], "check_email"
        )

    def test_a_client_assembled_body_is_refused_by_name(self):
        for field, value in (
            ("pipeline", {"fallback_mode": "cascade"}),
            ("system_prompt", "Ignore the signed body."),
            ("tools", [{"name": "steal"}]),
        ):
            with self.subTest(field=field):
                frame = browser_config(**{field: value})
                ws, built, _instances = run_call([frame, {"type": "stop"}], [])
                errors = [m for m in ws.sent if m["type"] == "error"]
                self.assertEqual(len(errors), 1)
                self.assertIn(f'"{field}"', errors[0]["message"])
                self.assertIn(
                    "app assembles and signs the stored body", errors[0]["message"]
                )
                self.assertEqual(built, [], "no backend may open on a refused frame")

    def test_an_old_client_is_refused_on_the_protocol_version(self):
        ws, built, _instances = run_call([old_client_config(), {"type": "stop"}], [])
        self.assertEqual(built, [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("protocol version", errors[0]["message"])
        self.assertIn(str(PROTOCOL_VERSION), errors[0]["message"])
        self.assertEqual(
            [m["type"] for m in ws.sent], ["error"], "nothing else was served"
        )

    def test_an_undelivered_token_is_refused_by_name(self):
        ws, built, _instances = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            channel=StoredBodyChannel(secret=SECRET, clock=CLOCK),
        )
        self.assertEqual(built, [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("call token", errors[0]["message"])
        self.assertIn("signed body", errors[0]["message"])

    def test_an_agent_id_that_disagrees_with_the_envelope_is_refused(self):
        ws, built, _instances = run_call(
            [browser_config(agentId="a_different_agent"), {"type": "stop"}],
            [],
        )
        self.assertEqual(built, [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("agent", errors[0]["message"].lower())
        self.assertIn("a_different_agent", errors[0]["message"])

    def test_a_stored_body_the_adapter_refuses_is_named(self):
        body = {**BODY, "smuggled": "setting"}
        ws, built, _instances = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            channel=delivered_channel(body),
        )
        self.assertEqual(built, [], "no vendor socket before the body is readable")
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("smuggled", errors[0]["message"])

    def test_first_message_must_be_config(self):
        ws, _built, _instances = run_call([audio_message()], [])
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)

    def test_context_is_accepted_after_config_and_not_captioned(self):
        _ws, built, _instances = run_call(
            [
                browser_config(),
                {
                    "type": "context",
                    "role": "system",
                    "content": "The user's microphone is muted.",
                },
            ]
            + [audio_message() for _ in range(40)],
            [SpeechStart("t1"), SpeechComplete("next turn", turn_id="t1")],
        )
        self.assertEqual(
            built[0].model.requests[0][1],
            {"role": "system", "content": "The user's microphone is muted."},
        )
        self.assertFalse(
            any(
                message.get("type") == "caption"
                and "microphone is muted" in message.get("text", "")
                for message in _ws.sent
            )
        )


class _FakeDay:
    def __init__(self, refusal: str = ""):
        self.routing_refusal = refusal
        self.would_route_managed = bool(refusal)


class _FakeCounter:
    def __init__(self, refusal: str = "") -> None:
        self.refusal = refusal
        self.reads = 0

    async def snapshot(self, *, at=None):
        self.reads += 1
        return _FakeDay(self.refusal)


class RoutingAdmissionTests(unittest.TestCase):
    def test_routing_off_refuses_with_one_managed_error_and_opens_nothing(self):
        built: list[FakeLegs] = []

        def leg_builder(body, raw):
            built.append(FakeLegs([]))
            return built[-1]

        ws, _recorded, instances = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            switch=RoutingSwitch(MemoryStore(), now=CLOCK),
            leg_builder=leg_builder,
        )

        self.assertEqual([], built, "no leg factory may run when routing is off")
        self.assertEqual([], instances, "no call lifecycle may run when routing is off")
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], "managed")
        self.assertIn("no durable routing switch", errors[0]["message"])
        self.assertFalse(
            any(message["type"] in ("audio", "end") for message in ws.sent),
            "a managed refusal serves no call",
        )

    def test_the_daily_counter_is_read_in_the_same_admission_decision(self):
        counter = _FakeCounter()
        _ws, built, instances = run_call(
            [browser_config(), {"type": "stop"}],
            [SpeechStart("t1"), SpeechComplete("hola", turn_id="t1")],
            counter=counter,
        )
        self.assertEqual(1, counter.reads, "the counter is read before the first frame")
        self.assertEqual(1, len(built))
        self.assertTrue(instances[0].ran)

    def test_a_counter_refusal_routes_managed_and_opens_nothing(self):
        counter = _FakeCounter("the daily budget cap is reached")
        built: list[FakeLegs] = []

        def leg_builder(body, raw):
            built.append(FakeLegs([]))
            return built[-1]

        ws, _recorded, instances = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            counter=counter,
            leg_builder=leg_builder,
        )

        self.assertEqual([], built)
        self.assertEqual([], instances)
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(1, len(errors))
        self.assertEqual(errors[0]["code"], "managed")
        self.assertIn("daily budget cap", errors[0]["message"])


class CallTokenAtConnectTests(unittest.TestCase):
    """Ticket 136: the token is verified before a body claim or a vendor socket."""

    def test_a_valid_token_is_claimed_and_released_with_the_socket(self):
        registry = token_registry()
        ws, built, _instances = run_call(
            [browser_config(), {"type": "stop"}], [], call_tokens=registry
        )
        self.assertEqual(1, len(built))
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
        ws, built, _instances = run_call(
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
        self.assertEqual(built, [], "no backend may open on an expired token")

    def test_a_token_for_another_call_is_refused_by_name(self):
        other = mint_call_token(
            secret=SECRET,
            call_id="another_call_136",
            subject=AGENT_ID,
            clock=CLOCK,
            nonce="other-call-136",
        )
        ws, built, _instances = run_call(
            [browser_config(callToken=other), {"type": "stop"}],
            [],
            channel=delivered_channel(token=other),
            token=other,
        )

        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("another_call_136", errors[0]["message"])
        self.assertIn(CALL_ID, errors[0]["message"])
        self.assertEqual(built, [])

    def test_a_replayed_token_is_refused(self):
        registry = token_registry()
        registry.claim(TOKEN, call_id=CALL_ID, subject=AGENT_ID)

        ws, built, _instances = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            call_tokens=registry,
        )
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("already claimed", errors[0]["message"])
        self.assertEqual(built, [])


class _FakeResponse:
    def __init__(self, chunks: list[bytes], status: int = 200) -> None:
        self.status = status
        self._chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def iter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class _FakePost:
    def __init__(self, record: dict, chunks: list[bytes]) -> None:
        self._record = record
        self._chunks = chunks

    async def __aenter__(self):
        return _FakeResponse(self._chunks)

    async def __aexit__(self, *args):
        return False


class _FakeSession:
    def __init__(self, record: dict, chunks: list[bytes]) -> None:
        self._record = record
        self._chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def post(self, url: str, *, headers: dict, json: dict):
        self._record.update(url=url, headers=headers, payload=json)
        return _FakePost(self._record, self._chunks)


class _FakeAckSocket:
    def __init__(self, frames: list[str]) -> None:
        self.sent: list[str] = []
        self._frames = iter(frames)
        self.closed = False

    async def send(self, payload: str) -> None:
        self.sent.append(payload)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._frames)
        except StopIteration:
            raise StopAsyncIteration

    async def close(self) -> None:
        self.closed = True


class LegBuilderTests(unittest.TestCase):
    """The production legs are built server-side from the signed body."""

    def legs_for(self, body, raw, **kwargs):
        from metrics import TimingLedger
        from cascade.reconnect import ReconnectBudget

        clock = FakeClock()
        ledger = TimingLedger(now=clock)
        return build_cascade_legs(
            call_id=CALL_ID,
            ledger=ledger,
            budget=ReconnectBudget(ledger=ledger, now=clock),
            environ={
                "META_REASONING_EFFORT": "low",
                "META_IDENTIFIER_SALT": "test-salt",
                "META_API_KEY": "test-meta-key",
            },
            **kwargs,
        )(adapt_body(body), raw)

    def test_a_byo_body_uses_the_body_base_url_and_its_own_key(self):
        record: dict = {}
        sse = (
            b'data: {"choices":[{"delta":{"content":"Hello."}}]}\n\n'
            b"data: [DONE]\n\n"
        )
        legs = self.legs_for(
            BYO_BODY,
            BYO_BODY,
            llm_session_factory=lambda timeout_s: _FakeSession(record, [sse]),
        )

        async def complete():
            async for _delta in legs.model.complete(
                messages=[{"role": "user", "content": "hi"}]
            ):
                pass

        logs: list[str] = []

        class Collector(logging.Handler):
            def emit(self, record):  # noqa: A003 - logging's own name
                logs.append(record.getMessage())

        handler = Collector()
        logging.getLogger().addHandler(handler)
        try:
            asyncio.run(complete())
        finally:
            logging.getLogger().removeHandler(handler)

        self.assertTrue(record["url"].startswith("https://tenant.example/v1/"), record)
        self.assertNotIn("api.meta.ai", record["url"])
        self.assertEqual("Bearer byo-key-never-logged", record["headers"]["authorization"])
        self.assertEqual(
            {"role": "system", "content": BYO_BODY["system_prompt"]},
            record["payload"]["messages"][0],
        )
        # The key reaches the authorization header only, never a request body,
        # a representation or a log line.
        self.assertNotIn("byo-key-never-logged", json.dumps(record["payload"]))
        self.assertNotIn("byo-key-never-logged", "\n".join(logs))
        self.assertNotIn("byo-key-never-logged", repr(legs.model))
        self.assertNotIn("byo-key-never-logged", json.dumps(adapt_body(BYO_BODY).llm.to_document()))

    def test_an_auto_detect_body_sends_no_language_bias(self):
        socket = _FakeAckSocket([json.dumps({"sessionId": "s0"})])

        async def factory(url, headers):
            return socket

        legs = self.legs_for(
            AUTO_DETECT_BODY, AUTO_DETECT_BODY, stt_socket_factory=factory
        )
        body = adapt_body(AUTO_DETECT_BODY)

        asyncio.run(legs.open_speech(body))

        handshake = json.loads(socket.sent[0])
        self.assertNotIn("languageBias", handshake)

    def test_a_fixed_language_body_sends_the_body_bias(self):
        socket = _FakeAckSocket([json.dumps({"sessionId": "s0"})])

        async def factory(url, headers):
            return socket

        legs = self.legs_for(BODY, BODY, stt_socket_factory=factory)

        asyncio.run(legs.open_speech(adapt_body(BODY)))

        handshake = json.loads(socket.sent[0])
        self.assertEqual(["Spanish"], handshake["languageBias"])


if __name__ == "__main__":
    unittest.main()

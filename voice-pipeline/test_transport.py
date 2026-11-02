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
import os
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

from cascade.body_map import adapt_body, body_fingerprint
from cascade.call import CallLifecycle
from cascade.envelope import sign_body
from cascade.events import CallEventLog, EventStream, EventWriter, OperationalEvents
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
from transport import (
    BrowserCallTransport,
    build_cascade_legs,
    handle_browser_call,
)

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

#: The demo call's own id: the randomUUID the app mints, never the subject.
DEMO_CALL_ID = "5b0f5c9a-4e2a-4a2b-9c3d-1f2e3a4b5c6d"
DEMO_SUBJECT = "demo:audrey"

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


class FullyMeasuredModel(FakeModel):
    """Every token unit is reported, so ticket 101 can price the leg."""

    async def complete(self, *, messages, tools=None, turn=None):
        async for delta in super().complete(messages=messages, tools=tools, turn=turn):
            yield delta
        record = turn if turn is not None else MetaLLMTurn()
        record.usage = TurnUsage(
            prompt_tokens=3,
            completion_tokens=4,
            cached_tokens=0,
            reasoning_tokens=0,
            measured=True,
        )


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
    kind: str | None = None,
) -> dict:
    served = BODY if body is None else body
    signed = sign_body(
        body=served,
        minted_fingerprint=body_fingerprint(served, account_salt=ACCOUNT),
        account_salt=ACCOUNT,
        secret=SECRET,
        call_id=call_id,
        agent_id=agent_id,
        kind=kind,
        ttl_ms=60_000,
        clock=CLOCK,
    )
    # The service channel carries JSON, not dataclasses.
    return json.loads(json.dumps(signed.message()))


def delivered_channel(
    body=None,
    *,
    token: str = TOKEN,
    call_id: str = CALL_ID,
    agent_id: str = AGENT_ID,
    kind: str | None = None,
) -> StoredBodyChannel:
    channel = StoredBodyChannel(secret=SECRET, clock=CLOCK)
    channel.deliver(
        call_token=token,
        call_id=call_id,
        message=signed_message(body, call_id=call_id, agent_id=agent_id, kind=kind),
    )
    return channel


def audio_message() -> dict:
    return {"type": "audio", "data": base64.b64encode(b"\x00" * 320).decode()}


def token_registry(clock: float = 1_000_001.0) -> CallTokenRegistry:
    return CallTokenRegistry(secret=SECRET, clock=FakeClock(clock))


async def switch_in_mode(mode: str) -> RoutingSwitch:
    """A durable switch seeded to ``mode`` so a test call is decided by it."""
    store = MemoryStore()
    record = RoutingRecord.seeded(mode, actor="transport-test", at=CLOCK())
    await store.compare_and_set(
        ROUTING_KEY, None, StoredDocument(version=1, document=record.to_document())
    )
    return RoutingSwitch(store, now=CLOCK)


async def open_switch() -> RoutingSwitch:
    """A durable switch pinned to ``all`` so a test call is admitted."""
    return await switch_in_mode("all")


def seeded_switch(mode: str, *, recording: bool = False) -> RoutingSwitch:
    """A seeded switch built outside the event loop, for tests that read it."""
    store = MemoryStore()
    record = RoutingRecord.seeded(mode, actor="transport-test", at=CLOCK())
    asyncio.run(
        store.compare_and_set(
            ROUTING_KEY, None, StoredDocument(version=1, document=record.to_document())
        )
    )
    chooser = RecordingSwitch if recording else RoutingSwitch
    return chooser(store, now=CLOCK)


class RecordingSwitch(RoutingSwitch):
    """The real switch, with every frozen decision it produced kept."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.decisions = []

    async def decide(self, subject, *, refusal="", budget=None):
        decision = await super().decide(subject, refusal=refusal, budget=budget)
        self.decisions.append(decision)
        return decision


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
    mode=None,
    counter=None,
    call_tokens=None,
    operational_events=None,
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

        chosen_switch = switch
        if chosen_switch is None:
            chosen_switch = await (open_switch() if mode is None else switch_in_mode(mode))

        with mock.patch("transport.CallLifecycle", RecordingLifecycle), mock.patch.object(
            BrowserCallTransport, "listening", None
        ):
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
                switch=chosen_switch,
                counter=counter,
                operational_events=operational_events,
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
        self.assertTrue(
            any(c["role"] == "agent" and c["final"] is True for c in captions),
            "the reply ends with one final agent caption",
        )
        self.assertTrue(
            any(
                c["role"] == "agent"
                and c["final"] is True
                and c["text"] == "Hola."
                for c in captions
            ),
            "the greeting is the first final agent caption",
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

    def test_an_unbound_voice_is_refused_by_name_with_its_locale_before_a_socket(self):
        body = json.loads(json.dumps(BODY))
        body["voice"]["voice_id"] = "juergen"
        ws, built, instances = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            channel=delivered_channel(body),
        )

        self.assertEqual(built, [], "no vendor socket before the voice binding is read")
        self.assertEqual(instances, [], "no lifecycle is built for an unbound voice")
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("juergen", errors[0]["message"])
        self.assertIn("de (German)", errors[0]["message"])
        self.assertIn("422", errors[0]["message"])

    def test_an_unknown_voice_is_refused_by_name_before_a_socket(self):
        body = json.loads(json.dumps(BODY))
        body["voice"]["voice_id"] = "ghost"
        ws, built, _instances = run_call(
            [browser_config(), {"type": "stop"}],
            [],
            channel=delivered_channel(body),
        )

        self.assertEqual(built, [], "no vendor socket before the voice binding is read")
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn('unknown voice "ghost"', errors[0]["message"])

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

    def test_the_served_call_charges_the_daily_counter_it_was_admitted_against(self):
        from cascade.counter import DailyCounter

        noon = 1_793_361_600.0
        counter = DailyCounter(MemoryStore(), now=lambda: noon)
        legs = FakeLegs(
            [SpeechStart("t1"), SpeechComplete("hola", turn_id="t1")]
        )
        legs.model = FullyMeasuredModel()
        _ws, _built, instances = run_call(
            [browser_config(), audio_message(), {"type": "stop"}],
            [SpeechStart("t1"), SpeechComplete("hola", turn_id="t1")],
            legs=legs,
            counter=counter,
        )

        day = asyncio.run(counter.snapshot(at=noon))

        self.assertEqual(1, len(instances))
        self.assertGreater(
            day.spent,
            Decimal("0"),
            "the call's wire usage never reached the daily counter",
        )


def run_subject_call(*, kind, agent_id, mode=None, switch=None):
    """One browser call whose signed envelope declares ``kind``.

    The token subject, the envelope's agent id and the browser's agent id are
    the same string, exactly as the transport requires.
    """
    token = mint_call_token(
        secret=SECRET,
        call_id=CALL_ID,
        subject=agent_id,
        clock=CLOCK,
        nonce=f"subject-kind-{kind}-{mode}-{agent_id}",
    )
    inbound = [browser_config(agentId=agent_id, callToken=token), {"type": "stop"}]
    channel = delivered_channel(token=token, agent_id=agent_id, kind=kind)
    return run_call(
        inbound,
        [],
        channel=channel,
        token=token,
        switch=switch,
        mode=mode,
    )


class SubjectKindRoutingTests(unittest.TestCase):
    """Ticket 03: the routing subject's kind is the signed envelope's claim.

    The kind is never read from the id: a tenant envelope whose agent id starts
    with ``demo:`` is still a tenant call. Every refusal opens zero vendor
    sessions, and a permitted call opens exactly one cascade connection.
    """

    def test_a_v2_demo_envelope_under_demo_opens_exactly_one_cascade_connection(self):
        switch = seeded_switch("demo", recording=True)
        ws, built, instances = run_subject_call(
            kind="demo", agent_id="demo:audrey", switch=switch
        )

        self.assertEqual(1, len(built), "the demo envelope reached the leg builder")
        self.assertEqual(1, len(instances), "one call, one cascade connection")
        self.assertTrue(instances[0].ran)
        self.assertFalse(any(m["type"] == "error" for m in ws.sent))
        self.assertEqual(1, len(switch.decisions), "one frozen decision per call")
        self.assertEqual(
            {"id": "demo:audrey", "kind": "demo"},
            switch.decisions[0].subject.to_document(),
            "the decision carries the envelope's agent id and declared kind",
        )
        self.assertEqual("cascade", switch.decisions[0].disposition)

    def test_a_v2_tenant_envelope_under_demo_opens_zero_vendor_sessions(self):
        ws, built, instances = run_subject_call(
            kind="tenant", agent_id=AGENT_ID, mode="demo"
        )

        self.assertEqual([], built, "no vendor session may open for a tenant call")
        self.assertEqual([], instances, "no cascade connection for a tenant call")
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], "managed")
        self.assertIn(f'"{AGENT_ID}" is a tenant call', errors[0]["message"])
        self.assertIn("demo only makes stored demo subjects eligible", errors[0]["message"])

    def test_routing_off_refuses_both_kinds_with_zero_vendor_sessions(self):
        for kind, agent_id in (("demo", "demo:audrey"), ("tenant", AGENT_ID)):
            with self.subTest(kind=kind):
                ws, built, instances = run_subject_call(
                    kind=kind, agent_id=agent_id, mode="off"
                )

                self.assertEqual([], built, "no vendor session may open when routing is off")
                self.assertEqual([], instances, "no cascade connection when routing is off")
                errors = [m for m in ws.sent if m["type"] == "error"]
                self.assertEqual(len(errors), 1)
                self.assertEqual(errors[0]["code"], "managed")
                self.assertEqual(
                    "routing is off; every new call routes managed",
                    errors[0]["message"],
                )

    def test_a_v1_envelope_is_tenant_under_every_mode(self):
        for mode, expected in (("off", "managed"), ("demo", "managed"), ("all", "cascade")):
            with self.subTest(mode=mode):
                switch = seeded_switch(mode, recording=True)
                ws, built, instances = run_subject_call(
                    kind=None, agent_id=AGENT_ID, switch=switch
                )

                self.assertEqual(1, len(switch.decisions))
                self.assertEqual(
                    {"id": AGENT_ID, "kind": "tenant"},
                    switch.decisions[0].subject.to_document(),
                    "version 1 has no kind claim, so it is read as tenant",
                )
                if expected == "cascade":
                    self.assertEqual(1, len(built))
                    self.assertEqual(1, len(instances))
                    self.assertFalse(any(m["type"] == "error" for m in ws.sent))
                    continue
                self.assertEqual([], built)
                self.assertEqual([], instances)
                errors = [m for m in ws.sent if m["type"] == "error"]
                self.assertEqual(len(errors), 1)
                self.assertEqual(errors[0]["code"], "managed")
                if mode == "demo":
                    self.assertIn(f'"{AGENT_ID}" is a tenant call', errors[0]["message"])

    def test_a_tenant_envelope_with_a_demo_prefix_is_still_refused(self):
        """The prefix proves nothing: a signed tenant kind wins over the id."""
        ws, built, instances = run_subject_call(
            kind="tenant", agent_id="demo:audrey", mode="demo"
        )

        self.assertEqual([], built, "a demo: prefix may never open a vendor session")
        self.assertEqual([], instances)
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], "managed")
        self.assertIn('"demo:audrey" is a tenant call', errors[0]["message"])

    def test_a_v2_demo_envelope_under_all_opens(self):
        ws, built, instances = run_subject_call(
            kind="demo", agent_id="demo:audrey", mode="all"
        )

        self.assertEqual(1, len(built))
        self.assertEqual(1, len(instances))
        self.assertTrue(instances[0].ran)
        self.assertFalse(any(m["type"] == "error" for m in ws.sent))

    def test_a_store_outage_still_routes_managed(self):
        store = MemoryStore()
        record = RoutingRecord.seeded("demo", actor="transport-test", at=CLOCK())
        asyncio.run(
            store.compare_and_set(
                ROUTING_KEY, None, StoredDocument(version=1, document=record.to_document())
            )
        )
        store.fail_reads = True
        switch = RecordingSwitch(store, now=CLOCK)

        ws, built, instances = run_subject_call(
            kind="demo", agent_id="demo:audrey", switch=switch
        )

        self.assertEqual([], built, "an unreadable switch may open no vendor session")
        self.assertEqual([], instances)
        self.assertEqual(1, len(switch.decisions))
        self.assertIsNone(switch.decisions[0].mode)
        self.assertEqual("managed", switch.decisions[0].disposition)
        errors = [m for m in ws.sent if m["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], "managed")
        self.assertIn("routing switch is unreadable", errors[0]["message"])


class DemoTraceSubjectTests(unittest.TestCase):
    """Ticket 17: the connect path passes the verified kind into the trace.

    The demo call's trace is keyed by the demo call id (the app's randomUUID),
    and every line that names a subject names ``demo:<voice>``. A demo envelope
    carrying a tenant subject is refused before a leg is built, so a demo trace
    can never carry a tenant identity.
    """

    def run_demo(
        self,
        *,
        directory: str,
        kind: str = "demo",
        agent_id: str = DEMO_SUBJECT,
        call_id: str = DEMO_CALL_ID,
    ):
        from server import operational_events_for

        token = mint_call_token(
            secret=SECRET,
            call_id=call_id,
            subject=agent_id,
            clock=CLOCK,
            nonce=f"demo-trace-{kind}-{agent_id}",
        )
        inbound = [browser_config(agentId=agent_id, callToken=token), {"type": "stop"}]
        with mock.patch.dict(
            os.environ, {"VOICE_PIPELINE_EVENTS_DIR": directory}
        ):
            return run_call(
                inbound,
                [],
                channel=delivered_channel(
                    token=token, call_id=call_id, agent_id=agent_id, kind=kind
                ),
                token=token,
                switch=seeded_switch("demo"),
                operational_events=operational_events_for,
            )

    def test_a_demo_call_writes_one_trace_keyed_by_call_id_with_its_demo_subject(self):
        with tempfile.TemporaryDirectory() as directory:
            _ws, _built, instances = self.run_demo(directory=directory)
            path = Path(directory) / f"{DEMO_CALL_ID}.jsonl"

            self.assertEqual(1, len(instances), "one demo call, one cascade connection")
            self.assertTrue(path.exists(), "the demo call wrote no trace")
            self.assertEqual(DEMO_CALL_ID, path.stem)
            self.assertNotEqual(DEMO_SUBJECT, path.stem, "the subject named the file")
            rows = [
                json.loads(line)
                for line in path.read_text().splitlines()
                if line
            ]

        self.assertTrue(rows, "the demo trace is empty")
        self.assertTrue(all(row["callId"] == DEMO_CALL_ID for row in rows))
        subjects = [row["subject"] for row in rows if "subject" in row]
        self.assertTrue(subjects, "no line named a subject")
        self.assertEqual({DEMO_SUBJECT}, set(subjects))

    def test_a_demo_envelope_with_a_tenant_subject_opens_no_leg_and_writes_no_trace(self):
        with tempfile.TemporaryDirectory() as directory:
            ws, built, instances = self.run_demo(
                directory=directory, agent_id=AGENT_ID
            )
            files = list(Path(directory).glob("*.jsonl"))

        self.assertEqual([], built, "a refused trace identity opened a leg")
        self.assertEqual([], instances, "a refused trace identity opened a call")
        self.assertEqual([], files, "a refused trace identity wrote an artifact")
        errors = [message for message in ws.sent if message["type"] == "error"]
        self.assertEqual(1, len(errors))
        self.assertIn("subject", errors[0]["message"])


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


class HoldReturnTests(unittest.TestCase):
    """A hold return re-mints a token and body for the same call id.

    The service accepts the fresh token after the first socket released its
    claim, runs the greeting-less resumed body, carries the history into the
    first model request, and appends to the same call-scoped trace file. No
    vendor socket and no database: the transport's own fakes.
    """

    def test_a_re_minted_token_reclaims_the_same_call_and_continues_its_trace(self):
        first_token = mint_call_token(
            secret=SECRET,
            call_id=DEMO_CALL_ID,
            subject=DEMO_SUBJECT,
            clock=CLOCK,
            nonce="demo-hold-first",
        )
        second_token = mint_call_token(
            secret=SECRET,
            call_id=DEMO_CALL_ID,
            subject=DEMO_SUBJECT,
            clock=CLOCK,
            nonce="demo-hold-second",
        )
        registry = token_registry()

        fresh_body = json.loads(json.dumps(BODY))
        resumed_body = json.loads(json.dumps(BODY))
        resumed_body.pop("greeting")
        history = [
            {"role": "user", "content": "We run a bakery in Lisbon."},
            {"role": "assistant", "content": "What is your busiest hour?"},
        ]
        resumed_body["history"] = history

        with tempfile.TemporaryDirectory() as directory:
            def events_for(call_id, subject, *, kind=None):
                writer = EventWriter(pipeline="cascade", call_id=call_id)
                sink = CallEventLog(directory, call_id=call_id)
                return OperationalEvents(
                    EventStream(writer, sink=sink, subject_kind=kind),
                    subject=subject,
                    now=CLOCK,
                )

            inbound = lambda token: [  # noqa: E731 - one shape for both calls
                browser_config(agentId=DEMO_SUBJECT, callToken=token),
                audio_message(),
                {"type": "stop"},
            ]
            events = [SpeechStart("t1"), SpeechComplete("hola", turn_id="t1")]

            first_ws, first_legs, _ = run_call(
                inbound(first_token),
                events,
                channel=delivered_channel(
                    fresh_body,
                    token=first_token,
                    call_id=DEMO_CALL_ID,
                    agent_id=DEMO_SUBJECT,
                    kind="demo",
                ),
                call_tokens=registry,
                operational_events=events_for,
            )
            second_ws, second_legs, _ = run_call(
                inbound(second_token),
                events,
                channel=delivered_channel(
                    resumed_body,
                    token=second_token,
                    call_id=DEMO_CALL_ID,
                    agent_id=DEMO_SUBJECT,
                    kind="demo",
                ),
                call_tokens=registry,
                operational_events=events_for,
            )

            # The fresh token is accepted for the same call after the first
            # socket released its claim; the old token is never reused.
            self.assertNotEqual(first_token, second_token)
            self.assertEqual(registry.live_call_ids(), (), "both sockets are done")
            self.assertEqual(
                [m["type"] for m in first_ws.sent if m["type"] == "end"], ["end"]
            )
            self.assertEqual(
                [m["type"] for m in second_ws.sent if m["type"] == "end"], ["end"]
            )

            # The resumed body's history is the first model request, so the
            # next reply continues instead of starting blank. The fresh body
            # opened with its greeting; the resumed one did not.
            self.assertEqual(second_legs[0].model.requests[0][: len(history)], history)
            self.assertEqual(
                second_legs[0].model.requests[0][-1],
                {"role": "user", "content": "hola"},
                "the new turn follows the carried conversation",
            )
            self.assertEqual(first_legs[0].voice.greeted, ["Hola."])
            self.assertEqual(second_legs[0].voice.greeted, [])

            # One call id, one trace file: both runs appended to it.
            traces = sorted(Path(directory).glob("*.jsonl"))
            self.assertEqual(len(traces), 1, "no second call record")
            lines = [
                json.loads(line)
                for line in traces[0].read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertTrue(lines, "the resumed call left trace lines")
            self.assertEqual({line["callId"] for line in lines}, {DEMO_CALL_ID})
            self.assertTrue(
                any(line["type"] == "greeting.start" for line in lines),
                "the first call's opening is in the same trace",
            )


if __name__ == "__main__":
    unittest.main()

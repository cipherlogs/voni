"""Voni telephony spike: Telnyx Call Control <-> AssemblyAI Voice Agent API.

Replaces the earlier cascading pipeline (AssemblyAI STT -> LLM Gateway ->
Cartesia TTS, orchestrated by pipecat; removed, see git history).

Why the switch: LLM Gateway is the one AssemblyAI product the $50 free credit
does *not* cover, and an unfunded account gets 2 requests/minute on it. A voice
agent spends one request per conversational turn, so the greeting plus one
reply exhausted the window and every later turn 429'd — which the openai SDK
swallowed as silent retries and the caller heard as dead air.

The Voice Agent API bundles STT + LLM + TTS + turn detection into a single
session, is covered by the free credits, and is limited by *concurrent
sessions* rather than requests per minute. One call is one session, so there is
no per-turn budget left to exhaust.

This server is now a bridge, not a pipeline. Both legs speak base64 G.711 at
8 kHz, so audio is re-wrapped between envelopes and never transcoded:

    Telnyx  {"event":"media","media":{"payload":<b64>}}
    Agent   {"type":"input.audio","audio":<b64>}      (to the agent)
    Agent   {"type":"reply.audio","data":<b64>}       (from the agent)
"""

import asyncio
import base64
import json
import os
import time
from contextlib import asynccontextmanager

import aiohttp
import uvicorn
import websockets
from fastapi import FastAPI, Request, WebSocket
from loguru import logger

from pipecat.runner.utils import parse_telephony_websocket

from voni_db import recorder
from tool_coordinator import ToolCoordinator
from voice_judge import classify_user_turn, judge_enabled, sample_judge
from bridge_config import BridgeConfig, bridge_config
from campaign_runner import decode_client_state, dispatch, telnyx_stream_params

PUBLIC_HOST = os.environ["PUBLIC_HOST"]  # e.g. "abc-123.trycloudflare.com" (no scheme)

# Record the Telnyx leg while the voice-quality problem is open. This is the
# one thing we have never measured: AssemblyAI's session recording proves what
# the agent *generated* (checked twice, zero dropouts), but everything from our
# bridge onward — the cloudflared tunnel, Telnyx, the PSTN hop — is unmeasured,
# and that is exactly where the caller says the voice breaks up. `dual` puts
# each leg on its own channel, so the agent's audio can be inspected alone.
# Set RECORD_CALLS=0 once the breakup is fixed; it costs Telnyx money per call.
RECORD_CALLS = os.environ.get("RECORD_CALLS", "1") != "0"

AGENT_WS_URL = "wss://agents.assemblyai.com/v1/ws"

# Campaign bookkeeping for outbound dials, keyed by Telnyx call control id.
# Deliberately in memory: both entries are meaningful only between one call's
# `call.initiated` and its `call.hangup`, and a bridge restart mid-call leaves
# the claim to be requeued by Voni's stale-claim sweep rather than resurrected
# from a stale local record.
CAMPAIGN_DIALS: dict[str, tuple[str, str | None]] = {}
ANSWERED_CALLS: set[str] = set()

# The AssemblyAI stored agent that answers each inbound call, resolved from the
# number that was dialled (plan Day 7-8, inbound number binding). Empty for a
# number with no binding, which falls back to the platform default.
INBOUND_AGENTS: dict[str, str] = {}

# Telnyx hangup causes, mapped to the outcomes Voni's queue understands. Anything
# unlisted becomes `failed`, which still consumes an attempt but is visibly not a
# "they did not pick up" — the two need different follow-up.
HANGUP_OUTCOMES = {
    "user_busy": "busy",
    "timeout": "no_answer",
    "no_answer": "no_answer",
    "originator_cancel": "no_answer",
    "call_rejected": "no_answer",
    "normal_clearing": "no_answer",
}

# Written to AssemblyAI's prompting guide, which is explicit that the shape of
# the prompt drives how human the agent sounds: front-load the one rule that
# matters, give it an identity rather than a behaviour list, grant explicit
# permission to be informal (safety training defaults models to stiff and
# formal), tell it to mirror the caller's length, and ban the exact bot-tell
# phrases rather than asking vaguely for "natural".
#
# The previous prompt described the agent as "a quick voice-agent connectivity
# test", so it behaved like one — the caller got "I will pass that feedback
# along to our team" and "Thank you for that feedback", which is precisely the
# register they asked us to get away from.
SYSTEM_PROMPT = (
    "BE SHORT AND ANSWER INSTANTLY. Most replies are under ten words.\n\n"
    "You are Voni, a person on a phone call. Not a demo, not a script.\n\n"
    "Answer first, in the fewest words that work. Never open with a preamble, a "
    "restatement of the question, or a filler sentence. Match the caller's "
    "length — a few words back for a few words. Have opinions. You can be dry.\n\n"
    "Never say: 'I'd be happy to help', 'Great question', 'Thank you for that "
    "feedback', 'I'll pass that along', 'I apologise for', 'Is there anything "
    "else'. Those make you sound like a bot.\n\n"
    "Spoken sentences only. No markdown, bullets, asterisks or emoji — they get "
    "read aloud as punctuation."
)
# Kept verbatim: this is the one turn the caller rated "superb", because it is
# pre-scripted and so reaches them in 382 ms instead of seconds (see the
# time-to-first-audio note on `turn_detection` below).
GREETING = "Hi, this is Voni. Can you hear me okay?"
VOICE_ID = "anna"

# Telnyx names G.711 variants "PCMU"/"PCMA"; the Voice Agent API uses MIME-ish
# names for the same wire formats, both fixed at 8 kHz.
ENCODING_MAP = {"PCMU": "audio/pcmu", "PCMA": "audio/pcma"}

# Telnyx Call Control streams are RECEIVE-ONLY unless the dial/answer command
# sets stream_bidirectional_mode="rtp" — without it Telnyx silently ignores the
# media we send back.
#
# `stream_bidirectional_codec` declares what OUR outbound audio is encoded as.
# Telnyx: "When the audio is sent using a different encoding than on the call,
# it will be transcoded, which may cause a degradation in quality." So this must
# match the codec the call actually negotiated, and the agent must be told to
# emit that same encoding — then nothing transcodes anywhere.
#
# It has to be declared on the answer/dial command, before the negotiated codec
# is known, so it is a prediction. PCMU is Telnyx's own default and what every
# observed inbound call to the US number negotiated; PCMA showed up only on
# outbound PSTN legs. A mismatch is logged, not fatal — Telnyx still transcodes.
#
# Telnyx also offers G722 / OPUS / AMR-WB / L16(16 kHz) here. L16 is their
# recommendation for AI agents (no transcoding, lower latency) — but only when
# the call leg is wideband. On an 8 kHz G.711 phone call, sending 16 kHz would
# just force a downconvert, so PCMU is the right choice for telephony.
BIDIRECTIONAL_CODEC = "PCMU"

# One 20 ms G.711 frame at 8 kHz. The agent emits 300-byte (37.5 ms) chunks and
# the PSTN leg runs on 20 ms frames, so every agent chunk straddles a frame
# boundary and Telnyx has to re-frame. Both sizes are inside Telnyx's documented
# "20 milliseconds to 30 seconds", but handing it whole frames removes the
# re-framing. Costs no latency: we hold at most 159 bytes, under 20 ms.
FRAME_BYTES = 160
ULAW_SILENCE = b"\xff"  # G.711 mu-law encodes digital silence as 0xFF


def _ulaw_abs_table() -> list[int]:
    """|amplitude| for each mu-law byte, so silence can be spotted without numpy."""
    table = []
    for byte in range(256):
        u = ~byte & 0xFF
        magnitude = (((u & 0x0F) << 3) + 0x84) << ((u >> 4) & 0x07)
        table.append(magnitude - 0x84)
    return table


ULAW_ABS = _ulaw_abs_table()
# Full scale is ~32124. Both numbers were swept against call 4's recording,
# scoring each candidate against AssemblyAI's own `time_to_first_audio_ms`:
# level 60 / 2% of samples gave a mean error of 260ms, versus 415ms for the
# 500 / 15% this started at. Speech onset ramps up gradually, so a high floor
# always reports the first word late.
SILENCE_LEVEL = 60
SPEECH_FRACTION = 0.02
# A gap this long between agent audio chunks means Telnyx ran out of queued
# audio, which the caller hears as the voice breaking up.
STALL_SECS = 0.15

async def send_frames(telnyx_ws: WebSocket, stats: dict, flush: bool = False) -> None:
    """Push whole 20 ms PCMU frames at Telnyx, keeping any partial tail back."""
    pending = stats["pending"]
    while len(pending) >= FRAME_BYTES:
        frame = bytes(pending[:FRAME_BYTES])
        del pending[:FRAME_BYTES]
        await telnyx_ws.send_text(json.dumps(
            {"event": "media", "media": {"payload": base64.b64encode(frame).decode()}}
        ))
        stats["to_caller"] += 1
    if flush and pending:
        # End of reply: pad the tail out with silence rather than dropping it
        # or letting it bleed into the front of the next reply.
        frame = bytes(pending) + ULAW_SILENCE * (FRAME_BYTES - len(pending))
        pending.clear()
        await telnyx_ws.send_text(json.dumps(
            {"event": "media", "media": {"payload": base64.b64encode(frame).decode()}}
        ))
        stats["to_caller"] += 1

@asynccontextmanager
async def lifespan(_: FastAPI):
    # One pool for the process, opened once. Opening it per call would put a
    # Neon cold start (this project scales to zero) in front of call setup.
    await recorder.start()
    try:
        yield
    finally:
        await recorder.stop()


app = FastAPI(lifespan=lifespan)


@app.post("/webhook")
async def webhook(request: Request):
    body = await request.json()
    event = body.get("data", {})
    event_type = event.get("event_type")
    payload = event.get("payload", {})
    call_control_id = payload.get("call_control_id")

    logger.info(f"webhook event: {event_type} call_control_id={call_control_id}")

    if event_type == "call.initiated":
        runtime = await bridge_config.get(force=True)
        # Persist before answering. This is a plain HTTP handler, not the audio
        # path, and the media WebSocket has not opened yet — so the one awaited
        # database call in the whole bridge lives here, where it costs the
        # caller nothing. Outbound calls get a row too, even though only
        # inbound ones are answered below.
        # An outbound campaign dial carries its linkage in client_state, which
        # Telnyx echoes back on every webhook for the call. Inbound calls have
        # none, and simply get no campaign.
        campaign = decode_client_state(payload.get("client_state"))
        campaign_lead_id = campaign.get("campaign_lead_id")

        # Inbound calls route by the number that was dialled; outbound ones
        # already know their agent from the campaign that placed them.
        inbound = payload.get("direction") == "incoming"
        bound_agent_id = (
            await resolve_inbound_agent(call_control_id, payload.get("to"))
            if inbound
            else None
        )

        await recorder.open_call(
            call_control_id,
            payload.get("from"),
            payload.get("to"),
            "inbound" if payload.get("direction") == "incoming" else "outbound",
            runtime.organization_id,
            bound_agent_id or runtime.agent_id,
            campaign.get("campaign_id"),
        )

        if campaign_lead_id:
            # The Voni call id is captured here, not at hangup: `close_call`
            # pops its per-call state during WebSocket teardown, which races the
            # hangup webhook, and losing the race would report the outcome with
            # no call attached.
            CAMPAIGN_DIALS[call_control_id] = (
                campaign_lead_id,
                recorder.get_call_id(call_control_id),
            )

    if event_type == "call.initiated" and payload.get("direction") == "incoming":
        # Inbound calls must be explicitly answered; outbound calls are
        # auto-answered by Telnyx when the far end picks up, and streaming is
        # requested directly on the original dial command instead — issuing
        # `answer` on an outbound leg is rejected with error 90102.
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/answer",
                headers={
                    "Authorization": f"Bearer {runtime.telnyx_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    **telnyx_stream_params(PUBLIC_HOST, BIDIRECTIONAL_CODEC),
                },
            ) as resp:
                text = await resp.text()
                logger.info(f"answer+stream request -> {resp.status}: {text}")

    elif event_type == "call.answered":
        # Whether the far end actually picked up is not recoverable from the
        # hangup cause alone — normal_clearing looks the same after a ten-minute
        # conversation and after a decline. This is the only unambiguous signal,
        # so it is recorded regardless of RECORD_CALLS.
        ANSWERED_CALLS.add(call_control_id)
        if RECORD_CALLS:
            await start_recording(call_control_id)

    elif event_type == "call.hangup":
        await report_campaign_outcome(call_control_id, payload)

    elif event_type == "call.recording.saved":
        # Presigned and short-lived; grab it promptly.
        urls = payload.get("recording_urls") or payload.get("public_recording_urls") or {}
        logger.info(f"TELNYX RECORDING SAVED: {json.dumps(urls)}")
        recorder.set_recording(call_control_id, urls.get("mp3") or urls.get("wav"))

    return {"ok": True}


async def start_recording(call_control_id: str) -> None:
    """Start a dual-channel recording of the Telnyx leg. Never fatal.

    The exact body schema could not be probed offline — Telnyx validates
    `call_control_id` before the body, so a bad field only shows up on a live
    call. That is fine here: this is a debugging instrument, so a failure is
    logged with Telnyx's own error (which names the valid values) and the call
    carries on regardless.
    """
    try:
        runtime = await bridge_config.get()
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/record_start",
                headers={
                    "Authorization": f"Bearer {runtime.telnyx_api_key}",
                    "Content-Type": "application/json",
                },
                json={"format": "mp3", "channels": "dual"},
            ) as resp:
                body = await resp.text()
                if resp.status == 200:
                    logger.info("telnyx recording started (dual channel)")
                else:
                    logger.warning(
                        f"telnyx record_start -> {resp.status}: {body[:400]} "
                        f"(call continues; fix the body from this error)"
                    )
    except Exception as e:
        logger.warning(f"telnyx record_start failed, continuing: {e}")


def build_session_update(
    in_encoding: str, out_encoding: str, runtime: BridgeConfig,
    agent_id: str | None = None,
) -> dict:
    """Build the one `session.update` that configures the agent session.

    `output.format` is immutable after `session.ready`, so it has to be right
    on this first message.

    `agent_id` overrides the platform default when the dialled number is bound
    to its own agent; without a binding it is None and the default applies.
    """
    stored_agent = agent_id or runtime.assemblyai_agent_id
    if stored_agent:
        # Stored agents carry their own prompt, voice, tools and encoding.
        return {
            "type": "session.update",
            "session": {"agent_id": stored_agent},
        }

    return {
        "type": "session.update",
        "session": {
            "system_prompt": SYSTEM_PROMPT,
            "greeting": GREETING,
            "input": {
                "format": {"encoding": in_encoding, "sample_rate": 8000},
                # `max_accuracy`: the best finals for the screen and the LLM.
                # Its longer endpointing wait doesn't apply here — the
                # explicit min/max_silence below override the mode preset.
                #
                # The first real call measured time-to-first-audio at 382 ms
                # for the pre-scripted greeting but 0.5-15.4 s (mean 4.8 s)
                # for every reply the model had to think about, and the agent
                # streams that wait to us as real-time SILENCE inside
                # `reply.audio`. 59% of the agent's airtime was dead air.
                "transcription_mode": "max_accuracy",
                # Scene + vocabulary for the opening turn, which would
                # otherwise run on generic recognition. Neutral: Voni is
                # vertical-agnostic, and the no-binding fallback has no
                # agent config to derive from. Stored-agent bindings carry
                # the per-agent list from provision.
                "transcription_prompt": (
                    "A business phone call. The caller may mention names, "
                    "places, dates, times, amounts, and reference numbers."
                ),
                "keyterms": ["Voni", "WhatsApp"],
                # PSTN callers are on handsets/speakerphone: far-field
                # isolation fits the mic. Applied at connect, before the
                # speech-to-text connection opens.
                "voice_focus": "far-field",
                "voice_focus_threshold": 0.8,
                #
                # These were left unset for the first two calls, which meant
                # the *adaptive* endpointer decided when the caller had
                # finished. It is patient by design, and it showed: measured
                # time-to-first-audio on call 2 was 1.2-2.3s when the caller
                # stopped cleanly, but 7.8s, 11.3s and 11.9s on turns where
                # they carried on talking — the agent politely waiting, and
                # streaming silence at us the whole time.
                #
                # The streaming best-practices guide gives the voice-agent
                # starting point outright: `min_turn_silence=100`,
                # `max_turn_silence=1000`, `interruption_delay=500` (the mode
                # default; first partial at ~800ms effective). Same three
                # knobs, named `min_silence`/`max_silence`/
                # `interruption_delay` on this API.
                #
                # KNOWN COST, accepted deliberately: setting min/max silence
                # switches off adaptive pacing and entity-aware waiting for the
                # rest of the session, so the agent can now split a phone
                # number or an email across turns. The docs' own remedy is to
                # raise these mid-call for an entity-capture step — do that
                # when the qualification flow starts asking for numbers, via a
                # `session.update` (both fields are mutable mid-session).
                # The 1000 ceiling (not the 500 we ran before) is what keeps
                # mid-thought pauses from being cut: call 4 measured the
                # end-of-turn wait at 0.70-1.14s, mean 0.91s.
                "turn_detection": {
                    "min_silence": 100,
                    "max_silence": 1000,
                    "interrupt_response": True,
                    # 500 is the balanced-mode default: coughs, breath, and
                    # "uh-huh" end before the first partial fires, so junk
                    # rarely cuts the agent off. We forward only the inbound
                    # track, so the agent never hears itself, and barge-in
                    # stays semantic rather than raw VAD.
                    "interruption_delay": 500,
                },
            },
            "output": {
                "voice": VOICE_ID,
                "format": {"encoding": out_encoding, "sample_rate": 8000},
            },
        },
    }


async def resolve_inbound_agent(call_control_id: str, to_number: str | None) -> str | None:
    """Ask Voni which agent answers the number that was dialled.

    Returns the Voni agent id (for the `calls` row) and records the AssemblyAI
    stored agent id in `INBOUND_AGENTS` for `build_session_update` to pick up.

    A failure here is never fatal: the call falls back to the platform default
    agent, which is exactly the behaviour that existed before bindings. Ringing
    out because a lookup timed out would be a far worse trade.
    """
    if not to_number:
        return None
    api_url = os.environ.get("VONI_API_URL", "").rstrip("/")
    secret = os.environ.get("VONI_TOOL_SECRET", "")
    if not api_url or not secret:
        return None

    try:
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                f"{api_url}/api/internal/inbound-agent",
                params={"to": to_number},
                headers={"Authorization": f"Bearer {secret}"},
            ) as response:
                body = await response.json(content_type=None)
                if response.status != 200 or not body.get("ok"):
                    logger.warning(f"inbound agent lookup failed: {body}")
                    return None
    except Exception as error:
        logger.warning(f"inbound agent lookup unavailable, using default: {error}")
        return None

    remote = body.get("assemblyaiAgentId")
    if remote:
        INBOUND_AGENTS[call_control_id] = remote
    logger.info(
        f"inbound {to_number} -> agent {body.get('label') or body.get('agentId')} "
        f"({body.get('source')})"
    )
    return body.get("agentId")


async def report_campaign_outcome(call_control_id: str, payload: dict) -> None:
    """Close the loop Voni's dispatcher opened when it handed out this lead.

    Reported from here rather than from `campaign_runner.py` because only the
    webhook sees the hangup cause, and the runner has moved on by the time a
    call ends. A campaign lead whose outcome is never reported stays `dialing`
    and blocks the queue until Voni's stale-claim sweep requeues it — so this
    swallows its own errors but always tries.
    """
    claim = CAMPAIGN_DIALS.pop(call_control_id, None)
    answered = call_control_id in ANSWERED_CALLS
    ANSWERED_CALLS.discard(call_control_id)
    if not claim:
        return  # inbound, or a call this process did not dial
    campaign_lead_id, call_id = claim

    cause = str(payload.get("hangup_cause") or "")
    # `call.answered` is the only trustworthy signal that a human (or a machine)
    # picked up; the cause alone cannot distinguish a real conversation from a
    # decline, since both end in normal_clearing.
    outcome = "answered" if answered else HANGUP_OUTCOMES.get(cause, "failed")
    logger.info(
        f"campaign outcome: {outcome} (cause={cause or 'none'}, answered={answered}) "
        f"for campaign_lead={campaign_lead_id}"
    )

    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            await dispatch.report(session, campaign_lead_id, outcome, call_id)
    except Exception as error:
        logger.warning(f"could not report campaign outcome, continuing: {error}")


async def hang_up(call_control_id: str) -> None:
    """End the Telnyx leg. 422/90018 just means the call already ended."""
    try:
        runtime = await bridge_config.get()
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/hangup",
                headers={
                    "Authorization": f"Bearer {runtime.telnyx_api_key}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                if resp.status not in (200, 422):
                    logger.error(f"hangup -> {resp.status}: {await resp.text()}")
    except Exception as e:
        logger.error(f"hangup failed: {e}")


async def telnyx_to_agent(telnyx_ws: WebSocket, agent_ws, stats: dict) -> None:
    """Forward caller audio into the agent session.

    Only the inbound track is forwarded. The agent has no echo cancellation of
    its own, and feeding it the outbound track would let it hear its own voice
    and interrupt itself mid-reply.
    """
    while True:
        message = json.loads(await telnyx_ws.receive_text())
        event = message.get("event")

        if event == "media":
            media = message.get("media", {})
            track = media.get("track", "inbound")
            if track != "inbound":
                stats["skipped_track"] += 1
                continue
            # Already base64 G.711 at 8 kHz — same as the agent expects.
            await agent_ws.send(
                json.dumps({"type": "input.audio", "audio": media["payload"]})
            )
            stats["to_agent"] += 1
            now = time.monotonic()
            if stats["first_in"] is None:
                stats["first_in"] = now
            stats["last_in"] = now
            if stats["to_agent"] % 100 == 0:
                logger.debug(
                    f"inbound {stats['to_agent']} frames in "
                    f"{now - stats['first_in']:.1f}s"
                )
        elif event == "stop":
            logger.info("Telnyx sent stop")
            return
        else:
            # Anything that isn't media or stop — notably Telnyx `error`
            # events, which were previously dropped on the floor.
            logger.warning(f"Telnyx event {event!r}: {json.dumps(message)[:300]}")


async def agent_to_telnyx(
    agent_ws, telnyx_ws: WebSocket, stats: dict, tools: ToolCoordinator
) -> None:
    """Forward agent audio to the caller and handle barge-in."""
    async for raw in agent_ws:
        event = json.loads(raw)
        event_type = event.get("type")
        # State-only and non-blocking for tool.call. HTTP execution runs in a
        # child task, so this coroutine keeps draining reply.audio meanwhile.
        tool_local_error = await tools.handle_event(event)

        if event_type == "reply.audio":
            now = time.monotonic()
            stats["speaking"] = True
            pcm = base64.b64decode(event["data"])
            stats["reply_bytes"] += len(pcm)
            if stats["first_audio_at"] is None:
                stats["first_audio_at"] = now

            # Real time-to-first-audio, measured here rather than taken from
            # `transcript.agent.delta`. That delta's `start_ms` is an offset
            # into the SPEECH, not into the reply stream, so on call 2 it
            # reported a flattering 442 ms mean while the session timeline said
            # the caller had actually waited 4.5s on average. The agent streams
            # its thinking time as real mu-law silence, so the honest measure is
            # `reply.started` -> first chunk that is not silent.
            # Sustained energy, not a single loud sample. The first version of
            # this used max() over the chunk and was wrong in both directions on
            # call 4 — it fired at 0 ms on one reply (a lone spike inside the
            # thinking silence) and at 917 ms on the greeting that AssemblyAI
            # timed at 380 ms. Requiring a real fraction of the chunk to be
            # above the floor is what distinguishes speech from dither.
            if stats["speech_at"] is None and (
                sum(1 for b in pcm if ULAW_ABS[b] > SILENCE_LEVEL)
                >= len(pcm) * SPEECH_FRACTION
            ):
                stats["speech_at"] = now
                if stats["reply_started_at"] is not None:
                    stats["ttfa_seen"].append(
                        int((now - stats["reply_started_at"]) * 1000)
                    )

            # Starvation watch. Telnyx queues and plays what we send, so it is
            # the playout buffer — but we forward at exactly the rate the agent
            # produces (measured 1.0x every reply, never a burst), which leaves
            # that buffer at zero depth. Any stall upstream lands straight in
            # the caller's ear as a gap. Count them instead of theorising about
            # why the voice breaks up.
            if stats["last_audio_at"] is not None:
                gap = now - stats["last_audio_at"]
                if gap > STALL_SECS:
                    stats["stalls"] += 1
                    stats["worst_stall"] = max(stats["worst_stall"], gap)
                    logger.warning(
                        f"agent audio stalled {gap * 1000:.0f}ms — Telnyx had "
                        f"nothing queued to play for that window"
                    )
            stats["last_audio_at"] = now

            stats["pending"].extend(pcm)
            await send_frames(telnyx_ws, stats)
        elif event_type == "input.speech.stopped":
            logger.debug("agent event: input.speech.stopped")
        elif event_type == "input.speech.started":
            # Deliberately does NOT flush Telnyx's buffer.
            #
            # Barge-in here is *semantic*: the server decides whether speech is
            # a real interruption or just a backchannel ("uh-huh") and only
            # then stops generating. Flushing on every speech-start — which is
            # what AssemblyAI's browser guidance suggests for snappier
            # barge-in — throws away audio Telnyx has not played yet while the
            # agent keeps generating the rest of the sentence. On a phone leg,
            # where carrier echo and background noise trigger this constantly
            # and there is no local echo cancellation, the caller hears the
            # voice break up mid-sentence. Wait for the confirmed interruption.
            stats["speech_started"] += 1
        elif event_type == "reply.done":
            stats["speaking"] = False
            await send_frames(telnyx_ws, stats, flush=True)
            if stats["first_audio_at"] is not None:
                elapsed = time.monotonic() - stats["first_audio_at"]
                audio_secs = stats["reply_bytes"] / 8000.0  # 1 byte/sample @ 8 kHz
                ratio = (audio_secs / elapsed) if elapsed > 0 else float("inf")
                if stats["speech_at"] is not None and stats["reply_started_at"]:
                    ttfa = int((stats["speech_at"] - stats["reply_started_at"]) * 1000)
                    speech_secs = max(0.0, audio_secs - ttfa / 1000.0)
                    # "~" is not decoration: this estimate carries roughly
                    # +/-300ms of error against AssemblyAI's own figure. Good
                    # enough to spot a regression live, NOT good enough to
                    # declare victory — the previous version of this metric was
                    # wrong by 10x and reported success. Confirm with
                    # `pull_session.py` and the Telnyx recording.
                    head = f"first word after ~{ttfa} ms, then {speech_secs:.2f}s of speech"
                else:
                    head = "no speech in this reply"
                logger.info(
                    f"reply sent [{event.get('status')}]: {head}; "
                    f"{audio_secs:.2f}s of audio pushed in {elapsed:.2f}s "
                    f"(={ratio:.1f}x real time)"
                )
            if event.get("status") == "interrupted":
                # The server really did stop generating, so dropping buffered
                # audio is correct here — it prevents stale speech playing on
                # after the caller took the turn. Drop our own partial frame
                # too, or it bleeds into the front of the next reply.
                stats["pending"].clear()
                await telnyx_ws.send_text(json.dumps({"event": "clear"}))
                stats["cleared"] += 1
            elif tools.take_hangup_request():
                # Agent-initiated hangup: generation settled and the flush
                # above pushed the last frames, but Telnyx still has to PLAY
                # the goodbye at 1x. Estimate the unplayed tail from pushed
                # audio vs elapsed wall-clock and wait it out (bounded), or
                # the teardown below cuts the closing line off mid-word.
                if stats["first_audio_at"] is not None:
                    pushed_secs = stats["reply_bytes"] / 8000.0
                    played_secs = time.monotonic() - stats["first_audio_at"]
                    tail = min(8.0, max(0.0, pushed_secs - played_secs))
                else:
                    tail = 0.0
                if tail > 0:
                    logger.info(f"agent ended the call; draining {tail:.1f}s of goodbye audio")
                    await asyncio.sleep(tail)
                else:
                    logger.info("agent ended the call; tearing down both legs")
                return
        elif event_type == "transcript.user":
            logger.info(f"caller: {event.get('text')!r}")
            # Jev barge-in classification, synchronous only: backchannel vs
            # real interruption while the agent holds the floor. Fire-and-
            # forget Jev sampling when configured — never awaited here, so
            # the 2.5s reply latency this loop was tuned for is untouched.
            text = event.get("text") or ""
            if stats.get("speaking") and stats.get("speech_at") is not None:
                agent_ms = (time.monotonic() - stats["speech_at"]) * 1000.0
                decision, prob = classify_user_turn(text, agent_ms)
                # Overheard either way: caller speech that landed while the
                # agent held the floor registers even when the judge keeps
                # the agent talking.
                stats["overheard"] += 1
                if decision == "yield":
                    stats["user_yields"] += 1
                else:
                    stats["backchannels"] += 1
                logger.debug(f"judge barge-in={decision} p={prob:.2f} text={text!r}")
                if judge_enabled():
                    asyncio.create_task(
                        sample_judge(
                            "barge-in",
                            {"partialText": text, "agentSpeakingMs": agent_ms},
                        )
                    )
            # Enqueued, never awaited: this loop forwards 20 ms frames and the
            # reply latency was tuned from 3.5s to 2.5s over five real calls.
            # A round trip to Frankfurt here would give part of that back.
            recorder.record_turn(stats["call_control_id"], "user", event.get("text"))
        elif event_type == "transcript.agent":
            logger.info(
                f"agent: {event.get('text')!r} interrupted={event.get('interrupted')}"
            )
            recorder.record_turn(stats["call_control_id"], "agent", event.get("text"))
        elif event_type == "reply.started":
            # Reset per-reply accounting here rather than on the first audio
            # frame, so a reply that produces no audio can't leak counters into
            # the next one. This is also the clock TTFA is measured against.
            stats["reply_started_at"] = time.monotonic()
            stats["first_audio_at"] = None
            stats["speech_at"] = None
            stats["last_audio_at"] = None
            stats["reply_bytes"] = 0
            logger.debug("agent event: reply.started")
        elif event_type == "session.error":
            if tool_local_error:
                logger.warning(f"tool-local session update failed; call continues: {event}")
                continue
            # at_capacity / concurrency_exceeded / internal_error are retryable;
            # every other code is fatal for this session.
            logger.error(f"agent session error: {event}")
            return
        elif event_type == "session.ended":
            logger.info("agent session ended")
            return


@app.websocket("/media-stream")
async def media_stream(websocket: WebSocket):
    await websocket.accept()

    transport_type, call_data = await parse_telephony_websocket(websocket)
    logger.info(f"media-stream connected: transport_type={transport_type} call_data={call_data}")

    if transport_type != "telnyx" or not call_data.get("call_id"):
        # The call never completed the Telnyx "connected"+"start" handshake —
        # most commonly because the far end hung up before streaming set up.
        logger.warning("Incomplete Telnyx stream handshake, closing")
        await websocket.close()
        return

    call_control_id = call_data["call_id"]
    telnyx_encoding = call_data.get("outbound_encoding", "PCMU")
    in_encoding = ENCODING_MAP.get(telnyx_encoding)
    out_encoding = ENCODING_MAP[BIDIRECTIONAL_CODEC]
    if telnyx_encoding != BIDIRECTIONAL_CODEC:
        logger.warning(
            f"codec mismatch: call negotiated {telnyx_encoding} but we declared "
            f"{BIDIRECTIONAL_CODEC} at answer time — Telnyx will transcode our "
            f"audio, degrading quality"
        )
    if in_encoding is None:
        logger.error(f"Unsupported Telnyx encoding {telnyx_encoding!r}, closing")
        await websocket.close()
        return

    # Frame counters. If the caller reports silence, these say which leg was
    # dry: no `to_agent` means Telnyx audio never arrived, no `to_caller` means
    # the agent never produced any.
    stats = {"call_control_id": call_control_id,
             "to_agent": 0, "to_caller": 0, "skipped_track": 0,
              "speech_started": 0, "cleared": 0,
              "backchannels": 0, "user_yields": 0, "overheard": 0, "speaking": False,
             "reply_started_at": None, "first_audio_at": None, "speech_at": None,
             "last_audio_at": None, "reply_bytes": 0, "ttfa_seen": [],
             "stalls": 0, "worst_stall": 0.0,
             "pending": bytearray(),
             "first_in": None, "last_in": None}
    logger.info(f"telnyx inbound={telnyx_encoding} -> agent in={in_encoding} "
        f"out={out_encoding} (bidirectional codec {BIDIRECTIONAL_CODEC})")

    agent_ws = None
    tools = None
    # Captured at session.ready and reported again at teardown: it is the key
    # to the session recording + timeline, and the docs ask for it on any
    # support report about audio glitches or unexpected interruptions.
    session_id = None
    try:
        runtime = await bridge_config.get(force=True)
        # Voice Agent API uses Bearer authentication. Browser sessions use the
        # short-lived tokens minted by Voni instead of this server credential.
        agent_ws = await websockets.connect(
            AGENT_WS_URL,
            additional_headers={
                "Authorization": f"Bearer {runtime.assemblyai_api_key}"
            },
        )

        await agent_ws.send(
            json.dumps(
                build_session_update(
                    in_encoding, out_encoding, runtime,
                    INBOUND_AGENTS.pop(call_control_id, None),
                )
            )
        )

        # Audio sent before session.ready is discarded, so block until it lands.
        while True:
            event = json.loads(await agent_ws.recv())
            if event.get("type") == "session.ready":
                session_id = event.get("session_id")
                logger.info(f"agent session ready: {session_id}")
                recorder.set_session_id(call_control_id, session_id)
                break
            if event.get("type") == "session.error":
                logger.error(f"agent session failed to start: {event}")
                return

        tools = ToolCoordinator(agent_ws, recorder.get_call_id(call_control_id))

        # Whichever leg ends first tears down the other.
        done, pending = await asyncio.wait(
            [
                asyncio.create_task(telnyx_to_agent(websocket, agent_ws, stats)),
                asyncio.create_task(agent_to_telnyx(agent_ws, websocket, stats, tools)),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        for task in done:
            if task.exception():
                logger.error(f"bridge task failed: {task.exception()}")

    except Exception as e:
        logger.error(f"bridge error: {e}")
    finally:
        if tools is not None:
            await tools.close()
        if agent_ws is not None:
            try:
                # Skipping session.end leaves a 30-second grace window that
                # still bills.
                await agent_ws.send(json.dumps({"type": "session.end"}))
                await agent_ws.close()
            except Exception:
                pass
        await hang_up(call_control_id)
        await recorder.close_call(call_control_id)
        seen = stats["ttfa_seen"]
        lead_summary = (
            f"time_to_first_word(approx) mean={sum(seen) / len(seen):.0f}ms "
            f"max={max(seen)}ms over {len(seen)} replies"
            if seen else "time_to_first_word n/a"
        )
        stall_summary = (
            f"audio_stalls={stats['stalls']} worst={stats['worst_stall'] * 1000:.0f}ms"
        )
        logger.info(
            f"call torn down — frames caller->agent={stats['to_agent']} "
            f"agent->caller={stats['to_caller']} skipped_track={stats['skipped_track']} "
            f"speech_started={stats['speech_started']} "
            # buffer_clears is also the confirmed-interruption count: the two
            # happen on the same event. A large gap between it and
            # speech_started means most detected speech was back-channel.
             f"confirmed_interruptions={stats['cleared']} {lead_summary} "
             f"judge_yields={stats['user_yields']} judge_backchannels={stats['backchannels']} "
             f"overheard={stats['overheard']} "
            f"{stall_summary} "
            f"inbound_span={(stats['last_in'] - stats['first_in']) if stats['first_in'] else 0:.1f}s"
        )
        # Every session is retained with a recording and a turn-by-turn
        # timeline carrying `time_to_first_audio_ms`. `pull_session.py` turns
        # this id into that table, which is how the dead-air problem was found.
        logger.info(f"session artifacts: ./pull_session.py {session_id}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765)

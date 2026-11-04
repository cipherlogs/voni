"""Jev fast cover judge: tone-or-silence with no hash fallback.

Owner direction: Jev is more reliable than the deterministic hash, so a slow,
broken, low-confidence, or missing judge is silence, never a guessed line.
End-intent short-circuits before any network: "hang up" never hears a cover.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from typing import Any

#: Jev on the Vercel AI Gateway evaluate endpoint.
JEV_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate"
JEV_MODEL = "typesafe-ai/jev"

#: Solid high confidence: below this the cover stays silent.
CONFIDENCE_GATE = 0.85

#: Jev must answer well inside the ack delay; never delay the cover on it.
TIMEOUT_S = 0.12

_JUDGE_TONES = frozenset({"negative", "question", "neutral", "unknown"})


def resolve_api_key(env: Any | None = None) -> str | None:
    source = env if isinstance(env, dict) else os.environ
    get = source.get if hasattr(source, "get") else lambda k, d=None: os.environ.get(k, d)
    return get("AI_GATEWAY_API_KEY") or get("VOICE_JUDGE_API_KEY")


def resolve_gateway_url(env: Any | None = None) -> str:
    source = env if isinstance(env, dict) else os.environ
    get = source.get if hasattr(source, "get") else lambda k, d=None: os.environ.get(k, d)
    return get("VOICE_JUDGE_GATEWAY_URL") or JEV_GATEWAY_URL


def resolve_model(env: Any | None = None) -> str:
    source = env if isinstance(env, dict) else os.environ
    get = source.get if hasattr(source, "get") else lambda k, d=None: os.environ.get(k, d)
    return get("VOICE_JUDGE_MODEL") or JEV_MODEL


def cover_question() -> dict[str, Any]:
    return {
        "type": "choice",
        "instructions": (
            "Read one caller final turn on a live sales demo call. Pick exactly one: "
            "negative if complaining/upset (broken, terrible, hate, worst, fed up); "
            "question if asking (what/why/how/when/can/could/do/is/are plus '?'); "
            "neutral for a plain statement; unknown for empty/greeting-only; "
            "silence when the turn asks to end (hang up, bye, that's all, I'm done), "
            "is filler-only (um, uh, mm-hmm), or is greeting-only (hi, hello). "
            "End-intent, complaint with an end request, greeting-only, and filler-only "
            "are always silence, never a tone."
        ),
        "options": ["negative", "question", "neutral", "unknown", "silence"],
    }


async def _post_evaluate(
    url: str,
    api_key: str,
    model: str,
    state: dict[str, Any],
    questions: dict[str, Any],
    timeout_s: float,
    session_factory: Any | None = None,
) -> dict[str, Any] | None:
    payload = {
        "model": model,
        "state": json.dumps(state)[:4000],
        "questions": questions,
    }
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    if session_factory is not None:
        async with session_factory(url, headers, payload, timeout_s) as resp:
            status = getattr(resp, "status", 200)
            if status != 200:
                return None
            if hasattr(resp, "json"):
                data = await resp.json()
            else:
                body = await resp.read() if hasattr(resp, "read") else b"{}"
                data = json.loads(body.decode("utf-8") or "{}")
            return data if isinstance(data, dict) else None
    import urllib.request

    def _blocking() -> dict[str, Any] | None:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
                code = getattr(resp, "status", 200)
                if code != 200:
                    return None
                return json.loads(resp.read().decode("utf-8") or "{}")
        except Exception:
            return None

    return await asyncio.to_thread(_blocking)


def _pick_tone(data: dict[str, Any] | None) -> tuple[str | None, float]:
    try:
        answers = (data or {}).get("answers") or {}
        judge = answers.get("judge") or {}
        pick = judge.get("pick")
        prob = judge.get("probability", 0.5)
        prob_f = float(prob) if isinstance(prob, (int, float)) else 0.5
        if pick == "silence":
            return None, prob_f
        if pick in _JUDGE_TONES and prob_f >= CONFIDENCE_GATE:
            return str(pick), prob_f
        # Boolean-shaped answers: {probability} without pick cannot name a tone.
        return None, prob_f
    except Exception:
        return None, 0.0


async def jev_cover_tone(
    caller_text: str,
    locale: str = "en",
    *,
    api_key: str | None = None,
    gateway_url: str | None = None,
    model: str | None = None,
    timeout_s: float = TIMEOUT_S,
    session_factory: Any | None = None,
) -> str | None:
    """Jev tone-or-None for one caller final. Fail-silence on every edge."""
    text = (caller_text or "").strip()
    if not text:
        return None
    try:
        from cascade.end_intent import wants_to_end
        from turns import is_backchannel

        if wants_to_end(text, locale or "en"):
            return None
        if is_backchannel(text):
            return None
    except Exception:
        pass
    key = api_key if api_key is not None else resolve_api_key()
    if not key:
        return None
    url = gateway_url or resolve_gateway_url()
    name = model or resolve_model()
    try:
        data = await asyncio.wait_for(
            _post_evaluate(
                url, key, name, {"caller_text": text, "locale": locale or "en"},
                {"judge": cover_question()}, timeout_s, session_factory,
            ),
            timeout=timeout_s + 0.05,
        )
    except (asyncio.TimeoutError, asyncio.CancelledError):
        return None
    except Exception:
        return None
    tone, _ = _pick_tone(data)
    return tone


def make_cover_judge(
    locale: str = "en",
    *,
    api_key: str | None = None,
    gateway_url: str | None = None,
    model: str | None = None,
    timeout_s: float = TIMEOUT_S,
    session_factory: Any | None = None,
) -> Callable[[str], Awaitable[str | None]]:
    """Build the ``ack_judge`` seam for one call locale."""

    async def _judge(caller_text: str) -> str | None:
        return await jev_cover_tone(
            caller_text, locale,
            api_key=api_key, gateway_url=gateway_url, model=model,
            timeout_s=timeout_s, session_factory=session_factory,
        )

    return _judge


__all__ = [
    "CONFIDENCE_GATE",
    "JEV_GATEWAY_URL",
    "JEV_MODEL",
    "TIMEOUT_S",
    "cover_question",
    "jev_cover_tone",
    "make_cover_judge",
    "resolve_api_key",
    "resolve_gateway_url",
    "resolve_model",
]

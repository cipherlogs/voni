"""Jev fast cover judge: tone-or-silence with no hash fallback.

Owner direction: Jev is more reliable than the deterministic hash, so a slow,
broken, low-confidence, or missing judge is silence, never a guessed line.
End-intent short-circuits before any network: "hang up" never hears a cover.

Tiered confidence: question/neutral/unknown speak at 0.6; negative needs 0.85
because a wrong sympathy costs more than a missed filler. Every decision is
logged redacted (tone, confidence bucket, latency ms, reason) with no secrets
and no caller text.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from typing import Any

#: Jev on the Vercel AI Gateway evaluate endpoint.
JEV_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate"
JEV_MODEL = "typesafe-ai/jev"

#: Solid high confidence: below this the cover stays silent.
CONFIDENCE_GATE = 0.85

#: Tiered gates per tone: a wrong sympathy costs more than a missed filler,
#: so negative needs 0.85 while question/neutral/unknown speak at 0.6.
CONFIDENCE_GATES: dict[str, float] = {
    "negative": 0.85,
    "question": 0.6,
    "neutral": 0.6,
    "unknown": 0.6,
}

#: Jev must answer well inside the ack delay; never delay the cover on it.
TIMEOUT_S = 0.12

_log = logging.getLogger(__name__)

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


def confidence_gate_for(tone: str) -> float:
    """The confidence floor for one tone: 0.85 for negative, 0.6 otherwise."""
    return CONFIDENCE_GATES.get(tone, CONFIDENCE_GATE)


def _confidence_bucket(prob: float) -> str:
    """Coarse confidence bucket for redacted logs: no precise score leaks."""
    try:
        value = float(prob)
    except Exception:
        return "unknown"
    if value < 0.6:
        return "lt-0.6"
    if value < 0.85:
        return "0.6-0.85"
    return "gte-0.85"


def _emit_cover_log(
    logger: Any | None,
    *,
    tone: str | None,
    prob: float,
    latency_ms: float,
    reason: str,
) -> None:
    """One redacted cover line: tone, bucket, latency, reason only.

    Never logs secrets or caller text: the payload, headers, key, URL, and
    the final itself stay out of the line.
    """
    target = logger if logger is not None else _log
    emit = getattr(target, "info", None)
    if not callable(emit):
        return
    try:
        emit(
            "jev_cover tone=%s bucket=%s latency_ms=%.1f reason=%s",
            tone or "-",
            _confidence_bucket(prob),
            float(latency_ms),
            reason,
        )
    except Exception:
        pass


async def _post_evaluate(
    url: str,
    api_key: str,
    model: str,
    state: dict[str, Any],
    questions: dict[str, Any],
    timeout_s: float,
    session_factory: Any | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """POST one evaluate; returns ``(data, reason)`` with redacted reasons.

    ``reason`` is ``None`` on a parsed dict, ``"non-200"`` on a status edge,
    and ``"unknown"`` on a transport or parse failure. No secrets or caller
    text are logged here; the caller logs the redacted outcome.
    """
    payload = {
        "model": model,
        "state": json.dumps(state)[:4000],
        "questions": questions,
    }
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    if session_factory is not None:
        try:
            async with session_factory(url, headers, payload, timeout_s) as resp:
                status = getattr(resp, "status", 200)
                if status != 200:
                    return None, "non-200"
                if hasattr(resp, "json"):
                    data = await resp.json()
                else:
                    body = await resp.read() if hasattr(resp, "read") else b"{}"
                    data = json.loads(body.decode("utf-8") or "{}")
                return (data if isinstance(data, dict) else None,
                        None if isinstance(data, dict) else "unknown")
        except Exception:
            return None, "unknown"
    import urllib.request

    def _blocking() -> tuple[dict[str, Any] | None, str | None]:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
                code = getattr(resp, "status", 200)
                if code != 200:
                    return None, "non-200"
                data = json.loads(resp.read().decode("utf-8") or "{}")
                return (data if isinstance(data, dict) else None,
                        None if isinstance(data, dict) else "unknown")
        except Exception:
            return None, "unknown"

    return await asyncio.to_thread(_blocking)


def _pick_tone(data: dict[str, Any] | None) -> tuple[str | None, float, str]:
    """Pick tone-or-None with tiered gates; returns ``(tone, prob, reason)``.

    ``reason`` is ``ok`` on a gated tone, ``silence-pick`` on an explicit
    silence, ``low-conf`` below the tone's gate, and ``unknown`` on an
    unknown pick or a boolean-shaped answer without a pick.
    """
    try:
        answers = (data or {}).get("answers") or {}
        judge = answers.get("judge") or {}
        pick = judge.get("pick")
        prob = judge.get("probability", 0.5)
        prob_f = float(prob) if isinstance(prob, (int, float)) else 0.5
        if pick == "silence":
            return None, prob_f, "silence-pick"
        if pick in _JUDGE_TONES:
            gate = CONFIDENCE_GATES.get(str(pick), CONFIDENCE_GATE)
            if prob_f >= gate:
                return str(pick), prob_f, "ok"
            return None, prob_f, "low-conf"
        # Boolean-shaped answers: {probability} without pick cannot name a tone.
        return None, prob_f, "unknown"
    except Exception:
        return None, 0.0, "unknown"


async def jev_cover_tone(
    caller_text: str,
    locale: str = "en",
    *,
    api_key: str | None = None,
    gateway_url: str | None = None,
    model: str | None = None,
    timeout_s: float = TIMEOUT_S,
    session_factory: Any | None = None,
    logger: Any | None = None,
) -> str | None:
    """Jev tone-or-None for one caller final. Fail-silence on every edge.

    Every exit logs one redacted line (tone, confidence bucket, latency ms,
    reason) with no secrets and no caller text. ``logger`` is injectable for
    tests; the module logger is the prod default.
    """
    started = time.monotonic()

    def _done(reason: str, tone: str | None = None, prob: float = 0.0) -> None:
        _emit_cover_log(
            logger,
            tone=tone,
            prob=prob,
            latency_ms=(time.monotonic() - started) * 1000.0,
            reason=reason,
        )

    text = (caller_text or "").strip()
    if not text:
        _done("empty")
        return None
    try:
        from cascade.end_intent import wants_to_end
        from turns import is_backchannel

        if wants_to_end(text, locale or "en"):
            _done("end_intent")
            return None
        if is_backchannel(text):
            _done("backchannel")
            return None
    except Exception:
        pass
    key = api_key if api_key is not None else resolve_api_key()
    if not key:
        _done("missing-key")
        return None
    url = gateway_url or resolve_gateway_url()
    name = model or resolve_model()
    try:
        data, post_reason = await asyncio.wait_for(
            _post_evaluate(
                url, key, name, {"caller_text": text, "locale": locale or "en"},
                {"judge": cover_question()}, timeout_s, session_factory,
            ),
            timeout=timeout_s + 0.05,
        )
    except (asyncio.TimeoutError, asyncio.CancelledError):
        _done("timeout")
        return None
    except Exception:
        _done("unknown")
        return None
    if post_reason is not None:
        _done(post_reason)
        return None
    tone, prob_f, pick_reason = _pick_tone(data)
    _done(pick_reason, tone=tone, prob=prob_f)
    return tone


def make_cover_judge(
    locale: str = "en",
    *,
    api_key: str | None = None,
    gateway_url: str | None = None,
    model: str | None = None,
    timeout_s: float = TIMEOUT_S,
    session_factory: Any | None = None,
    logger: Any | None = None,
) -> Callable[[str], Awaitable[str | None]]:
    """Build the ``ack_judge`` seam for one call locale."""

    async def _judge(caller_text: str) -> str | None:
        return await jev_cover_tone(
            caller_text, locale,
            api_key=api_key, gateway_url=gateway_url, model=model,
            timeout_s=timeout_s, session_factory=session_factory,
            logger=logger,
        )

    return _judge


__all__ = [
    "CONFIDENCE_GATE",
    "CONFIDENCE_GATES",
    "JEV_GATEWAY_URL",
    "JEV_MODEL",
    "TIMEOUT_S",
    "confidence_gate_for",
    "cover_question",
    "jev_cover_tone",
    "make_cover_judge",
    "resolve_api_key",
    "resolve_gateway_url",
    "resolve_model",
]

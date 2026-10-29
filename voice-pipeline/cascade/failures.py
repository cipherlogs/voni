"""What a provider failure means: trigger, bug or planned reconnect.

One pure table per leg decides whether a failure opens that leg's breaker.
The spec's trigger set is closed (`.scratch/meta-cascade/spec.md`,
"Trigger set is closed"): only retryable provider failures open a leg.
Deterministic request errors are our bugs — the call fails visibly and the
breaker is left to a human. Session expiry and the session length limits are
planned reconnects, and every unlisted code fails closed to ``do_not_open``.
Nothing here retries, sleeps, or reads a clock; retry policy and breaker
writes belong to the tickets that call this module.

Legs key the table, not bare codes: ``1011`` is a retryable close on both
speech and synthesis, while ``1008`` is a speech bug and an unlisted synthesis
code. A flat ``code -> action`` map would conflate them.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType

# Wire codes are integers; ``None`` is a close frame with no code. The string
# sentinels below stand in for lifecycle events that never carry a wire code.
Code = int | str | None

# The synthesis session's ``expires_at`` and the speech 60-minute session
# length are lifecycle facts, not wire codes. Callers pass this sentinel
# instead of inventing a close code for them.
SESSION_LIMIT = "session_limit"

# Model-leg table keys for the two failures that are not distinct statuses:
# a whole status class and a request timeout.
LLM_SERVER_ERROR = "5xx"
LLM_TIMEOUT = "timeout"


class FailureClass(str, Enum):
    """What a failure means. Exactly one applies to any classified failure."""

    TRIGGER = "trigger"
    BUG = "bug"
    PLANNED_RECONNECT = "planned_reconnect"
    DO_NOT_OPEN = "do_not_open"


@dataclass(frozen=True)
class FailureVerdict:
    leg: str
    code: Code
    failure_class: FailureClass
    reason: str

    @property
    def opens_breaker(self) -> bool:
        return self.failure_class is FailureClass.TRIGGER


@dataclass(frozen=True)
class FailureRule:
    failure_class: FailureClass
    reason: str


STT_CLOSE_RULES: Mapping[Code, FailureRule] = MappingProxyType(
    {
        1000: FailureRule(FailureClass.DO_NOT_OPEN, "normal completion"),
        1008: FailureRule(
            FailureClass.BUG,
            "invalid request or pacing: fail the call and alert, do not retry",
        ),
        1011: FailureRule(
            FailureClass.TRIGGER,
            "internal/backend failure: retry once with a new session",
        ),
        1013: FailureRule(
            FailureClass.TRIGGER, "rate limited: back off and open the breaker"
        ),
        None: FailureRule(
            FailureClass.TRIGGER,
            "close without a code is treated as 1011",
        ),
        SESSION_LIMIT: FailureRule(
            FailureClass.PLANNED_RECONNECT,
            "session length limit: reconnect at a turn boundary, not a failure",
        ),
    }
)

TTS_CLOSE_RULES: Mapping[Code, FailureRule] = MappingProxyType(
    {
        1000: FailureRule(FailureClass.DO_NOT_OPEN, "normal completion"),
        1006: FailureRule(FailureClass.TRIGGER, "abnormal socket close"),
        1011: FailureRule(FailureClass.TRIGGER, "abnormal socket close"),
        None: FailureRule(FailureClass.TRIGGER, "abnormal socket close"),
        1009: FailureRule(
            FailureClass.BUG,
            "message too large: split the Generate (at most 2,000 characters)",
        ),
        3005: FailureRule(
            FailureClass.TRIGGER,
            "no output while a FlushDone was owed: retry once, then open",
        ),
        3006: FailureRule(
            FailureClass.BUG,
            "invalid parameter: fail the call and alert, do not open",
        ),
        3008: FailureRule(
            FailureClass.PLANNED_RECONNECT,
            "session expiry: drain, then a new session for the next turn",
        ),
        3010: FailureRule(
            FailureClass.BUG,
            "text/control pacing: shed prefetch and back off, do not retry blindly",
        ),
        3011: FailureRule(
            FailureClass.BUG,
            "unread audio: read faster or reduce the queue, do not retry blindly",
        ),
        SESSION_LIMIT: FailureRule(
            FailureClass.PLANNED_RECONNECT,
            "reaching expires_at: drain the reply, then a new session",
        ),
    }
)

LLM_STATUS_RULES: Mapping[Code, FailureRule] = MappingProxyType(
    {
        400: FailureRule(
            FailureClass.BUG,
            "configuration or conversation-structure bug: fail the turn and alert",
        ),
        429: FailureRule(
            FailureClass.TRIGGER, "rate limited: open after the retry policy"
        ),
        LLM_SERVER_ERROR: FailureRule(
            FailureClass.TRIGGER, "server error: open after the retry policy"
        ),
        LLM_TIMEOUT: FailureRule(
            FailureClass.TRIGGER,
            "timeout: open after the retry policy; never restart mid-reply",
        ),
    }
)


def _verdict(leg: str, code: Code, rule: FailureRule | None) -> FailureVerdict:
    if rule is None:
        return FailureVerdict(
            leg=leg,
            code=code,
            failure_class=FailureClass.DO_NOT_OPEN,
            reason=(
                f"unclassified {leg} code {code!r}: fails closed to do_not_open"
            ),
        )
    return FailureVerdict(
        leg=leg,
        code=code,
        failure_class=rule.failure_class,
        reason=rule.reason,
    )


def classify_stt(code: Code) -> FailureVerdict:
    """Classify a speech-leg close code (or ``SESSION_LIMIT``)."""
    return _verdict("stt", code, STT_CLOSE_RULES.get(code))


def classify_tts(code: Code) -> FailureVerdict:
    """Classify a synthesis-leg close code (or ``SESSION_LIMIT``)."""
    return _verdict("tts", code, TTS_CLOSE_RULES.get(code))


def classify_llm(
    status: int | None = None, *, timed_out: bool = False
) -> FailureVerdict:
    """Classify a model-leg HTTP status, or a request timeout."""
    if timed_out:
        return _verdict(
            "llm",
            LLM_TIMEOUT if status is None else status,
            LLM_STATUS_RULES[LLM_TIMEOUT],
        )
    rule: FailureRule | None = None
    if isinstance(status, int):
        rule = LLM_STATUS_RULES.get(LLM_SERVER_ERROR if status // 100 == 5 else status)
    return _verdict("llm", status, rule)


def classify(
    leg: str, code: Code = None, *, timed_out: bool = False
) -> FailureVerdict:
    """Classify one failure for ``leg``; refuses an unknown leg by name."""
    if leg == "stt":
        return classify_stt(code)
    if leg == "tts":
        return classify_tts(code)
    if leg == "llm":
        return classify_llm(code, timed_out=timed_out)
    raise ValueError(f"unknown cascade leg {leg!r}; expected stt, llm or tts")


"""The one sensitive-capture window pair, derived from the stored body.

Sensitive values (an email, a phone number, an address, a budget) need a wider
end-of-turn window than ordinary conversation, or the agent cuts the caller off
mid-entity. The browser has always widened to `1400 / 4000` for that one turn;
the phone bridge used its own `500 / 2000` and restored its own `100 / 500`.
Three window pairs for one product is exactly the drift ADR 0007 exists to stop.

A body serves either the Turn preset (`turn_detection: null`, meaning-based
end-of-turn) or the demo latency experiment's explicit windows. The capture
window is the floor below, never narrowed by the body; a body that already asks
for a longer pause keeps its longer window. Restore is the body's own setting,
verbatim — never a bridge guess.

The floor lives here once. `telephony-bot/test_capture_windows.py` and
`voni/src/lib/voice/capture-windows.test.ts` both read
`voni/src/lib/voice/capture-window-cases.json`, so phone and browser are proved
equal from the same bodies. Tolerance: 0 ms — the two transports send identical
values, not merely close ones.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any

# The product's sensitive-capture window. Speech start/end are the silence pair;
# the interruption settings make barge-in usable while the caller dictates.
CAPTURE_FLOOR = MappingProxyType(
    {
        "min_silence": 1400,
        "max_silence": 4000,
        "interrupt_response": True,
        "interruption_delay": 0,
    }
)


def _milliseconds(value: Any) -> int:
    """A served window, or 0 when the body does not pin one."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, int(value))


def capture_windows(turn_detection: dict[str, Any] | None) -> dict[str, Any]:
    """The window pair for one sensitive turn, given the body's setting.

    The silence floor is a lower bound, not an override: a body that already
    asks for a longer pause keeps it, so a stored-body change reaches the phone
    path without a redeploy. The interruption settings stay the capture
    preset's — sensitive capture is also the turn where fast barge-in matters.
    """
    body = turn_detection or {}
    return {
        "min_silence": max(
            _milliseconds(body.get("min_silence")), CAPTURE_FLOOR["min_silence"]
        ),
        "max_silence": max(
            _milliseconds(body.get("max_silence")), CAPTURE_FLOOR["max_silence"]
        ),
        "interrupt_response": CAPTURE_FLOOR["interrupt_response"],
        "interruption_delay": CAPTURE_FLOOR["interruption_delay"],
    }

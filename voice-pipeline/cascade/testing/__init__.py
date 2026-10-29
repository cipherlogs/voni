"""Shared determinism kit for cascade tests (ticket 01 — frozen API).

Import everything from here; do not import the private modules directly:

    from cascade.testing import (
        FakeClock, FrozenClock, VirtualTimeout, run_with_deadline,
        Step, ScriptedSTT, ScriptedLLM, ScriptedTTS,
        Frame, Response, ScriptedSocketFactory, ScriptedSessionFactory,
    )

Three seams, one contract — nothing in this package touches a vendor, a
network or the wall clock:

- ``clock``          virtual time; deadlines fire only when time advances.
- ``scripted``       STT/LLM/TTS fakes implementing the providers.py ABCs.
- ``socket_factory`` websocket and HTTP plans: fixtures, delays, duplicate
                     frames, close codes, 429s and dropped connections.

Later tickets import these names; additive changes are fine, renames are not.
"""

from cascade.testing.clock import (
    TICK_MS,
    Clock,
    Deadline,
    FakeClock,
    FrozenClock,
    ManualClock,
    RealClock,
    VirtualTimeout,
    run_with_deadline,
)
from cascade.testing.scripted import (
    ScriptedLLM,
    ScriptedPrefetch,
    ScriptedSTT,
    ScriptedTTS,
    Step,
    as_steps,
)
from cascade.testing.socket_factory import (
    Frame,
    Response,
    ScriptedResponse,
    ScriptedSession,
    ScriptedSessionFactory,
    ScriptedSocket,
    ScriptedSocketClosed,
    ScriptedSocketFactory,
)

__all__ = [
    "TICK_MS",
    "Clock",
    "Deadline",
    "FakeClock",
    "FrozenClock",
    "ManualClock",
    "RealClock",
    "VirtualTimeout",
    "run_with_deadline",
    "ScriptedLLM",
    "ScriptedPrefetch",
    "ScriptedSTT",
    "ScriptedTTS",
    "Step",
    "as_steps",
    "Frame",
    "Response",
    "ScriptedResponse",
    "ScriptedSession",
    "ScriptedSessionFactory",
    "ScriptedSocket",
    "ScriptedSocketClosed",
    "ScriptedSocketFactory",
]

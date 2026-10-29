"""The phone bridge's sensitive-capture windows are the browser's, and both
come from the stored body (voice-parity ticket 71, ADR 0007).

These tests read the same checked-in cases the browser test reads. That is the
parity proof: one body in, one window pair out, on both transports.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from capture_windows import CAPTURE_FLOOR, capture_windows
from stored_agent_body import (
    read_turn_detection,
    turn_detection_from_body,
)

CASES_PATH = (
    Path(__file__).resolve().parents[1]
    / "voni"
    / "src"
    / "lib"
    / "voice"
    / "capture-window-cases.json"
)


def load_cases() -> dict:
    return json.loads(CASES_PATH.read_text())


class SharedFloorTests(unittest.TestCase):
    def test_the_bridge_floor_is_the_one_the_browser_and_fixture_pin(self):
        # The fixture is the single source of truth for both languages; the
        # bridge's runtime copy is allowed to exist so a phone deployment does
        # not need the Voni tree, but it may not drift.
        self.assertEqual(CAPTURE_FLOOR, load_cases()["floor"])


class CaptureWindowTests(unittest.TestCase):
    def test_every_shared_case_produces_the_same_windows(self):
        for case in load_cases()["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(
                    capture_windows(case["body_turn_detection"]),
                    case["capture"],
                )

    def test_the_turn_preset_restores_the_body_verbatim(self):
        # Restore is not a bridge guess either: null means the Turn preset and
        # an explicit experiment body comes back exactly as served.
        for case in load_cases()["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(
                    turn_detection_from_body(
                        {"input": {"turn_detection": case["body_turn_detection"]}}
                    ),
                    case["restore"],
                )

    def test_a_body_without_turn_detection_is_the_turn_preset(self):
        self.assertIsNone(turn_detection_from_body({"input": {}}))

    def test_an_unreadable_body_is_the_turn_preset_not_a_guess(self):
        for payload in [None, {}, {"input": None}, {"input": []}]:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    turn_detection_from_body(payload)


class StoredBodyReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_phone_windows_are_read_from_the_served_body(self):
        # The chain the bridge actually runs: platform payload -> body setting
        # -> capture windows. A changed served body changes the windows.
        wide = load_cases()["cases"][2]

        async def fetch(url: str, headers: dict[str, str]) -> dict:
            return {"input": {"turn_detection": wide["body_turn_detection"]}}

        served = await read_turn_detection("key", "agent-1", fetch=fetch)
        self.assertEqual(capture_windows(served), wide["capture"])

    async def test_a_served_body_change_reaches_the_bridge(self):
        payloads = [
            {"input": {"turn_detection": None}},
            {
                "input": {
                    "turn_detection": {
                        "min_silence": 1600,
                        "max_silence": 5200,
                        "interruption_delay": 250,
                    }
                }
            },
        ]
        seen: list[str] = []

        async def fetch(url: str, headers: dict[str, str]) -> dict:
            seen.append(url)
            return payloads[len(seen) - 1]

        first = await read_turn_detection(
            "key", "agent-1", fetch=fetch
        )
        second = await read_turn_detection(
            "key", "agent-1", fetch=fetch
        )
        self.assertIsNone(first)
        self.assertEqual(
            second,
            {
                "min_silence": 1600,
                "max_silence": 5200,
                "interruption_delay": 250,
            },
        )
        self.assertEqual(seen[0], "https://agents.assemblyai.com/v1/agents/agent-1")

    async def test_a_failed_read_is_the_turn_preset(self):
        async def fetch(url: str, headers: dict[str, str]) -> dict:
            raise RuntimeError("platform unavailable")

        self.assertIsNone(await read_turn_detection("key", "agent-1", fetch=fetch))


class NoBridgeLocalWindowTests(unittest.TestCase):
    def test_the_old_hardcoded_pacing_objects_cannot_return(self):
        # The bridge used to send 500/2000 to widen and 100/500 to restore.
        # Any numeric silence literal in the capture path is that guess coming
        # back; the windows must come from capture_windows().
        source = (
            Path(__file__).resolve().parent / "tool_coordinator.py"
        ).read_text()
        self.assertNotRegex(source, r'"(?:min|max)_silence"\s*:\s*\d')


if __name__ == "__main__":
    unittest.main()

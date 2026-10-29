"""The recorded barge-in case table passes unchanged on the cascade (ticket 92).

Spec: `.scratch/meta-cascade/spec.md` "Barge-in on `Cancel`, tail resume without
LLM" — Case table. The recorded recovery table is the cross-engine proof: it
passes on the cascade exactly as it passes on the managed path, and a
difference is a bug, not a new expected value. The table has two halves:

* **Recovery rows.** The managed path's recorded table
  (``voni/src/lib/voice/barge-in-recovery.cases.json``, ticket 70) is read
  directly — not copied — and every row is replayed on the cascade's own
  locating and resume seams. The cascade fixture records the row names it was
  recorded against, so a managed row that disappears (or a new one that is not
  recorded) fails by name instead of quietly shrinking the proof.
* **Lifecycle rows.** Double barge-in, cancel-after-expiry, greeting, goodbye
  and tool-hold come from the spec's M09 catalogue and are recorded in
  ``fixtures/barge_in/cases.json`` with the observables the cascade must
  produce. Every row runs; an unknown kind fails by name; a missing required
  row fails by name; a mismatch names the row, the key and both values.

The runner asserts against the recorded values, never against a value derived
from the implementation, which is the whole point of the table.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path

from cascade.assemblyai_tts import AssemblyAIStreamingTTS, Cancellation
from cascade.barge_in import (
    FILLER_RESUME_BUDGET_MS,
    BargeInCutPath,
    FillerResume,
)
from cascade.body_map import adapt_body
from cascade.greeting import CallGreeting
from cascade.meta_llm import MessageHistory, MetaLLMTurn, MetaToolCall
from cascade.test_tts_support import (
    BEGIN_EXPIRES_AT,
    audio_ms,
    begin,
    cancelled,
    flush_done,
    open_session,
    pcm_ms,
    word_boundaries,
    words,
)
from cascade.testing import ScriptedLLM
from cascade.testing.clock import FakeClock
from cascade.tools import ToolNarrationHold, continue_after_tool
from cascade.voice_binding import bind_voice
from metrics import TimingLedger
from providers import SentenceAudio

SAMPLE_RATE = 24000
CASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = CASE_DIR.parents[1]
CASES_PATH = CASE_DIR / "fixtures" / "barge_in" / "cases.json"
MANAGED_PATH = (
    REPO_ROOT / "voni" / "src" / "lib" / "voice" / "barge-in-recovery.cases.json"
)


class CaseTableError(ValueError):
    """The recorded table cannot be run as recorded."""


class MissingBargeInCase(CaseTableError):
    """A recorded row is absent from the table it must run against."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f'recorded barge-in case "{name}" is missing')


class UnrecordedBargeInCase(CaseTableError):
    """A row exists in the source table but was never recorded here."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(
            f'barge-in case "{name}" is not in the recorded table; record it '
            "deliberately, never dropped or renamed silently"
        )


class DuplicateBargeInCase(CaseTableError):
    """Two rows share a name, so one of them would never be observed."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f'barge-in case "{name}" is recorded twice')


class UnhandledBargeInCase(CaseTableError):
    """A row names a kind the cascade runner does not implement."""

    def __init__(self, name: str, kind: object) -> None:
        self.name = name
        self.kind = kind
        super().__init__(
            f'barge-in case "{name}" has unhandled kind {kind!r}; every recorded '
            "case must have a runner"
        )


class MissingExpectation(CaseTableError):
    """A row records no observable, so it could pass by doing nothing."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f'barge-in case "{name}" records no expected observable')


class CaseTableMismatch(CaseTableError):
    """The cascade differs from a recorded value: a bug, not a new value."""

    def __init__(self, name: str, key: str, expected: object, actual: object) -> None:
        self.name = name
        self.key = key
        self.expected = expected
        self.actual = actual
        super().__init__(
            f'barge-in case "{name}" recorded {key}={expected!r} but the cascade '
            f"produced {actual!r}; a difference is a bug, not a new expected value"
        )


def load_table() -> dict:
    return json.loads(CASES_PATH.read_text())


def load_managed() -> dict:
    return json.loads(MANAGED_PATH.read_text())


#: The lifecycle rows ticket 92 requires. A deleted row must fail by name.
REQUIRED_CASE_NAMES: tuple[str, ...] = (
    "double barge-in keeps one acknowledgement per cancel and the latest "
    "caller turn wins",
    "a cancel after expiry gets no acknowledgement; playback stops locally",
    "a greeting barge-in cancels the greeting and the caller wins",
    "a goodbye barge-in cancels the closing line and the caller wins",
    "a tool-hold barge-in cancels the hold and the tool result still lands",
)


def recorded_cases(table: dict) -> list[dict]:
    """The lifecycle rows, refusing a missing or duplicated row by name."""
    cases = list(table.get("cases") or [])
    names = [case.get("name") for case in cases]
    for name in REQUIRED_CASE_NAMES:
        if name not in names:
            raise MissingBargeInCase(name)
    for name in set(names):
        if names.count(name) > 1:
            raise DuplicateBargeInCase(name)
    return cases


def recovery_rows(table: dict, managed: dict) -> list[dict]:
    """The managed recovery rows this cascade table was recorded against."""
    recorded = list(table.get("recoveryRows") or [])
    actual = [case["name"] for case in managed.get("cases") or []]
    missing = [name for name in recorded if name not in actual]
    if missing:
        raise MissingBargeInCase(missing[0])
    for name in actual:
        if name not in recorded:
            raise UnrecordedBargeInCase(name)
    return [case for case in managed["cases"] if case["name"] in recorded]


def run_case(case: dict) -> dict:
    """Run one recorded lifecycle row and compare every recorded observable."""
    name = str(case.get("name") or "<unnamed>")
    handler = HANDLERS.get(case.get("kind"))
    if handler is None:
        raise UnhandledBargeInCase(name, case.get("kind"))
    expected = case.get("expect")
    if not isinstance(expected, dict) or not expected:
        raise MissingExpectation(name)
    try:
        observed = asyncio.run(_guard(handler(case)))
    except CaseTableError:
        raise
    except Exception as error:  # noqa: BLE001 - the row must fail by name
        raise CaseTableError(
            f'barge-in case "{name}" did not run: '
            f"{type(error).__name__}: {error}"
        ) from error
    for key, value in expected.items():
        if observed.get(key) != value:
            raise CaseTableMismatch(name, key, value, observed.get(key))
    return {"name": name, **observed}


async def _guard(awaitable, timeout_s: float = 5.0):
    return await asyncio.wait_for(awaitable, timeout_s)


# -- shared fakes -----------------------------------------------------------


class PushSocket:
    """A websocket the scenario feeds frame by frame, in order."""

    def __init__(self) -> None:
        self.frames: asyncio.Queue = asyncio.Queue()
        self.sent: list[str] = []
        self.closed = False

    def push(self, frame: str) -> None:
        self.frames.put_nowait(frame)

    def __aiter__(self) -> "PushSocket":
        return self

    async def __anext__(self) -> str:
        return await self.frames.get()

    async def send(self, message: str) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True


class Recorder:
    """One cut path over a recording sink."""

    def __init__(self, tts, clock=None) -> None:
        self.tts = tts
        self.played: list[bytes] = []
        self.flushes: list[object] = []
        self.played_event = asyncio.Event()
        self.path = BargeInCutPath(
            tts=tts,
            on_audio=self._on_audio,
            flush_playout=self._on_flush,
            clock=FakeClock() if clock is None else clock,
        )

    async def _on_audio(self, chunk: SentenceAudio) -> None:
        self.played.append(chunk.pcm)
        self.played_event.set()

    async def _on_flush(self, flush) -> None:
        self.flushes.append(flush)


class OneFrameTTS:
    """A session that speaks one frame: the caller's turn after a cut."""

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.flush_id = None
        self.cancels = 0

    async def speak(self, text: str):
        self.spoken.append(text)
        self.flush_id = 90
        yield SentenceAudio(pcm=b"caller-turn", sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        self.cancels += 1
        return Cancellation()


async def caller_turn_frames() -> int:
    """A new caller turn speaks: the floor was not left owned by the cut."""
    tts = OneFrameTTS()
    recorder = Recorder(tts)
    recorder.path.start(
        tts.speak("The caller's answer."), turn="caller", reply="The caller's answer."
    )
    await recorder.path.join()
    return len(recorder.played)


class GatedTTS:
    """A synthesis session whose frames are released by the scenario."""

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.cancels = 0
        self.flush_id = None
        self.frames: asyncio.Queue = asyncio.Queue()

    def feed(self, flush_id: int, pcm: bytes) -> None:
        self.frames.put_nowait((flush_id, pcm))

    async def speak(self, text: str):
        self.spoken.append(text)
        while True:
            flush_id, pcm = await self.frames.get()
            self.flush_id = flush_id
            yield SentenceAudio(pcm=pcm, sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        self.cancels += 1
        return Cancellation()


async def finished():
    yield SentenceAudio(pcm=b"answer", sample_rate=SAMPLE_RATE, text="An answer.")


# -- double barge-in --------------------------------------------------------


def _real_session(socket: PushSocket, clock: FakeClock) -> AssemblyAIStreamingTTS:
    async def factory(url, headers):
        return socket

    return AssemblyAIStreamingTTS(
        voice_id="anna",
        transport="browser",
        api_key="test-key",
        socket_factory=factory,
        clock=clock,
    )


async def _double_barge_in(case: dict) -> dict:
    """Two cuts, each acknowledged by its own ``Cancelled``; latest turn wins."""
    socket = PushSocket()
    tts = _real_session(socket, FakeClock())
    socket.push(begin())
    await tts.open()
    recorder = Recorder(tts)

    socket.push(audio_ms(700, flush_id=0))
    socket.push(
        word_boundaries(
            flush_id=0,
            audio_start_ms=0,
            entries=words(("hello", 0, 300), ("there.", 300, 700)),
        )
    )
    socket.push(flush_done(flush_id=0, audio_duration_ms=700))
    socket.push(audio_ms(400, flush_id=1))
    socket.push(flush_done(flush_id=1, audio_duration_ms=400))
    recorder.path.start(
        tts.speak("Hello there. Friend."), turn="turn-1", reply="Hello there. Friend."
    )
    await recorder.path.join()

    await recorder.path.cut("partial", speech_started_at=0.0, played_ms=400)
    plan = await recorder.path.interrupt("backchannel")

    # The first resume reads its own Cancelled and one frame, then is cut.
    socket.push(cancelled(audio_duration_seconds=0.4))
    socket.push(audio_ms(300, flush_id=5))
    socket.push(flush_done(flush_id=5, audio_duration_ms=300))
    recorder.played_event.clear()
    await recorder.path.resume(plan)
    await recorder.played_event.wait()
    await recorder.path.cut("partial", speech_started_at=0.0, played_ms=0)

    # The latest caller turn: the second Cancelled, then its own audio.
    socket.push(audio_ms(50, flush_id=5))
    socket.push(cancelled(audio_duration_seconds=0.05))
    socket.push(audio_ms(250, flush_id=6))
    socket.push(flush_done(flush_id=6, audio_duration_ms=250))
    played_before = len(recorder.played)
    recorder.path.start(tts.speak("An answer."), turn="turn-2", reply="An answer.")
    await recorder.path.join()

    return {
        "cancels": len(tts.cancellations),
        "acknowledgements": sum(1 for c in tts.cancellations if c.acknowledged),
        "cuts": len(recorder.path.cuts),
        "cancelled_resumes": sum(1 for r in recorder.path.resumes if r.cancelled),
        "stale_audio_played": sum(
            1 for pcm in recorder.played if pcm == pcm_ms(50)
        ),
        "latest_turn_frames": len(recorder.played) - played_before,
        "latest_turn_flush_id": tts.flush_id,
    }


# -- cancel after expiry ----------------------------------------------------


async def _cancel_after_expiry(case: dict) -> dict:
    """After ``expires_at`` the vendor never answers; playback stops locally."""
    socket = PushSocket()
    clock = FakeClock(float(BEGIN_EXPIRES_AT) + 1.0)
    tts = _real_session(socket, clock)
    socket.push(begin())
    await tts.open()
    recorder = Recorder(tts, clock)

    socket.push(audio_ms(700, flush_id=0))
    socket.push(
        word_boundaries(
            flush_id=0,
            audio_start_ms=0,
            entries=words(("hello", 0, 300), ("there.", 300, 700)),
        )
    )
    recorder.path.start(
        tts.speak("Hello there."), turn="turn-1", reply="Hello there."
    )
    await recorder.played_event.wait()

    cut = await recorder.path.cut(
        "partial", speech_started_at=0.0, played_ms=200
    )
    played_at_cut = len(recorder.played)
    # No ``Cancelled`` is pushed: the session is ending. A frame from the old
    # request must still never reach the caller.
    socket.push(audio_ms(100, flush_id=0))
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    return {
        "cancels": len(tts.cancellations),
        "acknowledgements": sum(1 for c in tts.cancellations if c.acknowledged),
        "client_flushed": cut.client_flushed,
        "frames_after_cut": len(recorder.played) - played_at_cut,
        "reply_in_flight": recorder.path.reply_in_flight,
    }


# -- greeting ---------------------------------------------------------------


GREETING = "Hola, soy Voni. ¿En qué puedo ayudarte?"


def _greeting_body():
    return adapt_body(
        {
            "system_prompt": "You are Voni, a careful voice agent.",
            "greeting": GREETING,
            "voice": {"voice_id": "lola"},
            "input": {"language_codes": ["es"]},
            "output": {"voice": "lola"},
            "tools": [],
            "llm": [],
        }
    )


class GatedGreetingVoice:
    """One greeting frame, then it waits until the cut releases it."""

    def __init__(self) -> None:
        self.binding = bind_voice("lola")
        self.begin = {}
        self.greeted: list[str] = []
        self.cancelled = 0
        self.first_frame = asyncio.Event()
        self.gate = asyncio.Event()

    async def speak_greeting(self, text: str):
        self.greeted.append(text)
        yield SentenceAudio(pcm=b"greeting-1", sample_rate=SAMPLE_RATE, text=text)
        self.first_frame.set()
        await self.gate.wait()
        yield SentenceAudio(pcm=b"greeting-2", sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        self.cancelled += 1
        self.gate.set()


async def _greeting_barge_in(case: dict) -> dict:
    """The greeting producer is the one cancelled; the caller's turn follows."""
    voice = GatedGreetingVoice()
    sink: list[SentenceAudio] = []
    frames = asyncio.Event()

    def collect(audio: SentenceAudio) -> None:
        sink.append(audio)
        frames.set()

    greeting = CallGreeting(
        voice=voice,
        ledger=TimingLedger(now=FakeClock()),
        sink=collect,
        chime=lambda: None,
    )
    playback = greeting.start(_greeting_body())
    await asyncio.wait_for(voice.first_frame.wait(), timeout=5.0)
    frames_before = len(sink)

    outcome = await playback.cancel("greeting")
    caller = await caller_turn_frames()

    return {
        "greeting_cancels": voice.cancelled,
        "greeting_lines": len(voice.greeted),
        "greeting_frames_after_cut": len(sink) - frames_before,
        "greeting_resumed": len(voice.greeted) > 1,
        "caller_turn_frames": caller,
        "cancelled": outcome.cancelled,
    }


# -- goodbye ----------------------------------------------------------------


async def _goodbye_barge_in(case: dict) -> dict:
    """The closing line's producer is cancelled; the caller's turn follows."""
    tts = GatedTTS()
    recorder = Recorder(tts)
    tts.feed(0, b"closing-1")
    recorder.path.start(
        tts.speak("Goodbye, and thanks."),
        turn="turn-1",
        reply="Goodbye, and thanks.",
    )
    await recorder.played_event.wait()
    frames_before = len(recorder.played)

    cut = await recorder.path.cut("goodbye", speech_started_at=0.0, played_ms=100)
    # The rest of the closing line arrives after Cancel: it is stale.
    tts.feed(1, b"closing-2")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    caller = await caller_turn_frames()

    return {
        "closing_cancels": tts.cancels,
        "closing_frames_after_cut": len(recorder.played) - frames_before,
        "cause": cut.cause,
        "caller_turn_frames": caller,
    }


# -- tool hold --------------------------------------------------------------


NARRATION = "Let me check the listings for you."


def _narrated_turn() -> MetaLLMTurn:
    turn = MetaLLMTurn(
        content_text=NARRATION,
        finish_reason="tool_calls",
        tool_calls=[
            MetaToolCall(
                index=0,
                call_id="call_1",
                name="search_properties",
                arguments='{"location": "Dubai"}',
            )
        ],
    )
    turn.close()
    return turn


def _a_result():
    from cascade.tools import ToolResult

    return ToolResult(
        name="search_properties",
        tool_call_id="call_1",
        payload={"ok": True, "data": {"count": 1}},
    )


class GatedHoldVoice:
    """A voice whose next hold frame is released by the scenario."""

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.cancels = 0
        self.cancelled = False
        self.release = asyncio.Event()
        self.started = asyncio.Event()

    async def speak(self, text: str):
        self.cancelled = False
        self.spoken.append(text)
        self.started.set()
        while True:
            await self.release.wait()
            self.release.clear()
            if self.cancelled:
                return
            yield SentenceAudio(pcm=b"hold", sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self) -> None:
        self.cancels += 1
        self.cancelled = True
        self.release.set()


async def _tool_hold_barge_in(case: dict) -> dict:
    """The hold producer is cancelled; the tool result still lands in history."""
    turn = _narrated_turn()
    history = MessageHistory()
    history.append_user("Any villas in Dubai?")
    voice = GatedHoldVoice()
    sink: list[SentenceAudio] = []
    frames = asyncio.Event()

    def collect(audio: SentenceAudio) -> None:
        sink.append(audio)
        frames.set()

    hold = ToolNarrationHold(voice=voice, locale_code="en", sink=collect)
    task = asyncio.ensure_future(hold.speak(turn=turn))
    await asyncio.wait_for(voice.started.wait(), timeout=5.0)
    voice.release.set()
    await asyncio.wait_for(frames.wait(), timeout=5.0)
    frames_before = len(sink)
    # The narration was already cut before the hold; what the barge-in cancels
    # is the hold line itself, counted from the first hold frame.
    cancels_before = voice.cancels

    await hold.cancel()
    hold_cancels = voice.cancels - cancels_before
    outcome = await asyncio.wait_for(task, timeout=5.0)
    async for _ in continue_after_tool(
        llm=ScriptedLLM([[]]), history=history, turn=turn, outcome=_a_result()
    ):
        pass
    caller = await caller_turn_frames()

    return {
        "hold_cancels": hold_cancels,
        "hold_frames_after_cut": len(sink) - frames_before,
        "tool_result_in_history": [
            message["role"] for message in history.messages
        ]
        == ["user", "assistant", "tool"],
        "caller_turn_frames": caller,
        "cancelled": outcome.cancelled,
    }


HANDLERS = {
    "double_barge_in": _double_barge_in,
    "cancel_after_expiry": _cancel_after_expiry,
    "greeting_barge_in": _greeting_barge_in,
    "goodbye_barge_in": _goodbye_barge_in,
    "tool_hold_barge_in": _tool_hold_barge_in,
}


# -- the recovery half: the managed table, unchanged ------------------------


def _recovery_plan(row: dict) -> list[str]:
    """Reconstruct the row's audio at the recorded cut.

    The managed table records the words whose start had played at ``playedMs``
    (its caption pacing), not vendor word timings. The cascade needs real
    ``WordBoundaries``, so each row is replayed with the last heard word
    straddling the cut — exactly the mid-word cut the managed table describes —
    and nothing else moved. Then the cascade must locate the same tail the
    recorded row says it leaves.
    """
    heard = row["heard"].split()
    words_in_line = row["line"].split()
    slot = row["playedMs"] / max(len(heard) - 0.5, 0.5)
    entries = [
        (word, index * slot, (index + 1) * slot)
        for index, word in enumerate(words_in_line)
    ]
    total = int(round(len(words_in_line) * slot))
    return [
        begin(),
        audio_ms(total, flush_id=0),
        word_boundaries(flush_id=0, audio_start_ms=0, entries=words(*entries)),
        flush_done(flush_id=0, audio_duration_ms=total),
    ]


async def _drain(iterator) -> None:
    async for _ in iterator:
        pass


def _locate(row: dict):
    tts, _ = open_session(_recovery_plan(row))
    asyncio.run(_drain(tts.speak(row["line"])))
    return Recorder(tts).path.cut_point(row["playedMs"])


class TailTTS:
    """A session that speaks the located tail once."""

    def __init__(self, point) -> None:
        self.point = point
        self.spoken: list[str] = []
        self.flush_id = None

    async def speak(self, text: str):
        self.spoken.append(text)
        self.flush_id = 5
        yield SentenceAudio(pcm=b"tail", sample_rate=SAMPLE_RATE, text=text)

    async def cancel(self):
        return Cancellation()


def _speak_tail(point) -> list[str]:
    tts = TailTTS(point)
    recorder = Recorder(tts)
    plan = FillerResume(
        text=point.resume_text, budget_ms=FILLER_RESUME_BUDGET_MS, resume=point.resume
    )

    async def scenario():
        await recorder.path.resume(plan)
        await recorder.path.join()

    asyncio.run(scenario())
    return tts.spoken


class ManagedRecoveryTableTest(unittest.TestCase):
    def test_the_managed_table_is_the_recorded_contract_this_table_runs(self):
        table = load_table()
        managed = load_managed()

        self.assertEqual(
            table["recoverySource"],
            "voni/src/lib/voice/barge-in-recovery.cases.json",
        )
        self.assertEqual(table["recoveryContract"], managed["contract"])

    def test_every_managed_row_runs_and_locates_its_recorded_tail(self):
        table = load_table()
        managed = load_managed()
        rows = recovery_rows(table, managed)

        self.assertEqual(len(rows), len(managed["cases"]))
        for row in rows:
            with self.subTest(case=row["name"]):
                point = _locate(row)
                self.assertTrue(point.word_level)
                self.assertEqual(row["rest"], point.resume.text)

    def test_every_managed_row_speaks_its_recorded_tail_exactly_once(self):
        table = load_table()
        managed = load_managed()
        rows = recovery_rows(table, managed)

        for row in rows:
            with self.subTest(case=row["name"]):
                point = _locate(row)
                self.assertEqual([row["rest"]], _speak_tail(point))

    def test_a_missing_managed_row_fails_by_name(self):
        table = load_table()
        managed = load_managed()
        removed = managed["cases"].pop(0)

        with self.assertRaises(MissingBargeInCase) as caught:
            recovery_rows(table, managed)

        self.assertEqual(removed["name"], caught.exception.name)
        self.assertIn(removed["name"], str(caught.exception))

    def test_an_unrecorded_managed_row_fails_by_name(self):
        table = load_table()
        managed = load_managed()
        extra = dict(managed["cases"][0], name="a brand new managed row")
        managed["cases"].append(extra)

        with self.assertRaises(UnrecordedBargeInCase) as caught:
            recovery_rows(table, managed)

        self.assertEqual("a brand new managed row", caught.exception.name)


class LifecycleCaseTableTest(unittest.TestCase):
    def test_every_recorded_lifecycle_row_runs(self):
        table = load_table()
        rows = recorded_cases(table)

        results = [run_case(row) for row in rows]

        self.assertEqual([row["name"] for row in rows], [r["name"] for r in results])
        self.assertEqual(len(rows), len(results))

    def test_a_missing_lifecycle_row_fails_by_name(self):
        table = load_table()
        removed = table["cases"].pop(0)

        with self.assertRaises(MissingBargeInCase) as caught:
            recorded_cases(table)

        self.assertEqual(removed["name"], caught.exception.name)
        self.assertIn(removed["name"], str(caught.exception))

    def test_a_duplicated_lifecycle_row_fails_by_name(self):
        table = load_table()
        table["cases"].append(dict(table["cases"][0]))

        with self.assertRaises(DuplicateBargeInCase) as caught:
            recorded_cases(table)

        self.assertEqual(table["cases"][0]["name"], caught.exception.name)

    def test_an_unhandled_kind_fails_by_name(self):
        table = load_table()
        row = dict(table["cases"][0], kind="telepathy")

        with self.assertRaises(UnhandledBargeInCase) as caught:
            run_case(row)

        self.assertEqual(row["name"], caught.exception.name)
        self.assertEqual("telepathy", caught.exception.kind)
        self.assertIn("telepathy", str(caught.exception))

    def test_a_row_without_an_expectation_fails_by_name(self):
        table = load_table()
        row = dict(table["cases"][0], expect={})

        with self.assertRaises(MissingExpectation) as caught:
            run_case(row)

        self.assertEqual(row["name"], caught.exception.name)

    def test_a_difference_names_the_row_the_key_and_both_values(self):
        table = load_table()
        row = dict(table["cases"][1], expect={"cancels": 99})

        with self.assertRaises(CaseTableMismatch) as caught:
            run_case(row)

        error = caught.exception
        self.assertEqual(row["name"], error.name)
        self.assertEqual("cancels", error.key)
        self.assertEqual(99, error.expected)
        self.assertEqual(1, error.actual)
        self.assertIn("not a new expected value", str(error))


if __name__ == "__main__":
    unittest.main()

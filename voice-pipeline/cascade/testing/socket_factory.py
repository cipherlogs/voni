"""Replayable websocket and HTTP seams for cascade tests (ticket 01).

One factory serves a recorded fixture and a fault script without changing the
client under test: a plan is an ordered list of ``Frame`` (websocket) or
``Response`` (HTTP) values, and faults are just plan entries — a delay, a
duplicated frame, a close code, a 429, a dropped connection.

Delays are virtual: they advance the injected ``FakeClock``. A plan with a
delay and no clock raises instead of sleeping, so a sleeping test cannot be
written by accident.

Public API (later tickets import these; do not rename):

    Frame                       one inbound websocket frame, or a fault
    ScriptedSocket              websocket-shaped connection (send/aiter/close)
    ScriptedSocketFactory       callable (url, extra_headers) -> Awaitable[socket]
    ScriptedSocketClosed        abnormal close shaped like websockets'
    Response                    one scripted HTTP response, or a fault
    ScriptedSessionFactory      callable (timeout_s=...) -> async CM session

Recorded surfaces: ``factory.connections`` (url, headers, socket) and
``factory.posts`` (url, headers, json), plus ``socket.sent``.

``ScriptedSocketClosed`` is deliberately a local ``ConnectionError`` rather
than a ``websockets`` import: the kit must import with no vendor SDK present.
It carries ``.code`` and ``.reason`` so classifier code reads it the same way
it reads ``websockets.exceptions.ConnectionClosed``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from cascade.testing.clock import Clock

_DELAY_NEEDS_CLOCK = (
    "scripted delay needs an injected clock; pass clock=FakeClock() so the "
    "wait is virtual, never wall-clock"
)


class ScriptedSocketClosed(ConnectionError):
    """Abnormal socket close. Shaped like ``websockets``' close exception."""

    def __init__(self, code: int, reason: str = "") -> None:
        super().__init__(f"socket closed with code {code}: {reason}")
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class Frame:
    """One inbound websocket frame, or a fault at that position.

        Frame(json.dumps(begin))                  # recorded fixture frame
        Frame(json.dumps(partial), delay_ms=900)  # arrives 0.9s later
        Frame(json.dumps(partial), repeat=2)      # duplicate frame (chaos)
        Frame(close_code=1011, reason="boom")     # abnormal close (chaos)
        Frame(exc=TimeoutError("stalled"))        # connection dropped
    """

    data: str | bytes | None = None
    delay_ms: float = 0.0
    repeat: int = 1
    close_code: int | None = None
    reason: str = ""
    exc: BaseException | None = None

    def __post_init__(self) -> None:
        if self.repeat < 1:
            raise ValueError(f"repeat must be at least 1: {self.repeat!r}")
        if self.delay_ms < 0:
            raise ValueError(f"delay_ms cannot be negative: {self.delay_ms!r}")
        payloads = (
            self.data is not None,
            self.close_code is not None,
            self.exc is not None,
        )
        if sum(payloads) != 1:
            raise ValueError(
                "a Frame needs exactly one of data, close_code or exc"
            )


async def _sleep_ms(delay_ms: float, clock: Clock | None) -> None:
    if delay_ms == 0.0:
        return
    if clock is None:
        raise RuntimeError(_DELAY_NEEDS_CLOCK)
    await clock.sleep(delay_ms / 1000.0)


@dataclass(frozen=True)
class Response:
    """One scripted HTTP response for a single ``post()`` call.

        Response(body=b'{"ok": true}')
        Response(status=429, body=b"slow down")
        Response(chunks=(sse_token, sse_token, done))   # streaming body
        Response(chunks=(), delay_ms=30_000)            # time-to-first-byte
        Response(exc=ConnectionResetError("reset"))     # dropped connection
    """

    status: int = 200
    body: bytes | None = None
    chunks: tuple[bytes, ...] = ()
    delay_ms: float = 0.0
    exc: BaseException | None = None

    def __post_init__(self) -> None:
        if self.status < 100:
            raise ValueError(f"invalid HTTP status: {self.status!r}")
        if self.delay_ms < 0:
            raise ValueError(f"delay_ms cannot be negative: {self.delay_ms!r}")
        if self.body is not None and self.chunks:
            raise ValueError("a Response takes body or chunks, not both")

    @property
    def all_chunks(self) -> tuple[bytes, ...]:
        if self.body is not None:
            return (self.body,)
        return self.chunks


class ScriptedSocket:
    """Websocket-shaped connection: ``await send``, ``async for``, ``await close``."""

    def __init__(
        self, plan: Iterable[Frame | str | bytes], *, clock: Clock | None = None
    ) -> None:
        self._frames: list[Frame] = []
        for item in plan:
            frame = item if isinstance(item, Frame) else Frame(item)
            self._frames.extend(frame for _ in range(frame.repeat))
        self._clock = clock
        self.sent: list[str | bytes] = []
        self.closed = False
        self.connected = True

    def __aiter__(self) -> "ScriptedSocket":
        return self

    async def __anext__(self) -> str | bytes:
        if not self._frames:
            self.connected = False
            raise StopAsyncIteration
        frame = self._frames.pop(0)
        await _sleep_ms(frame.delay_ms, self._clock)
        if frame.exc is not None:
            self.connected = False
            raise frame.exc
        if frame.close_code is not None:
            self.connected = False
            raise ScriptedSocketClosed(frame.close_code, frame.reason)
        if frame.data is None:  # pragma: no cover - Frame guarantees a payload
            raise RuntimeError("frame has no payload")
        return frame.data

    async def send(self, message: str | bytes) -> None:
        if self.closed:
            raise ScriptedSocketClosed(1000, "send after close")
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True
        self.connected = False


class ScriptedSocketFactory:
    """Callable socket factory over one plan, or one plan per connection.

    ``plans`` is either a single plan (a list of Frame/str/bytes) or a list of
    plans; the last plan repeats for further reconnects so a reconnect test
    does not index-error. ``connect_delay_ms`` and ``error`` script the
    handshake itself.
    """

    def __init__(
        self,
        plans: Iterable[Frame | str | bytes] | Iterable[Iterable[Frame | str | bytes]],
        *,
        clock: Clock | None = None,
        connect_delay_ms: float = 0.0,
        error: BaseException | None = None,
    ) -> None:
        self._plans = _normalise_plans(plans)
        self._clock = clock
        self._connect_delay_ms = connect_delay_ms
        self._error = error
        self.connections: list[dict[str, Any]] = []

    async def __call__(
        self, url: str, extra_headers: dict[str, str] | None = None
    ) -> ScriptedSocket:
        await _sleep_ms(self._connect_delay_ms, self._clock)
        if self._error is not None:
            raise self._error
        index = len(self.connections)
        plan = self._plans[min(index, len(self._plans) - 1)]
        socket = ScriptedSocket(plan, clock=self._clock)
        self.connections.append(
            {"url": url, "headers": dict(extra_headers or {}), "socket": socket}
        )
        return socket

    @property
    def socket(self) -> ScriptedSocket | None:
        """The most recently opened socket, for ``sent`` assertions."""
        return self.connections[-1]["socket"] if self.connections else None


def _normalise_plans(
    plans: Iterable[Frame | str | bytes] | Iterable[Iterable[Frame | str | bytes]],
) -> list[list[Frame | str | bytes]]:
    items = list(plans)
    if not items:
        return [[]]
    if all(isinstance(item, (Frame, str, bytes)) for item in items):
        return [items]
    return [list(plan) for plan in items]  # type: ignore[arg-type]


class ScriptedResponse:
    """Async context manager + ``iter_bytes``, the shape the backends expect."""

    def __init__(self, response: Response, *, clock: Clock | None = None) -> None:
        self.status = response.status
        self._response = response
        self._clock = clock

    async def __aenter__(self) -> "ScriptedResponse":
        return self

    async def __aexit__(self, *args: Any) -> bool:
        return False

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        response = self._response
        await _sleep_ms(response.delay_ms, self._clock)
        if response.exc is not None:
            raise response.exc
        for chunk in response.all_chunks:
            yield chunk


class ScriptedSession:
    """Async context manager session with ``post()``, as aiohttp exposes it."""

    def __init__(self, factory: "ScriptedSessionFactory") -> None:
        self._factory = factory
        self.posts: list[dict[str, Any]] = []

    async def __aenter__(self) -> "ScriptedSession":
        return self

    async def __aexit__(self, *args: Any) -> bool:
        return False

    def post(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: Any = None,
    ) -> ScriptedResponse:
        return self._factory._next_response(self, url, headers=headers, json=json)


class ScriptedSessionFactory:
    """HTTP session factory over a global response plan.

    Responses are consumed in ``post()`` call order across every session, so
    concurrent requests (Cartesia fires one per sentence) stay deterministic.
    ``timeout_s`` from the client is recorded, not enforced: timeouts belong
    to ``run_with_deadline`` and the injected clock.
    """

    def __init__(
        self,
        responses: Iterable[Response],
        *,
        clock: Clock | None = None,
    ) -> None:
        self._responses = list(responses)
        self._clock = clock
        self._cursor = 0
        self.sessions: list[dict[str, Any]] = []
        self.posts: list[dict[str, Any]] = []

    def __call__(self, *, timeout_s: float = 0.0) -> ScriptedSession:
        session = ScriptedSession(self)
        self.sessions.append({"timeout_s": timeout_s, "session": session})
        return session

    def _next_response(
        self,
        session: ScriptedSession,
        url: str,
        *,
        headers: dict[str, str] | None,
        json: Any,
    ) -> ScriptedResponse:
        index = self._cursor
        self._cursor += 1
        record = {"url": url, "headers": dict(headers or {}), "json": json}
        session.posts.append(record)
        self.posts.append(record)
        if index >= len(self._responses):
            raise LookupError(
                f"ScriptedSessionFactory has no response for post #{index} "
                f"({len(self._responses)} scripted)"
            )
        return ScriptedResponse(self._responses[index], clock=self._clock)


SocketFactory = Callable[[str, dict[str, str]], Awaitable[Any]]
"""Signature the STT backends accept; ``ScriptedSocketFactory`` satisfies it."""

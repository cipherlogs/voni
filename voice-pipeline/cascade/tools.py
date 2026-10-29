"""Tool calls execute over the app's existing HTTP route (ticket 81).

ADR 0006's original sin is two implementations of one agent body. A tool is
part of that body, so the cascade does not execute it: it calls the app's
existing ``POST /api/tools/[name]`` route and lets ``executeTool`` do the work.
Reimplementing the built-ins in Python would be the second implementation, so
this module owns only the hop and the shape handed back to the model.

The hop carries four facts and never a fifth:

* **the tool secret** in the route's bearer header. The route's auth is its own
  contract; a missing secret refuses here, because an unauthenticated request
  must never be sent;
* **the signed call's id** as ``context.callId``. Ticket 64's envelope (or
  ticket 65's token channel) minted the call before anything vendor-facing
  existed, so the model and the browser never supply a call identity;
* **the model's call id** as ``toolCallId``, so the route can dedupe. Ticket 82
  owns the rule: only an id of 1 to 64 characters is executable; a missing or
  blank id is denied without a request (the turn holds), and an overlength id
  fails the turn as a provider contract violation;
* **the model's arguments** unchanged. Argument validation is ticket 40's and
  happens before a call reaches here.

The result returns as one ``role: "tool"`` message written by
:func:`cascade.meta_llm.tool_result_message`, with the matching call id, and
:func:`continue_after_tool` makes the *same logical turn*'s next model request.
The route's own ``ok: false`` payload is a tool result too — a tool that
answers "not found" is a result the model can speak, not a failure.

The hop is bounded by :data:`TOOL_TIMEOUT_BOUND`, read from
:mod:`cascade.thresholds`; while the bound is open this module refuses by name
instead of inventing a number. It is also off the audio path: :meth:`start`
returns a :class:`ToolHop` immediately and the continuation awaits it, so the
reply stream never blocks on a side effect.

``end_call`` is not a tool. It is a pure signal (:class:`EndCallSignal`): no
request is made and nothing speakable follows it. The closing line and the
hangup are ticket 87's.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from cascade.envelope import VerifiedBody
from cascade.meta_llm import (
    CALL_ID_MAX_LENGTH,
    TOOL_CALL_ID_MISSING,
    TOOL_DENIED_COUNTER,
    MetaLLMTurn,
    ToolCallIdentityError,
    ToolDenial,
    tool_result_message,
)
from cascade.thresholds import require_bound
from metrics import TimingLedger
from providers import TokenDelta, ToolCallRequest

#: The app's existing tool route. The name is one path segment, never a body
#: field, because that is the route the managed path already serves.
TOOL_ROUTE_PATH = "/api/tools/{name}"

#: The route's bearer secret. Host env by spec; never committed and never part
#: of an error message.
TOOL_SECRET_ENV = "VONI_TOOL_SECRET"

#: The registry bound that bounds one hop (ticket 76 supplies the value).
TOOL_TIMEOUT_BOUND = "tool.timeout_ms"

#: Call control, never an HTTP tool.
END_CALL_TOOL = "end_call"

#: The only context kind a cascade call sends. A test context is the app's
#: own dry-run path, not something a live call may claim.
CALL_CONTEXT_KIND = "call"


class ToolHopError(RuntimeError):
    """A tool hop that did not produce a result; nothing was spoken."""


class ToolSecretError(ToolHopError):
    """No tool secret is configured, so no request may be sent.

    The message names the env var and never the value: an error that echoes a
    secret is a log line waiting to happen.
    """

    def __init__(self) -> None:
        super().__init__(
            f"{TOOL_SECRET_ENV} is not configured: the tool route is "
            "authenticated with the tool secret, so an unauthenticated request "
            "is never sent"
        )


class ToolContextError(ToolHopError):
    """The signed call's identity is absent, so the hop cannot be bound to it."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"the tool hop needs the call id the signed envelope minted: {reason}"
        )


class ToolRequestError(ToolHopError):
    """A model tool call is not the shape the route's contract accepts."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"the tool request cannot be built: {reason}")


class ToolCallIdError(ToolHopError):
    """The model's call id cannot identify an executed call (ticket 82)."""

    def __init__(self, name: str, call_id: Any, reason: str) -> None:
        self.name = name
        self.call_id = call_id
        super().__init__(f'tool "{name}": {reason}')


class ToolCallIdMissing(ToolCallIdError):
    """The call has no id, so there is nothing the route could dedupe on.

    Not executed and not answered: the vendor cannot be sent a ``tool`` result
    for a call it never identified, so the turn closes with a hold line and the
    denial is recorded instead.
    """

    def __init__(self, name: str, call_id: Any = "") -> None:
        super().__init__(
            name,
            call_id,
            "call_id is missing or empty; the call is not executed and the turn "
            "closes with a hold line",
        )


class ToolCallIdOverlong(ToolCallIdentityError, ToolHopError):
    """The call id is outside the vendor's 1-64 character contract (ticket 82).

    A provider contract violation, not a tool result: executing (or denying) a
    call whose identity cannot be quoted back to the vendor would leave the
    turn unanswerable, so the turn fails instead.
    """

    def __init__(self, name: str, call_id: str) -> None:
        self.name = name
        self.call_id = call_id
        super().__init__(
            f'tool "{name}": call_id is {len(call_id)} characters; the vendor '
            f"contract is 1-{CALL_ID_MAX_LENGTH}"
        )


def require_call_id(name: str, call_id: Any) -> str:
    """The one call-id rule both the executor and the request enforce.

    A missing or blank id is denied (the turn holds); an overlength id is a
    provider contract violation. Splitting the two matters: one is a model
    mistake the caller hears a hold line for, the other means this turn cannot
    be answered at all.
    """
    if not isinstance(call_id, str) or not call_id.strip():
        raise ToolCallIdMissing(name, call_id)
    if len(call_id) > CALL_ID_MAX_LENGTH:
        raise ToolCallIdOverlong(name, call_id)
    return call_id


class ToolBoundError(ToolHopError):
    """The injected hop bound cannot be used; a hop is never unbounded."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"the tool hop bound {reason}")


class ToolEndpointError(ToolHopError):
    """No base URL for the app, so there is no route to call."""

    def __init__(self) -> None:
        super().__init__(
            "the tool hop needs the app's base URL: the route lives in the app, "
            "and no default host is guessed"
        )


class ToolRouteError(ToolHopError):
    """The route answered with a status or body the hop cannot read.

    Ticket 84 turns this into a failed tool result; this module only names it,
    with the tool, the call and the status, and never the secret.
    """

    def __init__(self, name: str, call_id: str, reason: str) -> None:
        self.name = name
        self.call_id = call_id
        self.reason = reason
        super().__init__(f'tool "{name}" for call "{call_id}": {reason}')


class ToolTimeout(ToolRouteError):
    """The hop outlived its bound; a side effect may or may not have happened."""

    def __init__(self, name: str, call_id: str, timeout_ms: float) -> None:
        super().__init__(
            name,
            call_id,
            f"no response within {timeout_ms:g} ms ({TOOL_TIMEOUT_BOUND}); the "
            "hop is bounded so the call never hangs on a tool",
        )
        self.timeout_ms = timeout_ms


class ToolTurnError(ToolHopError):
    """This continuation cannot answer the turn as it was asked.

    One call is the unit a tool turn continues to; several calls are ticket
    86's ordering rule. Refusing by name is deliberate: appending the results
    we happen to have first would send the vendor a request missing a tool
    result, which is an HTTP 400 and a lost turn.
    """

    def __init__(self, calls: int) -> None:
        self.calls = calls
        super().__init__(
            f"this turn requested {calls} tool calls; the continuation executes "
            "one call per tool turn (ticket 86 owns several calls in index "
            "order), so the turn is refused rather than half answered"
        )


@dataclass(frozen=True)
class ToolRequest:
    """One hop, as the route's contract asks for it.

    ``call_id`` is the only call identity that may appear: it comes from the
    signed body envelope, never from the model's arguments or the browser.
    """

    name: str
    call_id: str
    tool_call_id: str
    arguments: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name:
            raise ToolRequestError("the tool name is empty")
        if not isinstance(self.call_id, str) or not self.call_id.strip():
            raise ToolContextError("it is empty")
        require_call_id(self.name, self.tool_call_id)
        if not isinstance(self.arguments, Mapping):
            raise ToolRequestError(
                f"arguments must be an object, got {type(self.arguments).__name__}"
            )

    def path(self) -> str:
        """The route path; the name is one encoded segment, dots included."""
        return TOOL_ROUTE_PATH.format(name=quote(self.name, safe=""))

    def url(self, base_url: str) -> str:
        return f"{base_url.rstrip('/')}{self.path()}"

    def body(self) -> dict[str, Any]:
        """The exact JSON the route parses, and nothing else."""
        return {
            "toolCallId": self.tool_call_id,
            "arguments": dict(self.arguments),
            "context": {"kind": CALL_CONTEXT_KIND, "callId": self.call_id},
        }

    def headers(self, secret: str) -> dict[str, str]:
        """The route's bearer auth and content type, and nothing else."""
        return {
            "authorization": f"Bearer {secret}",
            "content-type": "application/json",
        }


@dataclass(frozen=True)
class ToolResult:
    """The route's answer, ready to become the model's ``role: "tool"`` message.

    The payload is carried verbatim: a ``{"ok": false, "error": …}`` answer is
    a tool result the model can speak, not an outage. Transport failures never
    reach this type (ticket 84 owns their mapping).
    """

    name: str
    tool_call_id: str
    payload: Mapping[str, Any]

    def __post_init__(self) -> None:
        if not isinstance(self.payload, Mapping):
            raise TypeError(
                f"a tool result payload must be an object, got {type(self.payload).__name__}"
            )

    @property
    def ok(self) -> bool:
        """Whether the route reported success; anything else is a result too."""
        return self.payload.get("ok") is True

    @property
    def reason(self) -> str:
        """The route's own refusal text, when it refused."""
        error = self.payload.get("error")
        return error if isinstance(error, str) else ""

    def content(self) -> str:
        """The route's payload as the one text field the vendor accepts."""
        return json.dumps(dict(self.payload), ensure_ascii=False)

    def tool_message(self) -> dict[str, Any]:
        """The ``role: "tool"`` message answering this call, by call id."""
        return tool_result_message(self.tool_call_id, self.content())


@dataclass(frozen=True)
class EndCallSignal:
    """``end_call`` succeeded as call control: there is nothing left to run.

    It carries no speakable text on purpose (CODING_STANDARDS: the end-call
    result is a pure signal; the closing line is spoken before the signal).
    """

    call_id: str
    tool_call_id: str = ""

    @property
    def name(self) -> str:
        return END_CALL_TOOL


ToolOutcome = ToolResult | EndCallSignal


@dataclass(frozen=True)
class DeniedCall:
    """A call that was not executed because it has no executable identity.

    ``hold`` is always true: a denied call closes the turn with a hold line
    (ticket 85 speaks it) instead of a tool result the vendor cannot match. The
    denial is carried here so the turn can record it without re-deriving why.
    """

    name: str
    denial: ToolDenial
    hold: bool = True

    @property
    def tool_call_id(self) -> str:
        """The id the call carried; empty when none was supplied."""
        return self.denial.call_id

    def __post_init__(self) -> None:
        if self.denial.code != TOOL_CALL_ID_MISSING:
            raise ValueError(
                f"a denied call carries the missing-call-id denial, got "
                f"{self.denial.code!r}"
            )


class ToolHop:
    """One in-flight hop: the audio path starts it, the continuation awaits it."""

    def __init__(self, task: asyncio.Future | None, outcome: ToolOutcome | None) -> None:
        self._task = task
        self._outcome = outcome

    @property
    def done(self) -> bool:
        """Whether the hop has an answer; a caller may check without waiting."""
        return self._outcome is not None or (
            self._task is not None and self._task.done()
        )

    def cancel(self) -> None:
        """Drop the hop; a cancelled side effect is reported, never guessed."""
        if self._task is not None and not self._task.done():
            self._task.cancel()

    async def outcome(self) -> ToolOutcome:
        """Await the hop's one answer, or raise the named reason it has none."""
        if self._outcome is not None:
            return self._outcome
        assert self._task is not None
        return await self._task


class ToolExecutor:
    """Executes one model tool call against the app's existing route.

    One executor belongs to one call: the call id it carries is the one the
    signed envelope minted, and no request can name another.
    """

    def __init__(
        self,
        *,
        base_url: str,
        call_id: str,
        secret: str | None = None,
        session_factory: Any = None,
        timeout_ms: float | None = None,
    ) -> None:
        if not isinstance(base_url, str) or not base_url.strip():
            raise ToolEndpointError()
        if not isinstance(call_id, str) or not call_id.strip():
            raise ToolContextError("it is empty")
        self._base_url = base_url.strip()
        self._call_id = call_id
        # The env is read lazily so a deployment can set it after import; an
        # absent secret still refuses at request time.
        self._secret = secret
        self._session_factory = session_factory
        self._timeout_ms = timeout_ms

    @property
    def call_id(self) -> str:
        return self._call_id

    @classmethod
    def from_verified(
        cls,
        verified: Any,
        *,
        base_url: str,
        secret: str | None = None,
        session_factory: Any = None,
        timeout_ms: float | None = None,
    ) -> "ToolExecutor":
        """Bind the hop to the call id the signed envelope verified (ticket 64).

        The body the app signed is the only source of a call identity, so this
        is the constructor a live call uses: nothing the browser or the model
        says can name a different call than the one the app sealed.
        """
        if not isinstance(verified, VerifiedBody):
            raise ToolContextError(
                f"expected a verified signed body, got {type(verified).__name__}"
            )
        return cls(
            base_url=base_url,
            call_id=verified.call_id,
            secret=secret,
            session_factory=session_factory,
            timeout_ms=timeout_ms,
        )

    def request_for(self, call: ToolCallRequest) -> ToolRequest:
        """The route request for one model call, bound to this executor's call."""
        return ToolRequest(
            name=call.name,
            call_id=self._call_id,
            tool_call_id=call.call_id,
            arguments=call.arguments,
        )

    def timeout_ms(self) -> float:
        """The hop's bound in milliseconds, or the named reason it is open."""
        if self._timeout_ms is not None:
            value = float(self._timeout_ms)
            if value <= 0:
                raise ToolBoundError(f"must be positive, got {value:g} ms")
            return value
        return float(require_bound(TOOL_TIMEOUT_BOUND))

    def start(self, call: ToolCallRequest) -> ToolHop:
        """Begin the hop and return at once; nothing here awaits the network.

        Call control first: ``end_call`` is a signal, not a tool, so it has no
        identity requirement. Every other call must carry a vendor-valid id
        (ticket 82): a missing or blank id returns a denied outcome without a
        request, and an overlength id fails the turn here, before any request.
        """
        if call.name == END_CALL_TOOL:
            return ToolHop(
                task=None,
                outcome=EndCallSignal(
                    call_id=self._call_id, tool_call_id=call.call_id
                ),
            )
        try:
            require_call_id(call.name, call.call_id)
        except ToolCallIdMissing as error:
            return ToolHop(
                task=None,
                outcome=DeniedCall(
                    name=call.name,
                    denial=ToolDenial(
                        name=call.name,
                        reason=str(error),
                        call_id=call.call_id if isinstance(call.call_id, str) else "",
                        code=TOOL_CALL_ID_MISSING,
                    ),
                ),
            )
        return ToolHop(task=asyncio.ensure_future(self._hop(call)), outcome=None)

    async def execute(self, call: ToolCallRequest) -> ToolOutcome:
        """Start and await one hop; convenience for a caller that is not streaming."""
        return await self.start(call).outcome()

    # -- the hop ----------------------------------------------------------

    async def _hop(self, call: ToolCallRequest) -> ToolOutcome:
        request = self.request_for(call)
        secret = self._resolve_secret()
        timeout_ms = self.timeout_ms()
        session_factory = self._session_factory or _aiohttp_session()
        try:
            payload = await asyncio.wait_for(
                self._exchange(
                    request,
                    secret=secret,
                    timeout_ms=timeout_ms,
                    session_factory=session_factory,
                ),
                timeout=timeout_ms / 1000.0,
            )
        except asyncio.TimeoutError as error:
            raise ToolTimeout(call.name, self._call_id, timeout_ms) from error
        return ToolResult(
            name=call.name, tool_call_id=call.call_id, payload=payload
        )

    async def _exchange(
        self,
        request: ToolRequest,
        *,
        secret: str,
        timeout_ms: float,
        session_factory: Any,
    ) -> Mapping[str, Any]:
        """One POST, read to the end; the status and body are all we may learn."""
        session = session_factory(timeout_s=timeout_ms / 1000.0)
        async with session as active:
            async with active.post(
                request.url(self._base_url),
                headers=request.headers(secret),
                json=request.body(),
            ) as response:
                status = response.status
                chunks = [chunk async for chunk in response.iter_bytes()]
        if status < 200 or status >= 300:
            raise ToolRouteError(
                request.name, self._call_id, f"the route answered HTTP {status}"
            )
        return _payload(request.name, self._call_id, b"".join(chunks))

    def _resolve_secret(self) -> str:
        secret = self._secret
        if secret is None:
            secret = os.environ.get(TOOL_SECRET_ENV, "")
        if not isinstance(secret, str) or not secret.strip():
            raise ToolSecretError()
        return secret


def _payload(name: str, call_id: str, body: bytes) -> Mapping[str, Any]:
    """The route's JSON object, or a named unreadable-body failure."""
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ToolRouteError(
            name, call_id, f"the route body is not readable JSON ({error})"
        ) from error
    if not isinstance(value, dict):
        raise ToolRouteError(
            name, call_id, f"the route body is a JSON {type(value).__name__}, not an object"
        )
    return value


def _aiohttp_session() -> Any:
    """The one HTTP adapter the cascade already has; a shared module is later."""
    from cascade.meta_llm import _AiohttpSession

    return _AiohttpSession


async def continue_after_tool(
    *,
    llm: Any,
    history: Any,
    turn: MetaLLMTurn,
    outcome: ToolOutcome,
    tools: list[dict[str, Any]] | None = None,
    record: MetaLLMTurn | None = None,
    ledger: TimingLedger | None = None,
) -> AsyncIterator[TokenDelta | ToolCallRequest]:
    """Continue the same logical turn with a new model request, or nothing.

    A :class:`ToolResult` is recorded with the assistant message that asked for
    it and the next request sees both, which is the only shape the vendor
    accepts. A :class:`DeniedCall` closes the turn instead: its denial is
    recorded on the turn (once — the LLM layer may already have recorded it when
    it emitted the identity-less request) and a hold line is owed (ticket 85),
    but no request is made, because a ``tool`` message cannot answer a call the
    vendor never identified. An :class:`EndCallSignal` yields no event at all:
    end call is call control, so nothing speakable follows it.
    """
    if isinstance(outcome, EndCallSignal):
        return
    if isinstance(outcome, DeniedCall):
        _record_denial(turn, outcome.denial, ledger=ledger)
        turn.hold_line_required = True
        return
    if len(turn.tool_calls) != 1:
        raise ToolTurnError(len(turn.tool_calls))
    history.append_tool_turn(turn, [outcome.tool_message()])
    kwargs: dict[str, Any] = {}
    if record is not None:
        kwargs["turn"] = record
    async for event in llm.complete(
        messages=history.request_messages(), tools=tools, **kwargs
    ):
        yield event


def _record_denial(
    turn: MetaLLMTurn, denial: ToolDenial, *, ledger: TimingLedger | None = None
) -> None:
    """Record a denial once, counting it when this call is the first to see it.

    Identity is ``(name, call_id, code)``, never the prose: the LLM layer and
    the tool layer describe the same denial in their own words, and counting the
    same refusal twice would overstate how often the model was denied.
    """
    identity = (denial.name, denial.call_id, denial.code)
    if any(
        (recorded.name, recorded.call_id, recorded.code) == identity
        for recorded in turn.denied_tool_calls
    ):
        return
    turn.denied_tool_calls.append(denial)
    if ledger is not None:
        ledger.count(TOOL_DENIED_COUNTER)

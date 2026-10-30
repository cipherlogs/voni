"""voice-pipeline service: browser WebSocket <-> cascade orchestrator.

Run from this directory with the bridge venv:
    ../telephony-bot/.venv/bin/python server.py
    ../telephony-bot/.venv/bin/python -m uvicorn server:app --port 8766

Env (host-provided, never committed):
    ASSEMBLYAI_API_KEY, AI_GATEWAY_API_KEY, CARTESIA_API_KEY,
    VOICE_PIPELINE_PORT (default 8766),
    VOICE_PIPELINE_ENVELOPE_SECRET (the signed-body envelope secret; absent
    means the stored-body channel is closed and no call is served),
    DATABASE_URL (the shared durable store; absent means /readyz fails closed
    and no new call is accepted).

Routes:
    GET /healthz            liveness probe, no vendors, store or key touched;
                            reports the protocol version this service speaks.
    GET /readyz             readiness: durable store, daily counter and breaker
                            readable, not draining, protocol version; 503 when
                            any of them is unknown. Never probes a vendor.
    POST /v1/call-body      the app -> service channel (ticket 65): the app
                            delivers the signed stored body for a call token.
                            Ticket 64's envelope and body hash are verified
                            here, before any browser socket exists.
    WS  /v1/browser-call    one cascade call per socket; the browser's config
                            names only its call token, agent id and protocol
                            version (see transport.py).

The stored body is held in-process, which is the M1 foundation seam: the
deployment's token-verifying / durable store (M17) replaces it behind the same
``deliver``/``claim`` pair.

Every log record is scrubbed before it is written (ticket 137): the call token,
the vendor keys, the tool secret, the signing secret and the database URL never
reach an access log, an error log or a crash dump, and a vendor handshake body
is replaced whole rather than kept.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse

from cascade.breaker import Breaker
from cascade.counter import DailyCounter
from cascade.envelope import EnvelopeError
from cascade.health import DrainState, readiness
from cascade.log_redaction import install_log_redaction
from cascade.pg_store import PostgresStore
from cascade.token import (
    PROTOCOL_VERSION,
    CallTokenRegistry,
    ClientConfigError,
    StoredBodyChannel,
)
from transport import handle_browser_call

SERVICE_NAME = "voice-pipeline"

#: The signed-body message's own field names; the app may say nothing else.
CALL_BODY_FIELDS = ("call_token", "call_id", "signed_body")


def create_app(
    *,
    envelope_secret: str | bytes | None = None,
    clock: Callable[[], float] = time.time,
    call_tokens: CallTokenRegistry | None = None,
    store: Any = None,
    counter: Any = None,
    breaker: Any = None,
    drain: DrainState | None = None,
) -> FastAPI:
    # Ticket 137: every record — uvicorn access, error, crash dump — is
    # scrubbed before a handler can write it. The call token in the socket
    # query string and the vendor key inside the handshake body never land.
    install_log_redaction()

    app = FastAPI(title="Voni cascade voice pipeline")

    secret = (
        envelope_secret
        if envelope_secret is not None
        else os.environ.get("VOICE_PIPELINE_ENVELOPE_SECRET", "")
    )
    # No secret means no channel: the browser path refuses by name rather
    # than ever trusting a body that reached it unverified.
    body_channel = StoredBodyChannel(secret=secret, clock=clock) if secret else None
    app.state.stored_bodies = body_channel
    # One signing secret, one signature construction (ticket 64), used for the
    # signed body envelope and for the short-TTL call token (ticket 136); the
    # token's own ``kind`` claim keeps the two domains apart.
    token_registry = (
        call_tokens
        if call_tokens is not None
        else (CallTokenRegistry(secret=secret, clock=clock) if secret else None)
    )
    app.state.call_tokens = token_registry

    # Ticket 139: readiness dependencies. The durable store is the Fly
    # Postgres attachment (ticket 135); a missing DATABASE_URL or an unset
    # budget bound is recorded here and fails readiness closed rather than
    # stopping the process (liveness stays honest and live calls continue).
    configuration_errors: dict[str, str] = {}
    if store is None:
        dsn = os.environ.get("DATABASE_URL", "").strip()
        if dsn:
            try:
                store = PostgresStore(dsn)
            except ValueError as exc:
                configuration_errors["store"] = str(exc)
        else:
            configuration_errors["store"] = (
                "no durable store configured; set DATABASE_URL in the service "
                "host's environment"
            )
    if store is not None:
        if counter is None:
            try:
                counter = DailyCounter(store, now=clock)
            except Exception as exc:
                configuration_errors["counter"] = (
                    f"{type(exc).__name__}: {exc}"
                )
        if breaker is None:
            try:
                breaker = Breaker.from_registry(store, now=clock)
            except Exception as exc:
                configuration_errors["breaker"] = (
                    f"{type(exc).__name__}: {exc}"
                )
    drain_state = drain if drain is not None else DrainState()
    app.state.store = store
    app.state.counter = counter
    app.state.breaker = breaker
    app.state.drain = drain_state
    app.state.readiness_errors = configuration_errors

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        """Liveness: the process is up. No store, vendor or key is touched."""
        return {
            "status": "ok",
            "service": SERVICE_NAME,
            "protocolVersion": PROTOCOL_VERSION,
        }

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        """Readiness: this instance may take a new call right now."""
        report = await readiness(
            drain=drain_state,
            store=store,
            counter=counter,
            breaker=breaker,
            configuration_errors=configuration_errors,
        )
        return JSONResponse(
            status_code=200 if report.ready else 503,
            content=report.to_document(),
        )

    @app.post("/v1/call-body", status_code=202)
    async def call_body(request: Request) -> dict[str, Any]:
        # A draining instance finishes live calls; it starts none.
        if drain_state.draining:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"the service is draining ({drain_state.reason}) and "
                    "accepts no new call; live calls continue"
                ),
            )
        if body_channel is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "the signed-body channel is closed: set "
                    "VOICE_PIPELINE_ENVELOPE_SECRET in the service host's "
                    "environment so a delivered body can be verified"
                ),
            )
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="call body must be JSON")
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=400,
                detail=f"call body must be an object, got {type(payload).__name__}",
            )

        unknown = sorted(set(payload) - set(CALL_BODY_FIELDS))
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f'unknown call body field "{unknown[0]}"',
            )
        missing = [field for field in CALL_BODY_FIELDS if field not in payload]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f'call body field "{missing[0]}" is missing',
            )

        try:
            verified = body_channel.deliver(
                call_token=payload["call_token"],
                call_id=payload["call_id"],
                message=payload["signed_body"],
            )
        except (EnvelopeError, ClientConfigError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        return {
            "status": "accepted",
            "call_id": verified.call_id,
            "agent_id": verified.agent_id,
            "body_hash": verified.body_hash,
        }

    @app.websocket("/v1/browser-call")
    async def browser_call(websocket: WebSocket) -> None:
        await websocket.accept()
        if drain_state.draining:
            # Named, so the app shows the truth instead of a dropped socket.
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "draining",
                    "message": (
                        f"the service is draining ({drain_state.reason}) and "
                        "accepts no new call; live calls continue"
                    ),
                }
            )
            await websocket.close()
            return
        await handle_browser_call(
            websocket,
            body_channel=body_channel,
            call_tokens=token_registry,
        )

    return app


app = create_app()


def main() -> None:
    import uvicorn

    # NOTE: uvloop is installed in the service venv but the asyncio loop is
    # pinned until the hung-second-request fault under uvloop is root-caused
    # (see smoke investigation: prefetch adoption stalls on uvloop only).
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("VOICE_PIPELINE_PORT", "8766")),
        loop="asyncio",
    )


if __name__ == "__main__":
    main()

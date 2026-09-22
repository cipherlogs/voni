"""voice-pipeline service: browser WebSocket <-> cascade orchestrator.

Run from this directory with the bridge venv:
    ../telephony-bot/.venv/bin/python server.py
    ../telephony-bot/.venv/bin/python -m uvicorn server:app --port 8766

Env (host-provided, never committed):
    ASSEMBLYAI_API_KEY, AI_GATEWAY_API_KEY, CARTESIA_API_KEY,
    VOICE_PIPELINE_PORT (default 8766).

Routes:
    GET /healthz            liveness probe, no vendors touched.
    WS  /v1/browser-call    one cascade call per socket (see transport.py
                            for the JSON protocol).
"""

from __future__ import annotations

import os

from fastapi import FastAPI, WebSocket

from transport import handle_browser_call

SERVICE_NAME = "voice-pipeline"


def create_app() -> FastAPI:
    app = FastAPI(title="Voni cascade voice pipeline")

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": SERVICE_NAME}

    @app.websocket("/v1/browser-call")
    async def browser_call(websocket: WebSocket) -> None:
        await websocket.accept()
        await handle_browser_call(websocket)

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

# syntax=docker/dockerfile:1
#
# The cascade voice service (M17, ticket 135): one container, one process.
#
# Build from the repository root, because the service imports one bridge module
# for judge parity:
#
#   docker build -f voice-pipeline/Dockerfile -t voni-voice-pipeline .
#
# The `voni` app is a different image and a different Fly app
# (deploy/fly.voni.toml); nothing of the app is copied here.
#
# Python 3.13 is the version the Python CI job installs (`uv venv --python
# 3.13`), so the image runs the interpreter combination the test suite proved.
FROM python:3.13-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VOICE_PIPELINE_PORT=8766 \
    VOICE_PIPELINE_EVENTS_DIR=/var/lib/voni/events \
    VONI_SCOREBOARD_BUDGETS_JSON=/srv/scoreboard-budgets.json

WORKDIR /srv

# Runtime pins only; the image must not carry the bridge server's stack.
COPY voice-pipeline/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# The cascade thresholds registry resolves the frozen budget record and refuses
# to import without it. Copy that one JSON file (not the app) and point the
# documented override at it: the budgets stay single-source, and the image does
# not carry a Next app.
COPY voni/src/lib/demo/scoreboard-budgets.json /srv/scoreboard-budgets.json

# The service, plus the one module the judge parity bridge imports. No
# telephony-bot server, no Node, no app.
COPY voice-pipeline/ /srv/voice-pipeline/
COPY telephony-bot/voice_judge.py /srv/telephony-bot/voice_judge.py

# Not root: the service reads sockets, and a call's operational-event artifact
# (VOICE_PIPELINE_EVENTS_DIR) is a best-effort record under a directory this
# user owns. The directory is created here, before the uid switch, so the
# container never tries to mkdir it at call time inside /srv.
RUN useradd --create-home --user-group --uid 10001 voni \
    && mkdir -p /var/lib/voni/events \
    && chown -R voni:voni /var/lib/voni
USER 10001

WORKDIR /srv/voice-pipeline

EXPOSE 8766

# One worker on the asyncio loop. The command runs ``main()``, which installs
# the SIGTERM drain supervisor and disables uvicorn's default handler;
# ``uvicorn server:app`` would skip the drain and end a live call. uvloop stays
# pinned off in server.py (the prefetch adoption stall) and is not installed
# here anyway. A call is one WebSocket on this process for its whole life; the
# two Fly machines, not two workers in one container, are the two instances.
CMD ["python", "server.py"]

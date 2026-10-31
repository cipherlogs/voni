# voice-pipeline — the cascade service

One WebSocket per browser call. The shipped cascade is **Meta streaming STT →
Meta Muse Spark → AssemblyAI streaming TTS**, with the call body delivered over
a separately signed channel. Floor arbitration, prefetch and sentence-by-
sentence synthesis let the caller take the floor and start audio while the
model is still generating.

The demo call is this service's only client. Tenant agent calls and test calls
stay on the managed path in the app; the cascade serves the demo alone.

## The three legs

| Leg | Module | What ships |
| --- | --- | --- |
| STT | `cascade/meta_stt.py` | Meta streaming speech, biased with the body's `keyterms`; partials drive the turn window and prefetch. |
| LLM | `cascade/meta_llm.py` | Meta Muse Spark on the Standard rung (`muse-spark-1.3`, `VOICE_PIPELINE_LLM_MODEL` overrides it). A body `llm` entry constructs the tenant's own OpenAI-compatible client instead; the Meta key is never substituted for it. |
| TTS | `cascade/assemblyai_tts.py` | AssemblyAI streaming synthesis. The voice's Locale comes from `cascade/voice_binding.py`, the only synthesis-language authority; an unbound voice is refused by name before the first frame. |

`transport.py` builds the legs (`build_cascade_legs`), `cascade/call.py` owns
the call lifecycle, `cascade/turn_stream.py` the turn, `cascade/tools.py` the
server-side tools (`end_call` stays an in-process signal), `cascade/events.py`
the trace artifact and `cascade/cost.py` the price of the call.

## The demo

- Five voices, one per Locale: `audrey` (en), `malvina` (es), `donatien` (fr),
  `jorg` (de), `benicio` (pt). English is the default.
- The subject is `demo:<voice>`. The envelope carries it as `agent_id` (v2,
  `kind: "demo"`), the call token carries it as `subject`, and the browser sends
  it as `agentId`; the transport refuses any disagreement.
- `routing=demo` is the demo's production value. The durable switch row
  `routing:switch` is the one authority and is read once per call: `routing=off`
  refuses every new call, opens zero vendor sessions and is the kill switch.
  There is no managed fallback from this service.
- Flip and audit the switch with `scripts/routing_switch.py` (see its
  docstring: `show`, then `set --mode off|demo|all --operator … --reason …`).

## The signed channel

The app assembles the body, signs it and mints a single-use call token; the
service verifies both before it reads a single setting.

```
POST /v1/call-body        app → service
  {"call_token": "ct1.…", "call_id": "…", "signed_body": {"envelope": {…}, "body": {…}}}
  202 {"status": "accepted", "call_id": …, "agent_id": …, "body_hash": …}

WS /v1/browser-call       browser → service
  first frame: {"type":"config","protocolVersion":1,"agentId":"demo:<voice>","callToken":"ct1.…"}
  then:        {"type":"audio","data": base64 pcm16 24 kHz}, {"type":"context",
               "role":"system","content":…} (hidden context, never captioned),
               {"type":"stop"}
```

- One HMAC secret, `VOICE_PIPELINE_ENVELOPE_SECRET`, on both sides. It signs the
  v2 envelope (`cascade/envelope.py`) and the `ct1` call token (`cascade/token.py`);
  there is no default and no second signing name.
- The body hash binds the delivered body, the envelope binds the call and the
  agent, and the token is single-use: one token, one body, one socket.
- `envelope.ttl_ms` and `call_token.ttl_ms` are both 60 000 ms
  (`cascade/thresholds.json`); a hold return delivers a fresh body and token for
  the same call id with the greeting suppressed.
- Refusals are typed (`EnvelopeError`, `ClientConfigError`, `CallTokenError`) and
  reach the caller by name; a refused connect opens no vendor session.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /healthz` | liveness; touches no store, vendor or key |
| `GET /readyz` | drain, store, counter and breaker readiness (200/503) |
| `POST /v1/call-body` | accept a signed body (202) or refuse it by name (400/503) |
| `WS /v1/browser-call` | one cascade call per socket, identity-only config frame |

## Running it

The service is `python server.py` from this directory — never
`uvicorn server:app`, because the drain handler lives in `main()`.

```
# Runtime deps (a container installs requirements.txt; CI adds requirements-ci.txt).
python -m pip install -r requirements.txt

# Dev launcher: loads ../voni/.env.local and serves :8766.
sh scripts/local_server.sh
```

## Real legs (key-gated)

The old manual smoke script is gone: its wire shape predated the call token
and the signed body, so it could not start a call this service accepts. The
real check is the app's own command, which builds the body with the app's body
builder and signs it with the app's envelope and call-token signers:

```
cd voni
# deployed
npm run check:real-legs -- --base-url https://pipeline.example.com
# local (dev:cascade's plain internal port)
npm run check:real-legs -- --base-url http://127.0.0.1:8767
```

It plays the committed caller clip twice, through the real vendors, and asserts
the captions, the received audio frames, the trace artifact at
`VOICE_PIPELINE_EVENTS_DIR`/`voice-pipeline/.events` and the `cost.priced` row.
After the two turns it sends the demo's off-track note as a hidden context
frame (asserting it is never captioned) and, by default, proves the hold return
end to end: the same call id is re-minted with `resume: true` and the carried
history, no greeting is spoken, a caller clip gets a continuation, and the
call leaves one trace file. An unmeasured cost row is reported as `INFO`, never
`PASS`. `--no-resume` skips the hold-return phase.
It needs `META_API_KEY`, `ASSEMBLYAI_API_KEY` and the shared
`VOICE_PIPELINE_ENVELOPE_SECRET`; without the two vendor keys it prints
`skipped: META_API_KEY and ASSEMBLYAI_API_KEY are required for the real legs`
and exits 0. It is never run by the pull-request workflow: CI runs its unit
tests and no vendor key exists there.

Tests are stdlib `unittest` and are run from this directory. The telephony-bot
venv is the bridge judge the parity tests import:

```
../telephony-bot/.venv/bin/python -m unittest discover -s . -p "test_*.py"
```

The CI-equivalent wrapper (both suites, fails on an unexpected skip) is run
from the repo root:

```
PYTHON=telephony-bot/.venv/bin/python bash scripts/python-tests.sh
```

## Environment

Every value is read at runtime from the host environment (the image sets only
the artifact-directory default). Secrets are names only in
`deploy/voice-pipeline.env.example`.

| Name | Required | Meaning |
| --- | --- | --- |
| `VOICE_PIPELINE_ENVELOPE_SECRET` | yes | envelope + call-token HMAC key; absent ⇒ `/v1/call-body` 503 and browser calls refused |
| `DATABASE_URL` | yes | Postgres DSN for the routing switch, daily counter and breaker; absent ⇒ readiness fails closed |
| `META_API_KEY` | yes | Meta STT and the default Spark rung |
| `META_REASONING_EFFORT` | yes | the measured Spark effort; Spark refuses construction without it |
| `META_IDENTIFIER_SALT` | yes | salts the stable internal id sent to Meta; never leaves the service |
| `ASSEMBLYAI_API_KEY` | yes | the TTS leg |
| `VOICE_PIPELINE_TOOL_BASE_URL` | yes | the app origin for `/api/tools/<name>`; empty ⇒ no tool executor and tool calls are dropped |
| `VONI_TOOL_SECRET` | yes | bearer for the app's tool route |
| `VOICE_PIPELINE_PORT` | no | listen port, 8766 |
| `VOICE_PIPELINE_EVENTS_DIR` | no | trace artifact directory (`/var/lib/voni/events` in the image) |
| `VOICE_PIPELINE_LLM_MODEL` | no | Standard-rung model id, `muse-spark-1.3` |
| `VOICE_PIPELINE_BUILD_VERSION`, `FLY_IMAGE_REF` | no | build report on `/healthz` |

The host is the Northflank shape: one service, one instance, a Postgres addon,
one volume, port 8766, a 30-second drain. See `deploy/northflank/README.md`.

## Trace and cost

- One JSONL trace per call id in `VOICE_PIPELINE_EVENTS_DIR` (default
  `.events/`, gitignored). Every call-scoped line names its subject
  (`demo:<voice>`), so a reader knows which voice produced it; the end message
  cites the path (`eventsPath`) or why it is missing (`eventsError`).
- Every call is priced from `cascade/rates/v1.json`. A leg with no measured unit
  or no rate is `measured: false` with a named reason — never `0`. The end
  message carries the per-leg cost, the rate-table version and the total.
- The demo's evidence reads: `scoreboard:demo --pipeline cascade
  --ledger <end-message.json>` (from `voni/`) writes the cascade artifact, and
  `readiness:pack` accepts cascade artifacts only. The managed scoreboard reads
  the platform stored-agent body instead; see `docs/agents/demo-scoreboard.md`
  for which claims come from which body.

## Scoreboard (managed vs cascade, same definitions both sides)

- `audio_in_to_first_partial` — screen latency
- `final_to_first_token` — think start
- `final_to_first_playout` / `floor_take_to_first_playout` — reply gap
- counts: `backchannel`, `yield`, `interruption`, `prefetch_*`, `tool_denied`, `end_call`, `overheard` (partials heard while the agent held the floor, whether or not they took it)

Routing today is the durable switch described above, not per-call
`fallback_mode`; `config.py` is the old per-call schema and is not read by
`server.py`.

## Layout (the parts you will open first)

- `cascade/envelope.py`, `cascade/token.py` — the signed body and the call token.
- `cascade/routing.py`, `cascade/admission.py` — the one routing decision and the
  only place it becomes a socket.
- `cascade/call.py`, `cascade/turn_stream.py` — lifecycle, turns, greeting, drain.
- `cascade/voice_binding.py` — voice → Locale, the only synthesis-language authority.
- `cascade/events.py`, `cascade/cost.py`, `cascade/usage.py` — trace and price.
- `providers.py` — the `StreamingSTT` / `LLMStream` / `StreamingTTS` contracts and
  event types (no vendor SDKs).
- `turns.py` — floor arbitration (`take_floor` / `wait` / `backchannel`), fail-closed.
- `metrics.py` — `TimingLedger`, the A/B scoreboard.
- `config.py` — the old per-call pipeline config schema; not the service config.

## Historical: the earlier gateway/Cartesia slice

Earlier revisions of this file described an initial browser slice (AssemblyAI
speech-to-text, an AI Gateway model, Cartesia synthesis) with a scripted smoke
call and its measured baselines. That slice was replaced by the Meta/AssemblyAI
cascade above; none of its vendor settings or scripts are read by this service,
and any remaining mention belongs to the historical record, not the runtime.

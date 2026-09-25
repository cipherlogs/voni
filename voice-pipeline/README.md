# voice-pipeline (P0: contracts)

Cascade voice pipeline: streaming STT → speculative LLM → streaming TTS, one
pipeline core with two transports (browser WS @ 24 kHz PCM, Telnyx WS @ 8 kHz
mu-law). Replaces turn-based waiting with early commit: partials drive
prefetch, the commit gate fires the LLM the moment intent is complete, tokens
stream to TTS per sentence so audio starts while the LLM still generates.

## Why this exists

The managed AssemblyAI agent only thinks after end-of-turn silence, so every
reply pays VAD wait + full think + full TTS render before the first sound. A
cascade overlaps all three. The previous cascade was removed for cost (2
req/min on an unfunded LLM leg), not latency — the gateway key funds the LLM
leg now, which is why this is back.

## Layout

- `providers.py` — `StreamingSTT` / `LLMStream` / `StreamingTTS` contracts plus
  event types. No vendor SDKs here.
- `turns.py` — turn commit gate (`commit` / `wait` / `backchannel`),
  fail-closed. Backchannel wording mirrors `telephony-bot/voice_judge.py` and
  `voni` jev-judges.ts; parity is tested, not assumed.
- `metrics.py` — `TimingLedger`: the A/B scoreboard.
- `config.py` — per-call pipeline config with validation.

## Scoreboard (managed vs cascade, same definitions both sides)

- `audio_in_to_first_partial` — screen latency
- `final_to_first_token` — think start
- `final_to_first_playout` / `commit_to_first_playout` — reply gap
- counts: `backchannel`, `yield`, `interruption`, `prefetch_*`, `tool_denied`, `end_call`, `overheard` (partials heard while the agent held the floor, committed or not)

## Safety invariant

`fallback_mode` defaults to `"managed"`. A call routes at this pipeline only
on explicit `"cascade"`. The managed path stays live until the cascade beats
it on all three gap metrics for two consecutive test rounds.

## Phases

- P0 (here): contracts, commit gate, metric rig, config schema.
- P1: browser vertical slice — AssemblyAI STT, gateway LLM, Cartesia TTS.
- P2: PSTN adapter (8 kHz, recording/timeline parity).
- P3: Deepgram backend + admin provider UI.

## Running tests

Pipeline tests import the bridge judge for parity, so run them with the
bridge venv (stdlib-only otherwise):

```
../telephony-bot/.venv/bin/python -m unittest discover -s . -p "test_*.py"
```

## Running the service (P1 talking slice)

```
sh scripts/local_server.sh   # dev only: loads ../voni/.dev.vars, serves :8766
```

- `GET /healthz` — liveness, no vendors touched.
- `WS /v1/browser-call` — one cascade call per socket; protocol in
  `transport.py`. Browser sends a `context` message after `config` for hidden
  system context (`role: "system"`, `content`); the server appends it to
  orchestrator history for the next turn, never emits it as a caption, and
  never interrupts current audio. Requires `ASSEMBLYAI_API_KEY`, `AI_GATEWAY_API_KEY`,
  `CARTESIA_API_KEY` in host env (production runs with real host env,
  never this script).
- `scripts/smoke_call.py` — end-to-end dev check: streams a voice sample
  through STT → LLM → TTS over the wire and prints captions, audio stats,
  and ledger gaps. Needs no arguments with the dev launcher running.

Measured P1 baselines (2.4s sample, qwen3.5-flash, sonic-2): screen latency
~0.8s, think ~5s, reply gap ~7s. The think leg dominates — a faster gateway
model is the biggest remaining lever.

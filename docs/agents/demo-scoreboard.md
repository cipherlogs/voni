# Demo scoreboard, eval, and gates

Read this before exploring or changing the demo-call loop. It maps the seam,
the evidence producers, and the live-run rules so you do not have to re-read
six large files.

## The seam

```
npm run scoreboard:demo
  scripts/score-demo.mts            orchestrator: runs scenarios, merges evidence, writes one artifact
    scripts/eval-demo-agent.mts     real-audio runner (stored demo agent by default)
    scripts/call-trace.mts          merges one session's events into HEARD/VONI/CUT/gap rows
  src/lib/demo/scoreboard.ts        pure gates, artifact build, diff, streak, matrix
  voni/scoreboard-runs/*.json       gitignored artifacts (one per run)
```

- `score-demo` is the only command that writes a scoreboard artifact.
- `scoreboard:matrix` replays per-voice regression from artifacts; it never
  re-evaluates the gate artifact.
- `scoreboard:streak` reads the last artifacts and checks a code fingerprint;
  it never runs audio itself.
- `scoreboard:inspect` prints a compact artifact/report (use it instead of
  dumping raw JSON). For machine-readable output, pipe
  `npm run --silent scoreboard:inspect -- --artifact <path> --json`.

## File map

| File | Owns |
| --- | --- |
| `voni/scripts/score-demo.mts` | scenario suite, per-scenario evidence routing, artifact write, console table, prior-artifact diff, timing lock |
| `voni/scripts/eval-demo-agent.mts` | live client scenarios, fake playout/timeline, `EVAL SUMMARY`, optional `--events` JSONL |
| `voni/scripts/call-trace.mts` | Call trace rows, `gap Nms`, `CUT at`, `HEARD`, barge-in verdict |
| `voni/src/lib/demo/scoreboard.ts` | gate functions, artifact shape, format/diff/streak/matrix, budget wiring |
| `voni/src/lib/demo/scoreboard-budgets.ts` | frozen budget table; the single source for gate thresholds |
| `voni/src/lib/voice/session.ts` | live session: adaptive end-of-turn, barge-in, end-call drain |
| `voni/src/lib/demo/stored-agents.ts` | stored demo agent body, fingerprint, LLM override, provision/refresh |
| `voni/src/lib/demo/voni-agent.ts` | demo prompt rules, greeting, check-in/end instructions |
| `voni/src/lib/demo/scoreboard-report.ts` | compact inspect/report formatters |
| `voni/src/lib/demo/turn-marks.ts` | client receipt marks (`turn.user_final`, `turn.reply_start`, first-audio anchor) for the split |
| `voni/src/lib/demo/latency-split.ts` | per-turn endpointing/generation/delivery arithmetic, ordinary vs post-cut |
| `voni/src/lib/demo/playout-preroll.ts` | the fixed playback pre-roll constant (report-only `perceived`, never a gate input) |
| `voni/src/lib/demo/turn-windows.ts` | one formatter for turn-window evidence (gate detail + inspect report) |
| `voni/src/lib/voice/silent-greeting.ts` | one silent-greeting session: the line as the greeting, native level (caller clips + reference capture) |
| `voni/src/lib/demo/reference-render.ts` | reference cache (voice + text), PCM WAV writer, default line = the voice's greeting |
| `voni/scripts/render-reference.mts` | `npm run voice:reference`: render one line in one voice outside a conversation (W0) |
| `docs/demo-latency-ladder.md` | turn-window experiment rulebook, stop rule, and ledger (not a gate or budget owner) |

Evidence flow: runner stdout -> parsers in `score-demo` -> gate inputs in
`scoreboard.ts` -> `artifact.gates` + `runnerEvidence`/`callTrace`. Gate
detail strings are the audit trail; a FAIL must name its session/turn.

## Gate -> producer -> artifact

| Gate | Producer | Artifact |
| --- | --- | --- |
| plumbing | `classifyRunnerOutcome` | `evalRunner.status/breakReason` |
| measurements | `hasMeasuredEvidence` | `gates`, `runnerEvidence` |
| reply-gap | Call trace gaps / `--gap` | `replyGap`, `beats.*.gapSamples`, `callTrace` |
| end-of-turn | stored body + trace CONFIG scan | `gates` detail |
| greeting-cut | greeting-cut scenario | `beats["greeting-cut"].cutMs` |
| barge-in-cut | stop-over / hang-up-over | `beats["real-cut-answered"]`, `runnerEvidence` |
| filler-resume | filler-over line | `beats["filler-ignored"]` |
| overheard-recall | over-talk trace + `OVERHEARD ASIDE` | `overheard` |
| email-invite | invite-tag / `--email-json` | `emailInvite` |
| double-talk | over-talk `DOUBLE TALK` | `doubleTalk` |
| dead-air | silence-check-in `SILENCE TIMELINE` | `deadAir` |
| end-call-drain | bye-audio + both hang-up scenarios | `endCallDrain` |
| timbre-probes | `--probe-json` / session evidence | `probes`, `loudness` |
| accent-human | `--rate` + `--recording` | `humanRatings`, `humanReview` |
| phone-checklist, talk-hold-pinned | manual/external | informational rows only |

Thresholds live only in `scoreboard-budgets.ts` and its JSON record. Do not
edit a budget to pass; fix the call or amend the spec first.

## Reference capture (W0)

`npm run voice:reference -- --voice lola` renders one line in one voice
outside a conversation. It reuses the silent-greeting session the runner uses
for caller clips: a session told to stay silent, with the line as its greeting,
so no model is in the audio. The cache key is voice + text under
`voni/.voice-references/` (gitignored), and the file is a PCM WAV at the
voice's native level — no client gain, no limiter, no normalisation. The
default line is that voice's own greeting, in its own Locale; `--text` renders
another sentence so a mid-call defect is attributed to the text rather than the
greeting.

## Live-run rules

- Run live timing scenarios **one at a time**; `score-demo` takes
  `/tmp/voni-demo-timing.lock`. Parallel live runs inflate cut/reply numbers.
- `npm run scoreboard:demo` defaults to the full 9-scenario suite; use
  `--scenario <name>` for focused triage. A dry run spawns nothing.
- Live runs need `voni/.dev.vars` (AssemblyAI + AI Gateway keys) and, for the
  stored path, `DATABASE_URL` (Neon) so the demo agent can be provisioned.
- Artifacts are gitignored working files. Use `scoreboard:inspect`; do not
  paste raw artifacts or `SILENCE TIMELINE` blobs into a report.
- `--transport stored` is the landing-demo path. `--transport inline` is for
  debugging the inline body only; do not measure the demo on it.
- Every measurement run records the live decision timeline
  (`turn.user_final`, `turn.reply_start`, first audio with the one
  `anchor: true` clock mark, `reply.create`, cut, tool, drain, aside,
  hangup) by default, so the artifact always carries the per-turn split. It
  writes `voni/scoreboard-runs/.events/<artifact stem>/<scenario>.jsonl`
  (gitignored, one file per scenario). `--events /tmp/run.jsonl` overrides
  the location (focused: that file; suite: `/tmp/run.<scenario>.jsonl`), and
  `--no-events` restores the old no-stream debug path. A stream that cannot
  be written or read is a warning, never a gate failure.
  `scoreboard:inspect --events` summarizes one file.

## Fast LLM override

The stored demo agent uses an OpenAI-compatible gateway when
`AI_GATEWAY_API_KEY` exists:

```
llm: [{ base_url, model, api_key, reasoning_effort? }]   // max 1 entry
```

Defaults are in `stored-agents.ts` (`AI_GATEWAY_API_KEY`, optional
`DEMO_LLM_BASE_URL`, `DEMO_LLM_MODEL`, `DEMO_LLM_REASONING_EFFORT`). The key is
write-only on the agent, never returned to the browser. Remove the key or send
`llm: []` to revert to the managed model. The body is hashed into
`demoAgentFingerprint`, so a model change refreshes the cached agent.

## Reviewing gate changes

Use `CODING_STANDARDS.md` at the repo root for the judgement rules (one gate
owns one section, evidence provenance, turn citations, threshold single-source).
Mechanical parts are tests: budget freeze, shared artifact validation, report
formatters.

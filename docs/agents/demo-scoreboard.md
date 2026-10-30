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
- `scoreboard:kill -- --from <rounds-root>` judges the ticket-119 kill
  criterion over measured rounds (one subdirectory per round, or a flat
  directory as one round); only `OK` exits zero, and a dated risk acceptance is
  `RISK-ACCEPTED`, never a pass.
- `scoreboard:inspect` prints a compact artifact/report (use it instead of
  dumping raw JSON). For machine-readable output, pipe
  `npm run --silent scoreboard:inspect -- --artifact <path> --json`.

## File map

| File | Owns |
| --- | --- |
| `voni/scripts/score-demo.mts` | scenario suite, per-scenario evidence routing, artifact write, console table, prior-artifact diff, timing lock |
| `voni/scripts/score-kill.mts` | ticket-119 kill gate: reads round artifacts, prints OK/BLOCKED/KILLED/RISK-ACCEPTED/INCOMPLETE |
| `voni/src/lib/demo/kill-criterion.ts` | small-sample verdicts, measured rounds, the kill criterion and the dated risk acceptance |
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
| `voni/src/lib/demo/gate-producers.ts` | the one gate → producer-scenario table, its coverage assertion, and the startup summary |
| `voni/scripts/render-reference.mts` | `npm run voice:reference`: render one line in one voice outside a conversation (W0) |
| `voni/src/lib/audio/vendor-floor.ts` | committed vendor floor loader: provenance sidecar + PCM16 WAV, named refusals, no empty floor (W0) |
| `voni/scripts/capture-vendor-floor.mts` | `npm run voice:vendor-floor`: capture or register the vendor floor, committed as evidence (W0) |
| `docs/demo-latency-ladder.md` | turn-window experiment rulebook, stop rule, and ledger (not a gate or budget owner) |

Evidence flow: runner stdout -> parsers in `score-demo` -> gate inputs in
`scoreboard.ts` -> `artifact.gates` + `runnerEvidence`/`callTrace`. Gate
detail strings are the audit trail; a FAIL must name its session/turn.

## Gate -> producer -> artifact

`voni/src/lib/demo/gate-producers.ts` is the single source for the scenario
producers below; `score-demo` reads it at startup (before the timing lock) and
fails when a gate's producer is not in the default suite, so a gate cannot
report INFO forever on evidence nobody runs. Gates with no scenario producer
declare why there (`run`, `operator`, `manual`) instead of staying silent.

| Gate | Producer | Artifact |
| --- | --- | --- |
| plumbing | `classifyRunnerOutcome` | `evalRunner.status/breakReason` |
| measurements | `hasMeasuredEvidence` | `gates`, `runnerEvidence` |
| reply-gap | Call trace gaps / `--gap` | `replyGap`, `beats.*.gapSamples`, `callTrace` |
| end-of-turn | stored body + trace CONFIG scan | `gates` detail |
| greeting-cut | greeting-cut scenario | `beats["greeting-cut"].cutMs` |
| barge-in-cut | stop-over | `beats["real-cut-answered"]`, `runnerEvidence` |
| filler-resume | filler-over line | `beats["filler-ignored"]` |
| overheard-recall | over-talk trace + `OVERHEARD ASIDE` | `overheard` |
| email-invite | invite-tag / `--email-json` | `emailInvite` |
| double-talk | over-talk `DOUBLE TALK` | `doubleTalk` |
| dead-air | silence-check-in `SILENCE TIMELINE` | `deadAir` |
| end-call-drain | bye-audio + free-gate coverage, then both hang-up scenarios | `endCallDrain` |
| timbre-probes | `--probe-json` / session evidence + `--reference`/`--delivered` measured captures | `probes`, `loudness` |
| accent-human | `--rate` + `--recording` | `humanRatings`, `humanReview` |
| phone-checklist, talk-hold-pinned | manual/external | informational rows only |

Thresholds live only in `scoreboard-budgets.ts` and its JSON record. Do not
edit a budget to pass; fix the call or amend the spec first. The phone bridge
reads the same JSON record at runtime (`VONI_SCOREBOARD_BUDGETS_JSON` overrides
its path in a deployment without the `voni/` tree), so its drain constants
cannot drift from the browser's.

## Measured timbre captures

The timbre gate's six measured axes need the reference render of the line and
the Delivered audio the caller received. Both are saved WAVs decoded through
`MeasuredLevelFile` before the runner starts:

```
cd voni
npm run voice:reference -- --voice lola          # writes .voice-references/lola-*.wav
npm run scoreboard:demo -- --voice lola \
  --reference .voice-references/<reference>.wav \
  --delivered <delivered-capture>.wav \
  --probe-json <probes.json> --rate ...
```

`--delivered` is the browser delivered capture (`?delivercapture=1`) or the
phone/agent-channel WAV. A run without the pair keeps the measured leg INFO;
an unreadable file fails by name before any artifact is written. A measured
PASS still needs the agent-channel PCM evidence (`--probe-json`) and the
weighted ballot: a missing channel is INFO, never a PASS.

## Subject matrix ordering (W5, tickets 78/118)

`npm run scoreboard:matrix` judges one subject per row — `{agent, Locale,
transport, pipeline}` — and every row's verdict comes from that subject's own
artifact. The featured subject is not a flag: it is the registry default, the
`anna`/en browser subject, and `buildRegressionMatrix` refuses any other
`featuredSubject` by name. It is measured and judged first, and every other
subject, English and non-English alike, stays `BLOCKED` with a named reason
(`blocked: featured subject demo anna (en, browser) has not passed …`) until the
featured subject's own current run in that matrix passes. A missing or
non-passing featured run blocks too; only PASS opens the gate. The measure
order (the CLI's spawn list) and the judgement order (the matrix rows) both use
`orderFeaturedFirst`, so there is one implementation of the rule. The rule is
recorded in `artifact.ordering` (rule, featured status, every unjudged blocked
row key, detail) and in the `ordering:featured-first` gate row, and printed in
the compact table, so a Locale is never silently judged on an unproved
instrument. `--strict` fails while any row is blocked: a subject that was not
judged is not clean.

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

## Vendor floor (W0)

`voni/evidence/vendor-floor/anna-en.wav` (+ `anna-en.json`) is the committed
recording every subject must clear: `anna` speaking `VONI_GREETINGS.en`,
captured 2026-10-29 from the vendor's text-to-speech engine
(`assemblyai-tts-1`, `aai-anna`) with no client, platform or model in the path.
`npm run voice:vendor-floor` reproduces it (or registers an owner-supplied
playground recording with `--from-recording`), and
`loadVendorFloor()` in `src/lib/audio/vendor-floor.ts` is the only reader. It
refuses a missing, unreadable, tampered or misdescribed floor by name — there
is no empty floor a comparison could silently pass against. See the README in
that directory for the provenance fields and the measured baseline.

## Re-audition pack (W2, ticket 41)

`npm run voice:reaudition -- --voice lola --locale es --pending --out reaudition-runs/lola-es-pending`
writes a `pending-live-call` template with the exact operator steps. A complete
pack needs the reference render, the platform agent channel and the browser
delivered WAV, plus the platform transcript; any missing capture leaves the
pack `incomplete` and the verdict `unresolved`, never a pass.

The automated verdict is content-only, because the gate is about the words:
`accept` means the content did not hold up (the per-locale rendering layer is
justified), `withdraw` means it held up (not justified to fix quality), and
`unresolved` means the pack cannot decide. `--adr` writes the section into the
locale-rendering decision record (ADR 0008); an unresolved pack leaves it
`proposed`. `src/lib/demo/reaudition.test.ts` covers assembly, the verdict
rules, named missing-capture errors and the pending path with synthetic WAVs.

## Readiness pack (ticket 152)

`npm run readiness:pack -- --manifest <path> [--tenants <path>] [--json] [--out <path>]`
assembles the all-subject cutover pack. It assembles and checks; it never
decides accept/withdraw, writes audio, binds a voice or marks a human ticket
resolved.

| File | Owns |
| --- | --- |
| `voni/src/lib/demo/readiness-manifest.ts` | manifest/tenant/deferral parsing, named refusals, run-history resolution and the last-two check |
| `voni/src/lib/demo/readiness-pack.ts` | per-subject assembly through `assembleCascadeReauditionPack`, roll-up, markdown render |
| `voni/scripts/readiness-pack.mts` | CLI, `--help` contract, exit codes, `--json`/`--out` |
| `voni/src/lib/demo/readiness-pack.test.ts` | synthetic six-subject fixture and every refusal path |

Manifest contract (full shape in the CLI `--help`): one row per eligible
subject with `artifacts` (the last two clean cascade runs, oldest first),
exactly one history source — `runsDir` to scan or a complete `runHistory` — the
reference+delivered pair and W0 `line`, transcript, the owner's recorded
`verdict` and two ballots. A manifest without history is blocked as
`run history not supplied; last-two consecutive unverified`; a supplied pair is
verified against the history and a clean/ineligible run after or between it
blocks.

Extra refusals beyond the ticket's minimum, kept because they close a hole:
a duplicate/undated/unexplained deferral, a deferral for a subject with
evidence or outside `routing=all`, and a tenant whose Locale/transport differs
from its `--tenants` row. `--tenants` is optional; without it no tenant roster
is known.

Exit codes: 0 ready, 1 blocked, 2 bad input. The pack itself is evidence for
the human gate, not the record: the owner records the verdict in
`.scratch/meta-cascade/issues/152-*.md` per
`docs/agents/meta-cascade-human-gates.md`. One failed or missing subject blocks
all; a dated deferral covers only a subject with no evidence.

## Live-run rules

- Run live timing scenarios **one at a time**; `score-demo` takes
  `/tmp/voni-demo-timing.lock`. Parallel live runs inflate cut/reply numbers.
- `npm run scoreboard:demo` defaults to the full default suite
  (`SUITE_SCENARIOS`: 10 scenarios, both goodbye-drain paths included); use
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

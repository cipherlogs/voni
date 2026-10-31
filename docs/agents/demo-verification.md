# Demo verification — subsystem map and residual risks

Read this before building or changing the demo contract, the certificate, the
panel or the `demo:verify` command. The decisions are recorded in
[ADR 0013](../adr/0013-demo-readiness-is-a-signed-certificate.md); this file is
the subsystem map those tickets fill in and the committed register that every
certificate cites. Vocabulary is `CONTEXT.md`'s "Demo verification" section —
certificate, certification run, defect card, panel, gold label, take, caller
corpus, held-out scenario — and is used here as written.

The register is dated **2026-10-31** (register version 1). A risk leaves it only
when the ticket that closes it records the evidence here; it is never deleted to
make a certificate green.

## The seam

```
                   ┌─ browser adapter (certifies) ────────────────────────┐
caller PCM in ─────┤  real landing page, real app, real pipeline,          │─────> agent PCM out
                   │  real vendor legs, synthetic mic at getUserMedia,    │       + delivered WAV
                   │  delivered WAV, browser marks                        │       + browser marks
                   ├─ protocol adapter (diagnoses, never certifies) ──────┤
                   │  call-body HTTP + browser-call WebSocket, no browser │
                   └──────────────────────────────────────────────────────┘
```

One scenario runtime runs both adapters. A scenario is data: caller takes with
trigger rules, a soundscape, expected properties and faults. There is no mocked
tool executor on the golden path, no fake pipeline in the certifying adapter,
and no test branch inside production code.

## Subsystem map

Each ticket fills its own row when it lands. `not landed` is deliberate: no path
is recorded before it exists, and a row that claims a path the repo does not
have is a defect in this map.

| Unit | Owns | Where | Ticket |
| --- | --- | --- | --- |
| Ground truth | the persisted `end` message, the turn-level ledger, the delivered WAV, the client marks | pipeline trace and priced row exist (`voice-pipeline/cascade/events.py`, `voice-pipeline/cascade/cost.py`); the end message is persisted beside it as `<call-id>.end.json` with one `end` row (`OperationalEvents.end`); turn rows are written by `OperationalEvents.turns` (`cascade.events.TurnLedger`) through the same sanitized stream — caller final, reply start, first audio, cut, tool call/result, goodbye, hangup, failure, fallback and protocol error — and the end row's `turnSummary` is the ledger's count; a hold return resumes the trace with continued turn ids; the browser call marks are posted beside the delivered WAV (`voni/src/lib/voice/call-marks.ts`, `voni/src/app/api/dev/call-marks/route.ts`) | 03, 04, 05 |
| Contract registry | 82 property ids in ten families, each with a bar, one evidence source and its threshold key | `voni/src/lib/demo/verification/contract/` — one `families/*.family.ts` per family, discovered by `loader.ts`; `contractDocument()` is the machine-readable form | 06 |
| Frozen budget record | the single threshold source; the drift test that fails a hand-edited number | `voni/src/lib/demo/scoreboard-budgets.ts` + `.json` (the contract's `dv*` keys; cascade-owned keys still come from `voice-pipeline/cascade/thresholds.json`), `voni/src/lib/demo/verification/contract/bars.ts` + `contract-bars.json`, moved only with `npm run contract:bars -- --write` | 06 |
| Verdict and statistics | pooling, per-scenario tails, fail-closed unknowns, ineligibility | `voni/src/lib/demo/verification/verdict/` — `statistics.ts` pools, `judge.ts` judges, `evaluators.ts` discovers one `evaluators/*.evaluators.ts` module per family | 07 |
| Certificate | schema, builder, validator, target binding, residual-risk ids, panel signature | `voni/src/lib/demo/verification/certificate/` — `types.ts` is the schema, `build.ts` turns one verdict-core run into one certificate, `validate.ts` refuses an unknown schema, a mismatched target/fingerprint/corpus, an uncited verdict and a certified claim with no panel signature, `risks.ts` mirrors this register's ids (drift-tested), `render.ts` is the compact view; committed files live in `voni/evidence/certificates/` | 08 |
| Defect cards | one card per failed property with turn, excerpt, bar and replay command | `voni/src/lib/demo/verification/cards/` — `build.ts` refuses a card without a session, a turn (for turn-level evidence) or an existing evidence file; `wav.ts` bounds every excerpt inside the named take/WAV; `replay.ts` is the one parser the runner must accept unchanged; `render.ts` is the compact card | 09 |
| Scenario runtime and caller corpus | parser, trigger rules, hashed takes, corpus manifest, the ten-scenario English fast contract, the twelve-scenario Locale core | `voni/src/lib/demo/verification/scenarios/` — `types.ts` is the adapter-agnostic record (takes, trigger rules, soundscape, expected property ids, faults); `parse.ts` refuses unknown fields, classes, locales, property ids, takes, triggers and faults by name and enforces the eight held-out names; `triggers.ts` resolves the caller script against the agent timeline deterministically and refuses an unresolved step; `corpus.ts` discovers `<root>/manifest.json` plus one directory per scenario and verifies each take's declared sha256, naming a drifted take; `corpus/` is the committed corpus at version 2 (84 scenarios, 205 real TTS takes): the ten fast-contract scenarios (twenty takes), ticket 13's five comprehension and five emotion scenarios (thirty takes), ticket 14's soundscape/connectivity/meta-security entries (nineteen takes), and ticket 15's `tools-slow-email` plus the sealed held-out `two-tools-in-turn` (five new takes; the three tools scenarios carry seven), ticket 16's forty-eight `locale-<behaviour>-<locale>` scenarios (120 real TTS takes, twelve behaviours on es/fr/de/pt), and ticket 20's six resilience edge scenarios (eleven takes, R2–R7), and `generate.ts` + `scripts/generate-caller-takes.mts` (`npm run corpus:takes`) record a take once or a deliberate `--retake`; `fast.ts` selects its ten, proves the six call-path capabilities, scopes the verdict (uncited families are `OUT-OF-SCOPE`, never green), and reads the fast cost ceiling from E3; `locale.ts` proves the four Locales hold the same class, triggers, properties, soundscape and fault per behaviour, scopes each Locale's contract, and bounds the 48-call nightly / 144-call full plans with the economics owner. `facts.ts` resolves each scenario's script to its authored take text for the exactness evaluators. Ticket 19 adds the filler-cut scenario (a cut, then a filler that resumes the tail) and gives a scenario an optional `holdOpenMs` so a greeting-only call is actually held open (32 s) before the harness hangs up. `CALLER-CORPUS.md` records the voice, model and retake rule; `SOUNDSCAPES.md` records the television gap and the second-voice/speakerphone scope. The remaining English scenarios are not landed | 10, 12–16, 19 |
| Locale matrix | four Locales judged independently; understanding held as RR-02 until a named native reviewer signs | `voni/src/lib/demo/verification/verdict/locale.ts` — `judgeLocaleMatrix` requires exactly one complete evidence set and twelve calls per Locale at the run's repetition count, refuses a measurement recorded under another Locale or a scenario outside that Locale's core, judges each Locale against its own scoped contract, and returns `pending-human` with RR-02 when `judgeLocaleUnderstanding` has no valid named sign-off; a role word, a malformed date or a missing sample/gold-label id is unverified, never a pass | 16 |
| Protocol adapter | diagnosis runs over the existing live-call socket; never certifies | `voni/scripts/lib/protocol-adapter/` — `refusals.ts` names a missing key, corpus, scenario, vendor build, soundscape or test inbox before any vendor opens, `transport.ts` drives `POST /v1/call-body` + `WS /v1/browser-call` at the browser's 128-sample cadence and keeps the service's captions, `faults.ts` applies the scenario's media faults, `tool-evidence.ts` reads the demo tool log (`voni/src/lib/demo/tool-log.ts`, `tool-log-store.ts`, the `demo_tool_calls` table) and the real inbox by tag (`voni/src/lib/demo/verification/tools/inbox.ts`), `evidence.ts` writes the per-run directory under `voni/.demo-runs/`, `runner.ts` turns one call into one verdict and any provable card; `voni/scripts/protocol-diagnose.mts` accepts a card's replay command unchanged and never returns 0. `npm run demo:inbox:probe` is the read-only live inbox check | 11, 15 |
| Browser adapter | certifying runs on the real page, synthetic mic, delivered WAV, browser marks | `voni/scripts/lib/browser-adapter/` — `refusals.ts` names a fake pipeline, a test build, a missing key, corpus, scenario, vendor build, soundscape or capture sink before Chromium opens; `synthetic-mic.ts` replaces `getUserMedia` from a Playwright init script before app code; `call.ts` builds the one invocation and runs `voni/tests/e2e/browser-adapter.spec.ts`; `evidence.ts` requires the delivered WAV, browser marks, trace and end document to cite one call id and reads cost from the call's own priced row; the browser report also carries the visitor's transcript and each caller take's wall-clock start, and `runner.ts` passes the scenario's `expectedProperties` and authored facts to the verdict core; it also reads the demo tool log and the real inbox delivery, so X4/X5/X7/X8 are measurable here, while the marks carry no caption text and X2/X3/X6/X9 fail closed on this adapter until a transcript exists; `runner.ts` judges the bundle, builds the certificate (exit 0/3) or withholds it by name, and records a parity comparison; `voni/scripts/browser-verify.mts` is the command. Ticket 20 adds the media-fault seam (the scenario's jitter/dropout/latency applied to caller playback at the mic edge, never replayed), the browser-edge vocabulary (`page-freeze`, `page-hidden`, `mic-denied`, `device-switch`, `deploy-drain` in `scenarios/types.ts`), the harness observations R2–R7 read (`edge` on the call bundle), and one producing corpus scenario per property (`resilience-reconnect`, `-hold-return`, `-hidden-page`, `-mic-denied`, `-device-switch`, `-deploy-drain`; R1's are the existing connectivity scenarios) | 17, 20 |
| Evaluator families | L1–L11, T1–T10, C1–C10, K1–K8, X1–X10, A1–A8, R1–R8, S1–S6, E1–E4, H1–H7 | L1–L11 landed in `voni/src/lib/demo/verification/verdict/evaluators/lifecycle.evaluators.ts` with the pure mark/trace/WAV analysis in `verdict/lifecycle/`: L2 compares the connected paint with admission and with the first audible sample, L5 compares config with mic acquisition, L6 judges the bounded voice open and its named unavailable state, L7 and L9 read the delivered WAV (opening breath, goodbye tail and drop), L8 reads the talk-clock mark, L10 judges the named failed-greeting state, and L11 compares the end/end_call order. C1–C10 landed in `verdict/evaluators/conduct.evaluators.ts` with its evidence layer in `evaluators/turn-conduct/`; C2 measures the greeting-only wait and C1 counts an end_call with no caller request. The browser marks now also carry `ringback_start`/`ringback_stop`, `talk_clock_start` and `error_received`; they are dev-only observation. H6 landed in `voni/src/lib/demo/verification/verdict/evaluators/human.evaluators.ts` (judge calibration). S1–S6 landed in `verdict/evaluators/security.evaluators.ts` with the pure scans in `verdict/security/`: S1 judges the injection reply (judge record) and scans the trace/tool log, S2 binds every tool row to its call and subject, S3 counts tool rounds against `tool.loop_cap` and requires a polite ending at the cap, S4 scans caller PII beyond the trace's identities, S5 scans credentials in trace/tool/browser rows, S6 requires two interleaved call traces. E1–E4 landed in `verdict/evaluators/economics.evaluators.ts`: E1/E2/E4 judge one call from its own `cost.priced` row and persisted `end` message; E3 is run-scoped and is judged by the run gate in `voni/src/lib/demo/verification/economics/run-ceiling.ts` (`preflightRunCeiling` before the run, `scopeRunToCeiling` at the end), which narrows E3 to the plan's own ceiling. K5 and K6 are discovered from `verdict/evaluators/locale.evaluators.ts` (same implementations, one owner): K5 in a non-English Locale scans both the trace and the delivered-audio transcript (`evaluators/comprehension/locale.ts`), requires the delivered audio, and cites the offending segment (a turn id or a WAV `@start-end` window); K6 requires a judge finding that names the same Locale and cites its turns. K1–K8 landed in `verdict/evaluators/comprehension.evaluators.ts` with its text layer in `evaluators/comprehension/`: K1 compares the tool argument to the corrected spelled address, K2/K3/K5 read the turn transcript, K4/K6/K7 read the judge's property findings, and K8 compares the caller transcript to the known TTS take text. The protocol adapter keeps the service's captions, so K2/K3/K5/K8 can measure a real run; K1 still needs a tool argument the evidence does not carry, and K8 stays unresolved because no frozen record carries a word-error bar. X1–X10 landed in `verdict/evaluators/tools.evaluators.ts`, reading `voni/src/lib/demo/verification/tools/evidence.ts` (tool log, turn rows, captions), `tools/inbox.ts` (the real test inbox) and the grounded returning-sender judgement; the tool log is the redacted `demo_tool_calls` row written only by the pipeline credential. R1–R8 landed in `verdict/evaluators/resilience.evaluators.ts`: R1 counts a lost turn and a doubled first-audio row from the turn ledger while the scenario's fault ran; R2 requires a reconnect (or the freeze/rejoin edge) with unique turn epochs and one greeting; R3/R4 read the hold record for kept memory, no ring-greeting or ringback, and a stopped talk clock; R5 requires a named mic refusal with no open socket or an observed teardown; R6 accepts a reacquisition or an honest end; R7 requires a finished live call and a second call refused with code `draining`; R8 fails on any `provider_fallback` row and the run gate reports the whole run `ineligible`. R7 is unmeasured until a run has a real drain trial; the browser harness records the condition as unapplied rather than faking a refusal. The protocol adapter refuses any scenario with browser-edge conditions by name, so it is never more permissive. A1–A8 landed in `verdict/evaluators/audio.evaluators.ts` with the pure analysis in `verdict/audio/`: the delivered WAV reader refuses a missing, unreadable or misdescribed file by name, A1/A6 read dropouts, clicks and clipped runs, A3/A5/A8 align the delivered greeting to the committed voice reference, and A7 reads the barge fade against the trace's own `turn.cut` row. T1–T10 landed in `verdict/evaluators/turn-taking.evaluators.ts` with the sample/scene layer in `evaluators/turn-conduct/`: `audio.ts` reads the delivered WAV into voiced segments and content fingerprints, `timeline.ts` anchors the WAV to the page's `first_audible` mark once and places the synthetic microphone's takes on the same wall clock, `evidence.ts` reads the ledger, marks and captions without trusting them. T1 is caller-take end to the delivered response onset (the ack is not a turn row), T2 is the caller final to the reply's `first_audio` row, T3/T6 cite the recorded `turn.cut` and the delivered stop/resume excerpts, T4/T7 count finals against the authored real turns, T5 refuses a repeated filler tail, T8 is the longest uncovered inter-utterance pause, T9 reports the premature-cut ratio and fails closed on a missed end (its two bars carry different units), T10 counts a reply onset inside a caller take. C1–C10 landed in `verdict/evaluators/conduct.evaluators.ts`: C1 reads `endedBy` and the hangup turn plus the caller's `wantsEnd`, C2 measures `first_audible` to teardown (a greeting-only scenario declares `holdOpenMs`), C5 compares the visitor's agent captions because trace rows carry no words by design, C7 measures the WAV tail after the last sample, C8 finds a voiced segment or reply row after the end receipt/hangup, and C3/C4/C6/C9/C10 are judge findings (missing judge = unmeasured). `ScenarioAttempt.expectedProperties` bounds which evaluators run on a scenario; a property no attempt cites still fails closed. T1–T10, A1–A8 and R1–R8 are not landed | 13, 15, 18–22, 26 |
| Machine judges and calibration | two transcript-grounded judges, third-judge/panel escalation, vendor independence, weighted-kappa gate | `voni/src/lib/demo/verification/judges/` — `panel.ts` refuses a judge on the agent's vendor (`AGENT_VENDOR = meta`), scores two judges independently and reconciles a disagreement above one point through a third judge to the panel; `kappa.ts` is the linear weighted-kappa arithmetic; `rubric.ts` hashes the rubric; `calibration.ts` verifies every judge/axis at the frozen `dvJudgeKappaMin` bar and refuses a changed rubric hash; a live judge transport is not landed and is key-gated by `AI_GATEWAY_API_KEY` | 26
| Studio | local-only Record, Rate and Corpus surfaces; never in the deployed build | Record landed in `voni/scripts/studio/`: `take-store.ts` writes one immutable hashed take per landing (`voni/.studio/`, gitignored) on the shared digest in `scenarios/digest.ts`; `dialogues.ts` validates authored prompt cards; `http.ts` serves `record.html` on loopback only and refuses a production environment or host by name; no `src/` file imports it. Rate and Corpus landed in the same process: `rate.ts` builds the blind queue (every failing call ahead of the clean sample, seeded per-session order, A/B sides with a private answer key, seven axes, free text and defect tags), `rating-store.ts` persists attributable sessions and gold labels under `voni/.studio/rating/` and rehashes evidence on every serving, `rate.html` and `corpus.html` are the surfaces, `take-store.ts` retires a take with `retired.json` (never editing the take) and records baseline consent metadata; `selectable()` excludes retired and baseline takes | 23, 24 |
| Human baseline | three to five consented, hashed reference calls, blind comparison only | prepared, **not captured** (human gate): session plan and owner runbook in `docs/demo-human-baseline.md`; `voni/scripts/studio/baseline.ts` verifies consent references, the 4–6 minute band, rehashed takes, a pinned hash list and non-use as certification input, exposed as `npm run demo:baseline:verify`; `take-store.ts` lists active baseline takes with `baselineTakes()` | 25 |
| Panel and gold labels | blind sample, seven axes, blind A/B, signature, exit 3 | `voni/src/lib/demo/verification/panel/` — `types.ts` fixes the twelve-call sample (two per Locale plus the two worst remaining failing calls, every failing call mandatory) and the gold-label/signature vocabulary; `verdict.ts` computes H1–H5 and H7 from the panel's gold labels against the contract's frozen bars; `run.ts` merges those verdicts into the run. The local-only orchestration is `voni/scripts/studio/panel/` — `session.ts` builds the blind session (every failing call mandatory), `gold-labels.ts` exports attributable labels and their digest, `signature.ts` signs/verifies and completes H7. `voni/scripts/lib/demo-certificate.ts` is `demo:certificate`; an unsigned certificate is `pending-human` and exits 3 | 27 |
| CLI | `demo:verify`, `demo:studio`, `demo:certificate`; exits 0/1/2/3 | `voni/scripts/demo-verify.mts` is the command; the testable contract is `voni/scripts/lib/verify-cli/` — `args.ts` accepts the three spec forms and a defect card's replay command unchanged, `plan.ts` owns the target/mode/Locale matrix (fast ten ×1; nightly English 40 + Locale core 12 ×1; full the same ×3), and `run.ts` preflights keys, corpus and vendor builds as one named exit 2, takes the machine-wide timing lock (a held lock is a named exit 2, never a wait), dispatches diagnose through the protocol adapter and certification through the browser adapter, and issues at most one certificate from a full run. Diagnose never writes a certificate and the protocol adapter's exit 0 is refused. `staging` and `production` refuse by name (no evidence sink); nightly/full refuse by name until the 40-scenario English and four Locale core corpora land. A fast or nightly scoped-clean report is exit 1, never a certificate | 28 |
| Streak and cutover | three-clean streak, staging gate, post-flip confirmation, monthly full production | not landed | 29 |
| CI cadence | fast contract, nightly health, weekly full certification, Locale matrix | not landed | 30 |

### The fast contract

The English fast contract is ten committed scenarios at one repetition:
`golden-flow-hello`, `golden-flow-substantive`, `golden-flow-greeting-only`,
`turn-taking-barge`, `turn-taking-filler`, `soundscape-quiet-room`,
`connectivity-jitter`, `tools-email-send`, `ending-goodbye`,
`ending-caller-silence`. It proves greeting, a substantive turn, a barge-in, a
filler, one tool and a goodbye, derived from each scenario's triggers and
expected property ids rather than a second list.

A fast run is deliberately **not** a certificate. It measures the union of the
ten scenarios' expected properties; every other property is reported
`OUT-OF-SCOPE`, grouped by family (comprehension, economics, human, security
today), and a `scoped-pass` carries `certifiable: false`. The cost ceiling is
the contract's E3 `dvCostFastRunMaxUsd`; the wall-clock number is measured and
its missing frozen bound is recorded as a gap, never invented. The corpus is
recorded through `npm run corpus:takes` and a changed take refuses by name
unless `--retake <scenario>/<take>` moves the manifest version deliberately.

The Locale core is twelve behaviours (`golden-flow`, `golden-returning`,
`backchannel`, `barge-clause`, `filler`, `nonsense`, `angry`, `television`,
`jitter`, `goodbye-drain`, `slow-tool`, `code-switch`) on each of es, fr, de and
pt: forty-eight committed scenario directories and 120 real TTS takes. Every
Locale's version of a behaviour must keep the same class, trigger sequence,
property set, soundscape and fault; a translation changes words, never the
measured conduct. A nightly Locale run is 48 calls at one repetition and fits
E3's `dvCostNightlyRunMaxUsd`; a full Locale run is 144 calls at three and fits
`dvCostFullRunMaxUsd` (both preflighted by the economics owner). Those bounds
are the core's own plan, not the combined English + Locale plan: ticket 30
composes that plan and must preflight its own call count. The matrix
judges each Locale from its own twelve calls only: a borrowed measurement, a
missing call or a scenario from another Locale is `ineligible`. Conduct and
timing may pass on machine evidence; understanding cannot be claimed without a
named native reviewer, so the Locale is `pending-human` with RR-02 rather than
certified.

`demo:verify --fast` runs the ten scenarios through the certifying browser
adapter with the per-call certificate withheld, then judges the pooled attempts
with the real verdict core. A scoped-pass is still exit 1: the fast contract is
a merge gate, not a certificate, and exit 0 is reserved for a signed full
certification. The same rule makes a clean nightly health report exit 1.

The defect-card replay command is the one parser in
`voni/src/lib/demo/verification/cards/replay.ts`:
`demo:verify --scenario <name> --target <local|staging|production> --locale <en|es|fr|de|pt> --diagnose`
(or the repository's `npm run demo:verify -- ...` form). Ticket 11's runner and
ticket 28's CLI accept it unchanged; an unknown flag, a missing Locale or a
certification mode is a named refusal (exit 2).

The protocol adapter reads the committed vendor-build record at
`voni/evidence/vendor-builds.json` before it opens a vendor (RR-03). That file
does not exist yet: no engineer has recorded authentic STT/TTS/LLM build ids, so
a real protocol run refuses by name rather than inventing one. The adapter's
tests inject a fixture record; a live run stays unrun until the record lands.

### Browser adapter: what a local certificate can and cannot say

- The certifying browser run serves the app in **dev mode**, because the
  delivered WAV and the browser marks are written by the app's dev-only capture
  path (ticket 05). A `staging` or `production` target has no such sink, so the
  adapter refuses it by name (`target-invalid` / `capture-unavailable`) instead
  of inventing evidence. A local certificate is true for the dev-mode app;
  production certification needs an evidence sink production does not expose yet.
- The run refuses at preflight when `voni/evidence/vendor-builds.json` is absent
  (RR-03). The 2026-10-31 live rehearsal refused there. The call path itself was
  exercised separately with a test-only record; that run is not a certificate and
  is not reported as one.
- A completed run whose `cost.priced` row is unmeasured **withholds** the
  certificate (`cost-missing`) and keeps the verdict and cards. The 2026-10-31
  live rehearsal observed the STT `audio_seconds` and the TTS termination summary
  unmeasured, so its certificate was withheld; this is a pipeline evidence gap,
  not a browser-adapter pass.
- The evaluator families that have not landed still fail closed, so a browser
  run's verdict is `not-demo-ready`. A diagnose run measures one repetition and
  fails the timing/behaviour properties' three-repetition plan rather than
  borrowing a pass. The 2026-10-31 rehearsal on `golden-flow-hello` ran the real
  call end to end: one call id on the delivered WAV, marks, trace and end
  document, 24.2 s inside the 120 s ceiling, and a withheld certificate for the
  unmeasured cost.
- Parity compares deterministic properties only: the 2026-10-31 live rehearsal
  compared 29 and they agreed; the timing/behaviour properties were named as not
  compared because the protocol adapter may be faster, never more permissive.
  The rehearsal also proved the protocol adapter read its trace too early; it now
  waits, bounded, for the end sidecar and the trace's end row before judging.

An **unresolved** property is a recorded gap with no owning evaluator. Today
that is K8: the spec states "word error within bar" without a number, and no
frozen threshold record carries one, so ticket 13 kept K8 unresolved rather than
inventing a bar. The evaluator still computes the word error against the known
TTS take text and the entity mismatches exactly, but the contract fails the
property closed until a reviewed record supplies the number. H6 is no longer
unresolved: ticket 26 owns it through the judge calibration gate, which fails
closed when the calibration is absent, below the 0.65 bar or scored against
another rubric.

### Tools and email

The X properties read three call artifacts and one judgement, never the agent's
speech. The **tool log** is one redacted `demo_tool_calls` row per pipeline
model call: status (found/free/not arrived), returning, sent, success, a closed
code, latency and attempt count. It carries no address, name, warm line or
result payload; a browser poll is logged under its own credential and filtered
out by the reader. The **trace** carries the turn rows and the service's
captions. The **real test inbox** is re-read by the call's Test tag after the
call; X4 passes only when the tool found the email and that re-read produces the
same message. `npm run demo:inbox:probe` is the read-only live check, and a run
whose scenario cites X4/X5/X10 refuses before a call when the inbox credentials
are missing or the inbox cannot be reached. X10 reads a judge's grounded
returning-sender record (`memoryUsed`, `inviteRepeated`, transcript turn
citations); without it the property is unmeasured, never inferred from the tool.

A missing tool log, transcript or delivered WAV is a named gap that fails the
property closed. That is deliberate: the instrument can report X4 unverified
until someone actually emails the test inbox with the call's tag, but it cannot
report a delivery it did not see. X9 scans the agent's captions and refuses any
turn that delivered audio without a caption (un-scanned speech is not clean);
it does not independently re-transcribe the delivered WAV, so a leak the
captions miss remains a residual gap rather than a pass.

The one seam is the call boundary. If a proposed change adds a second seam
inside the call lifecycle or the turn stream, it contradicts ADR 0013 and needs
a new record before it is built.

**Panel gaps.** The confirmed sample is twelve calls: two per Locale as the
base, the two worst remaining failing calls in the extra slots, and every
failing call mandatory (a run with more than two remaining failures grows past
twelve rather than dropping one). H1's "would you stay" bar is binary while the
Studio's axis is five-point; a 4 or 5 is a yes and 1–3 is a no, recorded on the
property's gaps. H2's forty-judgments-per-Locale floor cannot be met by one
twelve-call session: the first certification reports H2 unverified until panel
gold labels accumulate across sessions (RR-04), and an under-sampled H2 is a
failure, never a skip. H5 uses the spec's strict `< 40%` operator, so exactly
40% fails. The seven rating axes are `stayOnCall`, `soundsHuman`, `turnTaking`,
`understanding`, `languageNaturalness`, `warmth`, `pacing`, verbatim. The
signature is a digest attestation over the certificate identity, the panel
session and the exact gold labels — not a secret-key signature, because the
repository holds no owner key. `demo:certificate --panel <session-id>
--reviewer <name>` refuses a different run, a missing or different reviewer, a
missing or different date, an incomplete panel and an already-signed
certificate by name; an unsigned certificate is `pending-human` and exits 3,
never certified.

### Lifecycle and connect: the two reported-bug proofs

Ticket 18 makes the two reported symptoms the first red tests, judged by the
production evaluators and turned into defect cards:

- **Connected before admission.** L2 compares the `connected_painted` mark with
  `admitted` and reports the gap to `first_audible` in the same judgement. The
  red fixture paints connected at 350 ms, admits at 1250 ms and sounds at
  1600 ms; the fixed fixture paints after admission. The card names the session,
  not a turn, because a connect fact predates every turn. Defect cards therefore
  treat L1–L11 and C1–C2 as call-level even where the contract's evidence source
  is `ledger`, `trace`, `wav` or `browser`.
- **A greeting-only call that ends.** C2 measures the open window from the first
  audible sample to the ending mark against the 30 s bar; C1 allows a caller
  `caller_end`, a caller hangup, the clock, a budget stop, a refusal, a leg
  failure or a `turn.user_final` that asked to end, and counts an `end_call`
  without any of them. The red fixture ends at 8 s with
  `turn.hangup reason=end_call` and no caller end request. L9 additionally measures the delivered WAV's last run against the
  goodbye's synthesized length in the end message and reports both the played
  percentage and the drop delay; the fixture's 1200 ms goodbye is cut after
  400 ms.

The browser adapter's diagnose run makes one call. A timing/behaviour property
whose contract plan is three repetitions therefore fails with
`repetition-shortfall`; that is a named failure, never a borrowed pass. The
verdict flip is proven in `lifecycle.evaluators.test.ts` with the three
repetitions a full run supplies, and the browser-runner fixture narrows the
lifecycle plan to one repetition only to prove the same evidence path flips
without a harness change. A real full run keeps the contract's three
repetitions.

### Resilience evidence gaps

- **Deploy drain.** The browser harness can drop the page, deny the mic,
  switch the input and apply media faults, but it cannot start the service's
  drain. `resilience-deploy-drain` records the condition as unapplied and R7 is
  `unmeasured` (a failure), never a simulated refusal. A real proof needs an
  operator drain window or a service drain control the adapter may call; until
  then the property stays red rather than green by invention.
- **Media faults are uplink only.** The scenario's jitter and dropout are
  applied to caller playback at `getUserMedia`, the same shape the protocol
  adapter applies. A downlink dropout would need socket interception, which is
  a fake pipeline in the certifying adapter and is not built.
- **Reconnect is the browser's rejoin.** The demo client rejoins the same call
  id after a freeze/return; R2 proves the trace's turn epochs continue and one
  greeting is spoken. A transport-level socket drop is not retried by the
  demo client, so a scenario that only drops the socket ends honestly rather
  than resuming.
- **R8 is a run gate, not a scenario.** Every call's trace is scanned for
  `provider_fallback`; the mandatory proof is a contaminated browser run whose
  verdict is `ineligible` and whose certificate can never pass.
- **Mic denial has no delivered WAV.** A denied call never acquires the mic, so
  the playout tap writes no capture and the pipeline writes no trace or end
  document. The browser runner currently refuses that call by name
  (`capture-missing`) before verdict assembly; R5's evaluator and the
  `resilience-mic-denied` scenario prove the named state and socket count in
  the harness suite, but a certifying run has to grow a refusal-evidence path
  before R5 can be judged from a certificate run. The refusal is named, never a
  green.

### Soundscape and security evidence gaps

Ticket 14 added the soundscape, connectivity and meta/security scenarios (class
totals 4/3/3) and the S1–S6 evaluators. Three gaps are recorded rather than
papered over:

- **Television media.** No television or background PCM exists. The
  `soundscape-television` scenario names `television`, and the protocol adapter
  refuses `soundscape:television` by name before any vendor opens. It never
  substitutes `quiet-room`, which is digital silence. See
  `voni/src/lib/demo/verification/scenarios/SOUNDSCAPES.md`.
- **S1's reply evidence.** S1's contract evidence source is `judge`: the
  evaluator needs the exact caller line and the agent's reply. A protocol run
  assembles no judge record, so S1 is `missing-evidence` and fails closed until
  the certifying adapter supplies a transcript-backed judge record. A leak into
  the trace or tool log is still caught by the same evaluator's scan.
- **S6's two-call run.** S6 requires two interleaved calls and refuses a
  single-call bundle by name. The evaluator and its tests consume the two-call
  evidence, but no runner wires the pair yet; a run over one scenario cannot
  claim isolation.
- **S2's refused-attempt fields.** The trace records a tool call's name and
  ids, never its arguments. A model asking for another call or subject is
  provable only when the app's tool log supplies the `requestedCallId` /
  `requestedSubject`; S2 scans those fields when present and otherwise judges
  the rows' own call/subject binding. The tool-log reader that attaches them is
  not landed.

S4's exact caller-name matching also depends on a runner attaching the
scenario's private caller values; the generic email, phone, national-id, card
and IBAN shapes are scanned today.

### Audio evidence gaps

Ticket 21 measures A1–A8 from the delivered WAV and the committed voice
reference. Five limits are recorded rather than papered over:

- **A4 has no caller words to read.** The turn ledger records a caller final's
  length and emptiness, never its text (a deliberate privacy rule), and no
  agent transcript row exists either. A4 therefore reports
  `echo-unmeasurable` on a real trace and fails closed. The evaluator's
  token-overlap scan is live for a trace that carries `text`, but no runner may
  claim A4 green until a transcript-backed evidence source lands.
- **A5's reference is the English demo voice.** The committed pair is
  `voni/evidence/voice-reference/audrey-en.{wav,json}` (rendered by
  `voice-pipeline/scripts/render_reference.py`, 24 kHz PCM16, pinned by sha256).
  A5 compares the delivered greeting to that one line in that one voice; a
  Locale whose voice has no committed pair fails closed by name rather than
  borrowing audrey's audio. The loader is
  `voni/src/lib/audio/voice-reference.ts`.
- **A2 checks the capture's exact format, not a semantic stream rate.** The
  delivered file must be PCM16 mono and its declared description must agree
  with its header; a trace naming more than one stream rate is a mismatch. The
  device rate is allowed to differ from the stream rate because the worklet
  resamples, so A2 does not compare the two.
- **A6's overrun is the device overload.** A6 counts underruns as dropouts and
  overruns as runs of full-scale samples. It does not have a playout level-report
  artifact: the worklet's queue/cushion reports are not persisted with the call,
  so a starvation that leaves no audible hole cannot be named as an underrun.
- **A7 needs a recorded barge-in.** A7 reads the fade only when the trace has a
  `turn.cut` row with `reason: "barge_in"`; a call with no cut is
  `no barge-in cut was recorded`, never a pass. The fade is measured on the
  delivered file, so the trace's clock never has to align with sample zero.

## Residual-risk register

Every certificate carries the ids below that still apply. An id that is not in
this register is a named refusal; an id that is dropped without recorded closure
evidence is a false green. Ids are append-only and never renumbered; property
ids `R1`–`R8` (resilience) are not risk ids and the two must not be conflated.

**Owner** is a role, not a person: this repository records no individual's name,
and naming one is a human act. `owner` is the demo's accountable human (quality
and acceptance), `operator` performs the cutover and the deploy window,
`engineer` owns the harness and the vendor-build record. Each entry names exactly
one; an entry with two owners is a defect in this register.

| Id | Risk | Owner | Opened |
| --- | --- | --- | --- |
| RR-01 | TTS-only corpus has no Indian, Nigerian, Irish, Australian or East-Asian English accents until Studio takes exist | owner | 2026-10-31 |
| RR-02 | Non-English understanding is certified through an English translation proxy until native-speaker reviewers exist | owner | 2026-10-31 |
| RR-03 | Vendor drift invalidates a certificate; detection depends on recorded vendor build ids | engineer | 2026-10-31 |
| RR-04 | The human baseline is three to five people and the panel is one rater, so taste bias is real | owner | 2026-10-31 |
| RR-05 | Staging can drift from production; the post-flip confirmation is short | operator | 2026-10-31 |
| RR-06 | A one-instance deploy window refuses new calls; a visitor arriving mid-deploy is out of contract | operator | 2026-10-31 |
| RR-07 | Held-out scenarios are sealed by process, not by machine | engineer | 2026-10-31 |

### RR-01 — Accent coverage is TTS-only until Studio takes exist

**Risk.** The TTS-only caller corpus has no Indian, Nigerian, Irish, Australian
or East-Asian English accents until Studio takes exist.

**What it costs.** The human and comprehension properties can be certified for
the voices the TTS corpus can produce, not for the visitors the demo will meet.
A pass is real inside that envelope and silent about the accents outside it.

**Fail-closed.** The contract has no accent-group property yet, so no evaluator
may imply one. Every certificate cites RR-01 rather than claiming accent
coverage; coverage by accent group becomes an explicit row only when hashed
takes exist and a scenario uses them.

**Owner:** owner. **Opened:** 2026-10-31.
**Closure:** the caller corpus holds at least one hashed Studio take per named
accent group, each used by a certification scenario, and the certificate reports
accent coverage instead of citing this risk.

### RR-02 — Non-English understanding is judged through a translation proxy

**Risk.** Non-English understanding is certified through an English translation
proxy until native-speaker reviewers exist.

**What it costs.** The comprehension properties in es, fr, de and pt can pass on
a translation that a native ear would reject, so the certificate's Locale
coverage can overstate understanding while conduct and timing remain sound.

**Fail-closed.** Without a named native reviewer for a Locale, that Locale's
understanding is not a pass: the properties are reported unverified and the
certificate cites RR-02. This is the named residual risk ticket 16 allows, not a
green with a footnote.

**Owner:** owner (names the reviewers and records their sign-off).
**Opened:** 2026-10-31.
**Closure:** one named native reviewer per Locale (es, fr, de, pt) signs that
Locale's understanding sample, dated and recorded as a gold label.

### RR-03 — Vendor drift invalidates a certificate

**Risk.** A vendor model, voice or build change invalidates a certificate, and
detection depends on the vendor build ids recorded in the certificate.

**What it costs.** A green can describe a vendor build nobody can reproduce, and
the certificate then makes a claim about a product that no longer exists.

**Fail-closed.** A build id that cannot be recorded refuses the run (exit 2); it
is never recorded as `unknown`. A changed build id invalidates the certificate
and requires a new certification run. The monthly full production certification
bounds how long a stale green can stand.

**Owner:** engineer. **Opened:** 2026-10-31.
**Closure:** continuous — every vendor build change triggers a new certificate,
so this entry stays open while the vendors ship.

### RR-04 — Taste bias: a small human baseline and a one-rater panel

**Risk.** The human baseline is three to five people and the panel is one rater,
so taste bias is real.

**What it costs.** "Human-anchored" means anchored to a small sample and one
person's ear. The judge's kappa calibrates to that rater, not to a population, so
agreement with the panel is not agreement with the market.

**Fail-closed.** H2 requires at least 40 judgments per Locale, and a panel
samples 12 calls per certification — two per Locale, with every failing call
mandatory. Below the judgment floor the property is unverified, which is a
failure; a certificate without a named, dated panel signature is `pending-human`,
never certified.

**Capture status (2026-10-31).** The baseline is **not captured**. The agent
side is prepared: the session plan and owner runbook are in
`docs/demo-human-baseline.md`, and `npm run demo:baseline:verify` rehashes and
checks a recorded set. The recording is the owner's human gate. Capturing it
does not close this risk: the sample stays three to five people and the panel
one rater.

**Owner:** owner (the rater). **Opened:** 2026-10-31.
**Closure:** the baseline and panel widen beyond one rater — a later decision.
Until then this register records the bias instead of hiding it.

### RR-05 — Staging can drift from production

**Risk.** Staging can drift from production, and the post-flip confirmation is
short.

**What it costs.** The staging certificate gates a production image that is not
byte-identical in its environment, so a production-only failure — vendor region,
routing, TLS — can survive the short confirmation.

**Fail-closed.** A certificate is true only for its target; production never
inherits a staging green. The flip is gated on the same image, the post-flip
confirmation runs the contract's core, and the monthly full production
certification is the backstop. A failed confirmation rolls back through the
routing kill switch, not a deploy.

**Owner:** operator. **Opened:** 2026-10-31.
**Closure:** continuous — bounded by the monthly full production certification.

### RR-06 — A one-instance deploy window refuses new calls

**Risk.** A one-instance deploy window refuses new calls, and a visitor arriving
mid-deploy is out of contract.

**What it costs.** The demo can be unavailable while the product calls itself
ready, and the visitor sees the unavailable state at the moment they were most
willing to try it.

**Fail-closed.** The refusal is the named routing state, never a silent engine
change and never a ring into nothing; the run counts a refused call as a named
refusal (exit 2), never as a measured pass. Deploying outside demo hours is the
runbook mitigation, and load beyond the single-call contract and the drain is
out of scope.

**Owner:** operator. **Opened:** 2026-10-31.
**Closure:** the demo runs on more than one instance, or a zero-refusal deploy
path exists — neither is in this effort.

### RR-07 — Held-out scenarios are process-sealed

**Risk.** Held-out scenarios are sealed by process, not by machine.

**What it costs.** An engineer or agent with repository access can read a
held-out scenario and tune to it. No technical control prevents that, so the
suite's independence is only as strong as the discipline around it.

**Fail-closed.** Held-out scenarios are executed only by certification runs; a
held-out failure may not justify a fix. To fix one, retire it and promote a
replacement from the reserve. If a held-out scenario's content was used while
fixing, its green is void and it is retired. Every certificate cites RR-07, so
the seal's weakness is never implicit.

**Owner:** engineer. **Opened:** 2026-10-31.
**Closure:** continuous — the seal is re-established by retiring and promoting,
never by editing a held-out scenario in place.

## How a certificate cites these

The certificate carries `residualRiskIds`; every applicable id is listed, and a
certificate that cites an id absent from this register, or omits one that still
applies, is refused by name. The register's ids, owners and dates are what the
owner's signature signs over.

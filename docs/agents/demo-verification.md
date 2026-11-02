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
| Scenario runtime and caller corpus | parser, trigger rules, hashed takes, corpus manifest, the ten-scenario English fast contract, the twelve-scenario Locale core | `voni/src/lib/demo/verification/scenarios/` — `types.ts` is the adapter-agnostic record (takes, trigger rules, soundscape, expected property ids, faults); `parse.ts` refuses unknown fields, classes, locales, property ids, takes, triggers and faults by name and enforces the eight held-out names; `triggers.ts` resolves the caller script against the agent timeline deterministically and refuses an unresolved step; `corpus.ts` discovers `<root>/manifest.json` plus one directory per scenario and verifies each take's declared sha256, naming a drifted take; `corpus/` is the committed corpus at version 2 (91 scenarios, 227 real TTS takes): the ten fast-contract scenarios (twenty takes), ticket 13's five comprehension and five emotion scenarios (thirty takes), ticket 14's soundscape/connectivity/meta-security entries (nineteen takes), and ticket 15's `tools-slow-email` plus the sealed held-out `two-tools-in-turn` (five new takes; the three tools scenarios carry seven), ticket 16's forty-eight `locale-<behaviour>-<locale>` scenarios (120 real TTS takes, twelve behaviours on es/fr/de/pt), ticket 20's six resilience edge scenarios (eleven takes, R2–R7), and the three closing English scenarios (`golden-flow-booking`, `turn-taking-overlap`, `caller-hangup-mid-word`; nine takes) that bring English to the spec's 40, and the sealed `sarcastic`, `distressed` and `mispronounced-email` (nine takes) that complete the eight held-out names, and `generate.ts` + `scripts/generate-caller-takes.mts` (`npm run corpus:takes`) record a take once or a deliberate `--retake`; `fast.ts` selects its ten, proves the six call-path capabilities, scopes the verdict (uncited families are `OUT-OF-SCOPE`, never green), and presents the economics owner's settled fast-run check (`economy/run-ceiling.ts`) instead of resolving E3 or summing cost itself; `locale.ts` proves the four Locales hold the same class, triggers, properties, soundscape and fault per behaviour, scopes each Locale's contract, and bounds the 48-call nightly Locale core with the economics owner (a per-Locale full is refused until each Locale has a full set). `facts.ts` resolves each scenario's script to its authored take text for the exactness evaluators. Ticket 19 adds the filler-cut scenario (a cut, then a filler that resumes the tail) and gives a scenario an optional `holdOpenMs` so a greeting-only call is actually held open (32 s) before the harness hangs up. `CALLER-CORPUS.md` records the voice, model and retake rule; `SOUNDSCAPES.md` records the committed television bed and the second-voice/speakerphone scope. The English corpus is complete at 43; all eight held-out names are committed | 10, 12–16, 19, 30 |
| Locale matrix | four Locales judged independently; understanding held as RR-02 until a named native reviewer signs | `voni/src/lib/demo/verification/verdict/locale.ts` — `judgeLocaleMatrix` requires exactly one complete evidence set and twelve calls per Locale at the run's repetition count, refuses a measurement recorded under another Locale or a scenario outside that Locale's core, judges each Locale against its own scoped contract, and returns `pending-human` with RR-02 when `judgeLocaleUnderstanding` has no valid named sign-off; a role word, a malformed date or a missing sample/gold-label id is unverified, never a pass | 16 |
| Protocol adapter | diagnosis runs over the existing live-call socket; never certifies | `voni/scripts/lib/protocol-adapter/` — `refusals.ts` names a missing key, corpus, scenario, vendor build, soundscape or test inbox before any vendor opens, `transport.ts` drives `POST /v1/call-body` + `WS /v1/browser-call` at the browser's 128-sample cadence and keeps the service's captions, `faults.ts` applies the scenario's media faults, `tool-evidence.ts` reads the demo tool log (`voni/src/lib/demo/tool-log.ts`, `tool-log-store.ts`, the `demo_tool_calls` table) and the real inbox by tag (`voni/src/lib/demo/verification/tools/inbox.ts`), `evidence.ts` writes the per-run directory under `voni/.demo-runs/`, `runner.ts` turns one call into one verdict and any provable card; `voni/scripts/protocol-diagnose.mts` accepts a card's replay command unchanged and never returns 0. `npm run demo:inbox:probe` is the read-only live inbox check | 11, 15 |
| Browser adapter | certifying runs on the real page, synthetic mic, delivered WAV, browser marks | `voni/scripts/lib/browser-adapter/` — `refusals.ts` names a fake pipeline, a test build, a missing key, corpus, scenario, vendor build, soundscape or capture sink before Chromium opens; `synthetic-mic.ts` replaces `getUserMedia` from a Playwright init script before app code; `call.ts` builds the one invocation and runs `voni/tests/e2e/browser-adapter.spec.ts`; `evidence.ts` requires the delivered WAV, browser marks, trace and end document to cite one call id — except a scenario with the `mic-denied` edge, which must instead carry R5's named refusal and which names the audio and documents it genuinely never produced — and reads cost from the call's own priced row; the browser report carries the visitor's transcript, joined to the call clock through the client's own per-turn marks, and each caller take's wall-clock start, and `runner.ts` passes the scenario's `expectedProperties` and authored facts to the verdict core; it also reads the demo tool log and the real inbox delivery, so X2/X3/X5/X6/X7/X8/X9 are measurable here when the page rendered the lines, and X4 is measurable only when a tagged email actually reached the test inbox (nothing sends one during a run; see the named gaps); a caption/turn-mark count mismatch withholds the transcript by name rather than guessing a time; `runner.ts` judges the bundle, builds the certificate (exit 0/3) or withholds it by name, and records a parity comparison; `voni/scripts/browser-verify.mts` is the command. Ticket 20 adds the media-fault seam (the scenario's jitter/dropout/latency applied to caller playback at the mic edge, never replayed), the browser-edge vocabulary (`page-freeze`, `page-hidden`, `mic-denied`, `device-switch`, `deploy-drain` in `scenarios/types.ts`), the harness observations R2–R7 read (`edge` on the call bundle), and one producing corpus scenario per property (`resilience-reconnect`, `-hold-return`, `-hidden-page`, `-mic-denied`, `-device-switch`, `-deploy-drain`; R1's are the existing connectivity scenarios) | 17, 20 |
| Evaluator families | L1–L11, T1–T10, C1–C10, K1–K8, X1–X10, A1–A8, R1–R8, S1–S6, E1–E4, H1–H7 | L1–L11 landed in `voni/src/lib/demo/verification/verdict/evaluators/lifecycle.evaluators.ts` with the pure mark/trace/WAV analysis in `verdict/lifecycle/`: L2 compares the connected paint with admission and with the first audible sample, L5 compares config with mic acquisition, L6 judges the bounded voice open and its named unavailable state, L7 and L9 read the delivered WAV (opening breath, goodbye tail and drop), L8 compares the talk-clock mark with the delivered WAV's first voiced sample, L10 judges the named failed-greeting state, and L11 compares the end/end_call order. C1–C10 landed in `verdict/evaluators/conduct.evaluators.ts` with its evidence layer in `evaluators/turn-conduct/`; C2 measures the greeting-only wait and C1 counts an end_call with no caller request. The browser marks now also carry `ringback_start`/`ringback_stop`, `talk_clock_start` and `error_received`; they are dev-only observation. H6 landed in `voni/src/lib/demo/verification/verdict/evaluators/human.evaluators.ts` (judge calibration). S1–S6 landed in `verdict/evaluators/security.evaluators.ts` with the pure scans in `verdict/security/`: S1 judges the injection reply (judge record) and scans the trace/tool log, S2 binds every tool row to its call and subject, S3 counts tool rounds against `tool.loop_cap` and requires a polite ending at the cap, S4 scans caller PII beyond the trace's identities, S5 scans credentials in trace/tool/browser rows, S6 requires two interleaved call traces. E1–E4 landed in `verdict/evaluators/economics.evaluators.ts`: E1/E2/E4 judge one call from its own `cost.priced` row and persisted `end` message; E3 is run-scoped and is judged by the run gate in `voni/src/lib/demo/verification/economics/run-ceiling.ts` (`preflightRunCeiling` before the run, `scopeRunToCeiling` at the end), which narrows E3 to the plan's own ceiling. K5 and K6 are discovered from `verdict/evaluators/locale.evaluators.ts` (same implementations, one owner): K5 in a non-English Locale scans both the trace and the delivered-audio transcript (`evaluators/comprehension/locale.ts`), requires the delivered audio, and cites the offending segment (a turn id or a WAV `@start-end` window); K6 requires a judge finding that names the same Locale and cites its turns. K1–K8 landed in `verdict/evaluators/comprehension.evaluators.ts` with its text layer in `evaluators/comprehension/`: K1 compares the tool argument to the corrected spelled address, K2/K3/K5 read the turn transcript, K4/K6/K7 read the judge's property findings, and K8 compares the caller transcript to the known TTS take text. The protocol adapter keeps the service's captions, so K2/K3/K5/K8 can measure a real run; K1 still needs a tool argument the evidence does not carry, and K8 stays unresolved because no frozen record carries a word-error bar. X1–X10 landed in `verdict/evaluators/tools.evaluators.ts`, reading `voni/src/lib/demo/verification/tools/evidence.ts` (tool log, turn rows, captions), `tools/inbox.ts` (the real test inbox) and the grounded returning-sender judgement; the tool log is the redacted `demo_tool_calls` row written only by the pipeline credential. R1–R8 landed in `verdict/evaluators/resilience.evaluators.ts`: R1 counts a lost turn and a doubled first-audio row from the turn ledger while the scenario's fault ran; R2 requires a reconnect (a trace leg reconnect, the freeze/rejoin edge, or the client's own `reconnect` mark followed by a later `admitted`) with unique turn epochs and one greeting; R3/R4 read the hold record for kept memory, no ring-greeting or ringback, and a stopped talk clock; R5 requires a named mic refusal with no open socket or an observed teardown; R6 accepts a reacquisition or an honest end; R7 requires a finished live call and a second call refused with code `draining`; R8 fails on any `provider_fallback` row and the run gate reports the whole run `ineligible`. R7 is unmeasured until a run has a real drain trial; the browser harness records the condition as unapplied rather than faking a refusal. The protocol adapter refuses any scenario with browser-edge conditions by name, so it is never more permissive. A1–A8 landed in `verdict/evaluators/audio.evaluators.ts` with the pure analysis in `verdict/audio/`: the delivered WAV reader refuses a missing, unreadable or misdescribed file by name, A1/A6 read dropouts, clicks and clipped runs, A3/A5/A8 align the delivered greeting to the committed voice reference, and A7 reads the barge fade against the trace's own `turn.cut` row. T1–T10 landed in `verdict/evaluators/turn-taking.evaluators.ts` with the sample/scene layer in `evaluators/turn-conduct/`: `audio.ts` reads the delivered WAV into voiced segments and content fingerprints, `timeline.ts` anchors the WAV to the page's `first_audible` mark once and places the synthetic microphone's takes on the same wall clock, `evidence.ts` reads the ledger, marks and captions without trusting them. T1 is caller-take end to the delivered response onset (the ack is not a turn row), T2 is the caller final to the reply's `first_audio` row, T3/T6 cite the recorded `turn.cut` and the delivered stop/resume excerpts, T4/T7 count finals against the authored real turns, T5 refuses a repeated filler tail, T8 is the longest uncovered inter-utterance pause, T9 reports the premature-cut ratio and fails closed on a missed end (its two bars carry different units), T10 counts a reply onset inside a caller take. C1–C10 landed in `verdict/evaluators/conduct.evaluators.ts`: C1 reads `endedBy` and the hangup turn plus the caller's `wantsEnd`, C2 measures `first_audible` to teardown (a greeting-only scenario declares `holdOpenMs`), C5 compares the visitor's agent captions because trace rows carry no words by design, C7 measures the WAV tail after the last sample, C8 finds a voiced segment or reply row after the end receipt/hangup, and C3/C4/C6/C9/C10 are judge findings (missing judge = unmeasured). `ScenarioAttempt.expectedProperties` bounds which evaluators run on a scenario; a property no attempt cites still fails closed. L1 and L8 place the delivered WAV's first voiced sample on the call clock from the capture's own start (the tap begins at `microphone_acquired`), judge ringback and the talk clock against that measured time, and refuse a `first_audible` mark that names a different moment; a missing or silent WAV, a missing capture start or a lying mark fails closed instead of trusting the client's intent | 13, 15, 18–22, 26 |
| Machine judges and calibration | two transcript-grounded judges, third-judge/panel escalation, vendor independence, weighted-kappa gate | `voni/src/lib/demo/verification/judges/` — `panel.ts` refuses a judge on the agent's vendor (`AGENT_VENDOR = meta`), scores two judges independently and reconciles a disagreement above one point through a third judge to the panel; `kappa.ts` is the linear weighted-kappa arithmetic; `rubric.ts` hashes the rubric; `calibration.ts` verifies every judge/axis at the frozen `dvJudgeKappaMin` bar and refuses a changed rubric hash; a live judge transport is not landed and is key-gated by `AI_GATEWAY_API_KEY` | 26
| Studio | local-only Record, Rate and Corpus surfaces; never in the deployed build | Record landed in `voni/scripts/studio/`: `take-store.ts` writes one immutable hashed take per landing (`voni/.studio/`, gitignored) on the shared digest in `scenarios/digest.ts`; `dialogues.ts` validates authored prompt cards; `http.ts` serves `record.html` on loopback only and refuses a production environment or host by name; no `src/` file imports it. Rate and Corpus landed in the same process: `rate.ts` builds the blind queue (every failing call ahead of the clean sample, seeded per-session order, A/B sides with a private answer key, seven axes, free text and defect tags), `rating-store.ts` persists attributable sessions and gold labels under `voni/.studio/rating/` and rehashes evidence on every serving, `rate.html` and `corpus.html` are the surfaces, `take-store.ts` retires a take with `retired.json` (never editing the take) and records baseline consent metadata; `selectable()` excludes retired and baseline takes | 23, 24 |
| Human baseline | three to five consented, hashed reference calls, blind comparison only | **captured 2026-11-01**: 3 participants, 6 takes of 4:03–5:04, consented and pinned (RR-04); session plan and owner runbook in `docs/demo-human-baseline.md`; `voni/scripts/studio/baseline.ts` verifies consent references, the 4–6 minute band, rehashed takes, a pinned hash list and non-use as certification input, exposed as `npm run demo:baseline:verify`; `take-store.ts` lists active baseline takes with `baselineTakes()` | 25 |
| Panel and gold labels | blind sample, seven axes, blind A/B, signature, exit 3 | `voni/src/lib/demo/verification/panel/` — `types.ts` fixes the twelve-call sample (two per Locale plus the two worst remaining failing calls, every failing call mandatory) and the gold-label/signature vocabulary; `verdict.ts` computes H1–H5 and H7 from the panel's gold labels against the contract's frozen bars; `run.ts` merges those verdicts into the run. The local-only orchestration is `voni/scripts/studio/panel/` — `session.ts` builds the blind session (every failing call mandatory), `gold-labels.ts` exports attributable labels and their digest, `signature.ts` signs/verifies and completes H7. `voni/scripts/lib/demo-certificate.ts` is `demo:certificate`; an unsigned certificate is `pending-human` and exits 3 | 27 |
| Vendor usage ledger | `demo:usage` reads one terminal run's own priced rows and prints Meta/AssemblyAI quantities, USD per leg and vendor, per-scenario and per-call rows, the measured-vs-plan call count, and a named unmeasured section; it never estimates, never prices with another table, and never prints an unmeasured leg as `$0` | `voni/scripts/demo-usage.mts` is the command; `voni/scripts/lib/usage/` owns it — `evidence.ts` resolves a terminal adapter `run.json` (the adapter writes it only at the end) or a committed certificate's coverage call ids, and joins them to the per-call traces; `ledger.ts` sums the rows' own `amountUsd` and labels reported-but-netted token lines so no rate invites arithmetic the row did not charge; `sums.ts` is the one six-decimal reconciliation; `rates.ts` loads only the committed table a row cites and labels mixed versions; `run-journal.md` is the agreed interface for the next reader, and `readRunJournal` refuses by name until that branch lands | — |
| CLI | `demo:verify`, `demo:studio`, `demo:certificate`; exits 0/1/2/3 | `voni/scripts/demo-verify.mts` is the command; the testable contract is `voni/scripts/lib/verify-cli/` — `args.ts` accepts the three spec forms and a defect card's replay command unchanged, `plan.ts` owns the target/mode/Locale matrix (fast ten ×1; nightly English 43 + Locale core 12 ×4 at one; full the same 91 at three), and `run.ts` preflights keys, corpus and vendor builds as one named exit 2, takes the machine-wide timing lock (a held lock is a named exit 2, never a wait), dispatches diagnose through the protocol adapter and certification through the browser adapter, and issues at most one certificate from a full run. Diagnose never writes a certificate and the protocol adapter's exit 0 is refused. `staging` and `production` refuse by name (no evidence sink). The 43-scenario English and four Locale core corpora have landed, so nightly/full no longer refuse for a corpus; they still refuse before a call for a missing pipeline key; the vendor-build record landed on 2026-11-01 (RR-03). A full run with `--locale` other than `en` is refused by name: only English has the per-Locale full set. A fast or nightly scoped-clean report is exit 1, never a certificate | 28 |
| Streak and cutover | three-clean streak, staging gate, post-flip confirmation, monthly full production | `voni/src/lib/demo/verification/release/` — `streak.ts` judges the latest three committed certificates; `gate.ts` binds a clean staging certificate to the image; `confirmation.ts` bounds the post-flip record to ten calls; `rollback.ts` holds the one value and its zero-session proof; `monthly.ts` owns the cron and the recorded monthly production proof. `voni/scripts/demo-cutover.mts` (`npm run demo:cutover`) is the reader; records live in `voni/evidence/cutover/` | 29 |
| CI cadence | fast contract, nightly health, weekly full certification, Locale matrix | `voni/src/lib/demo/verification/cadence.ts` is the one count source (fast 10, nightly 91, full 273) and the cron constants; `voni/scripts/demo-gate-report.mjs` turns a `demo:verify --json` report into a merge gate that reads the artifact — expected call count, an empty `failedPropertyIds` and `ineligible: false` — before it reads the status, because a clean scoped-pass and a property failure both exit 1; `voni/scripts/demo-cadence-wiring.test.ts` parses `.github/workflows/{ci,nightly,demo-weekly,demo-monthly}.yml` and forbids vendor keys, path filters and timeout-less jobs. The fast job runs on every PR; nightly is English 43 × 1 + Locale core 12 × 1 × 4 = 91 calls; weekly full is the same plan × 3 = 273 with a panel signature still a human act | 30 |

### Release and cutover (ticket 29)

**A streak is three consecutive clean certifications.** The latest three
committed certificates, in run-id order, must all be `certified`, on a clean
tree, with no coverage gap, no run failure, full plan, the same code
fingerprint and one target. A dirty tree, a coverage gap, a different target, a
different fingerprint or a non-certified run in the window breaks it by name.
A single clean certification is nightly health; only the three-clean streak
supports a release or cutover claim.

**The staging gate.** `npm run demo:cutover -- --gate --image <sha256:...>`
opens only on a clean staging certificate for that image, plus the three-clean
staging streak on the same code. It refuses with exit 2 and names the missing
evidence when no staging certificate exists for the image; exit 3 when the
certificate is `pending-human` (the owner's panel and the baseline are human
gates); exit 1 when the evidence is present but red. It never runs a call and
never flips anything. The production flip remains the operator's
`cutover:check --set` action.

**Production never inherits staging.** `assertProductionCertificate` reads a
certificate only under the production expectation, so a staging certificate
cannot stand in for a production one. The gate's own
`production-inheritance` check states the same rule.

**Post-flip confirmation.** After the flip, `voni/evidence/cutover/post-flip-<run-id>.json`
records at most ten calls (the fast contract's core), the image, the staging
certificate it followed, the calls and the evidence directory. It is not a
certificate and never becomes one; a longer record is refused by name. The
monthly full production certification is the claim's backstop (RR-05).

**Rollback is one value.** `off` on the durable routing switch, proven by
`cutover:check -- --prove-off`: the refused call carries `code: "managed"` and
opens zero new vendor sessions. `npm run demo:cutover -- --rollback [--proof <record>]`
prints the one value and refuses an absent proof or a non-zero session count.
It never deploys.

**Monthly full production.** The schedule is one constant,
`0 4 1 * *` UTC (`MONTHLY_PRODUCTION_CRON`); the scheduled workflow must carry
exactly that cron and the workflow-as-code test compares them. The record is
`voni/evidence/cutover/monthly-production.json`: one entry per month, pointing
at a committed production certificate. An empty or certificate-less record is
`pending-human` (exit 3), never green; a stale month is exit 1; a cron drift,
image mismatch or wrong target/plan is exit 2.

**Panel gate.** The human baseline was captured on 2026-11-01 (RR-04) and
ticket 25 is resolved, but the panel owns a signed rating session and none has
been signed. Any gate that needs the panel therefore still refuses by name and
exits 3; it does not fake a staging or production green. There is no staging or
production evidence sink in this repository, so no staging/production run is
claimed here — only local tests and the named refusals.

### The fast contract

The English fast contract is ten committed scenarios at one repetition:
`golden-flow-hello`, `golden-flow-substantive`, `golden-flow-greeting-only`,
`turn-taking-barge`, `turn-taking-filler`, `soundscape-quiet-room`,
`connectivity-jitter`, `tools-email-send`, `ending-goodbye`,
`ending-caller-silence`. It proves greeting, a substantive turn, a barge-in, a
filler, one tool and a goodbye, derived from each scenario's triggers and
expected property ids rather than a second list.

A fast run is deliberately **not** a certificate. It measures the union of the
ten scenarios' expected properties plus the run-scoped E3; every other property
is reported `OUT-OF-SCOPE`, grouped by family (comprehension, human, security
today), and a `scoped-pass` carries `certifiable: false`. E3's
`dvCostFastRunMaxUsd` is judged by the economics run gate, not by a second
verdict path in `fast.ts`; `fast.ts` presents that gate's settled total and
boolean verbatim, and refuses a preflight projection by name. The wall-clock
number is measured and reported, and the gap names the measurement and the
spec's missing bar instead of inventing one or printing a permanent literal. The
corpus is recorded through `npm run corpus:takes` and a changed take refuses by
name unless `--retake <scenario>/<take>` moves the manifest version
deliberately.

The Locale core is twelve behaviours (`golden-flow`, `golden-returning`,
`backchannel`, `barge-clause`, `filler`, `nonsense`, `angry`, `television`,
`jitter`, `goodbye-drain`, `slow-tool`, `code-switch`) on each of es, fr, de and
pt: forty-eight committed scenario directories and 120 real TTS takes. Every
Locale's version of a behaviour must keep the same class, trigger sequence,
property set, soundscape and fault; a translation changes words, never the
measured conduct. A nightly Locale core is 12 calls per Locale at one
repetition and fits E3's `dvCostNightlyRunMaxUsd`; a full plan over all four
Locale cores would be 144 calls at three and fit `dvCostFullRunMaxUsd`, but
`--full --locale <es|fr|de|pt>` refuses by name because only English has a
per-Locale full set (the others hold the twelve-scenario core). Both plans are
preflighted by the economics owner. The amended
ceilings are **fast ≤ $2, nightly ≤ $15, full ≤ $45**. The composed plan ticket
30 runs is nightly English 43 × 1 plus Locale core 12 × 1 on each of four
Locales = 91 calls × the frozen $0.15 per-call cap = **$13.65**, inside $15;
weekly full is the same 91 × 3 = 273 calls = **$40.95**, inside $45. Those
bounds are one source: `scoreboard-budgets.ts` + `.json` (and the contract bar
record moved by `npm run contract:bars -- --write`), never a number in the
workflow. The matrix
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
`voni/evidence/vendor-builds.json` before it opens a vendor (RR-03). The record
landed on 2026-11-01 with the three legs the cascade opens: STT `meta`
`muse-voice-transcribe-1.0`, TTS `assemblyai` `assemblyai-tts-1` and LLM `meta`
`muse-spark-1.3`. The two Meta ids are the vendor's own served model ids
(`GET https://api.meta.ai/v1/models`), and `assemblyai-tts-1` is the model id the
TTS endpoint echoes back and the adapter asserts. A missing, empty, `unknown` or
drifted id still refuses by name; RR-03 stays open because a vendor can move.

### CI cadence (ticket 30)

The cadence is code and the workflows are parsed as code. One source,
`voni/src/lib/demo/verification/cadence.ts`, owns the counts and the two
scheduled crons; `voni/scripts/demo-cadence-wiring.test.ts` compares the
workflow YAML to it and fails by name when a job, wrapper, timeout, schedule or
artifact disappears.

- **Fast contract — merge gate.** `.github/workflows/ci.yml` runs
  `demo:verify --fast` on every pull request and push, with no `paths:` filter
  (running on every change is the superset of every call-path change). A clean
  scoped-pass exits 1 by contract, so `voni/scripts/demo-gate-report.mjs fast`
  reads the JSON and requires ten calls, `failedPropertyIds: []`,
  `ineligible: false` and `status: "scoped-pass"`; anything else fails, and a
  property failure reds even if the status claims scoped-pass. The gate is run
  with `node --import tsx` because it imports the cadence's one count source.
  The required wrapper `required-demo-fast-contract` fails a skipped, cancelled,
  failed or artifact-less job. Branch protection must require the wrapper, not
  the job.
- **Nightly health.** `.github/workflows/nightly.yml` adds
  `demo-nightly-health`: English 43 × 1 plus Locale core 12 × 1 on es, fr, de
  and pt = 91 calls. E3's `dvCostNightlyRunMaxUsd` ($15) is preflighted; at the
  frozen $0.15 cap the plan is $13.65. A clean report is `health-clean` and
  still exit 1, so the gate reads that status; it is a report, not a pass.
  `required-demo-nightly-health` fails an absent key as a named skip
  (`SKIPPED: demo nightly health made no call …`) and never lets a quiet night
  read green.
- **Weekly full.** `.github/workflows/demo-weekly.yml` runs the same plan at
  three repetitions = 273 calls, inside E3's `dvCostFullRunMaxUsd` ($45;
  $40.95 at the cap), on Mondays. It uploads the certificate and the run
  artifacts. A certificate is `pending-human` until the owner rates the panel
  and signs it; the gate accepts `certified` or `pending-human` **only with a
  certificate**, prints PENDING-HUMAN and is not a pass. The panel is still a
  human act.
- **Monthly full production.** `.github/workflows/demo-monthly.yml` carries
  `MONTHLY_PRODUCTION_CRON` (`0 4 1 * *`). It tries the full production target
  and records the month; both refuse by name today (no production evidence
  sink, no credentials), and the required wrapper fails. The empty
  `voni/evidence/cutover/monthly-production.json` is `pending-human` (exit 3),
  never a green month.
- **Artifacts.** Audio, traces, delivered WAVs, browser marks and per-run
  directories stay in `voni/.demo-runs/` and are uploaded as CI artifacts only.
  Only the certificate under `voni/evidence/certificates/` is committed. The
  workflow test asserts the `.gitignore` patterns and that no workflow stages
  or uploads the evidence directories as commits.
- **Corpus completeness.** The committed English corpus now holds all 43
  scenarios a nightly/full run is defined over (the four Locale cores are
  complete at twelve each), so `planVerify` reports no corpus gap and the
  nightly/full plan is 91/273 calls. `demo:verify` still refuses before a call
  for a missing pipeline key (the vendor-build record itself landed on
  2026-11-01); those are environment refusals, not a smaller plan reading
  green.
  The fast contract's ten scenarios are all present, and all eight held-out
  names are committed with real takes (`sarcastic`, `distressed` and
  `mispronounced-email` completed the seal). Adding the three sealed scenarios
  made English 43 and moved the plan to 91/273 calls.
- **Ticket 25 exception.** The panel/baseline are human gates; a missing
  signature or an unpinned baseline is `pending-human` (exit 3) and is not
  papered over by a merged certificate. No staging or production run is
  claimed in this repository.

### Browser adapter: what a local certificate can and cannot say

- The certifying browser run serves the app in **dev mode**, because the
  delivered WAV and the browser marks are written by the app's dev-only capture
  path (ticket 05). A `staging` or `production` target has no such sink, so the
  adapter refuses it by name (`target-invalid` / `capture-unavailable`) instead
  of inventing evidence. A local certificate is true for the dev-mode app;
  production certification needs an evidence sink production does not expose yet.
- The run refuses at preflight when `voni/evidence/vendor-builds.json` is
  missing, records an `unknown` id, or reports a `unversioned` pipeline build
  (RR-03). The 2026-10-31 live rehearsal refused there; the committed record
  landed on 2026-11-01, so only a missing pipeline key still stops a local run.
- **The microphone is gated on the service's first audio.** The connect takes
  seconds (mint, admission, vendor handshake) and the mic is live for all of it.
  Frames from that window are now held rather than forwarded: the service used
  to deliver them as one backlog when the session opened, and the vendor closes
  a stream that arrives ahead of real time ("Audio processing backlog too
  large"). A resumed call speaks no greeting, so `MIC_GATE_FALLBACK_MS` (8 s)
  opens the gate even when no audio ever arrives.
- **A call that produced no evidence is re-made once (owner amendment,
  2026-11-02).** A 273-call run aborts on the first call without evidence, and
  at the observed ~1% per-call fault rate a clean run was a fraction of a
  percent — an infrastructure hiccup, not a result, cost the whole run. A
  refusal code `marks-missing` or `call-refused` means nothing was measured, so
  the call is made once more and both attempts are named in the run; the second
  refusal stands, unretried. A call that ran and failed (`trigger-unresolved`,
  a below-bar property, a dropping socket after turns) is never re-made: that
  would be the retry-to-green the spec forbids. A completed run's
  `VerifyResult.retries` lists every re-made call.
- **Two rate limits bound a local run, and neither is a defect.** The app's
  demo token limiter is per IP per hour (`DEMO_MAX_PER_IP_PER_HOUR`, 3 by
  default); a verification stack must raise it above the plan's call count, or
  the second run of the day mints `429` and Chromium never opens the call. The
  TTS vendor allows **five synthesis sessions per minute per account**; the
  fast contract's ten calls at their natural length sit at about three per
  minute, and a full run at about one and a half, but back-to-back short calls
  (or a diagnose loop beside a run) trip it and the call ends with the vendor's
  `3009` refusal. One run at a time, with its calls at natural length, stays
  inside both. `collectCalls` therefore paces call starts at
  `DEFAULT_CALL_INTERVAL_MS` (30 s, override `DEMO_VERIFY_CALL_INTERVAL_MS`);
  the wait is pacing before a call, never a retry of one, so it cannot turn a
  failure green.
- A completed run whose `cost.priced` row is unmeasured **withholds** the
  certificate (`cost-missing`) and keeps the verdict and cards. The 2026-10-31
  live rehearsal observed the STT `audio_seconds` and the TTS termination summary
  unmeasured, so its certificate was withheld; this is a pipeline evidence gap,
  not a browser-adapter pass.
- Every family has a discovered evaluator, but a property whose evidence is
  absent still fails closed (for example the judge-backed conduct rows), so a
  browser run's verdict is `not-demo-ready` until its evidence lands; the run
  names each unmeasured property rather than passing it. A diagnose run measures one repetition and
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

The tools fast scenario cues its asking line at the agent's turn end, never at
call-open: the app drops microphone frames until the service's first audio, so a
line spoken before admission is never heard and the model cannot reach the tool
turn. A model tool request is bound to the `service` credential; the browser's
own `check_email` poll is logged under `browser` and filtered out, so X4 cannot
pass on the page's poll alone.

`comprehension-ambiguous-request` follows the same rule: its first line waits
for the agent's turn, never call-open. A call-open take played before the
greeting's first audio, was mostly dropped by the mic gate, and cut the
greeting; the cut made the vendor close the idle synthesis session.

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
  `turn.hangup reason=end_call` and no caller end request. L9 additionally
  measures the delivered WAV's last run against the goodbye's synthesized length
  in the end message and reports both the played percentage and the drop delay;
  the fixture's 1200 ms goodbye is cut after 400 ms.

A synthesis reconnect is a handover only after the new session's `Begin` is
asserted. A failed handshake leaves the adapter asking for another reconnect,
never an open session: call 5f4db146 transcribed the caller's second take,
generated the reply, and then raised `the synthesis session is not open` from a
reconnect whose handshake had failed, so the turn was captioned but silent. The
next speak now opens a session instead of treating the closed adapter as open.

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
- **Reconnect is the browser's rejoin, plus one bounded client retry.** The
  demo client rejoins the same call id after a freeze/return; R2 proves the
  trace's turn epochs continue and one greeting is spoken. After an unexpected
  transport drop on a live call it now re-mints the resume body for the same
  call id through the one mint route (carrying the bounded history), opens one
  replacement socket inside the recorded `reconnect.handshake_ms` bound, and
  sends config; the resume body omits the greeting, so nothing is replayed. It
  marks `reconnect` (reason, attempt) and, when the one attempt cannot resume,
  `reconnect_failed` (cause) before ending the call. A second drop or a caller's
  `stop()` never reconnects, and a connect failure before admission keeps the
  named refusal. This is proven by fakes only: no live run has yet observed a
  transport drop, so R2 remains unmeasured until one does.
- **R8 is a run gate, not a scenario, and has no production emitter.** Every
  call's trace is scanned for `provider_fallback`; the mandatory proof is a
  contaminated browser run whose verdict is `ineligible` and whose certificate
  can never pass. No pipeline row writes `provider_fallback` today, so a real
  fallback would not fire the row: the gate is proven by fixture, and the
  property is recorded as unproduced rather than claimed from a live call
  (owner: engineer; because the cascade does not emit the event yet).
- **Mic denial has no delivered WAV, and that is the expected evidence.** A
  denied call never acquires the mic, so the playout tap writes no capture and
  the pipeline may write no trace or end document. For a scenario carrying the
  `mic-denied` edge (and only that edge) the browser adapter assembles refusal
  evidence instead of refusing `capture-missing`: it reads whichever of marks,
  trace and end genuinely exist, binds them to the call id, names the absent
  capture, trace, end and priced cost as gaps, and never invents a WAV, a mark
  or a trace row. The call is refused by name (`mic-refusal-missing`) when the
  observation R5 reads is absent — no `micDenied` record, no named refusal, or
  a call socket still open with no observed teardown. R5 and the adapter share
  `judgeMicDenial`, so a denied call can never pass on the absence of evidence
  alone; every other scenario keeps the hard `capture-missing` refusal.
  A denied call that reached no service opened no session: no audio, token or
  character was spent, so its `cost.priced` row is a measured zero with no legs
  (`totalUsd: 0`), citing the committed rate table and the reason "no session
  opened (the app refused before any vendor call)". E1 and E2 read that row as
  zero usage and zero price, and the run total includes it without inventing a
  price. A denied call that did reach the service and wrote no priced row stays
  a named gap and withholds the certificate (`cost-missing`); R5 itself is
  judged from the refusal evidence and is not weakened.

### Soundscape and security evidence gaps

Ticket 14 added the soundscape, connectivity and meta/security scenarios (class
totals 4/3/3) and the S1–S6 evaluators. The gaps are recorded rather than
papered over:

- **Television media (closed).** `voni/evidence/soundscapes/television.wav` is
  committed with a sidecar, and the loader refuses a missing, unreadable,
  misdescribed or drifted pair by name. The five scenarios that name
  `television` run with a real bed; `quiet-room` remains digital silence. See
  "The committed television bed" below and
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

### The committed television bed

`voni/evidence/soundscapes/television.wav` is a 30 s, 24 kHz mono PCM16 excerpt
of the owner-supplied television audio, captured on 2026-11-02 from
`https://www.youtube.com/watch?v=-q4pH8bZ1SU` (audio track extracted with
`yt-dlp`, 30 s at 3240 s, the track's median-loudness window). Its sha256 is
`a316dddb809522868808d76b23f2988d460f90f6db0d891e130dfdb16b4867ab`; the sidecar
`television.json` records the source, window, rights note and what the bed is
not. `voni/scripts/lib/soundscapes.ts` loads the pair, validates id, file name,
rate, channels, bit depth, duration and hash against the decoded WAV, and
refuses a missing, unreadable, misdescribed or drifted file by name
(`soundscape-missing`, `soundscape-unreadable`, `soundscape-sidecar-invalid`,
`soundscape-audio-mismatch`) with the path and the reproduction command. It
never resamples.

`demo:verify` and `demo:certify:browser` load the map once and pass it as the
adapter's `soundscapes`. The protocol seam mixes the bed under the caller's
uplink at the scenario's declared level; the browser harness loops it into the
synthetic microphone's bus. The five scenarios that name it are
`soundscape-television` and `locale-television-{de,es,fr,pt}`. It is mixed
ambience only: never evidence of Voni's own audio and never a reference for a
property. The rights decision for committing this excerpt is the owner's.

### Audio evidence gaps

Ticket 21 measures A1–A8 from the delivered WAV and the committed voice
reference. Six limits are recorded rather than papered over:

- **A3/A5/A8 name a call that ended mid-line.** The capture holds what the
  playout rendered, so a call that hangs up with audio still queued delivers a
  complete, short file. The comparison reads the end document's
  `greeting.audioBytes` at `sampleRate` and the `delivered_capture` mark's
  `complete` report and refuses with `call-ended` ("the line was cut by the
  call's end, not lost by the tap"); a capture that did not report complete
  still refuses as `truncated`. Both are unmeasured; neither is a pass.

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
- **A5's distortion residual needs the same waveform, and a live greeting is a
  fresh synthesis.** The residual subtracts the reference from the delivered
  signal, so it is defined only for a copy (resampled, delayed, at another
  gain); the axis now reports `unmeasured` with the measured correlation when
  the pair shares no waveform. That is the live case: the streaming vendor is
  not reproducible — two live greetings of the same line, minutes apart, agree
  at |ρ| ≈ 0.005, and a live greeting against the committed reference at
  |ρ| ≈ 0.05–0.16 — so no committed reference can carry this axis until a
  same-PCM reference is pinned per render. The bar is unchanged; the axis
  refuses instead of reporting `1/correlation` as distortion.
- **A2 checks the capture's exact format, not a semantic stream rate.** The
  delivered file must be PCM16 mono and its declared description must agree
  with its header; a trace naming more than one stream rate is a mismatch. The
  device rate is allowed to differ from the stream rate because the worklet
  resamples, so A2 does not compare the two.
- **A6's overrun is the device overload.** A6 counts underruns as dropouts and
  overruns as runs of full-scale samples. It does not have a playout level-report
  artifact: the worklet's queue/cushion reports are not persisted with the call,
  so a starvation that leaves no audible hole cannot be named as an underrun.
  The underrun leg also ignores the silence a *cancelled greeting* leaves: when
  the end document says the greeting was cancelled and the hole begins where
  the greeting's produced audio (`audioBytes` at `sampleRate`) ran out from its
  first non-zero sample, that hole is a turn boundary — a caller who spoke over
  the greeting — and the detail names it. A hole anywhere else is still counted,
  and the bar stays zero.
- **A7 needs a recorded barge-in.** A7 reads the fade only when the trace has a
  `turn.cut` row with `reason: "barge_in"`; a call with no cut is
  `no barge-in cut was recorded`, never a pass. The fade is measured on the
  delivered file, so the trace's clock never has to align with sample zero.

### Named gaps with no producer (record-only)

These are recorded, not fixed. Each names the owner and why the instrument
fails closed; none may be relabelled as a pass.

- **No staging or production evidence sink.** The delivered WAV, browser marks
  and per-call trace are written by the local dev capture path only. Gate,
  monthly and post-flip runs stay named refusals (exit 2), never a certificate
  with a borrowed sink. Owner: engineer (a production capture sink is a later
  build).
- **No live judge transport.** The machine judges read a judge record, but no
  adapter calls a judge model; `AI_GATEWAY_API_KEY` gates a transport that is
  not landed. C3, C4, C6, C9, C10 (conduct), X10 (returning-sender memory) and
  H6 (calibration) stay fail-closed: a missing finding is `unmeasured`, which
  the verdict fails. Owner: engineer (the transport is out of this effort).
- **X4 needs a tagged outbound email the harness does not send.** The inbox is
  re-read by the call's Test tag, but nothing emails the test inbox with that
  tag during a run; X4 is unverified until a person sends it. Owner: operator
  (and the runbook names the step).
- **R8's event has no production emitter.** See the resilience section: the
  gate is proven by a fixture, because the cascade writes no
  `provider_fallback` row. Owner: engineer.
- **A6 has no playout level-report artifact.** The worklet's queue/cushion
  reports are not persisted, so A6 measures clipping (overruns) as a proxy and
  cannot name a starvation that leaves no audible hole. Owner: engineer.
- **T5 has no live filler-resume wiring.** The evaluator reads a filler-cut
  record the browser harness does not produce end to end, so a real call's T5
  stays unmeasured. Owner: engineer (the client resume path is a later build).
- **R7 drain needs an operator/service decision; R2's client reconnect is built
  but unobserved live.** The harness can drop the page or rejoin the same call
  id, but it cannot start a service drain, and no real run has yet dropped a live
  transport socket. The client now retries once (bounded and marked, fakes
  only), but R2 stays `unmeasured` until a run observes a real drop and rejoin.
  Owner: operator (drain window) and engineer (a live drop observation).
- **The television bed is committed; its rights decision is the owner's.**
  `soundscape-television` and the four `locale-television-*` scenarios mix
  `voni/evidence/soundscapes/television.wav` under the caller. The bed is
  ambience, never evidence of Voni's audio; a missing or drifted pair refuses by
  name rather than substituting `quiet-room` (digital silence). The owner
  carries the decision for committing the excerpt. Owner: owner (rights).
- **A per-Locale full set exists only for English.** The es, fr, de and pt
  corpora hold the twelve-behaviour core, not the full set, so
  `--full --locale <es|fr|de|pt>` refuses by name instead of issuing a full
  certificate whose Locale coverage is a core. Owner: engineer (the missing
  Locale scenarios are a corpus build, not a harness shortcut).
- **Vendor drift (RR-03) is detection, not prevention.** The committed record
  names the builds the run used, but a vendor can move a model behind the same
  name; only a fresh certification detects it. Owner: engineer.

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
| RR-04 | The captured human baseline is three people (six takes) and the panel is one rater, so taste bias is real | owner | 2026-10-31 |
| RR-05 | Staging can drift from production; the post-flip confirmation is short | operator | 2026-10-31 |
| RR-06 | A one-instance deploy window refuses new calls; a visitor arriving mid-deploy is out of contract | operator | 2026-10-31 |
| RR-07 | Held-out scenarios are sealed by process, not by machine | engineer | 2026-10-31 |
| RR-08 | The class census and the run plan are not the spec's shape: six resilience-edge scenarios are counted under `connectivity` (9, not 3), no scenario uses the spec's `locale` class, and the owner amendment moved English to 43 and the plan to 91/273 calls ($13.65/$40.95 under the amended $15/$45 ceilings) | engineer | 2026-10-31 |

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
is never recorded as `unknown`. The record committed on 2026-11-01 pins the
builds of that day; it is evidence, not a promise that the vendor still serves
them. A changed build id invalidates the certificate
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

**Capture status (2026-11-01).** Captured: three consenting participants
(`participant-01`…`participant-03`), two calls each, six takes of 4:03–5:04,
each with a consent pointer beside it and a pinned digest in
`voni/.studio/baseline-hashes.json`; `npm run demo:baseline:verify` reproduces
the list with exit 0. The session plan and owner runbook stay in
`docs/demo-human-baseline.md`.

**Why it stays open.** The sample is three people and the panel is one rater, so
the preference axis is anchored to three ears, not to a population. H5 is still
unverified until a signed panel rates calls against this audio; the baseline
audio being present is a prerequisite, not the measurement.

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

### RR-08 — The class census deviates from the spec

**Risk.** The spec's ten-class census (golden flow 4, turn-taking 8,
comprehension 5, emotion 5, soundscape 4, connectivity 3, meta/security 3,
ending 3, tools 3, Locale 2) is not the committed corpus's shape. Two deviations
are deliberate and named here instead of hidden: ticket 20's six resilience-edge
scenarios (R2–R7) are filed under `connectivity`, which therefore holds nine
rather than three, and no scenario uses the spec's `locale` class at all: the
Locale core is the 48 non-English scenarios on es, fr, de and pt, and each is
classed by its behaviour (`emotion`, `turn-taking`, and so on). The sealed
additions also move comprehension to 6 and emotion to 7, and the turn-taking
class holds 4 against the spec's 8.

**Owner amendment, 2026-10-31 — the plan and its cost moved with the corpus.**
This entry records the plan delta, not only the class census. Three sealed
scenarios (`sarcastic`, `distressed`, `mispronounced-email`) were added beyond
the spec's 40 to complete the eight held-out names, so the English corpus is
**43**. The nightly plan is therefore **91 calls** (English 43 + Locale core
12 x 4) and the weekly full plan is **273** (the same plan x 3), where the
spec's 40-scenario table describes 88 and 264. At the frozen $0.15 per-call cap
that is **$13.65 nightly** and **$40.95 full**, inside the amended E3 ceilings
of **$15** and **$45** (the spec's E3 table says $10 and $30). Corpus growth,
plan size and the ceiling amendment are one owner decision; a certificate
therefore cites this risk for its coverage *and* its plan/cost shape.

**What it costs.** A reader comparing the certificate's coverage to the spec's
census table sees a different shape, and a reader comparing the plan to the
spec's 88/264 calls sees 91/273. A coverage claim must be read from the corpus
and the certificate, not from the spec's class counts, and no class count in
this map is a coverage promise. The cost ceilings are the contract's frozen
amendment, not the spec's table.

**Fail-closed.** `class-corpus.test.ts` asserts the committed shape exactly, so
a class cannot silently grow or shrink. The reviews and the certificate report
the corpus's own classes; they never restate the spec's census as if it were the
committed set.

**Owner:** engineer. **Opened:** 2026-10-31.
**Closure:** the corpus either matches the spec's census (scenarios moved or
added so each class holds its spec count) or the spec's census table is amended
to the committed shape; until then this entry stays open.

## How a certificate cites these

The certificate carries `residualRiskIds`; every applicable id is listed, and a
certificate that cites an id absent from this register, or omits one that still
applies, is refused by name. The register's ids, owners and dates are what the
owner's signature signs over.

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
| Scenario runtime and caller corpus | parser, trigger rules, hashed takes, corpus manifest, the ten-scenario English fast contract, the twelve-scenario Locale core | `voni/src/lib/demo/verification/scenarios/` — `types.ts` is the adapter-agnostic record (takes, trigger rules, soundscape, expected property ids, faults); `parse.ts` refuses unknown fields, classes, locales, property ids, takes, triggers and faults by name and enforces the eight held-out names; `triggers.ts` resolves the caller script against the agent timeline deterministically and refuses an unresolved step; `corpus.ts` discovers `<root>/manifest.json` plus one directory per scenario and verifies each take's declared sha256, naming a drifted take; `corpus/` is the committed corpus at version 1: the ten fast-contract scenarios (twenty real TTS takes), ticket 13's five comprehension and five emotion scenarios (thirty real TTS takes), ticket 14's soundscape/connectivity/meta-security entries (class totals soundscape 4, connectivity 3, meta/security 3; nineteen real TTS takes), and ticket 16's forty-eight `locale-<behaviour>-<locale>` scenarios (120 real TTS takes, twelve behaviours on es/fr/de/pt), and `generate.ts` + `scripts/generate-caller-takes.mts` (`npm run corpus:takes`) record a take once or a deliberate `--retake`, speaking the scenario's Locale; `fast.ts` selects its ten, proves the six call-path capabilities, scopes the verdict (uncited families are `OUT-OF-SCOPE`, never green), and reads the fast cost ceiling from E3; `locale.ts` proves the four Locales hold the same class, triggers, properties, soundscape and fault per behaviour, scopes each Locale's contract, and bounds the 48-call nightly / 144-call full plans with the economics owner. `facts.ts` resolves each scenario's script to its authored take text for the exactness evaluators. `CALLER-CORPUS.md` records the voice, model, Locale and retake rule; `SOUNDSCAPES.md` records the television gap and the second-voice/speakerphone scope. The remaining twelve English scenarios are not landed | 10, 12–16 |
| Locale matrix | four Locales judged independently; understanding held as RR-02 until a named native reviewer signs | `voni/src/lib/demo/verification/verdict/locale.ts` — `judgeLocaleMatrix` requires exactly one complete evidence set and twelve calls per Locale at the run's repetition count, refuses a measurement recorded under another Locale or a scenario outside that Locale's core, judges each Locale against its own scoped contract, and returns `pending-human` with RR-02 when `judgeLocaleUnderstanding` has no valid named sign-off; a role word, a malformed date or a missing sample/gold-label id is unverified, never a pass | 16 |
| Protocol adapter | diagnosis runs over the existing live-call socket; never certifies | `voni/scripts/lib/protocol-adapter/` — `refusals.ts` names a missing key, corpus, scenario, vendor build or soundscape before any vendor opens, `transport.ts` drives `POST /v1/call-body` + `WS /v1/browser-call` at the browser's 128-sample cadence, `faults.ts` applies the scenario's media faults, `evidence.ts` writes the per-run directory under `voni/.demo-runs/`, `runner.ts` turns one call into one verdict and any provable card; `voni/scripts/protocol-diagnose.mts` accepts a card's replay command unchanged and never returns 0 | 11 |
| Browser adapter | certifying runs on the real page, synthetic mic, delivered WAV, browser marks | `voni/scripts/lib/browser-adapter/` — `refusals.ts` names a fake pipeline, a test build, a missing key, corpus, scenario, vendor build, soundscape or capture sink before Chromium opens; `synthetic-mic.ts` replaces `getUserMedia` from a Playwright init script before app code; `call.ts` builds the one invocation and runs `voni/tests/e2e/browser-adapter.spec.ts`; `evidence.ts` requires the delivered WAV, browser marks, trace and end document to cite one call id and reads cost from the call's own priced row; `runner.ts` judges the bundle, builds the certificate (exit 0/3) or withholds it by name, and records a parity comparison; `voni/scripts/browser-verify.mts` is the command | 17 |
| Evaluator families | L1–L11, T1–T10, C1–C10, K1–K8, X1–X10, A1–A8, R1–R8, S1–S6, E1–E4, H1–H7 | H6 landed in `voni/src/lib/demo/verification/verdict/evaluators/human.evaluators.ts` (judge calibration). S1–S6 landed in `verdict/evaluators/security.evaluators.ts` with the pure scans in `verdict/security/`: S1 judges the injection reply (judge record) and scans the trace/tool log, S2 binds every tool row to its call and subject, S3 counts tool rounds against `tool.loop_cap` and requires a polite ending at the cap, S4 scans caller PII beyond the trace's identities, S5 scans credentials in trace/tool/browser rows, S6 requires two interleaved call traces. E1–E4 landed in `verdict/evaluators/economics.evaluators.ts`: E1/E2/E4 judge one call from its own `cost.priced` row and persisted `end` message; E3 is run-scoped and is judged by the run gate in `voni/src/lib/demo/verification/economics/run-ceiling.ts` (`preflightRunCeiling` before the run, `scopeRunToCeiling` at the end), which narrows E3 to the plan's own ceiling. K1–K8 landed in `verdict/evaluators/comprehension.evaluators.ts` with its text layer in `evaluators/comprehension/`: K1 compares the tool argument to the corrected spelled address, K2/K3 read the turn transcript, K4/K6/K7 read the judge's property findings, and K8 compares the caller transcript to the known TTS take text. K5 in a non-English Locale scans both the trace and the delivered-audio transcript (`evaluators/comprehension/locale.ts`), requires the delivered audio, and cites the offending segment (a turn id or a WAV `@start-end` window); K6 requires a judge finding that names the same Locale and cites its turns. The protocol adapter does not capture a transcript, delivered-audio transcript or tool arguments yet, so every K text property is unmeasured on a real run (fail closed, not a stub); K8 stays unresolved because no frozen record carries a word-error bar. Non-English understanding remains RR-02 until a named native reviewer signs. The other families are not landed | 13, 18–22, 26 |
| Machine judges and calibration | two transcript-grounded judges, third-judge/panel escalation, vendor independence, weighted-kappa gate | `voni/src/lib/demo/verification/judges/` — `panel.ts` refuses a judge on the agent's vendor (`AGENT_VENDOR = meta`), scores two judges independently and reconciles a disagreement above one point through a third judge to the panel; `kappa.ts` is the linear weighted-kappa arithmetic; `rubric.ts` hashes the rubric; `calibration.ts` verifies every judge/axis at the frozen `dvJudgeKappaMin` bar and refuses a changed rubric hash; a live judge transport is not landed and is key-gated by `AI_GATEWAY_API_KEY` | 26 |
| Studio | local-only Record, Rate and Corpus surfaces; never in the deployed build | Record landed in `voni/scripts/studio/`: `take-store.ts` writes one immutable hashed take per landing (`voni/.studio/`, gitignored) on the shared digest in `scenarios/digest.ts`; `dialogues.ts` validates authored prompt cards; `http.ts` serves `record.html` on loopback only and refuses a production environment or host by name; no `src/` file imports it. Rate and Corpus landed in the same process: `rate.ts` builds the blind queue (every failing call ahead of the clean sample, seeded per-session order, A/B sides with a private answer key, seven axes, free text and defect tags), `rating-store.ts` persists attributable sessions and gold labels under `voni/.studio/rating/` and rehashes evidence on every serving, `rate.html` and `corpus.html` are the surfaces, `take-store.ts` retires a take with `retired.json` (never editing the take) and records baseline consent metadata; `selectable()` excludes retired and baseline takes | 23, 24 |
| Human baseline | three to five consented, hashed reference calls, blind comparison only | prepared, **not captured** (human gate): session plan and owner runbook in `docs/demo-human-baseline.md`; `voni/scripts/studio/baseline.ts` verifies consent references, the 4–6 minute band, rehashed takes, a pinned hash list and non-use as certification input, exposed as `npm run demo:baseline:verify`; `take-store.ts` lists active baseline takes with `baselineTakes()` | 25 |
| Panel and gold labels | blind sample, seven axes, blind A/B, signature, exit 3 | `voni/src/lib/demo/verification/panel/` — `types.ts` fixes the twelve-call sample (two per Locale plus the two worst remaining failing calls, every failing call mandatory) and the gold-label/signature vocabulary; `verdict.ts` computes H1–H5 and H7 from the panel's gold labels against the contract's frozen bars; `run.ts` merges those verdicts into the run. The local-only orchestration is `voni/scripts/studio/panel/` — `session.ts` builds the blind session (every failing call mandatory), `gold-labels.ts` exports attributable labels and their digest, `signature.ts` signs/verifies and completes H7. `voni/scripts/lib/demo-certificate.ts` is `demo:certificate`; an unsigned certificate is `pending-human` and exits 3 | 27 |
| CLI | `demo:verify`, `demo:studio`, `demo:certificate`; exits 0/1/2/3 | not landed | 28 |
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
E3's `dvCostNightlyRunMaxUsd`; a full run is 144 calls at three and fits
`dvCostFullRunMaxUsd` (both preflighted by the economics owner). The matrix
judges each Locale from its own twelve calls only: a borrowed measurement, a
missing call or a scenario from another Locale is `ineligible`. Conduct and
timing may pass on machine evidence; understanding cannot be claimed without a
named native reviewer, so the Locale is `pending-human` with RR-02 rather than
certified.

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

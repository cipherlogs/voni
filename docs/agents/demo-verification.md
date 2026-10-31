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
| Scenario runtime and caller corpus | parser, trigger rules, hashed takes, corpus manifest, the ten-scenario English fast contract | `voni/src/lib/demo/verification/scenarios/` — `types.ts` is the adapter-agnostic record (takes, trigger rules, soundscape, expected property ids, faults); `parse.ts` refuses unknown fields, classes, locales, property ids, takes, triggers and faults by name and enforces the eight held-out names; `triggers.ts` resolves the caller script against the agent timeline deterministically and refuses an unresolved step; `corpus.ts` discovers `<root>/manifest.json` plus one directory per scenario and verifies each take's declared sha256, naming a drifted take; `corpus/` is the committed English fast corpus (ten scenarios, twenty real TTS takes, version 1) and `generate.ts` + `scripts/generate-caller-takes.mts` (`npm run corpus:takes`) record a take once or a deliberate `--retake`; `fast.ts` selects the ten, proves the six call-path capabilities, scopes the verdict (uncited families are `OUT-OF-SCOPE`, never green), and reads the fast cost ceiling from E3. `CALLER-CORPUS.md` records the voice, model and retake rule. Locale corpora and the remaining thirty English scenarios are not landed | 10, 12–16 |
| Protocol adapter | diagnosis runs over the existing live-call socket; never certifies | `voni/scripts/lib/protocol-adapter/` — `refusals.ts` names a missing key, corpus, scenario, vendor build or soundscape before any vendor opens, `transport.ts` drives `POST /v1/call-body` + `WS /v1/browser-call` at the browser's 128-sample cadence, `faults.ts` applies the scenario's media faults, `evidence.ts` writes the per-run directory under `voni/.demo-runs/`, `runner.ts` turns one call into one verdict and any provable card; `voni/scripts/protocol-diagnose.mts` accepts a card's replay command unchanged and never returns 0 | 11 |
| Browser adapter | certifying runs on the real page, synthetic mic, delivered WAV, browser marks | `voni/scripts/lib/browser-adapter/` — `refusals.ts` names a fake pipeline, a test build, a missing key, corpus, scenario, vendor build, soundscape or capture sink before Chromium opens; `synthetic-mic.ts` replaces `getUserMedia` from a Playwright init script before app code; `call.ts` builds the one invocation and runs `voni/tests/e2e/browser-adapter.spec.ts`; `evidence.ts` requires the delivered WAV, browser marks, trace and end document to cite one call id and reads cost from the call's own priced row; `runner.ts` judges the bundle, builds the certificate (exit 0/3) or withholds it by name, and records a parity comparison; `voni/scripts/browser-verify.mts` is the command | 17 |
| Evaluator families | L1–L11, T1–T10, C1–C10, K1–K8, X1–X10, A1–A8, R1–R8, S1–S6, E1–E4, H1–H7 | H6 landed in `voni/src/lib/demo/verification/verdict/evaluators/human.evaluators.ts` (judge calibration). E1–E4 landed in `verdict/evaluators/economics.evaluators.ts`: E1/E2/E4 judge one call from its own `cost.priced` row and persisted `end` message; E3 is run-scoped and is judged by the run gate in `voni/src/lib/demo/verification/economics/run-ceiling.ts` (`preflightRunCeiling` before the run, `scopeRunToCeiling` at the end), which narrows E3 to the plan's own ceiling. The other families are not landed | 18–22, 26 |
| Machine judges and calibration | two transcript-grounded judges, third-judge/panel escalation, vendor independence, weighted-kappa gate | `voni/src/lib/demo/verification/judges/` — `panel.ts` refuses a judge on the agent's vendor (`AGENT_VENDOR = meta`), scores two judges independently and reconciles a disagreement above one point through a third judge to the panel; `kappa.ts` is the linear weighted-kappa arithmetic; `rubric.ts` hashes the rubric; `calibration.ts` verifies every judge/axis at the frozen `dvJudgeKappaMin` bar and refuses a changed rubric hash; a live judge transport is not landed and is key-gated by `AI_GATEWAY_API_KEY` | 26 |
| Studio | local-only Record, Rate and Corpus surfaces; never in the deployed build | Record landed in `voni/scripts/studio/`: `take-store.ts` writes one immutable hashed take per landing (`voni/.studio/`, gitignored) on the shared digest in `scenarios/digest.ts`; `dialogues.ts` validates authored prompt cards; `http.ts` serves `record.html` on loopback only and refuses a production environment or host by name; no `src/` file imports it. Rate and Corpus landed in the same process: `rate.ts` builds the blind queue (every failing call ahead of the clean sample, seeded per-session order, A/B sides with a private answer key, seven axes, free text and defect tags), `rating-store.ts` persists attributable sessions and gold labels under `voni/.studio/rating/` and rehashes evidence on every serving, `rate.html` and `corpus.html` are the surfaces, `take-store.ts` retires a take with `retired.json` (never editing the take) and records baseline consent metadata; `selectable()` excludes retired and baseline takes | 23, 24 |
| Human baseline | three to five consented, hashed reference calls, blind comparison only | prepared, **not captured** (human gate): session plan and owner runbook in `docs/demo-human-baseline.md`; `voni/scripts/studio/baseline.ts` verifies consent references, the 4–6 minute band, rehashed takes, a pinned hash list and non-use as certification input, exposed as `npm run demo:baseline:verify`; `take-store.ts` lists active baseline takes with `baselineTakes()` | 25 |
| Panel and gold labels | blind sample, seven axes, blind A/B, signature, exit 3 | not landed | 27 |
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
- 81 of 82 properties have no evaluator (tickets 13–22, 26), so a browser run's
  verdict is `not-demo-ready`. A diagnose run measures one repetition and fails
  the 53 timing/behaviour properties' three-repetition plan rather than borrowing
  a pass.
- Parity compares deterministic properties only: the 2026-10-31 live rehearsal
  compared 29 and they agreed; 53 timing/behaviour properties were named as not
  compared because the protocol adapter may be faster, never more permissive.

An **unresolved** property is a recorded gap with no owning evaluator. Today
that is K8: the spec states "word error within bar" without a number, so ticket
13 must add that bar to a frozen record before K8 can pass. Its entity check is
recorded, but it may not carry a pass alone. H6 is no longer unresolved: ticket
26 owns it through the judge calibration gate, which fails closed when the
calibration is absent, below the 0.65 bar or scored against another rubric.

The one seam is the call boundary. If a proposed change adds a second seam
inside the call lifecycle or the turn stream, it contradicts ADR 0013 and needs
a new record before it is built.

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

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
| Certificate | schema, builder, validator, target binding, residual-risk ids, panel signature | not landed | 08 |
| Defect cards | one card per failed property with turn, excerpt, bar and replay command | not landed | 09 |
| Scenario runtime and caller corpus | parser, trigger rules, hashed takes, corpus manifest | `voni/src/lib/demo/verification/scenarios/` — `types.ts` is the adapter-agnostic record (takes, trigger rules, soundscape, expected property ids, faults); `parse.ts` refuses unknown fields, classes, locales, property ids, takes, triggers and faults by name and enforces the eight held-out names; `triggers.ts` resolves the caller script against the agent timeline deterministically and refuses an unresolved step; `corpus.ts` discovers `<root>/manifest.json` plus one directory per scenario and verifies each take's declared sha256, naming a drifted take. English and Locale corpora not landed | 10, 12–16 |
| Protocol adapter | diagnosis runs over the existing live-call socket; never certifies | `voni/scripts/real-legs.mts` (seed, via `voni/scripts/lib/real-legs.ts`) | 11 |
| Browser adapter | certifying runs on the real page, synthetic mic, delivered WAV, browser marks | not landed | 17 |
| Evaluator families | L1–L11, T1–T10, C1–C10, K1–K8, X1–X10, A1–A8, R1–R8, S1–S6, E1–E4, H1–H7 | not landed | 18–22, 26 |
| Studio | local-only Record, Rate and Corpus surfaces; never in the deployed build | Record landed in `voni/scripts/studio/`: `take-store.ts` writes one immutable hashed take per landing (`voni/.studio/`, gitignored) on the shared digest in `scenarios/digest.ts`; `dialogues.ts` validates authored prompt cards; `http.ts` serves `record.html` on loopback only and refuses a production environment or host by name; no `src/` file imports it. Rate and Corpus not landed | 23, 24 |
| Human baseline | three to five consented, hashed reference calls, blind comparison only | not landed (human gate) | 25 |
| Panel and gold labels | blind sample, seven axes, blind A/B, signature, exit 3 | not landed | 27 |
| CLI | `demo:verify`, `demo:studio`, `demo:certificate`; exits 0/1/2/3 | not landed | 28 |
| Streak and cutover | three-clean streak, staging gate, post-flip confirmation, monthly full production | not landed | 29 |
| CI cadence | fast contract, nightly health, weekly full certification, Locale matrix | not landed | 30 |

An **unresolved** property is a recorded gap with no owning evaluator. Today
that is H6 (judge agreement with gold labels): it is wired to the `judge`
evidence source and the registry marks it unresolved, so the verdict engine
reports it unverified and the run fails closed until ticket 26 or 27 claims it.
K8 is unresolved for the same reason: the spec states "word error within bar"
without a number, so ticket 13 must add that bar to a frozen record before K8
can pass. Its entity check is recorded, but it may not carry a pass alone.

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

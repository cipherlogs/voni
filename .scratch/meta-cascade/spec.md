Status: ready-for-agent

# Meta cascade: own the orchestration, keep the voice

Replaces the packaged AssemblyAI Voice Agent path with a cascade we own, in order to move the one budget the managed path cannot reach. Decision record: [ADR 0011](../../docs/adr/0011-owned-cascade-with-meta-muse.md). Supersedes the "switching speech vendor is out of scope" line in `.scratch/voice-parity/spec.md`.

## Problem Statement

The managed path owns the turn boundary and the model, and the reply gap it produces is not tunable from our side. `replyGapP50Ms` is frozen at 1500 ms; the managed path measures 1923 ms p50 and 2181 ms p95. Four gateway models, every streaming-STT preset and three turn-window rungs all landed between 1.9 s and 2.3 s. Nothing in the managed surface exposes an earlier decision point.

A cascade we own does, partly. It cannot commit a turn early — Meta's realtime socket takes exactly one client text frame after the handshake (`endStream`), which ends the session rather than a turn — but it can pre-open synthesis, speak a first chunk before the first sentence ends, and speculate against the growing partial. Those are ours to tune, and the vendor's voice is reachable directly, so the voice does not change when the orchestrator does.

The cost of owning it is a second operational surface, a fourth data processor, one re-cast voice, and an instrument that loses its platform-capture leg. Those are recorded in the decision record, not hidden here.

There is a second, less visible problem. The cascade that exists today is a prototype with three silent defects:

- It takes `system_prompt` and `tools` off the wire from the browser, so the "stored body" is client-assembled and the one-body seam ADR 0006 established is violated on the path that is about to become the product.
- It records tool names and never executes a tool, so a tool-using conversation is a transcript with no action.
- It has no greeting, so a call opens in silence until the visitor speaks, and every reference line and audition clip describes audio the call never says.

A fourth defect is structural rather than a bug: the pipeline's own timing ledger ships to the browser and is consumed by one `console.debug`. There is no gap scoreboard, no artifact and no gate, so the cascade cannot be judged at all today. Owning the pipeline without owning its evidence would replace one unmeasurable path with another.

The privacy surface also changes. Standard `muse-spark-1.3` is chosen over the Contributor tier because Contributor's basis is permission to train Meta models on the content we send — on this product a caller's name, budget, financing and phone number. Standard is 12.5×/21× more expensive and worth it. The cost delta is roughly $2.3k/month at 100k calls, and the RPM argument is not the reason: Standard's 3,000 RPM is convenience, not the justification.

## Solution

Measure the five terms before building, then own the cascade in five ordered moves.

**1. Measure before building.** Record one 20 s WAV and run it through Meta STT, Spark and a pre-opened synthesis session. Print endpointing latency, the `speechEnd` → `speechComplete` post-processing gap, Spark's first-content-token time, synthesis first-audio, and the configured playout cushion. If the sum cannot reach 1500 ms, the kill criterion fires before a line of product code is written.

**2. Build the foundations.** A durable, shared provider breaker and a routing switch; both speech-to-text backends; Standard Spark; AssemblyAI synthesis; and one stored-body adapter with an explicit field map, an explicit ignore set, and an unknown key that fails by name.

**3. Rebuild the call.** The orchestrator is keyed on a logical turn identity that survives Meta's overlapping turns and reconnects. `speechComplete` is the only text the model may act on. The gate is demoted to floor arbitration. The greeting is spoken before any user audio. Tools execute over the existing HTTP route. Barge-in uses `Cancel`. A dropped leg reconnects once and a second failure ends the call with a drain.

**4. Add money and eyes.** Meter every leg from the wire against a named rate table, route new calls to managed at 80% of the daily cap, refuse cascade at 100%, and end a call at its own ceiling with a drain rather than a truncation. One event schema with `pipeline` and per-turn provider attribution, written by the same runner and read by the same reader as the managed artifact.

**5. Prove it.** Two captures instead of three; one comparison and one verdict. Clips and previews generated from the same synthesis endpoint and binding table. A W2 re-audition on the cascade. A container deployment with a drain, a versioned protocol and a short-TTL token. CI that proves every anti-lie test red first. A cutover of all six demo voices or none, with a rollback rehearsal and two signatures.

The bar is the frozen budget: 1500 / 2500, untouched. Three measured rounds without it is the kill criterion.

## User Stories

1. As a visitor, I want the first reply to start within 1.5 seconds, so the agent feels present instead of paused.
2. As a visitor, I want the voice I picked to be the voice I hear, so the orchestrator change is invisible to me.
3. As a visitor, I want no unexplained silence while the model thinks, so I do not conclude the call has dropped.
4. As a visitor, I want a greeting before I speak, so I know the call connected and who I am talking to.
5. As a visitor, I want to interrupt and be heard, so taking the floor is rewarded rather than fought.
6. As a visitor, I want a passing "okay so" to be ignored rather than answered, so backchannels do not derail the call.
7. As a visitor, I want "stop", "no" and "hold on" to take effect immediately, so steering is not a negotiation.
8. As a visitor, I want the agent to resume the part I did not hear, so an interruption never costs me words.
9. As a visitor, I want no sentence played twice after a reconnect, so a blip does not make the agent sound broken.
10. As a visitor, I want a dropped speech connection recovered, so a transient failure does not end the call.
11. As a visitor, I want a second failure to end with a goodbye rather than a dead line, so I know the call is over.
12. As a visitor, I want the goodbye to finish before the call ends, so the last word is never chopped.
13. As a visitor, I want a tool lookup not to stall the conversation, so a slow action does not become dead air.
14. As a visitor, I want a failed tool handled gracefully, so a backend fault does not crash the call.
15. As a visitor, I want my language spoken by a voice bound to that language, so I am not decoding a code-switch.
16. As a visitor, I want the agent to answer what I actually said, not an incomplete partial, so I am not correcting it.
17. As a visitor, I want the agent to stop talking when I speak over it, so the conversation stays turn-based.
18. As a visitor on a weak link, I want breakups to be rare and never to swallow a word, so a bad connection degrades gracefully.
19. As a visitor, I want a budget stop to end with a spoken close, not a cut mid-word, so the ending is deliberate.
20. As a visitor, I want my name, number, budget and address never split across two turns, so I can copy them on the first try.
21. As the owner, I want `replyGapP50Ms ≤ 1500` on a clean cascade artifact, so the one failing budget is actually moved.
22. As the owner, I want the voice unchanged when the orchestrator changes, so the product I auditioned is the product I ship.
23. As the owner, I want the managed path to remain the routing default until the cascade is proven, so a failed experiment is not a regression.
24. As the owner, I want the kill criterion stated before the work starts, so the decision is evidence rather than optimism.
25. As the owner, I want a fallback-contaminated run to be ineligible for green, so a number never describes a stack I did not judge.
26. As the owner, I want every green to name the pipeline and providers that produced it, so I can audit what was actually measured.
27. As the owner, I want the same gate schema on both engines, so the A/B compares like with like.
28. As the owner, I want `N/A` where managed cannot produce a measurement, never zero and never a win, so a missing leg cannot look good.
29. As the owner, I want all six demo voices or none at cutover, so no Locale is quietly left behind.
30. As the owner, I want German re-cast and auditioned rather than dropped, so one vendor miss does not remove a market.
31. As the owner, I want no Locale labelled beta and none hidden, so quality is the product decision.
32. As the owner, I want the content-rendering decision re-run on clean cascade audio, so the earlier managed-path verdict is not carried over.
33. As the owner, I want two signatures at cutover — quality and system — so one person cannot sign both halves.
34. As the owner, I want a rollback rehearsal before cutover, so the way back is a dated record rather than a memory.
35. As the owner, I want rollback to be a routing flip, not a deploy, so it works when a deploy is the thing that failed.
36. As the owner, I want a daily spend cap that routes new calls before it refuses them, so the product degrades instead of disappearing.
37. As the owner, I want a per-call ceiling that drains rather than truncates, so a budget stop is still a courteous call.
38. As the owner, I want a cost per call with a named rate-table version, so a price change cannot silently rewrite history.
39. As the owner, I want Standard Spark, not Contributor, because a caller's name, budget, financing and phone number are not training data.
40. As the owner, I want zero data retention requested on raw audio, and a pre-cutover blocker if it cannot be selected.
41. As the owner, I want a named native reviewer per Locale, so "reviewed" is a person and a date.
42. As the owner, I want the featured voice proved first, so a refactor bug is never mistaken for a Locale bug.
43. As the owner, I want each subject's verdict from its own artifact, so the matrix cannot pass by copying.
44. As the owner, I want managed to be an alternative chosen before the first frame, never a mid-call handover, so a call does not change engines under the caller.
45. As the owner, I want the second operational surface to have a pager, a drain and a health check, so owning the pipeline does not mean discovering it at 3 a.m.
46. As an engineer, I want provider contracts drivable by fakes, so the whole cascade is testable offline.
47. As an engineer, I want recorded wire frames replayed through an injected socket factory, so a vendor change is a fixture diff rather than a live surprise.
48. As an engineer, I want a negative test that the STT client never sends a text frame other than `endStream`, so a commit experiment cannot sneak back in.
49. As an engineer, I want the breaker driven by a fake clock, so every hysteresis rule is deterministic.
50. As an engineer, I want the breaker durable and shared across instances, so two instances cannot disagree about a provider's health.
51. As an engineer, I want probes with hysteresis and a canary, so a provider is not declared healthy on one lucky request.
52. As an engineer, I want a stale probe read as `half_open`, so a crashed prober cannot leave a leg silently open or closed.
53. As an engineer, I want a manual fallback pin that probes never clear, so an operator's decision outranks an automated one.
54. As an engineer, I want decoupled ladders, so a speech-socket failure never demotes a healthy model.
55. As an engineer, I want an explicit body field map and ignore set, so a new body field cannot arrive as an accidental cascade setting.
56. As an engineer, I want an unknown body key to fail by name, so a typo or a smuggled setting is a visible error.
57. As an engineer, I want a body with an LLM override to refuse the cascade, so a tenant's BYO model is not silently replaced.
58. As an engineer, I want the served body's fingerprint to equal the minted one, so the call cannot run a body nobody fingerprinted.
59. As an engineer, I want turn state keyed on a logical turn id that survives reconnect, so a late `speechComplete` cannot land in the wrong turn.
60. As an engineer, I want `speechComplete` to be the only LLM input, so no code path acts on a partial as a final.
61. As an engineer, I want interleaved turns to keep separate state, so turn 1's final cannot be answered with turn 2's words.
62. As an engineer, I want tool calls accumulated by index and executed once, so a split delta does not become two side effects.
63. As an engineer, I want idempotency by `(name, canonical arguments)` within a turn, so an LLM retry cannot double-charge or double-book.
64. As an engineer, I want narration on a `tool_calls` turn suppressed and replaced with a localized hold line, so the caller never hears the model think out loud.
65. As an engineer, I want barge-in to use `Cancel`, not a socket close, so the session survives the interruption.
66. As an engineer, I want the unheard tail resumed by re-synthesis with no LLM call, so an interruption costs no model spend.
67. As an engineer, I want one reconnect per leg and a second failure to end cleanly, so recovery is bounded rather than infinite.
68. As an engineer, I want call-level sequence numbers, so a duplicated or replayed audio frame never plays twice.
69. As an engineer, I want the TTS `Begin` echo asserted against the request, so a wrong sample rate or language fails visibly.
70. As an engineer, I want `FlushDone.audio_duration_ms` checked against bytes received, so dropped audio is a fact rather than a guess.
71. As an engineer, I want `Termination` characters recorded as the billed unit, so cost matches the vendor's meter.
72. As an engineer, I want one event schema with `pipeline` and per-turn providers, so the A/B has one reader.
73. As an engineer, I want every fallback emitted, including a connect-time fallback, so eligibility cannot be fooled by where the fallback happened.
74. As an engineer, I want a shared artifact reader for managed and cascade, so a second schema cannot fork the evidence.
75. As an engineer, I want the same runner to write both artifacts, so the comparison is not two harnesses.
76. As an engineer, I want the three cascade gaps and the shared reply gap, so each engine reports what it can actually measure.
77. As an engineer, I want a real browser end-to-end seam that writes a delivered capture on PRs, so client regressions are caught before a live call.
78. As an engineer, I want live vendor smoke key-gated and off PR CI, so a PR does not depend on four vendors and a credit card.
79. As an engineer, I want a nightly canary that re-records fixtures and alerts on wire drift, so a vendor change is visible without committing a fixture.
80. As an engineer, I want a rollback test that flips routing to `off`, so the way back is proved in CI.
81. As an engineer, I want a deploy that never terminates a live call, so shipping a fix is not itself an outage.
82. As an engineer, I want a versioned protocol that refuses an unknown version by name, so a half-deployed pair fails loudly.
83. As an engineer, I want the WS query token redacted from logs, so the browser's call credential is not a log line.
84. As an engineer, I want the Meta handshake body never logged, because the credential travels inside it.
85. As an engineer, I want a prefetch 429 not to open the breaker, so speculative work cannot demote a healthy model.
86. As an engineer, I want prefetch shed before a real turn under pressure, so the caller's turn is served first.
87. As an engineer, I want a missing usage reading recorded as `unmeasured`, never zero, so a cost claim cannot be invented.
88. As an engineer, I want the daily counter atomic across instances, so two simultaneous calls cannot both cross 80% unnoticed.
89. As an engineer, I want a call spanning midnight counted per unit-day, so the daily bucket is honest.
90. As an operator, I want `routing: off|demo|all` to govern new calls only, so a live call is never moved mid-conversation.
91. As an operator, I want an open breaker visible with a reason and a last probe, so triage starts at the provider, not at a theory.
92. As an operator, I want a manual fallback pin that only a human clears, so automation cannot override an incident decision.
93. As an operator, I want the 80% and 100% alerts deduped, so a crossing pages once, not once per call.
94. As an operator, I want a draining instance to fail readiness, so a deploy takes it out of rotation before it stops accepting calls.
95. As support, I want a call's per-turn provider attribution and fallback reason, so I can explain what the caller experienced.
96. As support, I want no raw transcript, audio or key in telemetry, so debugging cannot become a privacy incident.
97. As compliance, I want Standard mode, ZDR requested, and a disclosure line per processor, so the privacy surface is explicit.
98. As a rater, I want one shared recording per subject and my written reasons kept, so my score is comparable and actionable.
99. As a finance owner, I want cascade spend separated from vendor-billed managed spend, so the A/B does not mix two meters.
100. As an engineer, I want the edge cases in this spec to be tests or named open decisions, so a rare failure is not discovered by a caller.

## What is settled

- **Scope.** Browser first, two subjects to start (`anna`/en then `lola`/es) on the stored demo agent, then **every eligible subject**: demo and tenant, including BYO-LLM and auto-detect bodies once tickets 159/160 land. The phone cascade adapter is parked until the browser is proven; the managed bridge stays the phone product until M20. Managed is the fallback and rollback, not a parallel product to preserve.
- **Ladders, decoupled per leg.** STT: Meta → AssemblyAI → call fails visibly. LLM: Meta `muse-spark-1.3` → gateway → call fails visibly. TTS: AssemblyAI only. Managed is a routing decision made before the first frame, never a mid-call handover.
- **The breaker is real and shared.** One durable record per leg, read before every call, written on transition, closed by a probe with hysteresis, never closed over an operator's manual pin.
- **The boundary is the provider's.** `ENDPOINTING` mode; `speechComplete` is the only text the LLM may act on. Our gate arbitrates the floor.
- **The body is the stored body.** Server-signed, one adapter, an explicit ignore list that fails on an unknown key. A body carrying an LLM override is constructed from the stored body (ticket 159), not refused; a body whose override cannot be constructed fails visibly. The browser never assembles `system_prompt` or `tools`.
- **Money is metered from the wire.** A daily counter routes new calls to managed at 80%, refuses cascade at 100%, and a per-call ceiling ends the call with a drain rather than a truncation.
- **Green means the same thing on both engines.** One gate schema, one budget table, `pipeline` as a fourth subject axis, and no green from a fallback-contaminated run.
- **The bar is the frozen budget.** 1500 / 2500, untouched. Three measured rounds without it is the kill criterion.
- **Standard, not Contributor.** `muse-spark-1.3` Standard. Contributor trains Meta models on the content we send; on this product that content is a caller's name, budget, financing and phone number. Do not re-justify the choice with RPM: 150 RPM supports roughly 45 concurrent calls without prefetch, which is adequate for an MVP. Privacy is the reason.
- **All six demo voices or none** at demo cutover, then `routing=all` for every eligible subject. Per-subject gates, no waivers, two signatures: the owner signs quality, one named engineer signs the system. Managed remains the `off` fallback.
- **No speculative commit across `speechEnd`.** Deferred, not forgotten. It is its own ticket if the measured reply gap misses.
- **Tools execute over the existing HTTP route**, not in Python. The tool hop is off the latency-critical path, and reimplementing `executeTool` in Python is ADR 0006's original sin.
- **The greeting is rebuilt.** The body's greeting is spoken before any user audio, through the bound voice, cancellable by barge-in.

## Contracts and vocabulary

New terms are in `CONTEXT.md` under **Cascade pipeline**: Managed path, Cascade pipeline, Turn boundary, Floor arbitration, Provider breaker, Fallback-contaminated run. Existing terms keep their meaning — **Delivered audio** remains the only basis for a quality claim, **Voice binding** still means one voice speaks one Locale, **Session mechanics** still means behaviour shared by every call.

- The stored-agent body shape is unchanged. The cascade reads it; it does not get its own.
- `output.volume` and `turn_detection` are managed-only after cutover; the cascade adapter lists both in its ignore set.
- No new audio enters machine-readable evidence. The event stream stays timing-and-attribution only, through the existing sanitizer. Audio lives in gitignored working files.
- Budgets are added only with a stated source. None is edited.
- `commit` is not cascade vocabulary. The provider owns the **Turn boundary**; we **take the floor**, **yield**, or **wait**. A code path named `commit` on the cascade is a naming bug even if the behaviour is right.
- A **subject** is `{agent, Locale, transport, pipeline}`. The `pipeline` axis is what makes the A/B falsifiable.
- A **clean run** has no fallback, no budget stop, no missing capture for the gate it feeds, and no harness failure. Only a clean run can be green.
- A **fallback-contaminated run** used a fallback rung on any leg, at any phase, including connect. It is ineligible for green even if every number is inside budget.

## Implementation Decisions

### M0 — Measure before building

One ticket, ahead of all code. The response time of this pipeline is a sum of terms we have not measured: Meta's endpointing latency, the `speechEnd` → `speechComplete` post-processing gap, Spark's first-content-token time, synthesis first-audio from a pre-opened session, and the playout cushion. The P1 baseline recorded "think ~5 s" on a gateway model; if Spark behaves the same, the boundary is irrelevant and the kill criterion fires before the slice is built.

- **Input.** One 20 s WAV, mono 24 kHz 16-bit PCM, with a known speech-end position. It is streamed at real time, not as fast as the network allows, because Meta rejects a stream that runs ahead.
- **Endpointing latency.** The wall-clock gap between the last speech sample in the WAV and the `speechEnd` event, cross-checked against `speechEnd.audioProcessedMs` minus the known speech-end position. A disagreement is reported, not averaged away.
- **Post-processing gap.** The wall-clock gap between `speechEnd` and `speechComplete` for the same `turnId`. This is the term the vendor does not document.
- **First-content-token time.** The gap between the `speechComplete` receipt and the first **content** delta from Spark. A `reasoning_content` delta does not count: Spark always reasons, and a reasoning-only stream can look fast while the caller hears nothing. `reasoning_effort: "none"` is rejected by Spark with HTTP 400, so the spike measures the default and the lowest supported effort.
- **Synthesis first-audio.** The gap between the `Generate` + `Flush` for the first sentence and the first `Audio` frame, with the TTS session already open and `Begin` received before the user turn. The handshake is excluded from this term; it is a call-start cost, not a reply cost.
- **Playout cushion.** The configured target cushion, named as a configuration value, not measured from a live buffer. The perceived reply gap includes it even though it is not a network term.
- **Verdict.** `PASS` when every term is measured and the sum is ≤ 1500 ms; `AT RISK` when every term is measured and 1500 < sum ≤ 2500 ms; `FAIL` when the sum is > 2500 ms. An unmeasured term makes the report `AT RISK` with the missing term named, unless the measured terms already exceed 2500 ms, in which case it is `FAIL`. Never a silent blank and never `PASS`. A term that alone exceeds a budget is named even when the sum is inside it.
- **Test.** A synthetic timeline with a known injected delay per term must reproduce the expected sum. Deleting a term from the report must fail the test. A term reported without its producer line is a test failure.
- **Early stop.** If the report is `FAIL` or `AT RISK` because a term is structurally too large — especially first-content-token time — the cascade does not proceed to M1 until the owner records a decision. The spike is a feasibility gate, not a cutover claim.

### M1 — Foundations

#### Provider breaker and routing switch

One durable record per leg (`stt`, `llm`, `tts`), shared across every instance, read before the first frame of every call, written on every transition. The record is the only thing that decides which rung a leg uses; no per-call heuristic and no in-process cache may override it.

```
ProviderBreakerRecord = {
  leg: "stt" | "llm" | "tts",
  provider: string,                 // the rung currently selected
  state: "closed" | "open" | "half_open",
  openedAt: timestamp | null,
  lastFailureAt: timestamp | null,
  lastSuccessAt: timestamp | null,
  lastProbeAt: timestamp | null,
  probeSuccesses: [{ at: timestamp, latencyMs: number }],  // at most 3
  manualOverride: "none" | "fallback",
  trigger: { kind: string, code: string | number | null, phase: string, turn: number | null } | null,
  reason: string,
  recordVersion: 1,
}
```

- **Trigger set is closed.** A retryable provider failure opens a leg: STT close `1011` or `1013`; LLM HTTP `429`, `5xx`, or a timeout; TTS HTTP/WS timeout, an abnormal socket close (no close code, `1006`, or `1011`), or `3005` after its one retry. A deterministic request error is a configuration bug and must not open the breaker: STT `1008` (invalid request or pacing), TTS `3006` (invalid parameter), `3010` (text/control pacing), `3011` (unread audio), `1009` (message too large), LLM `400`. Those fail the call visibly, alert, and leave the breaker to the human. `3008` is session expiry, a planned reconnect, not a trigger. This is deliberately narrow: a typo must not hide behind a fallback for thirty seconds.
- **State transitions.** `closed` → `open` on a trigger. `open` → `half_open` when a probe is due (at least 30 s after the last probe) or when the record is stale (see below). `half_open` → `closed` after three probe successes each at least 30 s apart; `half_open` → `open` on any probe failure or any real-call failure. A real call is the canary: the first real call after a close is watched, and one failure reopens immediately without waiting for the three-probe ritual.
- **Staleness.** A record whose `lastProbeAt` is older than 2× the probe interval (60 s) is read as `half_open`, even if `state` says `closed`. A crashed prober cannot leave a leg silently green.
- **Probe per leg.** STT: open a session, send the handshake, send a short silence frame, send `endStream`, and wait for the close. LLM: one minimal completion with `max_completion_tokens` small enough to bound cost, and no tools. TTS: open a session, send one empty `Generate` + `Flush` + `Terminate`, and require `FlushDone` with `audio_duration_ms: 0` and `Termination`. A probe that costs a meaningful number of characters or tokens is not a probe.
- **Manual pin.** `manualOverride: "fallback"` forces the fallback rung and is never cleared by a probe. Only a human write returns it to `none`. The record's audit trail carries who, when and why. There is no automated `primary` pin; an operator who wants to test the primary clears the pin and lets the probes run.
- **Write failures.** A failed breaker write alerts and leaves the call running on the rung it already selected; it never kills a live call. The next call re-reads and fails closed to the last durable state.
- **Routing switch.** `routing: off | demo | all`, durable, read before the first frame, changed by an operator action with an audit trail.
  - `off` produces zero cascade connections; every new call routes managed.
  - `demo` makes the stored demo subjects eligible; tenant calls route managed.
  - `all` makes every eligible subject eligible; a subject is still refused by the body adapter (BYO LLM, no fixed Locale, unbound voice) and routes managed with a recorded reason.
  - The switch governs new calls only. A live call is never moved.
- **Eligibility is a conjunction, not a guess.** A new call goes cascade only when routing permits it, the body adapter accepts the body, the voice has a cascade binding, the Locale is fixed, and the daily counter is below its routing line. Every refusal records its reason. A refusal is a routing decision, not a fallback event, and does not contaminate a later cascade run.
- **What the breaker does not do.** It does not demote across legs. An STT failure never changes the LLM rung. It does not route to managed by itself: the routing switch and the daily counter are the only things that choose managed, and both do so before the first frame. A TTS leg with no fallback rung opens and a cascade call fails visibly; new calls still attempt cascade unless routing or the counter says otherwise. That is the price of "TTS: AssemblyAI only", and it is visible rather than papered over.

#### Meta speech-to-text backend

A `StreamingSTT` implementation over `wss://api.meta.ai/v1/asr/realtime`, with the socket factory injected so the whole backend is replayable offline.

- **Handshake.** The first JSON text frame within 10 s of connecting. `authorization.accessToken` is `"Bearer " + META_API_KEY`; the `Authorization` header is ignored by the vendor and must not be used. `audioEncoding` is `PCM_24KHZ`; `model` is `muse-voice-transcribe-1.0`; `mode` is `ENDPOINTING`; `partialMode` is `CUMULATIVE`; `emitAudioProgress` is `false`. `languageBias` is a list of **language names** (for example `["Spanish"]`) mapped from the Locale bundle's codes; `keywords` comes from the body's `keyterms`. Both are frozen at session start.
- **Session identity.** `sessionId` is a query parameter built from the call id and a session epoch, never a secret. The handshake acknowledgement has no `type` field; any frame without `type` is the ack, and any other frame before the ack is a protocol error.
- **Audio.** Binary frames only, signed 16-bit little-endian mono at 24 kHz, paced approximately real time. Never send JSON audio, base64, or a container. The client sends PCM silence during silence so the vendor's idle-input close does not fire. Never run more than 5 s ahead of processing.
- **Events.** `speechStart` opens a turn and carries `turnId`. `transcript` carries cumulative text and no `turnId`; it belongs to the most recent `speechStart`. `speechEnd` marks the boundary and carries `turnId`. `speechComplete` carries the final text and `turnId`. Unknown event types are ignored. An `error` event fails the call and names the session id.
- **Text frames.** The only client text frame after the handshake is `endStream`. There is no `ForceEndpoint`, no `UpdateConfiguration`, and no per-turn commit. A negative test asserts that no other text frame is ever emitted, including on reconnect.
- **Close codes.** `1000` normal completion; `1008` invalid request or pacing, not retryable, fail the call and alert; `1011` retry once with a new session, and if the reason is max session duration open a new session; `1013` rate limited, back off and open the breaker. A close without a code is treated as `1011`.
- **Session limits.** A realtime session runs up to 60 minutes and has no resume token. A new socket is a new session; transcripts are joined in our application. Idle input closes the stream, and a backlog beyond 5 s closes `1008`. The adapter reconnects before 60 minutes as a planned reconnect, not a failure.
- **End of call.** Drain queued audio, send `endStream`, keep reading until the vendor closes with `1000`. A dropped socket also ends input but may discard pending events, so a deliberate end always uses `endStream`.
- **Turn overlap.** Turns may overlap: a later `speechStart` can arrive before an earlier `speechComplete`. Partials carry no `turnId`, and `speechComplete` text may differ from the last partial. State is keyed on the provider `turnId` plus a local session epoch; the orchestrator, not this backend, owns the logical turn identity.
- **No word timestamps and no confidence.** The adapter never invents them. Timing is turn-level; the event stream records only the gaps the vendor actually supplies.

#### Meta LLM backend

An `LLMStream` implementation over Meta's OpenAI-compatible Chat Completions endpoint on Standard `muse-spark-1.3`.

- **Construction guard.** A model id containing `-contributor` is rejected at construction, not at request time. The guard is a test that fails if deleted. A model id outside the Standard allowlist is also rejected by name.
- **Request.** `POST /chat/completions` with `Authorization: Bearer`, `model: "muse-spark-1.3"`, the full message history, `stream: true`, `stream_options: { include_usage: true }`, and `tool_choice: "auto"` whenever tools are supplied. `parallel_tool_calls` is left at its default `true`; the orchestrator handles multiple calls. `reasoning_effort` is a measured configuration value: `"none"` is unavailable on Spark and returns HTTP 400, so the spike measures the default and the lowest supported effort, and M03 fixes the value with that measurement attached. The request never sets `store: true`, `stop`, `frequency_penalty`, `presence_penalty`, `n > 1`, `logprobs`, or unsupported modalities.
- **Messages.** The body's `system_prompt` is sent unchanged as a `system` message. The cascade does not rewrite the compiled prompt. Hidden context is appended as a `system` message for the next turn and never captioned. A tool turn replays the full assistant message with `tool_calls` before the `tool` messages; omitting it is an HTTP 400 and a test.
- **Token stream.** Content deltas are yielded as text. `reasoning_content` is recorded for usage and telemetry but never sent to TTS; a reasoning-only delta does not mark `first_token`. The first content delta marks `first_token`; the first playout marks `first_playout`.
- **Tool-call accumulation.** Tool-call deltas are accumulated by `index`, including a split `id`, a split `name`, and split `arguments`. Exactly one `ToolCallRequest` is emitted per index when `finish_reason` is `tool_calls` or the stream ends. A missing or empty `call_id` produces a request that is not executed; the turn is closed with a hold line and the denial is recorded. A `call_id` outside 1–64 characters is a provider contract violation and fails the turn.
- **Arguments.** The arguments string is parsed as JSON. A malformed or non-object result is a tool failure, never a silent execution with `{}`. The model may emit invalid JSON or arguments outside the schema; validate before invoking.
- **Usage.** The final chunk with `stream_options.include_usage` carries prompt, completion, total, cached and reasoning token counts. Usage is recorded per turn. A stream that is interrupted before the usage chunk records `unmeasured`, never zero.
- **Finish reasons.** `stop` is normal. `length` and `content_filter` speak what was generated, mark the reply truncated, and do not retry. `tool_calls` hands off to the tool loop. `function_call` is treated as `tool_calls` for compatibility.
- **Failures.** `400` is a configuration or conversation-structure bug: fail the turn, alert, do not open the breaker. `429`, `5xx` and timeouts are retryable: open the breaker after the retry policy, retry once before the first content token, and never restart a mid-reply completion (that would repeat speech). A second failure on the leg ends the call.
- **Privacy.** No caller-identifying value is sent as `user` or `safety_identifier`; if either is used it is a salted hash of an internal id, never a phone number, email or name. Prompt caching is a latency/cost decision and is reviewed with the ZDR question before cutover.

#### AssemblyAI speech synthesis backend

A `StreamingTTS` implementation over `wss://tts.us.assemblyai.com/v1/ws` on `assemblyai-tts-1`, one socket per call opened at call start, with `Cancel` as the barge-in primitive.

- **Connect.** `voice_id` from the body's binding, `language` from the voice's Locale, `sample_rate` and `encoding` from the transport (`24000`/`pcm_s16le` browser, `8000`/`pcm_mulaw` phone), `model_id=assemblyai-tts-1`. `language` is the vendor's language name, not our code; the binding table owns the mapping. `word_boundaries` is enabled because the barge-in tail resume needs a word-level cut point; if the vendor reports `word_boundaries_status` other than `complete`, the resume falls back to the sentence boundary.
- **Begin echo is an assertion.** `Begin.configuration.voice_id`, `language`, `sample_rate`, `encoding` and `model` are compared with what was requested. Any mismatch fails the call visibly, records the mismatch, and does not play audio. `Begin.expires_at` and `Begin.configuration.limits` are recorded. Unknown query parameters are visible in `Begin.configuration.unknown_params`; a non-empty list is a configuration bug, not a warning to ignore.
- **Generate and Flush.** Text is sent per sentence. The first sentence of a reply, and the greeting, is `Generate` + `Flush` immediately so audio starts without waiting for more context. A long sentence is split at a clause boundary or under the 2,000-character cap; an over-cap `Generate` closes the session with `3006`. Flushing per token is forbidden: it produces choppy prosody and spends the 20-control-frame-per-second budget.
- **Format echo and loss.** `FlushDone.audio_duration_ms` is compared with `bytes_received / (sample_rate × bytes_per_sample) × 1000`. A difference beyond a few milliseconds fails the call as audio loss. Every `Audio` frame holds whole samples; the client decodes at the `Begin` rate, never a hardcoded 24 kHz.
- **Termination.** `Terminate` performs an implicit flush and returns a final `FlushDone`, then `Termination`. `Termination.total_input_char_length` (or `billed_characters`) is the billed unit and is recorded per call; `audio_duration_seconds` and `session_duration_seconds` are recorded as facts.
- **Cancel.** On a real interruption, `Cancel` stops in-flight synthesis and discards unflushed text and pending flushes. `Audio` frames that arrive between `Cancel` and `Cancelled` belong to the old request and are dropped. `Cancelled.audio_duration_seconds` is recorded. The next request takes a new `flush_id` that may skip numbers; read it from the first frame after `Cancelled`. A `Generate` sent after `Cancel` is not caught by that cancel, so the tail can be re-sent immediately without waiting.
- **KeepAlive and idle.** A session closes after 120 s with no frame in either direction. A `KeepAlive` at a named interval below that keeps the socket open during a long caller pause; it counts against the control-frame budget. A session that reaches `expires_at` drops every frame; the adapter drains the current reply and opens a new session between turns rather than reconnecting mid-sentence.
- **Limits.** 2,000 characters per `Generate`, 3,600 s per session, about 100 characters/s text intake, 8,000 characters of unsynthesized backlog, 20 control frames/s sustained with a burst of about 60, and a WebSocket message-size limit. `3006` is a configuration error; `3008` is expiry; `3010` is rate/backlog; `3011` is unread audio; `3005` is no output while a `FlushDone` was owed; `1009` is a message too large; `1000` is normal.
- **No fallback.** TTS has no second rung. A TTS failure in the trigger set fails the call visibly, records the trigger, and opens the breaker. A configuration/pacing failure (`3006`, `3010`, `3011`, `1009`) fails the call and alerts without opening it, because it is our bug, not an outage. `3008` is a planned reconnect. A new call still attempts cascade unless routing or the counter says otherwise. A TTS failure at greeting time means no silent opening: the call ends with an error the browser can show.
- **Voice binding.** Every request's `language` equals the voice's declared Locale, asserted against the `Begin` echo. A voice that is not in the binding table refuses the call. The vendor's "usually sounds best in its own language" is a hint, not a licence to mix languages; the binding is the invariant.

#### Stored-body adapter and signed body

The cascade reads the exact stored body the managed path reads. It does not get its own builder, and the browser does not supply `system_prompt` or `tools`.

- **Assembly and transport.** The app assembles the body, reads back the served body, and verifies the full fingerprint including the account salt. It sends the body plus a body hash and an HMAC-signed envelope over the authenticated service channel. The browser sends only a call token, the agent id and the protocol version; it never sees the body, the prompt or the tool list. The service verifies the envelope and the body hash before opening a vendor socket. A body whose hash does not match the envelope is refused by name.
- **Field map.** The adapter has one explicit map and no implicit pass-through.
  - `system_prompt` → the system message.
  - `greeting` → the greeting line; absent or empty means no greeting.
  - `voice.voice_id` → the TTS voice binding.
  - `input.language_codes` → STT `languageBias` (language names) and the TTS language (the voice's own Locale).
  - `input.keyterms` → STT `keywords`.
  - `tools` → the model's tool array, converted from the body's REST shape to Chat Completions `{type: "function", function: {...}}`.
- **Ignore set, each with a reason.**
  - `name` — a call label, not behaviour.
  - `output.volume` — managed-only; direct synthesis has no such parameter and the cascade carries no gain stage.
  - `output.voice` — redundant with `voice.voice_id`.
  - `output.format` — the transport chooses the format.
  - `input.format` — the transport chooses the input format.
  - `input.transcription_mode` — Meta's mode is fixed at `ENDPOINTING`; there is no equivalent knob.
  - `input.transcription_prompt` — Meta exposes no free-form recognition prompt. The words it carries must be represented in `keyterms` before cutover; ignoring it silently would be a recognition regression, so the adapter records the field as ignored and the pre-cutover recognition check (the parity spec's W3a work) must show the words are represented elsewhere.
  - `input.voice_focus`, `input.voice_focus_threshold` — no Meta equivalent; the browser mic path already owns capture.
  - `input.turn_detection` — the provider owns the boundary; there is no turn-detection object to set.
- **Unknown keys fail.** A key at the top level, inside `input`, or inside `output` that is in neither the field map nor the ignore set fails the adapter by name. This is the profile-whitelist extension: a smuggled body key cannot become a cascade setting.
- **LLM override is constructed from the stored body; an unconstructible override fails visibly.** One non-empty `llm` entry is constructed from the stored body, before any vendor socket, and runs the same request/tool/failure contract; it is never refused or routed managed. `llm: []` is the documented revert to the default Meta rung. Ticket 159 replaces ticket 60's refusal.
- **Eligibility refusals.** A body with no `language_codes` (automatic language detection) is refused: the TTS session's language is fixed at connect and the voice binding requires one Locale. Such an agent routes managed until auto-detect gets its own decision. A body whose voice is not in the binding table is refused by name. A body whose `tools` contain an invalid Meta function name (more than one dot, or characters outside the allowed set) is refused by name, because a silently dropped tool is a product defect.
- **Fingerprint equality.** The app's check is the full fingerprint of the served body against the minted fingerprint. The service's check is the body hash and the signed envelope. Both must pass. A mismatch is a named refusal, not a warning.

### M2 — The call

#### Orchestrator: logical turns, provider boundary, floor arbitration

The orchestrator is rebuilt around a **logical turn id** — a `(sessionEpoch, providerTurnId)` pair. The provider `turnId` resets on reconnect and can overlap across turns; the logical id does not. Every piece of turn state is keyed on it: partial text, speech start and end timestamps, the final text, the tool loop, the reply, the audio cut point and the provider attribution.

- **Event handling.**
  - `speechStart` creates or refreshes the open turn for that provider `turnId`, records the start, and marks the turn as speaking.
  - `transcript` (partial) belongs to the most recent `speechStart`. It updates the cumulative text, marks `first_partial` once per call, and never becomes a user message to the model.
  - `speechEnd` marks the boundary, records endpointing latency, and does nothing else. No LLM request is made on `speechEnd`. A test asserts zero LLM requests between `speechEnd` and `speechComplete`.
  - `speechComplete` is the only event that may produce a reply. Its text is authoritative even when it differs from the last partial. An empty `speechComplete` is a no-speech turn: counted, not answered.
  - A `speechStart` for an unknown turn, a `speechComplete` for an unknown turn, a duplicate `speechComplete`, and a partial with no preceding `speechStart` are logged and ignored. Duplicate `speechComplete` is idempotent.
- **Reply ordering.** Finals are queued by logical turn id. A later turn's final waits for any earlier open turn to complete, because replying to turn 2 before turn 1 would invert the conversation. A bounded stall guard closes an abandoned turn with no reply and records it; the guard value is a named open threshold, not an invented one. If the guard fires, the later turn is answered and the abandoned turn is visible in the event stream.
- **Floor arbitration.** While the agent holds the floor — speaking, thinking, or with a live reply task — a partial is one of three things:
  - **take the floor** — a real interruption or a command overlap. The orchestrator sends TTS `Cancel`, stops the producer, and pivots. The command set is the existing one (`stop`, `wait`, `no`, `nope`, `repeat`, `again`, `sorry`, `listen`, and the phrases `hold on`, `hang on`, `excuse me`); it is not re-invented. `yes`/`yeah` are not commands; they take the existing soft-confirm path.
  - **backchannel** — every token is filler. It is counted, never answered, and does not cancel. The existing filler set and parity tests are reused.
  - **wait** — anything else. The agent keeps the floor.
  A partial while the agent is silent may start a speculative prefetch, which is read-only, cancellable, and never a reply. The prefetch is adopted only on an exact message match; a partial that differs from the final is wasted work, not a commit.
- **Final suppression.** A final classified as backchannel or echo is counted and produces no reply. Echo is the existing similarity/overheard classifier, not a new list. A command final takes the floor and steers the next turn. A normal final generates a reply.
- **Soft-yield is not the cascade's cut.** The managed path finishes the current sentence before pivoting; the cascade uses `Cancel` and meets `realCutMs`. The difference is deliberate: `Cancel` is the primitive the managed API never gave us, and a long sentence would otherwise blow the cut budget. The unheard tail is resumed by the barge-in path, not by finishing the stale sentence.
- **No speculative commit.** The orchestrator never calls the LLM from `speechEnd`, never sends `endStream` to force a turn, and never treats a partial as a final. `endStream` is sent only when the call ends.
- **Interleaved turns.** Turn 1's state and turn 2's state are separate objects. A late `speechComplete` for turn 1 after turn 2 has opened merges into turn 1, not turn 2. A reply to turn 1 is never captioned as turn 2's user text. A provider `turnId` reused after reconnect is disambiguated by the session epoch.
- **Call lifecycle.** A call opens the STT and TTS sessions, verifies the body and bindings, speaks the greeting if the body has one, and then streams. A browser `stop` or a dropped socket drains and ends. The end message carries the ledger, the call-level provider table, the cost, and the eligibility facts.
- **Bounded work.** Every await that can outlive a turn has a named bound: the reply task, the stall guard, the tool timeout, the drain, the reconnect handshake. No unbounded network await sits in the audio path.

#### Greeting on the cascade

The body's greeting is spoken before any user audio, through the bound voice, and it is cancellable.

- **Source.** The greeting text is the body's `greeting`, which is the same line the audition clip and the reference render use. A body with no greeting (the hold-return resume variant) opens silently; that absence is intentional and is not a defect.
- **Timing.** The greeting is sent after `Begin` is received and before the first user frame. It is one `Generate` + `Flush`; a long greeting is split at sentence boundaries with the first sentence flushed immediately. The first audible sample fires the connected chime, not the schedule.
- **Ledger.** `greeting_start`, `greeting_first_audio` and `greeting_done` are marks; the greeting is not a turn and is excluded from reply-gap samples. A call with no user audio still emits the greeting and ends with a drain.
- **Barge-in.** A `speechStart` or a taking-the-floor partial during the greeting sends `Cancel`, drops the greeting, and lets the caller's turn win. The greeting does not resume.
- **Failure.** A greeting synthesis failure is a TTS failure: the call ends visibly, the breaker records it, and there is no silent opening. A greeting that is never flushed is a bug; the idle timeout must not be the thing that reveals it.
- **Text equality.** The greeting text equals the body's greeting and the clip's source line. A mismatch is a test failure, not a copy-edit.

#### Tools: HTTP execution, idempotency, narration hold

Tools execute over the existing `POST /api/tools/[name]` route, because the tool hop is off the latency-critical path and reimplementing `executeTool` in Python would recreate ADR 0006's original sin.

- **Shape.** The body's REST tools are converted to Chat Completions function tools. The name must satisfy the vendor rule (letters, digits, underscores, dashes, at most one dot) and the parameters schema is passed through; the vendor adds a missing root `type` but the adapter does not rely on it. A tool that cannot be represented refuses the cascade by name.
- **Call identity.** A tool call is executed only with a real `call_id` from 1 to 64 characters. A missing or empty id is not executed; the turn is closed with a hold line and the denial is recorded. An overlength id fails the turn.
- **Execution.** The request carries `context: { kind: "call", callId }` and the tool secret. The call id is minted before the call and carried in the signed config. A tool failure, timeout, 401/404/500, or unreadable response becomes a tool result with `ok: false` and a reason; the call continues. A timed-out side-effecting tool is recorded as indeterminate and is not automatically retried within the turn; the route receives the `toolCallId` so the tool can dedupe.
- **Idempotency.** Within one logical turn, `(name, canonical arguments)` is memoised. A repeat replays the result and does not re-execute. Canonicalisation sorts object keys and normalises scalar formatting. The memo survives an LLM reconnect in the same turn and resets on a new turn. This is what makes an LLM retry safe.
- **Narration hold.** Content emitted on a turn ending `finish_reason: tool_calls` is discarded from audio and replaced with a localized hold line. The assistant message, including its content and `tool_calls`, is still appended to history verbatim; only the audio is suppressed. The model's next turn sees what it said, the caller heard the hold line.
- **Continuation.** A tool result is a `tool` message with the matching `tool_call_id`; the same logical turn continues with a new LLM request. The loop ends on `stop`, a tool-call cap, a second failure, or an end-call. The cap is a named open threshold; until it is supplied, the loop is bounded by the turn's own budget and the stall guard.
- **Order.** Multiple calls in one turn are executed in index order, one at a time, even when `parallel_tool_calls` is true. Side-effect order is worth more than the off-path latency, and the path is off the audio path anyway.
- **End call.** `end_call` is call control, never an HTTP tool. It speaks the closing line through the same TTS path, then ends the turn and the call. A barge-in during the goodbye disarms the hangup and the caller's turn wins. An `end_call` without a closing line is denied and recorded.
- **Unknown tools.** A tool name not in the body's tool list is denied, counted and answered with the hold line; it is never executed.

#### Barge-in on `Cancel`, tail resume without LLM

An interruption is a real caller turn winning the floor. It uses `Cancel`, not a socket close.

- **Cut.** On a taking-the-floor decision, send `Cancel`, stop the producer, tell the client to flush the playout, and drop every `Audio` frame between `Cancel` and `Cancelled`. Audio stops within `realCutMs` (1500 ms) of the caller's speech start.
- **Tail identity.** The client reports the last played audio position with the interruption (`played_ms`) from the worklet. The server maps it to the reply text using the per-sentence `FlushDone.audio_duration_ms` and the TTS `WordBoundaries` when they are complete. The resume point is the first unheard word; when word boundaries are unavailable or unreliable, it is the start of the first sentence that had not fully played. A short repeat is acceptable; a lost word is not.
- **Resume.** The unheard tail is re-synthesized on a new `flush_id` with the same voice and language, with zero LLM requests. It continues the existing reply, so the caller hears the rest of the sentence rather than a new answer. A new caller turn that has already taken the floor cancels a stale resume.
- **Filler.** A filler interruption is a backchannel: no `Cancel` and no reply. If audio was cut for any other reason, the tail resume still applies and still makes zero LLM calls. This is the existing `filler-resume` contract, reused.
- **Case table.** The recorded barge-in recovery case table is the cross-engine proof. It must pass unchanged on the cascade; a difference is a bug, not a new expected value. The same table runs on the phone in M20 through the μ-law transport.
- **Greeting and goodbye.** A barge-in during the greeting cancels it and the caller wins. A barge-in during the goodbye disarms the hangup and the caller wins. A barge-in during a tool hold cancels the hold line; the tool result is still appended to history.
- **Double barge-in.** Each `Cancel` has its own `Cancelled`; the next `Generate` after a `Cancel` is not caught by that cancel; the latest caller turn wins and a stale resume is discarded.
- **Expiry.** After `expires_at`, a `Cancel` gets no `Cancelled`; the adapter stops playback locally and lets the session end. The call is already draining.
- **Echo.** The existing echo/overheard classifier suppresses the agent's own voice; it does not become a command or an interruption.

#### Reconnect, sequence dedupe, partial reply

Recovery is bounded, visible and never repeats audio.

- **One reconnect per leg per call.** A second failure on the same leg ends the call. A planned reconnect at the 60-minute STT limit or the 3,600-second TTS limit is separate from the failure budget and preserves the logical turn.
- **STT.** A new session, a new handshake, a new provider `turnId`, and the current logical turn's buffered audio replayed from its `speechStart`. The new provider `turnId` maps to the existing logical turn; late events from the old session are ignored. The turn's text survives because the audio is replayed, not because the vendor resumes (it has no resume token).
- **LLM.** A failure before the first content token may retry once. A failure mid-reply does not restart the completion: it drains the sentences already queued, closes the turn at the last complete sentence, and never cuts mid-word. History records the spoken prefix, not the unspoken tail, so the next turn matches what the caller heard.
- **TTS.** A socket failure mid-reply keeps the audio already played; the remaining sentences are re-synthesized on a new session from the first unheard point. A second TTS failure ends the call without a spoken goodbye, because there is no voice to speak it; the browser shows an error and hangs up.
- **Sequence.** Every server-to-browser audio frame carries a call-level monotonic `seq` that is independent of the TTS `flush_id`. The client drops any frame whose `seq` is not greater than the highest played. A reconnect continues the sequence; it never resets. A `seq` gap is logged and the call continues; a duplicate with different bytes is dropped and logged.
- **Second failure.** A second failure on STT or LLM ends the call with a drain and a localized goodbye through the still-healthy TTS. A second failure on TTS ends without a goodbye. The end message carries the failure leg and the reason.
- **Planned reconnect.** Before the STT 60-minute limit and before the TTS `expires_at`, the adapter reconnects at a turn boundary, not mid-sentence. If the STT limit arrives mid-turn, the failure path applies: a new session, the turn's audio replayed, and the provider `turnId` mapped to the same logical turn. The logical turn and the call-level `seq` continue.

### M3 — Money and eyes

#### Budget meter, per-call ceiling, prefetch shedding

Money is metered from the wire, not from an estimate of what a turn probably cost.

- **Units.** STT audio processed in whole seconds (Meta bills down to whole seconds); LLM prompt, completion, cached and reasoning tokens; TTS billed characters from `Termination.total_input_char_length` / `billed_characters`. A unit that the vendor did not report is `unmeasured`, never zero.
- **Rate table.** A named, versioned table with per-leg rates, including cached input and reasoning/thinking tokens where the vendor prices them. A price change is a new version, never an edit. Every cost cites `rateTableVersion`.
- **Daily counter.** A durable, atomic, shared counter with UTC day buckets. Every billable unit adds to the day it was consumed, so a call spanning midnight contributes to both days. A reconnect replay is counted because the vendor bills it. A fallback leg is counted. A prefetch 429 that produced no usage is not counted.
- **80% routing line.** When the day's estimated spend crosses 80% of the daily cap, the next new calls route managed and one alert fires. Live cascade calls continue.
- **100% refusal line.** When it crosses 100%, new calls route managed and cascade is refused with a recorded reason; live calls continue unless their own ceiling stops them. "Refuses cascade" never means "refuses the call": managed is the product, and a call that cannot use managed fails with an ordinary error.
- **Per-call ceiling.** Checked after each billable unit. A breach ends the call with a drain and a spoken localized goodbye, marks `budget_stopped`, and allows no new LLM or TTS request except the goodbye. The goodbye's own cost is recorded and does not re-trigger the ceiling. The value is a named open threshold with a stated source; this spec does not invent it.
- **Prefetch shedding.** Under rate pressure — a `429`/`1013`, an exhausted remaining-quota header, an STT concurrency limit, or a TTS control-frame pressure signal — speculative prefetch is cancelled and refused while a real turn is still served. A prefetch `429` does not open the breaker; a real turn's `429` does. Prefetch is never allowed to consume the last unit a real turn needs.
- **Alerts.** The 80% and 100% crossings alert once per day per line, not once per call. A re-cross after a reset alerts again.
- **Managed separation.** The cascade counter covers cascade legs only. A managed artifact records cascade cost as `N/A — vendor-billed`, never zero. The A/B does not add the two meters together.
- **Eligibility.** A run with a budget stop is ineligible for green. A run with an unmeasured cost is ineligible for a cost claim; it may still be eligible for latency if every other required gate is clean, but the cost row is `INFO`/`unmeasured`, never `PASS`.

#### One event schema, attribution, cost per call

One schema, one writer, one reader. The managed artifact and the cascade artifact differ by a `pipeline` discriminator and by which capture legs exist, not by a second vocabulary.

- **Envelope.** Every call-scoped event carries `schemaVersion`, `pipeline`, `callId`, `subject`, `turn` (logical id or null), `atMs`, and a `phase` (`connect`, `turn`, `tool`, `drain`, `end`). An operational event (`breaker.transition`) carries the leg in place of `subject`/`turn`. Unknown schema versions are refused by the reader, never guessed.
- **Turn attribution.** Every turn names `{stt, llm, tts}` actually used, including a fallback rung and `null` for a leg that did not run (a backchannel has no LLM). A managed turn records the provider table as `N/A — vendor-owned`, not a fabricated vendor name.
- **Fallback events.** Every fallback emits `provider_fallback` with leg, from, to, trigger, turn (or null at connect) and phase. A connect-time fallback is still a fallback. A run containing any `provider_fallback` is contaminated.
- **Breaker events.** `breaker.transition` names the leg, from, to, reason, trigger and whether a manual pin is set. A transition is an operational event, not a turn event; it never carries transcript text.
- **Budget events.** `budget.crossing` (line, day, spend, cap) and `budget.stopped` (call, spend, ceiling) are emitted once each.
- **Greeting and reconnect.** `greeting.start`, `greeting.first_audio`, `greeting.done`, `reconnect` (leg, reason, planned/failure), `protocol.error` and `turn.failed` are first-class events, not console lines.
- **Sanitizer.** The existing forbidden-key and key-shaped-value rules apply. No `text`, `transcript`, `audio`, `data`, `pcm`, `authorization`, `token`, `api_key` or `secret` on a line. A `provider_fallback` reason is sanitized; a URL or key-shaped value is redacted. A raw Meta handshake is never logged, because the credential travels inside it.
- **Artifact.** One artifact per run: `subject`, `run` (code fingerprint, variant, timestamps), `pipeline`, `providers`, `gates`, `latency`, `cost`, `captures`, `eligibility`, `beats`. The same runner writes it for both engines; `scoreboard:inspect` reads it. A second writer or a second reader is a review failure.
- **Capture legs.** A cascade artifact carries `{reference, delivered}` and marks the platform leg `N/A — no platform capture on the cascade`. A managed artifact carries `{reference, platform, delivered}`. A cascade artifact that claims a platform capture is invalid; a managed artifact that claims a cascade-only event is invalid.
- **Cost.** Per leg and total, in the rate table's currency, with `rateTableVersion`. An unmeasured unit makes the total `unmeasured`, not a partial sum presented as complete.

#### Gap A/B and run eligibility

Both engines report the same gates. The cascade reports three gaps; managed reports the reply gap and `N/A` for the two it cannot produce.

- **Cascade gaps.** Screen latency (`audio_in` → first partial), think (`speechComplete` → first content token), reply gap (`speechComplete` → first audible playout). The commit mark does not exist on the cascade; a `commit_to_first_playout` row is `N/A`, not a copy of the reply gap.
- **Managed gaps.** Reply gap only. Screen latency and think are `N/A — no partials` and `N/A — no token stream`; never zero, never a win, and never silently absent.
- **Same definition.** The reply gap is the caller's final transcript → the first audible sample, anchored by the same client mark on both engines. The greeting is excluded. A cut turn is skipped by the reply-gap gate exactly as it is today.
- **Eligibility.** A run is eligible only when it is clean: no fallback on any leg at any phase, no budget stop, no missing capture for the gate it feeds, no harness failure, and a code fingerprint that matches the run under judgement. A contaminated run is re-run, not counted toward the kill criterion.
- **Per-subject verdict.** A subject's row derives its verdict from its own artifact only. A carried-over verdict fails. A subject with no artifact is `BLOCKED` with a named reason, not `PASS`.
- **Featured first.** `anna`/en is measured and judged first. `lola`/es is judged only after `anna` passes. Every other subject stays `BLOCKED` until the featured subject's current run passes.
- **Small samples.** A small-sample scope is judged against the tail budget, never its own median. A one-sample scope is not a p50 gate.
- **Kill criterion.** A measured round is two subjects, two consecutive clean runs each, no fallback, no budget stop. If three measured rounds fail `replyGapP50Ms ≤ 1500`, the cascade does not cut over. A contaminated round is not a measured round; it is re-run. A round that passes the reply gap but fails another required gate does not trigger the kill criterion, but it cannot cut over either.

### M4 — Prove

#### W0 two-capture profile and verdict rule

A cascade call has no platform recording. W0 runs two captures — reference and delivered — and keeps the verdict's value.

- **Reference.** A direct synthesis of the intended line, in the same voice, the same language, the same format and the same text as the call, with no STT, LLM, client or platform in the path. It uses the same TTS client and binding table as the call. The default line is the body's greeting, because that is the sentence that separates "broken from the first word" from "breaks once the model speaks"; `--text` renders another sentence for a mid-call defect. The reference is cached by voice + text + format.
- **Delivered.** The browser tap after the playout worklet, sample-exact, written as a 16-bit PCM WAV at the worklet's output rate. Dev-only, behind the existing `?delivercapture=1` flag, inert in production, and provably non-intrusive: enabling capture must not change the samples the worklet would otherwise emit.
- **Comparison.** One table over the two files: integrated level and RMS, true peak, distortion residual against the reference, crest factor, octave-band balance and band-to-band delta, envelope modulation rate and depth, breakup count with total and longest inserted silence, format facts (rate, channels, duration, byte rate), and onset. A comparison on a whole-call capture without a line marker is incomplete; use the greeting line or a time-marked segment.
- **Verdict layers, in causal order.**
  1. **Vendor voice** — the reference itself is malformed (no level, an inserted silence, a peak at the ceiling, the wrong line) or, where a committed floor exists, is worse than that floor. Nothing downstream can be judged.
  2. **Model text** — the call's transcript is not the intended line, so the audio layers were never given the same words.
  3. **Our pipeline** — the delivered audio differs from the reference in level, spectrum, distortion, voice or language, which is a server-side request/assembly defect. A format mismatch is not attributed from two captures; it makes the comparison unresolved.
  4. **Client** — the delivered audio shows a playout signature: chunk-rate envelope modulation, an inserted silence the reference does not have, a device-rate alias, or a boundary fade. This is below our server, in the browser.
  The first divergence is named; a later difference cannot steal the blame. The two-capture set separates vendor voice from our pipeline; the axis signature separates our pipeline from the client. This is the replacement for the managed path's platform leg, not a claim that a third capture exists.
- **Missing data.** A missing, unreadable, zero-byte, header-only, stereo, wrong-rate or misdescribed capture makes the comparison `unresolved`, never a pass. An onset difference beyond 50 ms makes it `unresolved`; a format mismatch makes it `unresolved`; a different line makes it `unresolved`.
- **Metrics can fail.** Every audio metric is proved able to fail on a synthetic worst case: a level step, a third-harmonic residual, a crest collapse, an octave tilt, an inserted silence, a chunk-rate modulation, a true peak at the ceiling. A metric that cannot be made to fail does not ship.
- **No audio in evidence.** The artifact carries capture paths and sha256 hashes, never audio bytes. The WAVs are gitignored working files.
- **Vendor floor.** `anna`'s committed vendor floor remains the external floor for `anna`. Every other voice is compared to its own reference, not to another voice's level. A reference that is worse than a committed floor is a vendor-voice regression even when it is self-consistent.

#### W1 re-point: level, clips, German re-cast

- **Level at native.** The cascade carries no `output.volume`, no client gain and no limiter. Each voice's native level is its target; a delivered level difference is a pipeline defect, not a tuning knob. The managed path keeps `output.volume` until it retires.
- **Clips.** A checked-in script renders each voice's real greeting, in its own Locale, at native level, from the same synthesis endpoint and binding table the call uses. A clip whose voice, Locale, text, format or measured level disagrees with its binding fails. Byte identity is not assumed; M15 measures whether the vendor render is deterministic, and only then requires a byte-identical regeneration. A voice/locale/level/format difference always fails. The PR test replays a recorded synthesis fixture; a live regeneration is key-gated and recorded as evidence, never a silent asset swap.
- **German.** `juergen` returns `422 voice_not_found` from the synthesis endpoint. Probe for a valid id first — a slug, a UUID, or an account-cloned slug. If a valid id exists, bind it and audition it. If it is genuinely absent, re-cast German to a catalogue voice whose declared Locale is `de`, audition it by the owner, and record reviewer and date. If no catalogue voice can be bound to `de`, German stays open — it is not re-cast to a voice bound to another Locale, and it is not dropped. The old clip is retired, not kept as a silent fallback.
- **No voice without a binding.** A voice that cannot be bound to one Locale is not a cascade subject. The Locale stays open; it is not beta and not dropped.
- **Previews.** Previews are generated from the synthesis endpoint at native level and covered by the clip test. A preview that does not match its voice's Locale and level fails. The `voice-preview` route's "AssemblyAI offers no standalone TTS" comment is wrong and is corrected with the route's rationale.
- **No gain stage.** Any per-voice gain, limiter or normalisation on the cascade path is a bug. `output.volume` does not exist on the cascade; a level change is a new native render or a new voice decision, not a client stage.

#### W2 re-audition on the cascade

One real cascade call, non-English voice, by ear, with a clean artifact and two ballots; the verdict is written into the decision record.

- **Subject.** `lola`/es is the first non-English subject. `anna`/en must pass its own gates first. A Locale without a named native reviewer stays open and is never judged on an unproved instrument.
- **Artifact.** The subject's own cascade artifact, clean, with a delivered capture, a reference and a transcript. A fallback or a budget stop makes it ineligible. A missing capture or a missing ballot blocks.
- **Ballots.** Two independent ballots on one shared recording per subject, with written reasons. The owner's verdict is a separate recorded statement with date and reasons, not a substitute for the two ballots.
- **Verdict.** `accept` means the content did not hold up and the per-locale rendering layer is justified; `withdraw` means it held up and the layer is not justified to fix quality; `unresolved` means the pack cannot decide. These are ADR 0008's meanings; do not flip them.
- **No carry-over.** The managed-path verdict (ticket 41) does not carry over. A new cascade artifact and a new verdict are required.
- **No manual shortcut.** "Verify manually" is not a verdict unless the human and the capture are both named.

#### Deployment: container, drain, versions, token

- **Host.** A container host that supports long-lived WebSockets and rolling deploys. Cloudflare Workers cannot hold a three-minute socket, so the Python service does not deploy there. The host choice is recorded in the deployment record, not assumed from the existing Workers deploy; the repo has no Dockerfile today, so M17 adds one.
- **Topology.** Two instances minimum, stateless except for the durable breaker and counter stores, one call per socket, no sticky session requirement. Any instance can serve any new call; a live call stays on its instance until it ends.
- **Token.** A short-TTL HMAC token issued by the Next app and verified by the service. The browser cannot set an `Authorization` header on `new WebSocket`, so the token travels in the query string; the service redacts it from access logs. The token binds the call id, the agent/subject and an expiry. An expired token is refused at connect; a token for another call is refused; a second concurrent socket for the same call is refused. A reconnect uses a new token.
- **Protocol version.** The config carries `protocolVersion`. The service refuses an unknown or missing version with a named error, and the client surfaces it. A half-deployed pair fails loudly rather than guessing.
- **Health.** `/healthz` is liveness and touches no vendor. `/readyz` is readiness: not draining, breaker store reachable, counter store reachable. Readiness reports the stores and the drain state; it does not call a vendor on every probe. A draining instance fails `/readyz` and receives no new call. A store outage fails readiness and new calls are refused; a live call continues.
- **Drain.** SIGTERM: fail `/readyz`, stop accepting new calls, let live calls finish, exit. The drain does not terminate a live call. The maximum wait is an operational setting with a stated source; a single session is bounded by Meta's 60-minute limit, but a call that reconnects can outlive it, so the wait is an operational policy rather than an assumption. A deploy that cannot wait is a deployment-policy decision, not a reason to kill a call.
- **Secrets and logging.** Meta key, AI Gateway key, AssemblyAI key, tool secret, HMAC secret, database URL: host env, never committed. The Meta handshake body is never logged, because the key travels in it. A crash dump or request log that includes the handshake is a privacy incident, not a debugging convenience. The WS query token is redacted.
- **Versions.** The service reports its code version and the protocol version in the end message and in `/healthz`; the artifact records the app and service versions. A version mismatch is visible before a cutover claim.

#### CI: Python job, fixtures, anti-lie, rollback

- **Python job.** A job that installs the bridge venv (the judge parity imports `telephony-bot`), the pipeline's vendor libraries and `fastapi`/`uvicorn`, then runs the Python test suite. The repo currently runs no Python job; that is the gap. A broken Python test fails CI, proved by a deliberately red commit.
- **Fixtures.** One suite per provider replaying recorded frames through the injected socket factory. A negative test asserts that the STT client never sends a text frame other than `endStream`. A fixture with a new additive event is accepted and ignored; a changed field fails the fixture and names the drift.
- **Anti-lie tests.** These are mandatory and proved red first:
  - a fallback-contaminated run cannot be green;
  - a run with no delivered capture cannot pass the timbre gate;
  - a run below budget cannot pass the reply-gap gate;
  - deleting the `provider_fallback` emission fails the eligibility test;
  - flipping routing to managed opens zero cascade sockets.
  Each proof is attached to the ticket as the red case, not described as an intention.
- **Rollback test.** Flip `routing` to `off`, assert new calls route managed and live calls finish. The rollback is a runtime switch, not a deploy.
- **Browser end-to-end seam.** A real Chromium, the real `CascadeSession`, the real playout worklet and a deterministic fake WebSocket server replaying recorded frames. It writes a real delivered capture and runs on every PR. It asserts the negotiated format, the cushion and drift behavior, the barge-in flush and cut, the greeting's first-audible chime, duplicate `seq` drop, the goodbye drain, and the error view. It is not a live vendor run: live vendor smoke remains key-gated and off PR CI. The artifact it produces is a browser-delivery artifact, not a cutover artifact.
- **Nightly smoke.** One call per leg, key-gated, re-recorded fixtures, drift alert, no commit. A vendor outage is an alert, not a red PR. The nightly smoke does not write the production breaker or counter; it uses a non-production store or records only.
- **Live run rules.** Live timing runs stay one at a time under the existing timing lock. Artifacts and event streams stay gitignored. No live run in PR CI.

#### Cutover and rollback rehearsal

- **All six or none.** Six demo voices, each with two consecutive clean runs, no fallback, no budget stop, a clean W0 pair, a W2 verdict and two ballots. One failed subject blocks the cutover; no waiver, no beta, no quiet omission.
- **Rollback rehearsal.** Before cutover, flip `routing` to `off`, confirm new calls route managed and live calls finish, record the dated artifact and the operator. The rehearsal is a record, not a memory. The rollback is a runtime switch, not a deploy.
- **Signatures.** The owner signs quality; one named engineer signs the system. Two people, not one person twice.
- **Routing.** At demo cutover, `routing` is `demo`; at full cutover, `routing` is **`all`**. Every eligible subject — demo or tenant — runs cascade; every ineligible body routes managed with a named reason. BYO-LLM (ticket 159) and auto-detect (ticket 160) are eligibility gaps to close, not permanent exclusions. The artifact path and run ids are cited in the decision record.
- **Kill criterion.** If three measured rounds fail `replyGapP50Ms ≤ 1500`, the automatic cutover does not proceed and `routing` stays `off`. The owner may explicitly accept the risk and run cascade anyway; that acceptance is a dated decision record with the evidence attached, never a silent default. A fourth measurement attempt still needs a new mechanism, not optimism.
- **Post-cutover.** The managed path remains live and reversible until the decommission decision (ticket 161). The breaker, counter and routing switch remain the operational controls. A second failure on a leg still ends a call cleanly; it does not silently move the product. `off` must always route a working product.
- **Decommission.** Removing managed is a separate, dated decision after a recorded stability window (ticket 161). Until then, `off` is the rollback and must remain deployable. A rollback you cannot invoke is not a rollback.

#### Phone cascade adapter (parked)

- **Transport.** Telnyx 8 kHz μ-law in 20 ms frames, decoded to 24 kHz 16-bit mono for Meta STT, and synthesized natively as `pcm_mulaw` at 8 kHz. Pace μ-law at 8,000 bytes/s; never forward as fast as it arrives.
- **Instrument.** A phone call is not measurable as Delivered audio today. The adapter is blocked by M19 and by an instrument that does not exist: a carrier-side or bot-side capture of what the caller actually hears, not the platform's recording.
- **Parity.** The shared barge-in and goodbye-drain case table must pass unchanged. The phone's buffer timing differs; the budgets do not.
- **Scope.** No phone cutover claim before the instrument exists. The managed bridge remains the phone product. Folding `telephony-bot` into the shared engine remains ADR 0007's recorded target, not this work.

## Edge case catalog

This catalog is normative. A row is either a test, a named refusal, or a named open decision. No row is left to "handle sensibly".

### Provider wire and session lifecycle

| Case | Required behavior |
|---|---|
| Meta handshake is not sent within 10 s | The vendor closes; the call fails visibly, records the reason, opens the STT breaker if the close is retryable. |
| Meta handshake ack has no `type` | Treated as the ack. Any other untyped frame before the ack is a protocol error. |
| A client text frame other than `endStream` is attempted | The client refuses locally; a test fails if the frame is emitted. There is no `ForceEndpoint`. |
| `speechStart` arrives while a previous turn is open | Both turns are tracked by `turnId`; the logical turn state is separate. |
| A partial arrives with no preceding `speechStart` | Logged and ignored; it is not attributed to a turn and never reaches the LLM. |
| `speechComplete` arrives for an unknown `turnId` | Logged and ignored; the call continues. |
| Duplicate `speechComplete` for the same `turnId` | Idempotent: the second is ignored; one reply at most. |
| `speechComplete` text differs from the last partial | `speechComplete` wins; the partial is never used as a user message. |
| `speechComplete` is empty | Counted as a no-speech turn; no LLM request, no reply. |
| Turn 2's `speechComplete` arrives before turn 1's | Held and answered in logical turn order; a bounded stall guard closes an abandoned turn. |
| A `speechStart` arrives during the greeting | The greeting is cancelled; the caller's turn wins. |
| A `speechStart` arrives during a tool hold | The hold line is cancelled; the tool result is still appended to history. |
| A `speechStart` arrives during the goodbye | The hangup is disarmed; the caller's turn wins. |
| The caller pauses longer than the TTS idle timeout | `KeepAlive` at a named interval below 120 s keeps the TTS session open; a missed keepalive is a TTS failure, not a silent gap. |
| The STT session reaches 60 minutes | Planned reconnect before the limit at a turn boundary; if it arrives mid-turn, use the failure path: new session, replay the turn audio, map the turn id. No resume token; the logical turn and call `seq` continue. |
| The TTS session reaches `expires_at` | Drain the current reply, open a new session for the next turn; no mid-sentence reconnect. |
| Meta closes `1008` | Fail the call, alert, do not retry, do not open the breaker: this is a request/pacing bug. |
| Meta closes `1011` | Retry once with a new session; if the reason is max duration, treat it as a planned reconnect. |
| Meta closes `1013` | Back off, open the STT breaker; no immediate retry storm. |
| TTS closes `3006` | Fail the call and alert; this is a configuration bug, not a provider outage, and does not open the breaker. |
| TTS closes `3008` | Session expiry (planned, not a breaker trigger): drain, new session for the next turn. |
| TTS closes `3010` | Rate/backlog (our pacing, not a breaker trigger): shed prefetch, back off, never flush per token. |
| TTS closes `3011` | Unread audio (our read path, not a breaker trigger): read faster or reduce the queue; do not retry blindly. |
| TTS closes `3005` | No output while a `FlushDone` was owed: retry once; if it fails again, fail visibly and open the breaker. |
| TTS closes `1009` | Message too large (our Generate size, not a breaker trigger): split the `Generate`; one `Generate` is at most 2,000 characters. |
| TTS socket closes without a code, with `1006`, or with `1011` | One reconnect; if it fails again, end without a spoken goodbye and open the breaker. |
| The LLM request times out before the first content token | Retry once; if it fails again, open the breaker; do not speak a partial. |
| The LLM request times out mid-reply | Drain the queued sentences; close at the last complete sentence; do not restart the completion. |
| TTS `Begin` echoes a different rate, encoding, voice, language or model | Fail the call visibly; do not play audio; record the mismatch. |
| `FlushDone.audio_duration_ms` disagrees with bytes received | Fail the call as audio loss; the delta is recorded. |
| `Cancel` with nothing in flight | `Cancelled` with 0.0; no audio to stop; the client flush still runs. |
| `Audio` arrives between `Cancel` and `Cancelled` | Dropped; it belongs to the cancelled request. |
| The next `flush_id` skips numbers | Read it from the first frame after `Cancelled`; never compute it. |
| A `Generate` is sent immediately after `Cancel` | It is not caught by that cancel; the tail can be re-sent without waiting for `Cancelled`. |
| `Cancel` is sent after `expires_at` | No `Cancelled`; stop playback locally; the session is ending. |
| `Begin.configuration.unknown_params` is non-empty | A configuration bug; refuse the call by name rather than ignore a misspelt parameter. |
| Meta emits an unknown additive event | Ignored; it is not a failure. A changed known field is a fixture drift. |
| Meta emits a binary frame | Ignored; audio is client-to-server only. |
| The browser sends a malformed base64 audio frame | Dropped and logged; it never enters the STT stream. |
| The browser disconnects without `stop` | The server drains, sends `endStream`, and ends with metrics; it does not hang. |

### Turn boundary, floor arbitration and ordering

| Case | Required behavior |
|---|---|
| A final is classified as a backchannel | Counted; no reply; no `Cancel`. |
| A final is classified as echo | Counted; no reply; no `Cancel`. |
| A command overlap is detected | Take the floor, `Cancel`, pivot; the command set is the existing one. |
| "yes"/"yeah" is the only overlap | Not a command; the existing soft-confirm path, not a hard cut. |
| A filler is misclassified as an interruption | The tail resume recovers the audio; zero LLM calls. |
| A real interruption happens mid-sentence | `Cancel`; audio stops within `realCutMs`; the tail resumes from the first unheard word. |
| A real interruption happens while the model is thinking | Cancel the LLM stream; no audio to cut; the next final is the new turn. |
| A real interruption happens during a tool hold | Cancel the hold line; the tool result still lands; the next turn uses it. |
| A second interruption arrives during a tail resume | The stale resume is cancelled; the latest caller turn wins. |
| Two finals arrive with no pause | Two logical turns; replies are ordered; the second may be a continuation, handled by the LLM context, not a new gate. |
| A final arrives while the previous reply is still streaming and no floor decision was made | It waits for the reply to settle, bounded by the stall guard, then replies. |
| The stall guard fires on an abandoned turn | The abandoned turn is recorded with no reply; the later turn is answered; no silent loss. |
| A provider `turnId` is reused after reconnect | Disambiguated by the session epoch; it never merges with the old turn. |
| A late `speechComplete` from the old session arrives after reconnect | Ignored; the logical turn's new session is authoritative. |
| A turn's reply is cut by a barge-in and the caller never returns to it | The reply is recorded as interrupted; the unspoken tail is not replayed unless the filler path asks for it. |
| The agent is silent and a partial arrives | Prefetch may start; it is read-only and cancellable; it is not a reply. |
| The prefetch text differs from the final | The prefetch is dropped; never adopted; no user message is invented from a partial. |
| A partial is identical to the previous partial | Ignored; no duplicate ledger mark, no duplicate prefetch. |
| A final arrives before any `speechStart` | Protocol violation; logged and ignored; no reply. |
| The caller speaks only silence | No `speechStart` or an empty `speechComplete`; no reply; the call continues. |

### Body adapter and eligibility

| Case | Required behavior |
|---|---|
| An unknown top-level body key | Refuse by name; route managed; record the reason. |
| An unknown `input` or `output` subkey | Refuse by name; never silently drop. |
| `llm: []` | Allowed; the documented revert to the default Meta rung. |
| `llm: [ {...} ]` | Constructed from the stored body; an unconstructible override fails visibly. |
| `greeting` absent | No greeting; valid for the resume variant. |
| `greeting` empty string | No greeting; valid; not a TTS request. |
| A greeting longer than 2,000 characters | Split at sentence boundaries; never one over-cap `Generate`. |
| `voice.voice_id` is not in the binding table | Refuse by name; route managed. |
| `language_codes` is absent or empty | Refuse: automatic language detection is not eligible on this slice; TTS needs one Locale. |
| `language_codes` contains a code Meta does not support | Refuse by name; never drop a language silently. |
| `language_codes` contains the voice's Locale plus another language | Allowed for STT bias; TTS stays the voice's Locale. |
| `keyterms` exceeds the vendor's keyword limit | Refuse by name; never truncate silently. |
| `input.transcription_prompt` is non-empty | Ignored by the adapter, recorded; the pre-cutover recognition check must show the words are represented elsewhere before cutover. |
| `input.turn_detection` is present | Ignored; the provider owns the boundary. |
| `output.volume` is present | Ignored; managed-only; the cascade has no gain stage. |
| `tools` has a name with more than one dot | Refuse by name; Meta returns HTTP 400. |
| `tools` has an invalid character in a name | Refuse by name. |
| The served body hash does not match the signed envelope | Refuse; never open a vendor socket. |
| The app's full fingerprint does not match the minted fingerprint | Refuse; route managed; record the mismatch. |
| The body has no `system_prompt` | A body contract violation; refuse by name. |
| A body key is added in a future builder change | The adapter fails until the map or ignore set is deliberately extended; that is the point. |

### Tools and model output

| Case | Required behavior |
|---|---|
| A tool call delta is split across chunks | Accumulate by `index`; emit one request per index. |
| Two tool calls in one turn | Execute in index order; append results in call order; one `tool` message per call. |
| A tool call has no `call_id` | Do not execute; close the turn with a hold line; record the denial. |
| A `call_id` is longer than 64 characters | Fail the turn; provider contract violation. |
| Tool arguments are invalid JSON | Do not execute; return a tool failure; the model can correct. |
| Tool arguments are valid JSON but not an object | Do not execute; return a tool failure. |
| The same `(name, canonical args)` repeats in one turn | Replay the memo; do not re-execute. |
| The same tool call repeats after an LLM reconnect in the same turn | Replay the memo; no double side effect. |
| A tool times out after a side effect | Record indeterminate; do not auto-retry in the turn; the route's `toolCallId` lets the tool dedupe. |
| The tool route returns 401/404/500 | Convert to a tool failure; the call continues. |
| The model invents a tool name | Deny, count, hold line; never execute. |
| The model emits content on a `tool_calls` turn | Discard from audio; speak the hold line; keep the assistant message in history. |
| `finish_reason: length` | Speak what was generated; mark truncated; do not retry. |
| `finish_reason: content_filter` | Speak what was generated; mark filtered; do not retry. |
| `finish_reason: stop` with empty content | No audio; close the turn; record it. |
| The tool loop reaches its cap | Speak a localized fallback line; end the turn; record the cap. |
| `end_call` arrives during a tool result | The closing line wins; the tool result is recorded but not spoken. |
| A barge-in arrives during the goodbye | Disarm the hangup; the caller wins. |

### Money and cost

| Case | Required behavior |
|---|---|
| Usage is missing because the stream was interrupted | `unmeasured`, never zero; no cost claim. |
| A call spans UTC midnight | Per-unit day buckets; both days are charged. |
| A reconnect replays audio | Counted; the vendor bills it. |
| A fallback leg runs | Counted; the run is contaminated. |
| A prefetch is dropped before any usage | Not counted. |
| A prefetch gets a 429 | Prefetch is shed; the breaker does not open; the real turn is served. |
| A real turn gets a 429 | Breaker opens after the retry policy; the call falls back or fails visibly. |
| The daily counter crosses 80% during a live call | The live call continues; the next new call routes managed; one alert. |
| The daily counter crosses 100% during a live call | The live call continues unless its own ceiling stops it; new calls route managed; one alert. |
| A per-call ceiling is crossed by a single LLM turn | Check after the unit; drain; no new request except the goodbye; record `budget_stopped`. |
| The goodbye itself crosses the ceiling | Allowed; recorded; does not re-trigger. |
| A managed call runs during a cascade budget stop | The managed meter is separate; no double counting. |
| Two instances increment the counter at the same moment | Atomic increment; one crossing event. |
| A rate table is missing a unit | The cost is `unmeasured`; the table is incomplete. |
| A rate changes | A new table version; old artifacts keep their version. |

### Evidence and A/B

| Case | Required behavior |
|---|---|
| A run used a fallback at connect | Contaminated; ineligible for green; the event names the connect phase. |
| A run used a fallback mid-turn | Contaminated; ineligible for green; the event names the turn. |
| A run stopped at the per-call ceiling | Contaminated; ineligible for green. |
| A run has no delivered capture | The timbre gate is `unmeasured`/`FAIL`; never `PASS`. |
| A run has no reference capture | The comparison is incomplete; never `PASS`. |
| A run has a cascade artifact claiming a platform capture | Invalid artifact; refuse. |
| A managed artifact claims a cascade-only event | Invalid artifact; refuse. |
| A subject's artifact is from an older code fingerprint | Historical only; not current; `BLOCKED` for the current matrix. |
| A subject has no artifact | `BLOCKED` with a named reason; never `PASS`. |
| The featured subject fails | Every other subject stays `BLOCKED`; `--strict` fails. |
| A small-sample scope | Judge against the tail budget, not its own median. |
| A contaminated round | Not a measured round; re-run; does not count toward three. |
| A round passes the reply gap but fails barge-in | No cutover; does not trigger the kill criterion; fix or wait. |
| A managed run records screen latency or think as zero | Invalid; must be `N/A — no partials` / `N/A — no token stream`. |
| A cost row has an unmeasured unit | Total is `unmeasured`; never a partial sum presented as complete. |

### Audio and instrument

| Case | Required behavior |
|---|---|
| The reference is at the true-peak ceiling | Verdict names the vendor voice; fix the reference before judging downstream. |
| The reference has an inserted silence | Verdict names the vendor voice; downstream unresolved. |
| The reference is the wrong line | Verdict names vendor voice/model text; audio layers were never comparable. |
| The delivered capture is a whole call with no line marker | Incomplete; use the greeting line or a marked segment. |
| Reference and delivered onsets differ by more than 50 ms | Unresolved; no layer blamed until aligned. |
| Reference and delivered formats differ | Unresolved; resample only through the shared decoder, never guess. |
| A metric cannot fail on a synthetic worst case | The metric does not ship. |
| A voice's native level differs from another voice | Expected; each voice is compared to its own reference. |
| A delivered level differs from the reference | Our pipeline or the client, not a gain knob; the verdict names the layer. |
| Chunk-rate modulation appears | Client signature; the playout owns timing and nothing else. |
| A device-rate path aliases | Client signature; the decimation filter is required. |
| A boundary fade appears mid-reply | Client signature; fades only at a true boundary. |
| `juergen` returns 422 | Probe for a valid id; re-cast if absent; the clip is retired, not silently kept. |
| A preview does not match its voice's Locale or level | Fail the clip test. |
| A clip's bytes differ but the binding and level match | Not a failure; a vendor render is not a stable artifact. |

### Operations and human gates

| Case | Required behavior |
|---|---|
| A deploy starts while a call is live | `/readyz` fails; the call finishes; the new instance takes new calls. |
| A draining instance receives a new call | Refused; the app routes to another instance or managed. |
| A token expires at connect | Refused; the browser surfaces a named error. |
| A token is reused for a second concurrent socket | Refused; one call per socket. |
| The protocol version is missing or unknown | Named refusal; no guessing. |
| The breaker store is down | `/readyz` fails; new calls refused/managed; live calls continue; the last durable state is the fallback. |
| A breaker write fails during a call | Alert; the call continues on its chosen rung; the next call re-reads. |
| A manual fallback pin is set | Probes never clear it; only a human write does. |
| A stale record's `lastProbeAt` is older than 60 s | Read as `half_open`; no silent green. |
| A probe succeeds three times 30 s apart | Closed; the next real call is the canary. |
| The canary fails | Reopen immediately; no three-probe ritual. |
| The nightly smoke sees a vendor outage | Alert, not a red PR; do not write the production breaker. |
| A subject has no named native reviewer | The Locale stays open; not beta, not dropped, not cut over. |
| A W2 pack is missing a capture or ballot | `unresolved`; blocks; never a pass. |
| A cutover subject fails | All six are blocked; no waiver. |
| The owner and engineer signatures are the same person | Invalid; two people are required. |
| The rollback rehearsal is missing | No cutover; a memory is not a record. |
| Three measured rounds fail the reply gap | No cutover; routing stays `off`; a fourth attempt needs a new ADR and a new mechanism. |

## Testing Decisions

Good tests assert external behavior: what the caller heard, what the artifact reports, what the comparison concludes, and what the harness refuses to accept. They never assert private fields, call order, or an implementation detail that is not itself a wire contract. A test that can pass with the feature deleted is not a test; the red case is proved first for gates and failure paths.

There are four primary seams. Each is an existing seam or the highest available point; no test reaches inside a provider client when a socket factory will do.

### Seam 1 — The orchestrator's provider interfaces

The highest seam for call mechanics. Fake `StreamingSTT`, `LLMStream` and `StreamingTTS` implementations feed a scripted event trace through the orchestrator; a fake clock makes every gap and timeout deterministic. The provider *wire* is tested behind the same seam by replaying recorded frames through each client's injected socket/session factory, so a backend never needs a live vendor to prove its contract.

- **Call mechanics.** Interleaved turns, late `speechComplete`, duplicate finals, backchannel/echo/command classification, reply ordering, the stall guard, no LLM request between `speechEnd` and `speechComplete`, and no partial ever treated as a final. Prior art: the existing Python orchestrator and turn tests.
- **Provider contracts.** STT event mapping and the `endStream`-only negative test; LLM tool-delta accumulation and the Contributor guard; TTS `Begin` echo, `FlushDone` byte check, `Cancel` ordering and `Termination` characters. Prior art: the existing provider tests and the injected socket factories.
- **Breaker and routing.** The state machine on a fake clock: every transition, the three-probe hysteresis, the canary, the manual pin, the stale read, and `routing=off` producing zero cascade connections. Prior art: the config and server tests.
- **Money.** A fake meter and clock: 80%, 100%, per-call ceiling, prefetch shedding, a prefetch 429 not opening the breaker, a real 429 opening it, and atomic increments. Prior art: the metric tests.

### Seam 2 — The scoreboard runner and the pure gate/artifact functions

The same runner writes both artifacts; the same reader parses them. The gates are pure over the artifact, so the anti-lie tests can construct a contaminated artifact without a live call. Prior art: the existing scoreboard, report, and inspect tests.

- **Eligibility.** A fallback at connect, a fallback mid-turn, a budget stop, a missing delivered capture, a missing reference, and a stale code fingerprint each make a run ineligible. Deleting the `provider_fallback` emission fails the test.
- **Shared reader.** A cascade artifact with a platform capture is invalid; a managed artifact with a cascade-only event is invalid; an unknown schema version is refused.
- **N/A.** Managed records `N/A` for screen latency and think; a zero fails. A cascade records `N/A` for the commit-to-playout row.
- **Per-subject.** A carried-over verdict fails; a subject with no artifact is `BLOCKED`; the featured subject blocks the rest; `--strict` fails while blocked.
- **Kill criterion.** Three measured failures stop the work; a contaminated round is re-run and does not count; a round that passes the reply gap but fails another gate cannot cut over.

### Seam 3 — The audio comparison and verdict over decoded WAVs

The comparison is pure over decoded audio; the verdict is pure over the comparison table. Synthetic WAVs with known level, distortion, crest, octave tilt, inserted silence, modulation and true peak prove each metric can fail. Prior art: the existing comparison, verdict, level-facts, distortion-crest, envelope-modulation, spectral-balance, breakup and vendor-floor tests.

- **Verdict layers.** Each cascade layer is reachable: vendor voice, model text, our pipeline, client. A later divergence cannot steal the blame.
- **Missing data.** A missing, unreadable, header-only, stereo, wrong-rate or misdescribed capture is `unresolved`; an onset beyond 50 ms is `unresolved`; a format mismatch is `unresolved`.
- **No pass by arithmetic.** The old formula that compared a constant to itself is gone; every level leg is a measured file.
- **Vendor floor.** A reference worse than the committed floor names vendor voice; a voice without a floor is compared to its own reference.

### Seam 4 — The browser end-to-end path

A real Chromium, the real browser client, the real playout worklet and a deterministic fake WebSocket server replaying recorded frames. It writes a real delivered capture through the existing dev tap and runs on every PR. This is the fourth primary seam and the one that catches client-only regressions the unit seams cannot.

- **What it proves.** The negotiated format is played at the rate the session confirmed; the cushion and drift behavior do not modulate the voice; a barge-in flushes and cuts within `realCutMs`; the greeting fires the chime on the first audible sample; a duplicate `seq` is dropped; the goodbye drains; an error is visible; the delivered capture is sample-exact and non-intrusive (enabling capture does not change the emitted samples).
- **What it does not prove.** It is not a live vendor run and cannot be a cutover artifact. Live vendor smoke stays key-gated, nightly, one call per leg, and off PR CI. The browser E2E's artifact is a browser-delivery artifact; the W0 live pair remains the quality artifact.
- **Prior art.** The existing browser client tests with injected sockets and microphones; the worklet tests; the Playwright e2e harness. The new seam is the same fake-socket technique driven through a real browser and a real worklet, not a new framework.
- **CI cost.** It is a PR job with a bounded runtime. If it outgrows the PR budget, it moves to a required pre-merge job, not to nightly-only, because the product requirement is that a browser artifact exists before merge.

### Fixtures, chaos and live smoke

- **Fixtures block every PR.** One suite per provider replays recorded frames. A fixture is a contract, not a snapshot of a mood: a changed known field fails and names the drift; an additive unknown event is ignored.
- **Chaos is deterministic.** Fake sockets, a fake clock, injected delays and close codes, duplicated frames, a mid-turn socket kill, a `Cancel` with no in-flight request, an expiry-time `Cancel`, a malformed tool delta. No sleeping tests.
- **Live smoke is key-gated and never in PR CI.** Nightly, one call per leg, which re-records the fixtures and alerts on wire drift without committing them. It does not write the production breaker or counter.
- **Unit tests never stand in for a call.** A subject is accepted only on a live artifact plus a ballot. The browser E2E and the fixture suites are safety nets, not quality claims.

## Ticket graph

A ticket is unblocked when every id in **Blocked by** is `resolved`.

| Id | Title | Blocked by | Gate it proves |
|---|---|---|---|
| M00 | Latency spike: the five terms | — | feasibility |
| M01 | Provider breaker and routing switch | — | routing |
| M02 | Meta STT backend (`ENDPOINTING`) | M00, M01 | contract |
| M03 | Meta LLM backend (Standard Spark) | M00, M01 | contract |
| M04 | AssemblyAI TTS backend and voice binding | M00, M01 | contract |
| M05 | Stored-body adapter and signed body | M01 | one body |
| M06 | Orchestrator: logical turns, provider-owned boundary | M02, M03, M04, M05 | mechanics |
| M07 | Greeting on the cascade | M06 | first impression |
| M08 | Tools: HTTP execution, idempotency, narration hold | M06 | tools |
| M09 | Barge-in on `Cancel`, tail resume without LLM | M06 | turn-taking |
| M10 | Reconnect, sequence dedupe, partial reply | M06 | failure |
| M11 | Budget meter, per-call ceiling, prefetch shedding | M03, M04 | money |
| M12 | Event schema, attribution, cost per call | M06 | eyes |
| M13 | Gap A/B and run eligibility | M00, M12 | the claim |
| M14 | W0 two-capture profile and verdict rule | M07, M12 | instrument |
| M15 | W1 re-point: level, clips, German re-cast | M04, M05, M07 | audio |
| M16 | W2 re-audition on the cascade | M13, M14, M15 | quality, human |
| M17 | Deployment: container, drain, versions, token | M01, M05 | operations |
| M18 | CI: Python job, fixtures, anti-lie, rollback, browser E2E | M02, M03, M04, M13 | safety |
| M19 | Cutover to all eligible subjects and rollback rehearsal | M13, M16, M17, M18 | cutover, human |
| M20 | Phone cascade adapter | M19 | parked |

### Ticket detail

Every acceptance criterion below is observable and every test can fail. The edge case catalog above is the expansion; the criteria below are the minimum a ticket must satisfy.

**M00 — Latency spike.** Record one 20 s WAV; run it through Meta STT, Spark and a pre-opened synthesis session; print the five terms.
- AC1: the report names, in ms, endpointing latency, `speechEnd` → `speechComplete`, first-content-token time, synthesis first-audio, and the configured playout cushion.
- AC2: the summed floor is compared to 1500 and 2500, and the report says `PASS`, `FAIL` or `AT RISK` — never a silent blank. `PASS` requires every term measured and sum ≤ 1500; `AT RISK` covers 1500–2500 or an unmeasured term whose measured terms are still inside 2500; `FAIL` is > 2500.
- AC3: a reasoning-only delta does not count as first content; `reasoning_effort: "none"` is reported as unavailable.
- Test: a synthetic timeline with a known injected delay per term reproduces the expected sum; deleting one term fails the report.

**M01 — Breaker and routing.** Durable per-leg record, transition on the closed trigger set, probe with hysteresis, manual pin that probes never clear, staleness read as `half_open`, `routing: off|demo|all` governing new calls only.
- AC1: a retryable rejected request opens the leg; the next call makes zero requests to the failed provider.
- AC2: three probe successes ≥ 30 s apart close it; one real-call failure re-opens it.
- AC3: `manual_override=fallback` survives every probe; only a human write clears it.
- AC4: a record whose `last_probe_at` is older than 2× the interval is read as `half_open`.
- AC5: `routing=off` produces zero connections to the cascade.
- AC6: a deterministic request error (`1008`, `3006`, `3010`, `3011`, `1009`, HTTP 400) fails the call and does not open the breaker.
- Test: the state machine driven by a fake clock; each AC is a failing assertion when the transition is removed.

**M02 — Meta STT.** Handshake with the credential in the frame, `PCM_24KHZ`, `ENDPOINTING`, `languageBias` and `keywords` from the Locale bundle, events mapped to the existing contract.
- AC1: `speechStart`/`transcript`/`speechEnd`/`speechComplete` parse; a partial is attributed to the most recent `speechStart`'s turn.
- AC2: a replay where turn 2 opens before turn 1's `speechComplete` keeps both turns distinct.
- AC3: close codes `1008`, `1011`, `1013` each produce the documented action, and `1008` is not retried.
- AC4: the client sends no text frame other than `endStream`, ever.
- AC5: the handshake ack (no `type`) is handled; an unknown additive event is ignored.
- Test: recorded frames replayed through an injected socket factory; AC4 fails if any other text frame is emitted.

**M03 — Meta LLM.** OpenAI-compatible streaming on `muse-spark-1.3`, tool deltas accumulated by index, `usage` captured, `-contributor` unreachable from a customer call.
- AC1: a tool-call turn parses name and arguments from deltas and emits exactly one `ToolCallRequest` per index.
- AC2: `usage` is recorded per turn with input, output, cached and reasoning token counts; a missing usage is `unmeasured`.
- AC3: a config naming a Contributor model is rejected at construction, not at request time.
- AC4: `reasoning_content` never reaches TTS and never marks first content.
- Test: recorded SSE fixtures; AC3 fails if the guard is removed.

**M04 — AssemblyAI TTS.** One socket per call opened at call start; `Generate`/`Flush`/`Cancel`/`Terminate`; `pcm_s16le`@24k for browser and `pcm_mulaw`@8k for phone; the binding invariant enforced.
- AC1: `Begin.configuration.sample_rate` and `encoding` are asserted against what was requested; a mismatch fails the call visibly.
- AC2: every request's `language` equals the voice's declared Locale, asserted against the session echo.
- AC3: `FlushDone.audio_duration_ms` matches the bytes received within a few ms.
- AC4: `Termination.total_input_char_length` is recorded as the billed unit.
- AC5: `Cancel` drops audio until `Cancelled` and reads the new `flush_id`; only documented TTS control frames are sent.
- Test: an injected socket that echoes a wrong sample rate must fail AC1; a request with a mismatched language must fail AC2.

**M05 — Stored-body adapter.** Editable body in, cascade config out: explicit field map, explicit ignore set, unknown key fails, an LLM override is constructed from the stored body (ticket 159).
- AC1: every mapped field appears in the config; every ignored field is listed and absent.
- AC2: adding a body key that appears in neither set fails the adapter by name.
- AC3: a body with one non-empty `llm` entry constructs the BYO client from the stored body; an unconstructible override fails visibly before any vendor socket; `llm: []` uses the default rung.
- AC4: the fingerprint of the served body equals the fingerprint the app minted; the service verifies the body hash and the signed envelope.
- AC5: a body with no fixed Locale, an unbound voice, or an invalid tool name is refused by name.
- Test: a smuggled key fails; the old override refusal is gone (deleting the construction fails the test).

**M06 — Orchestrator.** Logical-turn state, `speechComplete` as the only LLM input, floor arbitration, final suppression, no speculative commit.
- AC1: a final classified as backchannel or echo is counted and produces no reply.
- AC2: a command overlap ("stop", "no", "hold on") takes the floor and steers the next turn.
- AC3: turn state survives an interleaved turn without cross-talk.
- AC4: no code path acts on a partial as though it were a final; zero LLM requests between `speechEnd` and `speechComplete`.
- Test: a scripted event trace with an interleaved turn, a backchannel and a command; AC1 fails if suppression is removed.

**M07 — Greeting.** The body's greeting is spoken before any user audio, through the bound voice, cancellable.
- AC1: a call with no user audio emits the greeting and marks it in the ledger.
- AC2: the greeting text equals the body's greeting and the clip's source line.
- AC3: a barge-in during the greeting cancels it and the caller's turn wins.
- Test: a fake clock call with zero mic frames must produce greeting audio; AC3 fails if `Cancel` is not sent.

**M08 — Tools.** Execution over the existing HTTP route, real ids only, turn-keyed idempotency, narration discarded with a localized hold line.
- AC1: a tool result reaches the model as a `tool` message and the reply continues in the same turn.
- AC2: a repeated `(name, canonical-args)` in one turn replays the memoised result and does not re-execute.
- AC3: a call with no `tool_call_id` is not executed.
- AC4: content emitted on a turn ending `finish_reason: tool_calls` is discarded and the hold line is spoken instead.
- AC5: a timed-out tool returns an indeterminate failure result; the call continues; no automatic retry.
- Test: a fake executor counting invocations — a retry must leave the count at one; AC4 fails if the raw content is spoken.

**M09 — Barge-in.** `Cancel` on interruption; unseen tail resumed by re-synthesis with no LLM call.
- AC1: an interruption sends `Cancel` and audio stops within the `realCutMs` budget.
- AC2: a filler interruption resumes the unheard tail and makes zero LLM requests.
- AC3: the cross-transport case table passes unchanged.
- AC4: audio between `Cancel` and `Cancelled` is dropped; a double barge-in uses the latest `flush_id`.
- Test: the recorded case table against the cascade; AC2 fails if any LLM request occurs during resume.

**M10 — Reconnect and duplicates.** One reconnect per leg, replayed turn audio, sequence-numbered frames, partial replies finish their sentences.
- AC1: an STT socket killed mid-turn reconnects and the turn's text survives.
- AC2: a duplicated audio frame is dropped; played audio never repeats.
- AC3: an LLM failure mid-reply plays the queued sentences and never cuts mid-word.
- AC4: a second failure on the same leg ends the call with a drain and a localized goodbye; a TTS second failure ends without a spoken goodbye.
- Test: injected close codes and a duplicated frame; AC2 fails if the playout accepts a non-advancing sequence.

**M11 — Money.** Wire-metered daily counter, routing at 80%, refusal at 100%, per-call ceiling, prefetch shed before a real turn.
- AC1: a call's cost is reproducible from recorded native units and a named rate-table version.
- AC2: crossing 80% routes the next call at managed and alerts; crossing 100% refuses cascade for new calls and alerts.
- AC3: a per-call breach ends with a drain and a `budget_stopped` mark; the goodbye is allowed.
- AC4: under RPM pressure prefetch is refused while a real turn is still served; a prefetch 429 does not open the breaker.
- Test: a fake meter and a fake clock; AC4 fails if prefetch is served before the bucket is empty.

**M12 — Eyes.** One event schema with `pipeline`, per-turn attribution, fallback and breaker events, cost.
- AC1: every turn names the `{stt, llm, tts}` actually used; a managed turn records `N/A — vendor-owned`.
- AC2: a fallback emits `provider_fallback` with leg, from, to, trigger, turn and phase; a connect-time fallback is included.
- AC3: the artifact is written by the same runner as the managed artifact and parses with the same reader.
- AC4: cost cites its rate-table version; an unmeasured unit makes the total `unmeasured`.
- AC5: no event carries text, transcript, audio, PCM or a key.
- Test: deleting the fallback emission fails a test; a second schema fails the shared reader.

**M13 — Gap A/B.** Both engines report the same gates; three gaps on the cascade, reply gap on both, `N/A` for what managed cannot produce.
- AC1: managed records `N/A — no partials` for screen latency and `N/A — no token stream` for think; never zero, never a win.
- AC2: a run containing a fallback or a budget stop is ineligible and cannot be green.
- AC3: a subject's row derives its verdict from its own artifact only.
- AC4: a contaminated round is re-run and does not count toward the three.
- Test: a contaminated artifact must fail eligibility; a carried-over verdict must fail.

**M14 — W0 two-capture.** Reference from direct synthesis, delivered from the browser tap, one comparison, one verdict rule.
- AC1: the verdict names a layer from the cascade set — vendor voice, our pipeline, model text, client.
- AC2: a missing capture makes the comparison incomplete, never a pass.
- AC3: every audio metric is proved able to fail on a synthetic worst case.
- AC4: the artifact carries capture paths and hashes only; no audio bytes.
- Test: a synthetic WAV with known level, distortion and an inserted silence must fail each metric in turn.

**M15 — W1 re-point.** Level at native, clips generated from the synthesis endpoint with the same binding table, German re-cast and auditioned.
- AC1: regenerating one clip reproduces the committed asset's binding, text, format and measured level; byte identity is required only if M15 measures the vendor render as deterministic, and any voice/locale/level/format difference fails.
- AC2: a clip whose Locale or level disagrees with its voice fails.
- AC3: German resolves to a served voice and its clip is committed with reviewer and date; if it cannot, the Locale stays open and blocks cutover.
- AC4: no voice carries a gain stage on the cascade.
- Test: the clip regeneration test; AC2 fails against a deliberately mismatched clip.

**M16 — W2 re-audition (human).** One real cascade call, non-English voice, by ear, verdict written into the decision record.
- AC1: the artifact exists for the subject, clean, with two ballots.
- AC2: the owner's verdict is recorded with date and reasons, accepting or withdrawing content rendering.
- AC3: a missing capture or a missing ballot blocks.
- Human: the owner. Artifact: the subject's cascade artifact path. No "verify manually" without both named.

**M17 — Deployment.** Container host, two instances minimum, direct WS with a short-TTL HMAC token, `/healthz` and `/readyz`, drain on deploy, versioned protocol.
- AC1: a deploy completes without terminating a live call.
- AC2: a draining instance fails `/readyz` and receives no new call.
- AC3: a token past its TTL is refused; a valid one is accepted without a proxy hop; the query token is redacted from logs.
- AC4: an unknown protocol version is refused with a named error.
- AC5: the Meta handshake body and the WS token never appear in a log.
- Test: a call held open across a rolling deploy must complete; AC3 fails on an expired token.

**M18 — CI.** A Python job, fixture suites, the anti-lie tests, the rollback test, the browser E2E, nightly drift detection.
- AC1: CI fails on a broken Python test (proved by a deliberately red commit).
- AC2: each anti-lie test is red when its feature is deleted.
- AC3: the browser E2E runs on every PR and writes a delivered capture without a live vendor.
- AC4: nightly smoke re-records fixtures, alerts on drift, and commits nothing.
- Test: the red-first evidence is attached to the ticket.

**M19 — Cutover (human).** All eligible subjects: the six demo voices plus every tenant subject eligible under `routing=all`, two clean runs each, W2 recorded, ballots, rollback rehearsal, two signatures. Routing becomes `all`; managed remains the `off` fallback.
- AC1: every subject's clean artifacts pass the frozen budgets with no fallback and no budget stop.
- AC2: the rollback rehearsal is recorded — flip to `off`, new calls route managed, live calls finish.
- AC3: the owner signs quality and one named engineer signs the system.
- AC4: `routing` is `demo` and the artifact path is cited in the decision record.
- Test: the rollback test in CI; the rehearsal is a dated record, not a memory.

**M20 — Phone cascade (parked).** 8 kHz μ-law transport, decode → 24 kHz for STT, μ-law synthesis native, a phone delivered-audio instrument.
- AC1: a phone call is measurable as Delivered audio before any cutover claim.
- AC2: parity with the browser is proven by the shared case table.
- Blocked by M19, and by an instrument that does not exist yet.

## Kill criterion

**If three measured rounds fail to land `replyGapP50Ms ≤ 1500` on a clean cascade artifact, the automatic cutover does not proceed.** `routing` stays `off` and the work closes with the evidence recorded. The owner may explicitly accept the risk and run cascade anyway; that is a dated decision record with the evidence attached, not a silent default. No fourth measurement round is authorised by optimism; a further attempt needs a new decision record with a new mechanism in it.

A round is measured: two subjects, two consecutive clean runs each, no fallback, no budget stop. A contaminated round is re-run, not counted. A round that passes the reply gap but fails another required gate does not trigger the kill criterion, but it cannot cut over either.

## Out of Scope

- Any edit to a frozen budget, window or percentile.
- The phone cascade adapter (parked behind the browser, ticket M20).
- Folding `telephony-bot` into the shared engine (ADR 0007 stands).
- Per-voice equalisation or any mastering chain.
- Speculative commit across `speechEnd` (deferred, see ADR 0011).
- ~~Tenants with a BYO `llm` override~~ — now in scope as ticket 159; managed is no longer their permanent path.
- ~~Auto-detect tenants with no fixed Locale~~ — now in scope as ticket 160; STT omits `languageBias` and synthesis uses the bound voice's Locale.
- Locale content rendering (tickets 49–57, 59), which stays blocked behind the re-run W2 gate.
- Landing-page layout and dashboard information architecture.
- A second cascade-specific agent body; a second builder; a second event schema; a second scoreboard reader.
- A mid-call handover from cascade to managed, or managed to cascade.
- A Meta TTS; there is none. A second voice vendor; there is no second voice worth having.
- Re-litigating Standard vs Contributor, the turn boundary, decoupled ladders, the frozen budget, or the no-beta/no-drop doctrine.

## Further Notes

### Verified vendor facts

Checked against the vendors' published documentation on 2026-10-29. Meta's API is weeks old; re-verify anything time-sensitive before implementation.

**Meta — realtime speech-to-text** (`https://dev.meta.ai/docs/speech-to-text`, `/docs/api-reference/voice/realtime`, `/docs/pricing-rate-limits`)

- Endpoint `wss://api.meta.ai/v1/asr/realtime`; handshake is the first JSON text frame within 10 s; `authorization.accessToken` carries `Bearer ` + key; the `Authorization` header is ignored; the ack has no `type`.
- Modes `PUSH_TO_TALK` (default), `ENDPOINTING`, `DIARIZATION`. `ENDPOINTING` emits `speechStart` → `transcript` (partials, no `turnId`) → `speechEnd` → `speechComplete`. Turns can overlap; key state on `turnId`. `speechComplete` text may differ from the last partial.
- Audio is mono signed 16-bit little-endian `PCM_24KHZ` (48,000 bytes/s) or `PCM_16KHZ` (32,000 bytes/s); binary frames; pace at real time; no more than 5 s ahead; idle input closes the stream.
- The only client text frame after the handshake is `{"type":"endStream"}`; it half-closes input and the server flushes pending results. There is no per-turn commit.
- `languageBias` is a list of language names, not codes; `keywords` bias vocabulary; both are frozen at session start. 25 languages. No word timestamps, no confidence.
- Close codes: `1000` normal; `1008` invalid request or streaming-policy failure (backlog, below-real-time ingress), not retryable; `1011` internal/backend failure, retry; `1013` rate limited, back off.
- Realtime session up to 60 minutes; no resume token; a new socket is a new session.
- Rate limits: 256 concurrent streams, 16,000 streams/hour, shared with file transcription. Pricing: $0.18/audio-hour, whole seconds; ZDR priced at parity.
- Streaming usage: Meta's `stream_options.include_usage` is supported; usage appears on the final chunk and may be absent on an interrupted stream.

**Meta — language model** (`https://dev.meta.ai/docs/protocols/chat-completions`, `/docs/tool-calling`, `/docs/pricing-rate-limits`)

- OpenAI-compatible Chat Completions on `https://api.meta.ai/v1`; `muse-spark-1.3` Standard; Standard $1.25 input / $4.25 output / $0.15 cached per 1M; Contributor $0.10 / $0.20 / $0.002, 150 RPM; Standard 3,000 RPM / 4M TPM.
- Muse Spark always reasons; `reasoning_effort: "none"` returns HTTP 400. `reasoning_content` streams separately from content. `temperature` defaults to 1.0; `stop`, `frequency_penalty`, `presence_penalty`, `n > 1`, `logprobs` are unsupported.
- Tool calling is OpenAI-compatible: tool definitions under `function`, `tool_choice` must be `"auto"`, `parallel_tool_calls` defaults true, arguments stream by `index`, `finish_reason: "tool_calls"`, `call_id` 1–64 characters, function names allow at most one dot. The full assistant message with `tool_calls` must be replayed before the `tool` messages.
- `stream_options.include_usage` returns usage on the final chunk, with `cached_tokens` and reasoning tokens.
- `system` and `developer` are accepted at the same precedence; `developer` is preferred for new prompts, but the body's `system_prompt` is sent unchanged.

**AssemblyAI — text-to-speech** (`assemblyai-docs` MCP, `/tts/*`)

- `wss://tts.us.assemblyai.com/v1/ws?voice_id=…&language=…&sample_rate=…&encoding=…`; HTTP `POST /v1/speech`; `assemblyai-tts-1`.
- `pcm_s16le` 24 kHz is native; `pcm_mulaw` 8 kHz is first-class for telephony. Audio is raw mono, no container; `FlushDone.audio_duration_ms` matches bytes to within a few ms.
- `Generate` appends text; `Flush` concludes a request; `Cancel` stops in-flight synthesis and discards unflushed text and pending flushes; `KeepAlive` restarts idle; `Terminate` performs an implicit flush and returns `Termination`.
- `Cancel` answers `Cancelled`; audio between `Cancel` and `Cancelled` belongs to the old request and must be dropped; the next `flush_id` may skip numbers; a `Generate` after `Cancel` is not caught.
- `Termination.total_input_char_length` / `billed_characters` is the billed unit; `audio_duration_seconds` and `session_duration_seconds` are reported.
- Limits: 2,000 characters per `Generate`; 3,600 s session; 120 s idle; ~100 chars/s intake; 8,000-character backlog; 20 control frames/s with ~60 burst; WebSocket message size cap. Close/error codes include `3005`, `3006`, `3008`, `3010`, `3011`, `1009`.
- `Begin.configuration` echoes voice, language, sample rate, encoding, model and limits; unknown params are listed in `unknown_params`.
- `assemblyai-tts-1` speaks all six of our languages, but a voice usually sounds best in its own language; the binding is asserted, not conventional.
- `juergen` returns `422 voice_not_found` from `/v1/speech`; 15 of 16 voices render; native levels are within 2.4 LU; `output.volume` is 100 everywhere.

### Repo facts that changed the design

- `voni/evidence/voice-levels/levels.json`: 15 of 16 voices render through TTS, including `giovanni`/it, `lola`/es, `rafael`/pt, `estelle`/fr. `juergen`/de returns `422 voice_not_found`.
- `voni/evidence/vendor-floor/anna-en.json` was captured through `POST https://tts.us.assemblyai.com/v1/speech` (`aai-anna`, `assemblyai-tts-1`); the vendor floor is still valid.
- `voice-pipeline/transport.py` takes `system_prompt` and `tools` off the wire from the browser; the cascade's "stored body" is client-assembled today.
- `voice-pipeline/orchestrator.py` records tool names and never executes a tool.
- `voice-pipeline/transport.py` has `handle_browser_call` only; no Telnyx handler. `TRANSPORTS` lists `telnyx`; nothing implements it.
- The cascade has no greeting. No `first_message` anywhere; a call opens in silence until the visitor speaks.
- `voni/src/lib/voice/cascade-session.ts` says "Service auth: none in dev (localhost)."
- `TimingLedger.summary()` ships to the browser and is consumed by one `console.debug`; no gap scoreboard, no artifact, no gate.
- Deployment is Cloudflare Workers via OpenNext; Vercel appears only as the AI Gateway URL. No Dockerfile / fly.toml / render.yaml / railway.json / Procfile. `telephony-bot` runs bare `uvicorn :8765` behind a cloudflared tunnel.
- CI runs `voni` only: typecheck, lint, ffmpeg, `npm test`. No Python job.
- Managed measured reply gap: p50 1923 ms, p95 2181 ms. Budgets: `replyGapP50Ms` 1500, `replyGapP95Ms` 2500, `realCutMs` 1500, `fillerResumeTailMs` 2500. No budget exists for screen latency or think; the managed path cannot produce them.
- `.scratch/demo-cascade-pipeline/issues/01-owned-pipeline.md` is referenced by `PROGRESS.md` and `docs/demo-latency-ladder.md` but does not exist. This spec is the owning artifact for that fallback.

### Rejected options, not to be re-opened

- **Keep the managed path and tune it.** Rejected. Four models, every STT preset, three turn-window rungs, all between 1.9 and 2.3 s. A fifth knob is a fourth failed experiment.
- **Couple the providers in pairs.** Rejected. A dropped speech socket would demote a healthy model, and "which model answered this turn" would become a function of an unrelated outage.
- **Use the Contributor model tier.** Rejected. It trains Meta models on caller names, budgets, financing and phone numbers. Standard also removes the prefetch squeeze, but privacy is the reason; do not re-justify with RPM.
- **Speculate a commit at `speechEnd`.** Deferred. The post-processing gap is undocumented, the final may differ from the partial, and a divergence costs a second LLM request. It becomes its own ticket with its own evidence if the measured gap misses after cutover.
- **A cascade-specific agent body.** Rejected. It recreates ADR 0006's two-builders divergence.
- **Ship the phone path first.** Rejected. The phone has no delivered-audio instrument (ADR 0007), and ADR 0009 forbids a quality claim that is not Delivered audio.
- **Keep the voice-per-locale catalogue unchanged.** Rejected for one voice. `juergen` fails on the synthesis path; German is re-cast and auditioned.
- **A soft-yield cut on the cascade.** Rejected. Finishing the sentence can blow `realCutMs`; `Cancel` plus tail resume is the cascade's primitive. The managed soft-yield stays where it is.
- **Route to managed automatically when a TTS breaker opens.** Rejected for this spec. It would make managed a cross-leg response to a single vendor's health, which is the coupling the ladders reject. Routing stays an explicit switch and a budget decision; a TTS-open leg makes cascade calls fail visibly.
- **Treat the browser E2E as a live vendor run.** Rejected. A PR cannot depend on four vendors; the browser E2E uses a deterministic fake server and a real browser. Live vendor smoke stays nightly and key-gated.
- **Add a second schema for cascade.** Rejected. One reader, one writer, one vocabulary, a `pipeline` discriminator.
- **Use `output.volume` on the cascade.** Rejected. Direct synthesis has no such parameter, and the measurement says no voice needs gain. A server-side stage nobody asked for would hide a defect.

### Open dependencies and thresholds

These are not decided here. Each must be supplied, with a stated source, before the ticket that needs it ships. A number invented in code is a review failure.

1. **Named native reviewers per Locale.** A Locale without one stays open, is never beta, and is never dropped.
2. **Zero data retention on Meta's realtime ASR.** Priced at parity; unconfirmed that it can be selected through the API. Pre-cutover blocker if it cannot.
3. **`juergen`'s TTS id.** Probe for a valid id (slug, UUID, account-cloned slug); if genuinely absent, German is re-cast to a catalogue `de` voice and auditioned by the owner. If no catalogue voice can be bound to `de`, the Locale stays open and cutover is blocked.
4. **A Meta account that exposes Standard `muse-spark-1.3`.** The original note said the Contributor variant was verified; confirm Standard before the spec depends on it.
5. **The daily spend cap.** The 80%/100% behavior is fixed; the cap value is not.
6. **The per-call ceiling.** The drain behavior is fixed; the value is not.
7. **The deploy drain maximum wait.** The no-kill rule is fixed; the operational wait is not.
8. **The turn stall guard.** The ordering rule is fixed; the bound is not.
9. **The tool-call loop cap.** The loop rule is fixed; the cap is not.
10. **Spark's `reasoning_effort` value.** M00 measures; M03 fixes it with the measurement attached. `"none"` is unavailable.
11. **The TTS language-name mapping and the cascade binding for every voice.** The binding table is the authority; a voice without a Locale is not a subject.
12. **Meta keyword limits and the exact `languageBias` accepted names.** Re-verify against `/docs/api-reference/voice/schemas` before implementation.
13. **Prompt caching and retention under ZDR.** A privacy review item, not a latency default.
14. **The container host.** Recorded in the deployment record; not assumed from the Workers deploy.
15. **The phone delivered-audio instrument.** M20's blocker; it does not exist yet.
16. **The counter's day boundary.** UTC is assumed; confirm before M11 ships.
17. **The HMAC token claims and TTL.** A security review item; the token must bind the call and subject and be redacted from logs.
18. **The browser E2E runtime budget.** It runs on PRs; if it outgrows the PR budget, it moves to a required pre-merge job, never nightly-only.
19. **The exact barge-in resume granularity.** The case table is the authority; word-level where TTS `WordBoundaries` is complete, sentence-start otherwise.
20. **The `AT RISK` rule.** This spec reads the outline's three-way verdict as `PASS` ≤ 1500, `AT RISK` 1500–2500 or unmeasured, `FAIL` > 2500. Confirm if a different headroom reading is intended.
21. **The cutover run count.** This spec reads the outline's "two clean rounds each" as two consecutive clean runs per subject, while a kill-criterion round is the two-subject set. Confirm if the stricter reading (four runs per subject) is intended.

### Operational notes

- Live measurement runs stay one at a time under the existing timing lock; artifacts stay gitignored working files read through the compact report.
- The stored agents refresh from a body fingerprint, so an experimental variant must remain a distinct key rather than an edit to the production body.
- The Demo call's product path stays the stored agent; no measurement runs on the inline transport.
- Preview assets are committed; audio captures are not. The delivered WAV, the reference cache and the event stream are gitignored.
- The managed path remains live and reversible after cutover. The breaker, counter and routing switch are the controls; a second failure on a leg ends a call cleanly and does not move the product.
- The `voni` app and the Python service deploy separately. A protocol version mismatch is a deploy error; the `/readyz` and `/healthz` endpoints make it visible before a call.
- The 60-minute STT session and the 3,600-second TTS session are operational facts, not bugs. Planned reconnects are separate from the failure budget.

### Handoff and sequencing

- M0 is the feasibility gate. If it fails, stop and record the evidence; do not build M1.
- M1 is foundation-only and fixture-testable offline. Nothing user-visible ships until M6.
- M2 is the call. The greeting (M7) is not optional: without it the call opens in silence and the reference line describes audio the call never says.
- M3 makes the claim falsifiable. M12 must land before M13; an A/B without per-turn attribution is a number without a stack.
- M4 proves it. W0 (M14) supplies the instrument W1 (M15) reads; a clip difference is not a voice defect until W0 can name the layer. W2 (M16) must be a cascade artifact, not a managed one.
- M19 is the only cutover. All eligible subjects, demo and tenant, or none; a rollback rehearsal and two signatures; `routing` `all`; managed stays as the `off` fallback until ticket 161; the artifact path in the decision record.
- M20 is parked behind M19 and an instrument. It is not a second cutover path.
- The open Reply gap ticket and the three-consecutive-green ticket remain open and are not closed by this work. If the cascade proves the reply gap, their checked items are amended against this spec's evidence, not against a memory of the managed experiments.

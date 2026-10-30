# 119: Small samples, rounds and the kill criterion

**What to build:** A small-sample scope is judged against the tail budget, never its own median. A measured round is two subjects with two consecutive clean runs each; contaminated rounds are re-run; other-gate failures block cutover without killing the work.

**Blocked by:** 117 (Each subject's verdict comes from its own artifact), 03 (Threshold registry with a source requirement), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] A small-sample scope is judged against the tail budget, never its own median.
- [ ] A one-sample scope is not a p50 gate.
- [ ] A measured round is two subjects with two consecutive clean runs each.
- [ ] A contaminated round is re-run and does not count.
- [ ] Three measured rounds failing the reply gap stop the automatic cutover; a dated owner risk acceptance is a new decision record, not a silent pass. A round that passes the reply gap but fails another gate blocks cutover without killing it.

## Answer

# 119 — small samples, rounds and the kill criterion

`judgeReplyGapScope` is the one small-sample verdict: a scope below `MIN_SAMPLES_FOR_P50` (3, the existing reply-gap gate's floor) is judged by its max against the frozen p95 budget, so a one-sample scope is a tail sample and never a p50 gate; budgets come from `SCOREBOARD_BUDGETS`, and a parity test runs the same scopes through `replyGapGate` so the two rules cannot drift.
`judgeMeasuredRound` groups a round's artifacts by subject key (117), takes each subject's latest two adjacent clean runs through `deriveRunEligibility` (116), and only then judges the pooled gap. Contamination → `rerun`, not counted; wrong subject count, missing run/gap or a non-cascade pipeline → `incomplete`, not counted; the chosen pair is the consecutive-clean pair, so a clean/contaminated/clean series is not a measurement.
`evaluateKillCriterion`: three measured rounds failing the reply gap → `KILLED`, `automaticCutover: false`, routing stays off. A measured round that passes the gap but fails another required gate → `BLOCKED` (cutover blocked, kill not fired, work continues). A dated `OwnerRiskAcceptance` is validated field by field (kind, owner, `YYYY-MM-DD`, decision record, non-empty evidence) and reported as `RISK-ACCEPTED` — never `PASS`, automatic cutover still stopped, the record carried out.
Red proof (mutations each failed the named test, then restored): module absent first; `smallSample = false` → one-sample test red; `contaminated = false` → contaminated-round test red; kill threshold `>` → three-failure test red; other-gate branch disabled → BLOCKED test red; `RISK-ACCEPTED` changed to `PASS` → acceptance test red.
Evidence: `voni/src/lib/demo/kill-criterion.ts`, `kill-criterion.test.ts` (13 tests). `npm test` → 2320 tests, 2319 pass, 1 skipped, 0 fail; `npm run typecheck` OK; eslint clean on both files. Branch `cluster/gates-119`, base `bd9180dc`, commit `414365cc`; `git merge feat/meta-cascade` → already up to date.
Merger note: this is the pure seam, not yet wired into `score-matrix.mts`/a CLI; the reply-gap budgets stay `budget_key`-backed with no literal copied into the module. `counted` is the single "does this round count" flag; incomplete rounds carry named reasons and never block on their own.

_Implemented on `feat/meta-cascade`._

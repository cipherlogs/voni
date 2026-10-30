# 116: Only a clean run can be green

**What to build:** A run is eligible only when it is clean: no fallback on any leg at any phase, no budget stop, no missing capture for the gate it feeds, no harness failure, and a code fingerprint that matches the run under judgement.

**Blocked by:** 107 (One event envelope and reader refusal), 109 (Every fallback is emitted, including at connect), 114 (Three cascade gaps and an honest N/A)

**Status:** resolved

- [ ] A fallback on any leg at any phase makes a run ineligible.
- [ ] A budget stop, a missing capture for the gate it feeds, a harness failure or a fingerprint mismatch makes it ineligible.
- [ ] Only a clean run can be green.
- [ ] A contaminated run is marked for re-run and does not count toward the kill criterion.
- [ ] Removing the eligibility check makes a contaminated artifact green and the test fails.

## Answer

# 116 — only a clean run can be green

`deriveRunEligibility()` refuses a run on facts, not numbers: any `provider_fallback` on any leg at any phase (connect included), any `budget.stopped` (an 80% crossing is not one), a capture-fed gate (`timbre-probes` → reference+delivered) PASSing with its capture missing, a harness break (`evalRunner.status === "failed"` or a supplied break), and a missing/dirty/mismatched code fingerprint. A recorded `eligible: true` never overrides a fact; the artifact's own refusal keeps its named reason.
`judgeSubjectRun()` makes green unreachable for an ineligible run even when every required gate PASSes; a contaminated run is `ineligible`, `disposition: "rerun"`, `countsTowardKillCriterion: false`. `buildInspectReport()` derives it for every artifact and prints `verdict INELIGIBLE — marked for re-run` plus each refusal.
Red proof: replacing the derivation with the artifact's flag made the contaminated-but-all-PASS test green and the test failed; restored, it passes.

Evidence: `voni/src/lib/demo/artifact-reader.ts` (`deriveRunEligibility`, `GATE_CAPTURE_LEGS`, `FALLBACK_EVENT_TYPE`), `scoreboard.ts` (`judgeSubjectRun`, `RunVerdict`), `scoreboard-report.ts` (`InspectVerdict`, verdict line), `run-eligibility.test.ts` (connect fallback, budget stop, missing capture, harness break, fingerprint mismatch, anti-lie). Commands: `node --import tsx --test src/lib/demo/run-eligibility.test.ts` 7/7; `npm run typecheck` OK; full `npm test` 2148 tests, 2147 pass, 1 skipped, 0 fail.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

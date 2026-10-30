# 143: Anti-lie: a contaminated run cannot be green

**What to build:** A run with a fallback at any phase cannot pass, and the gate is proved by deleting the check. This is the test that stops a green number describing a stack that was not judged.

**Blocked by:** 116 (Only a clean run can be green), 142 (Provider fixtures run in CI)

**Status:** resolved

- [ ] A run with any fallback cannot be green; the artifact says why.
- [ ] The test is red when eligibility ignores the fallback event.
- [ ] A connect-time fallback is covered, not only a mid-turn one.
- [ ] The red case is attached to the ticket as a run.

## Answer

# 143 — Anti-lie: a contaminated run cannot be green

**Status: done.** Branch `cluster/antilie-143-146` @ `421b52e8`, based on
integration tip `43f0d427` (`git merge feat/meta-cascade` → "Already up to date").

- **Built:** `voni/src/lib/demo/anti-lie-contaminated-run.test.ts` (9 tests).
  Every fixture is a green candidate (all 12 required gates PASS, `eligible:
  true`); each contamination — a fallback at connect, a fallback mid-turn, a
  `budget.stopped`, a missing delivered capture behind a PASSing timbre gate, a
  harness break — must produce `kind: "ineligible"`, `green: false`,
  `disposition: "rerun"`, `countsTowardKillCriterion: false`, and a reason that
  names the fact (leg + phase/turn, budget stop, capture, harness). The print
  path says `verdict INELIGIBLE — marked for re-run`.
- **Artifact lie refused:** `parseScoreboardArtifact` now refuses an artifact
  whose own `eligibility.eligible` is `true` while its events record
  `provider_fallback` or `budget.stopped` (`eligibility.eligible`, message names
  the event and why it is not eligible for green). Honest `eligible: false`
  artifacts still parse and are still refused green by the gate.
- **TDD red first (two independent deletions):** delete the fallback branch in
  `deriveRunEligibility` → **6 pass / 3 fail** (connect + mid-turn went green);
  delete the new `assertEligibilityAgreesWithEvents` call → **8 pass / 1 fail**
  (the lying artifact parsed). Logs:
  `/tmp/opencode/meta-cascade/143-red-eligibility-ignores-fallback.log`,
  `143-red-artifact-lie-unchecked.log`. Restored; no Actions run URL (branch not
  pushed), same evidence convention as 142/08.
- **CI:** named `Anti-lie contaminated run` step in the `verify` job
  (`node --import tsx --test src/lib/demo/anti-lie-contaminated-run.test.ts`).
- **Green:** new module **9/9**; full `npm test` **2204 tests, 2203 pass, 1
  skipped, 0 fail**; `npm run typecheck` clean; eslint clean on the changed files.
- **Merger notes:** `artifact-reader.test.ts`'s "a cascade artifact may carry its
  own fallback event" fixture now marks the run ineligible (the event is still
  accepted; only the flag/stream contradiction is refused) — no assertion was
  removed. The reader refusal is deliberately narrow (direct flag/stream
  contradiction); capture/harness/fingerprint refusals stay in the one gate.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

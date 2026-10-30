# 117: Each subject's verdict comes from its own artifact

**What to build:** A subject row derives its verdict from its own artifact only. A copied verdict fails, and a subject with no artifact is blocked with a named reason, never a pass.

**Blocked by:** 116 (Only a clean run can be green), 112 (One artifact shape for both engines)

**Status:** resolved

- [ ] A subject's verdict derives from its own artifact only.
- [ ] A carried-over verdict fails.
- [ ] A subject with no artifact is blocked with a named reason, never a pass.
- [ ] An artifact from an older code fingerprint is historical only and blocked for the current matrix.
- [ ] A copied verdict is constructed and observed to fail.

## Answer

# 117 — each subject's verdict comes from its own artifact

`subjectGateVerdict()` now judges exactly one artifact: its own gates plus the artifact reader's clean-run eligibility, with the subject axis including `pipeline` (`subjectRowKey` is `agent@locale/transport/pipeline`). A row whose run is ineligible (fallback, budget stop, missing capture, harness break) is `BLOCKED` with every reason, never `PASS`; a missing artifact stays `MISSING` with a named reason; an entry or artifact carrying a `verdict` field is refused by name as a carried verdict.
The matrix compares each artifact's code fingerprint with the current tree: `buildRegressionMatrix({expectedCode})` (the CLI passes `readCodeFingerprint()`) blocks a different HEAD/dirty hash as historical evidence, while a dirty tree that matches itself is current. `deriveRunEligibility` gained a `fingerprintPolicy: "clean" | "current"` seam so the same eligibility facts serve both the single-run and matrix questions without duplicating rules.
Red proof: `subject-verdict.test.ts` constructs a managed/cascade pair (two rows, two run ids), an ineligible all-PASS run, a stale/missing/current/dirty fingerprint set, a no-artifact row, and both carried-verdict shapes; before the implementation the module did not exist (red), after it all 8 tests pass. Existing matrix/member tests were updated only to give their fixtures the fingerprint the new verdict requires and one finished-run summary.
Evidence: `voni/src/lib/demo/subject-verdict.ts` (`subjectGateVerdict`, `subjectRowKey`, `buildRegressionMatrix`, `applyFeaturedFirst`), `artifact-reader.ts` (`RunFingerprintPolicy`, historical reason), `artifact-absence.ts` (cycle-safe named N/A strings), `scoreboard.ts` (re-exports the old matrix surface; `subjectOfArtifact` carries the pipeline axis), `scripts/score-matrix.mts` (passes `expectedCode`), `subject-verdict.test.ts`.
Tests: `npm test` → 2203 tests, 2202 pass, 1 skipped, 0 fail; `npm run typecheck` OK; `npm run lint` 0 errors. Branch `cluster/verdict-117`, base 43f0d427. Merger note: the matrix verdict implementation moved to `subject-verdict.ts` and is re-exported from `scoreboard.ts`; `deriveRunEligibility` stays in `artifact-reader.ts` with a new optional policy, so ticket 116 callers are unchanged.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

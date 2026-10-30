# 118: The featured subject is judged first

**What to build:** The English featured subject is measured and judged first. Every other subject stays blocked until it passes, so no Locale is judged on an unproved instrument.

**Blocked by:** 117 (Each subject's verdict comes from its own artifact)

**Status:** resolved

- [ ] The featured English subject is measured and judged first.
- [ ] Every other subject stays blocked until the featured subject's current run passes.
- [ ] A missing or non-passing featured run blocks the rest.
- [ ] Strict mode fails while any row is blocked.
- [ ] The ordering rule and blocked rows are recorded in the artifact and printed in the table.

## Answer

# 118 — featured subject first

The featured subject is not a flag: `assertFeaturedSubject` pins it to the registry default (`anna`/en/browser), and `buildRegressionMatrix` refuses any other `featuredSubject` by name, so no invocation can re-point the rule at `lola` (`FeaturedSubjectError`). One exported `orderFeaturedFirst` is now the single implementation of the rule: the CLI's spawn list and the matrix's row order both call it, and the local copy in `score-matrix.mts` is gone.
`applyFeaturedFirst` judges the featured row first and BLOCKs every other row until that row's own current run PASSes — only PASS opens the gate, so a MISSING/FAIL/BLOCKED/INFO featured run keeps the rest unjudged, with the featured reason in each row detail and the key in `ordering.blocked` (now including rows already blocked for their own reason), recorded in `artifact.ordering` + `ordering:featured-first` and printed by `formatMatrixTable`; `--strict` still fails on the `matrix` gate.
Red proof: lola-as-featured was accepted (missing exception), `orderFeaturedFirst` did not exist, `ordering.blocked` was `[]` for an already-blocked row (all observed failing first); then a mutation that returns items unordered makes "a reordering that judged lola first fails" red, restored green.
Evidence: `voni/src/lib/demo/subject-verdict.ts` (`assertFeaturedSubject`, `orderFeaturedFirst`, `applyFeaturedFirst`), `subject-verdict.test.ts` (+5 tests), `scripts/score-matrix.mts` (uses the shared ordering), `scripts/score-matrix.test.ts` (+1 anti-duplication test), `docs/agents/demo-scoreboard.md` (W5/118 wording).
Tests: `npm test` → 2260 tests, 2259 pass, 1 skipped, 0 fail; `npm run typecheck` OK; `npm run lint` 0 errors (2 pre-existing warnings in `scripts/reviewer-pack.mts`). Branch `cluster/featured-118`, base `d5bd173c`.
Merger note: the row-level rule is unchanged from 117; the new `featuredSubject` guard means no caller may pass a non-default featured subject (only the CLI did, and it passes anna). Because subject identity includes `pipeline`, a cascade-only matrix has no featured row and stays fully blocked until a managed/featured `anna` row is present — intended by 117's subject axis, worth remembering when the cascade matrix writer lands.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

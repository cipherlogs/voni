# 145: Anti-lie: below budget is not a pass

**What to build:** A run whose reply gap exceeds the frozen budget cannot pass, even if the tail is inside its own budget. The test is red when the budgets are read from a second source or the comparison is inverted.

**Blocked by:** 114 (Three cascade gaps and an honest N/A), 142 (Provider fixtures run in CI)

**Status:** resolved

- [ ] A run below budget cannot pass the reply-gap gate.
- [ ] A sample set above the median budget but under the tail budget still fails the median gate.
- [ ] The test is red when the comparison is inverted or a budget is read from a second source.
- [ ] The red case is attached.

## Answer

# 145 — Anti-lie: below budget is not a pass

**Status: done.** Branch `cluster/antilie-145-148` @ `4ae61837`, based on
integration tip `06f9f097` (`git merge feat/meta-cascade` → "Already up to date").

- **Built:** `voni/src/lib/demo/anti-lie-reply-gap.test.ts` (7 tests). It drives
  the real `replyGapGate` with sample sets whose boundary comes from the
  committed `scoreboard-budgets.json` (read independently in the test) and the
  one `SCOREBOARD_BUDGETS` table: a set at the baseline passes, +1 ms fails, and
  a set over the median but under the tail fails naming `p50 … > 1500ms`. It
  also drives cascade artifacts through the shared reader: a numeric reply gap
  with no `first_playout` (substituting `final`), or with no `speech_complete`,
  is refused by field; a genuinely measured gap survives and the gate still
  fails it over budget; a missing mark is a named N/A and `replyGapGate([])` is
  never PASS. Named CI step `Anti-lie reply gap` added (lands in the 148 commit
  because the workflow edit was made after 145 was committed).
- **TDD red first (three independent deletions):** invert the p50 comparison
  (`>` → `<`) → **7 tests, 4 pass / 3 fail**; replace the record-backed
  `REPLY_GAP_P50_BUDGET_MS` with a literal `1600` ("second source") → **3 pass /
  4 fail**; delete `assertCascadeLatencyFromLedger` from `parseScoreboardArtifact`
  → **5 pass / 2 fail**. Logs:
  `/tmp/opencode/meta-cascade/145-red-inverted.log`,
  `145-red-second-source.log`, `145-red-ledger-deleted.log`.
- **Green:** `node --import tsx --test src/lib/demo/anti-lie-reply-gap.test.ts`
  → **7/7**. Full `npm test` → **2145 tests, 2144 pass, 0 fail, 1 skipped**;
  `npm run typecheck` and `npx eslint` on the new file are clean.
- **Merger notes:** no production code changed — the proof is a committed test
  over the existing gate and reader. The fixture derives its expected boundary
  from the committed record, so a retune that moves one source only fails here.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

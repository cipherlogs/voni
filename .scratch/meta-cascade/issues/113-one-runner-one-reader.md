# 113: One runner writes both artifacts, one reader reads them

**What to build:** The managed and cascade artifacts are written by the same runner and read by the same reader. A second schema, a second writer or a second reader is a review failure, because the A/B must compare like with like.

**Blocked by:** 112 (One artifact shape for both engines), 108 (Every turn names the providers that served it)

**Status:** resolved

- [ ] The same runner writes the managed and cascade artifacts.
- [ ] The inspect command reads both without a second code path.
- [ ] A second writer or a second reader fails review.
- [ ] A cascade artifact and a managed artifact of the same run shape print comparable compact rows.
- [ ] One of each is written and read through the same entry point.

## Answer

# 113 — one runner writes both engines' artifacts, one reader reads them

One artifact builder + one serializer now serve both engines: `buildArtifactShape()` fills only structural absences and `writeScoreboardArtifactFile()` is the sole write. `score-demo --pipeline cascade --ledger <end-message.json> --reference/--delivered` writes a cascade artifact from the call's own ledger through the same path; `--platform` opts a managed run into the identical ten-section shape. `scoreboard:inspect`, `score-matrix`, `score-streak` and `score-demo` all parse through `readScoreboardArtifactFile`; the inspect report prints one fixed five-row gap table for both engines. A cascade artifact claiming a platform capture or missing a section is refused by name.

Evidence:
- `voni/src/lib/demo/scoreboard.ts` — `ArtifactEngineInput`, `buildArtifactShape`, `writeScoreboardArtifactFile`, `ARTIFACT_LATENCY_LABELS`, absence constants.
- `voni/scripts/score-demo.mts` — `--pipeline cascade` branch, `--platform` managed opt-in, both call the one writer.
- `voni/scripts/scoreboard-inspect.mts`, `score-matrix.mts`, `score-streak.mts` — shared reader only.
- `voni/src/lib/demo/scoreboard-report.ts` — `InspectGaps`, `run.pipeline`, `formatGaps`.
- Tests: `artifact-reader.test.ts` (“one writer and one reader…”, “scoreboard scripts read artifacts only through the one reader”), `score-demo.test.ts` (cascade + managed shared-shape runs), `scoreboard-inspect.test.ts` (cascade rows, unknown schema refusal).
- Commands: `npm run typecheck` OK; `node --import tsx --test` on the four touched test files OK; full `npm test` 2138 tests, 2137 pass, 1 skipped, 0 fail.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

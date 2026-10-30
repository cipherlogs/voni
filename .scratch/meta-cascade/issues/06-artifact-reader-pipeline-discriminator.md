# 06: Artifact reader learns the pipeline discriminator

**What to build:** The shared artifact reader accepts today's managed artifacts and learns a pipeline discriminator, refusing a cascade artifact that claims a platform capture, a managed artifact that claims a cascade-only event, and an unknown schema version. This is the expand phase, so it lands before any cascade run exists.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Today's managed artifacts still parse and produce the same gate rows.
- [ ] A cascade artifact with a platform capture leg is refused by name.
- [ ] A managed artifact carrying a provider fallback event is refused by name.
- [ ] An unknown schema version is refused, never guessed or coerced.
- [ ] Only the reader accepts the new field in this ticket; the writer is unchanged, so no live run is required to prove it.

## Answer

06: `voni/src/lib/demo/artifact-reader.ts` is the shared reader — `parseScoreboardArtifact`/`readScoreboardArtifactFile`, `pipelineOfArtifact` (absent → `managed`), gate rows through the one `parseGateRows`.
Refusals by name: unknown `schemaVersion` (99, `"4"`, missing — never coerced), unknown pipeline, unknown capture leg, cascade + platform capture, managed + `provider_fallback`/`breaker.transition`/`budget.*` event.
`scoreboard.ts` additive only: `ArtifactPipeline`/`ArtifactCaptureLeg`/`ArtifactCapture`/`ArtifactCaptures`/`ArtifactEventRecord` + optional `pipeline`/`captures`/`events`; `buildSkeletonArtifact` untouched, `scoreboard-budgets.json` untouched.
Evidence: `node --import tsx --test src/lib/demo/artifact-reader.test.ts` → 10 pass (mutation-checked: removing each refusal fails its test); `npm test` → 2067 pass, 1 skipped, 0 fail; `npm run typecheck` clean; lint 0 errors.
The four `scripts/` local readers and `buildInspectReport` are unchanged — wiring them through this module is the remaining "one reader" step.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

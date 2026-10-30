# 112: One artifact shape for both engines

**What to build:** One artifact carries subject, run, pipeline, providers, gates, latency, cost, captures, eligibility and beats. A cascade artifact carries reference and delivered and marks the platform leg absent; a managed artifact carries three legs.

**Blocked by:** 06 (Artifact reader learns the pipeline discriminator), 107 (One event envelope and reader refusal)

**Status:** resolved

- [ ] The artifact carries subject, run, pipeline, providers, gates, latency, cost, captures, eligibility and beats.
- [ ] A cascade artifact carries reference and delivered, and marks the platform leg as absent with a named reason.
- [ ] A cascade artifact claiming a platform capture is invalid; a managed artifact claiming a cascade-only event is invalid.
- [ ] An unmeasured cost makes the total unmeasured.
- [ ] The reader refuses an invalid combination by name.

## Answer

# 112 — One artifact shape for both engines

- The reader now validates the ten sections the spec names: `subject, run, pipeline, providers, gates, latency, cost, captures, eligibility, beats` (`ARTIFACT_SECTIONS`). An artifact that declares `pipeline` must carry all ten; a legacy artifact with no discriminator stays readable expand-only.
- A cascade artifact carries `reference` + `delivered` and marks the platform leg with the named reason `N/A — no platform capture on the cascade`; a cascade claim of a platform capture, and a managed artifact claiming a cascade-only event, are refused by name.
- Managed captures are all three legs; managed providers/cost are the named N/A (`vendor-owned`, `vendor-billed`), never zero.
- `artifactCostTotal` returns `unmeasured` when any leg is, and the reader refuses a partial sum presented as a total (`cost.total`), naming the unmeasured leg. Every cost cites `rateTableVersion`.
- A latency gap an engine cannot produce (cascade commit-to-playout, managed partials/think) must be a named N/A, never silently absent or copied; eligibility is a boolean with at least one reason when false; `run.runId` must name the artifact's run.

Evidence: `voni/src/lib/demo/artifact-reader.ts` (+ test), additive types/constants in `voni/src/lib/demo/scoreboard.ts`. Tests: 25 in `artifact-reader.test.ts`; full suite 2109 tests, 0 fail. No writer changed (113 owns emitting the sections).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

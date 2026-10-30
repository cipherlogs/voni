# 115: Managed records N/A, never zero

**What to build:** The managed path cannot produce screen latency or think, and says so with named N/A values. A zero is invalid because it would look like a win.

**Blocked by:** 114 (Three cascade gaps and an honest N/A)

**Status:** resolved

- [ ] Screen latency is recorded as no-partials with a named reason.
- [ ] Think is recorded as no-token-stream with a named reason.
- [ ] A zero in either row is invalid and fails the reader.
- [ ] Neither row can be a win or silently absent.
- [ ] The compact report prints both rows.

## Answer

# 115 — managed N/A rows, never zero and never a fake value

Every gap a pipeline cannot produce is now a required row with the spec's named reason: managed carries `N/A — no partials` (screen), `N/A — no token stream` (think) and the managed commit N/A; cascade carries the cascade commit N/A. `PIPELINE_UNAVAILABLE_GAPS` is the per-pipeline derivation.
The reader refuses a missing row ("silently absent"), a number including 0 (a zero cannot read as a win), and an N/A borrowed from the other engine (a cascade claiming "no partials", a managed row claiming "the cascade has no commit mark") — each by field.
The compact report already prints one fixed five-row table for both engines; the round-trip test pins both managed N/A rows beside the cascade's measured rows.

Evidence: `voni/src/lib/demo/artifact-reader.ts` (`PIPELINE_UNAVAILABLE_GAPS`, `foreignAbsenceReason`, `parseLatency`), `artifact-reader.test.ts` (zero row, omitted commit row, cross-engine fake N/A, report round-trip). Command: `node --import tsx --test src/lib/demo/artifact-reader.test.ts` 38/38; `npm run typecheck` OK; full `npm test` 2148 tests, 2147 pass, 1 skipped after both tickets.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

# 107: One event envelope and reader refusal

**What to build:** Every call-scoped event carries the same envelope: schema version, pipeline, call id, subject, turn, time and phase. An operational event carries the leg instead. The reader refuses an unknown version instead of guessing.

**Blocked by:** 06 (Artifact reader learns the pipeline discriminator), 07 (One sanitizer for both event streams)

**Status:** resolved

- [ ] Every call-scoped event carries schema version, pipeline, call id, subject, turn, time and phase.
- [ ] An operational event carries the leg in place of subject and turn.
- [ ] The reader refuses an unknown schema version by name.
- [ ] A missing required field is refused, not defaulted.
- [ ] Both engines use the same envelope, distinguished only by the pipeline value.

## Answer

107: One envelope for both engines — `voni/src/lib/demo/event-envelope.ts` (`buildEventEnvelope`/`parseEventEnvelope`/`readEventEnvelopeFile`) and `voice-pipeline/cascade/events.py` (`EventWriter`), pinned by the shared `event-envelope.fixtures.json`.
Call-scoped = `schemaVersion, pipeline, callId, type, subject, turn, atMs, phase`; operational (`breaker.transition`) = `leg` in place of `subject`/`turn`; managed and cascade differ only by `pipeline`.
Reader refuses by name: unknown/missing `schemaVersion`, unknown `pipeline`/`phase`, every missing required field, operational+subject/turn, call-scoped+leg, managed+cascade-only event, cascade+managed-only field (`platformCapture`/`vendorOwned`), and any line still carrying a forbidden key.
The one sanitizer runs on every built line (forbidden keys dropped and reported, key-shaped reasons/URLs redacted); no `text`/`transcript`/`audio`/`pcm`/`token` reaches the stream. Python builds envelopes only — it adds no second denylist (sanitization stays in the TS writer per ticket 07).
Evidence: Python suite `797 tests OK`; `node --import tsx --test src/lib/demo/event-envelope.test.ts` → 13 pass; full `npm test` → 2087 pass, 1 skipped, 0 fail; `npm run typecheck` clean; eslint clean.
Merger notes: `artifact-reader.ts` now imports/re-exports `CASCADE_ONLY_EVENT_TYPES`/`isCascadeOnlyEvent` from `event-envelope.ts` (one vocabulary; 06 tests unchanged). No changes to `scoreboard-budgets.json`, `scoreboard.ts`, or `eval-events.ts`. Branch `cluster/events-107`, base `03ad6476` (merge: already up to date).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

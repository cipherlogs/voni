# 133: The cascade re-audition pack

**What to build:** One non-English cascade call becomes a pack: a clean artifact, a reference, a delivered capture and a transcript, with two independent ballots on one shared recording. A missing capture or ballot is unresolved.

**Blocked by:** 112 (One artifact shape for both engines), 114 (Three cascade gaps and an honest N/A), 120 (W0 reference render from direct synthesis), 121 (W0 delivered capture is sample-exact and non-intrusive)

**Status:** resolved

- [ ] The pack carries the subject's own clean cascade artifact, reference, delivered capture and transcript; there is no platform leg.
- [ ] A fallback or budget stop makes it ineligible.
- [ ] Two independent ballots are recorded on one shared recording, with written reasons.
- [ ] A missing capture or missing ballot leaves the pack incomplete and the verdict unresolved.
- [ ] The managed-path verdict does not carry over; a new artifact and verdict are required.

## Answer

# 133 — The cascade W2 re-audition pack

Added `voni/src/lib/demo/cascade-reaudition.ts`: `assembleCascadeReauditionPack` builds one pack from the subject's own parsed cascade artifact (the one shared reader), the reference and delivered WAVs, the transcript, the W0 two-capture comparison, the verdict-rule inputs and two ballots. The pack carries no platform leg — it records the named `N/A — no platform capture on the cascade` — and never writes or fabricates audio.

A missing/truncated capture, a missing artifact, a hash-misdescribed capture, a managed artifact, another subject's artifact, a fallback or `budget.stopped`, a transcript line that differs from the reference, or fewer than two distinct ballots on the delivered sha all leave the pack `incomplete` with named blockers and the verdict `unresolved`. The pack never decides accept/withdraw; `readyForOwner` hands those inputs to ticket 134. `cascadeReauditionRoster` lists all six demo voices, with German (`juergen`/de) `open` with the vendor's `voice_not_found` reason, and a missing subject blocks readiness.

Evidence: `cascade-reaudition.test.ts` (8 tests: complete pack/no platform, missing capture, missing/duplicate/mismatched ballots, fallback/budget stop, managed/other-subject carry-over refusal, missing artifact/hash mismatch, different line, six-subject roster with German open). Full `npm test` → 2153 tests, 2152 pass, 1 skipped, 0 fail. `npm run typecheck` clean; `npm run lint` 0 errors (2 pre-existing warnings in `scripts/reviewer-pack.mts`).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

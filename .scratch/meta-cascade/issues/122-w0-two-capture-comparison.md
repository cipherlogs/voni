# 122: One comparison table over reference and delivered

**What to build:** One table compares the reference and the delivered audio: level and RMS, true peak, distortion residual, crest factor, octave-band balance, envelope modulation, breakups, format facts and onset. The table is pure over decoded audio.

**Blocked by:** 120 (W0 reference render from direct synthesis), 121 (W0 delivered capture is sample-exact and non-intrusive)

**Status:** resolved

- [ ] The table reports integrated level and RMS, true peak, distortion residual, crest factor, octave-band balance and band delta, modulation rate and depth, breakup count with total and longest silence, format facts and onset.
- [ ] The table is pure over decoded audio and has no live dependency.
- [ ] A whole-call capture without a line marker is refused as incomplete; the greeting line or a marked segment is required.
- [ ] The existing metric library is reused, not reimplemented.
- [ ] Two synthetic files pin every field.

## Answer

# 122 — One comparison table over reference and delivered

Added `compareReferenceAndDelivered` + `formatTwoCaptureTable` in `voni/src/lib/audio/comparison.ts`: one table over exactly `{reference, delivered}`, no platform column, reusing `level-facts`, `distortion-crest`, `spectral-balance`, `envelope-modulation` and `breakups` unchanged. Every row carries a `producer` (e.g. `level-facts.analyseLevel`) and the table prints a producer legend.

A line marker is mandatory; a whole-call capture without the greeting line or a marked segment is `unresolved`. Missing/truncated/unreadable captures, format mismatches and onset deltas beyond the frozen `comparisonOnsetToleranceS` (50 ms) are `unresolved`, never a pass. The comparison is pure over decoded WAVs and measures native level (`gainStage: "none"`), slicing only the marked sample window so extra call audio is not counted as distortion/breakups.

Evidence: `comparison-two-capture.test.ts` (7 tests: every row/producer, native level, modulation, breakups, missing/truncated, greeting/segment markers, onset, format mismatch). `node --import tsx --test src/lib/audio/comparison-two-capture.test.ts src/lib/audio/comparison.test.ts` → 19 pass. Full `npm test` → 2153 tests, 2152 pass, 1 skipped, 0 fail. `npm run typecheck` clean.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

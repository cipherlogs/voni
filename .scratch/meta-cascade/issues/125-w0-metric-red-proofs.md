# 125: Every audio metric is proved able to fail

**What to build:** A metric that cannot be made to fail does not ship. Each one is proved against a synthetic worst case: a level step, a third-harmonic residual, a crest collapse, an octave tilt, an inserted silence, a chunk-rate modulation and a peak at the ceiling.

**Blocked by:** 122 (One comparison table over reference and delivered)

**Status:** resolved

- [ ] Every metric fails on its synthetic worst case: level step, third-harmonic residual, crest collapse, octave tilt, inserted silence, chunk-rate modulation and a true peak at the ceiling.
- [ ] A metric that cannot be made to fail does not ship.
- [ ] Each red proof is a committed test, not a manual observation.
- [ ] Deleting a metric makes its proof fail.

## Answer

# 125 — Every audio metric is proved able to fail

Added `voni/src/lib/audio/metric-red-proofs.test.ts`, one committed red proof per metric in the `W0_AUDIO_METRICS` registry: a 6.02 dB level step, a delivered peak at the full-scale ceiling, an 8.8 dB octave tilt, a 1% third-harmonic residual, a crest collapse (square at equal RMS), a 20 Hz/50% chunk-rate modulation, an inserted 0.5 s silence, a device-rate alias (11 kHz folded to 5 kHz) and a 60 ms boundary fade. Each proof drives `compareReferenceAndDelivered` with a synthetic WAV pair built by the test, then asserts the metric's own check is `FAIL`, names its producer and its failure — a check that disappeared is a lookup failure, not a skipped proof.

The same file pins the registry (`level, peak, spectrum, distortion, crest, modulation, breakups, alias, fade`) so a metric cannot be removed to skip its proof, asserts the proof map and registry move together, and includes a clean-copy control that must be `PASS` on every metric. Deleting a metric was probed by disabling the crest comparison (`const failed = false`): the crest proof failed, then the probe was reverted.

Evidence: `metric-red-proofs.test.ts` (12 tests: registry/coverage, 9 per-metric reds, clean control, crest-is-its-own-check). `node --import tsx --test src/lib/audio/*.test.ts` → 149 pass. Full `npm test` at the cluster tip → 2232 tests, 2231 pass, 1 skipped, 0 fail. `npm run typecheck` clean; eslint clean.

Base: `43f0d427`; branch `cluster/audio-123-125`; commit `93b294ee`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

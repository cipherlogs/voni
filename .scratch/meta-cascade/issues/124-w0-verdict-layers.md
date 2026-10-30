# 124: Verdict layers in causal order

**What to build:** The verdict names the first layer that diverged: the vendor's voice, the model's text, our pipeline, or the client. A later difference cannot steal the blame.

**Blocked by:** 122 (One comparison table over reference and delivered)

**Status:** resolved

- [ ] Layers are evaluated in causal order: vendor voice, model text, our pipeline, client.
- [ ] The first divergence is named, and a later difference cannot steal the blame.
- [ ] A model-text mismatch means the audio layers were never comparable.
- [ ] A level, spectrum, distortion, voice or language difference names our pipeline.
- [ ] Chunk-rate modulation, an inserted silence, a device-rate alias or a boundary fade names the client.

## Answer

# 124 — Verdict layers in causal order

Added `voni/src/lib/audio/w0-verdict.ts`: `decideW0Verdict` evaluates `vendor voice → model text → our pipeline → client`, names the first failing layer and its axis, marks every later layer `NOT-COMPARABLE`, and blocks a pass on any `UNMEASURED` input. A model-text mismatch names model text and leaves the audio layers never comparable. The pipeline axes are level, true peak, octave tilt, distortion, crest, voice and language; the client axes are chunk-rate modulation, inserted silence, device-rate alias and boundary fade. `evaluateW0Checks` returns every check in causal order without short-circuiting, so the proofs and the verdict read the same measurements.

`comparison.ts` now measures the four client signatures on the aligned pair and builds a pipeline audit that masks inserted-silence and fade windows out of both captures, so a playback hole or fade cannot be re-read as a server residual or level step. A detected modulation or alias owns the distortion/spectrum axis it imitates (marked `SKIPPED`, never a pipeline failure); a periodic envelope swing is modulation, a single bounded dip is a fade, and an inserted silence owns the swing. A level step plus a hole in the same capture still names our pipeline.

Evidence: `w0-verdict.test.ts` (16 tests: layer order/clean pass, level step + hole cannot steal, model text, missing transcript, tilt, harmonic, voice, language, modulation, hole, alias, fade, reference ceiling/hole, missing reference, every metric evaluated). `node --import tsx --test src/lib/audio/*.test.ts` → 137 pass at this commit; `cascade-reaudition.test.ts` 8 pass. Full `npm test` at the cluster tip → 2232 tests, 2231 pass, 1 skipped, 0 fail. `npm run typecheck` clean; eslint clean.

Base: `43f0d427`; branch `cluster/audio-123-125`; commit `4d050b75`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

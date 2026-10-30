# 127: Native level, and no gain stage anywhere

**What to build:** The cascade carries no volume field, no client gain and no limiter. Each voice's native level is its target, so a delivered level difference is a named defect rather than a tuning knob.

**Blocked by:** 122 (One comparison table over reference and delivered), 126 (Capture paths, hashes and the committed vendor floor)

**Status:** resolved

- [ ] The cascade carries no volume field, no client gain and no limiter.
- [ ] Each voice's native level is its target; a delivered level difference names a pipeline or client defect.
- [ ] Any per-voice gain, limiter or normalisation on the cascade path fails a test.
- [ ] A level change is a new native render or a new voice decision, never a client stage.
- [ ] The managed path keeps its volume field until it retires.

## Answer

# 127 — Native level, and no gain stage anywhere

**Status: done.** Branch `cluster/w1-127-132` @ `8a002b15`, base `a8112b65`
(`git merge feat/meta-cascade` → "Already up to date").

- New `voice-pipeline/cascade/native_level.py` is the one native-level contract:
  `NATIVE_GAIN_STAGE = "none"` is the only declared stage, `MANAGED_LEVEL_FIELD =
  "output.volume"` is named managed-only, and `assert_native_stage` /
  `assert_no_level_stage` refuse any other stage or level knob **by name**.
  `clips.py` now uses the constant everywhere it used to restate `"none"`.
- `voni/src/lib/audio/native-level.ts` mirrors it for the W0 instrument:
  `assertNativeLevel` refuses a comparison whose `gainStage` is not native,
  `assertNoLevelStage` is wired into `compareReferenceAndDelivered` (a `gain` /
  `volume` / `limiter` key on the cascade request fails before a sample is read),
  and `levelDefect` attributes a delta over the frozen `comparisonLevelLu` (1.5
  LU, read from the budget table) to `our pipeline` when it survives the
  client-signature mask, or to the `client` when the mask removes it. Within the
  bar is no defect; an unmeasured level is `null`, never zero.
- Native level is measured from the rendered bytes, not claimed: the test proves
  a 6.02 dB scale step reads as 6.02 LU, a gained clip fails the clip gate, and
  the synthesis request URL carries no level key. The stored body's
  `output.volume` is ignored and recorded, never turned into a cascade setting.

**Tests:** `cascade/test_native_level.py` 14 tests (red-first: module import and
the comparison-wiring deletion both fail it). `native-level.test.ts` 9 tests
(red-first; deleting `assertNoLevelStage` from `comparison.ts` fails the
"gain stage introduced" test). Full Python suite **1653, OK, 1 skipped**; full
`npm test` **2300 / 2299 pass / 1 skipped / 0 fail**; `npm run typecheck` clean;
eslint clean on changed files.

**Evidence:** `voice-pipeline/cascade/native_level.py`, `cascade/clips.py`,
`cascade/test_native_level.py`, `voni/src/lib/audio/native-level.ts` + test,
`voni/src/lib/audio/comparison.ts` (uses the constant + request guard).

**Merger notes:** additive. The only shared-file edit is `comparison.ts` (import +
one request guard + `gainStage: NATIVE_GAIN_STAGE`), which belongs to 122 — it is
behaviour-preserving for every existing request. No Python thresholds or budgets
touched; `scoreboard-budgets.json` untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

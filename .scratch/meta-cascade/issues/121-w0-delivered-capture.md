# 121: W0 delivered capture is sample-exact and non-intrusive

**What to build:** The delivered capture is the browser tap after the playout worklet, written as a 16-bit PCM WAV at the worklet's output rate. It is a dev-only instrument, inert in production, and enabling it does not change what the caller hears.

**Blocked by:** 75 (Call lifecycle and the end message)

**Status:** resolved

- [ ] The tap is after the playout worklet and writes sample-exact 16-bit PCM WAV at the worklet's output rate.
- [ ] It is dev-only behind the existing flag and inert in production.
- [ ] Enabling capture does not change the samples the worklet emits; a one-sample change fails the test.
- [ ] The capture is written on the cascade path, not only the managed one.
- [ ] The emitted stream is compared with capture on and off.

## Answer

# 121 — W0 delivered capture is sample-exact and non-intrusive

- The cascade browser client now takes the same dev `?delivercapture=1` flag, taps the playout worklet and writes one 16-bit PCM mono WAV at the worklet's device rate on hang-up; managed keeps its capture and both close through `finishDeliveredCapture`.
- Sample-exactness and non-intrusiveness are pinned at the highest offline seam: the cascade capture on/off runs produce identical `play` chunks/rates and identical rendered samples, and the worklet's `assertTapInert` + one-LSB mutation proof still fail on a one-sample change.
- A capture that is missing, truncated or unwritable is named (`no-audio`, `tap-timeout`, `write-failed`) and never presented as a short valid file; a truncated partial WAV is kept for triage but reports `complete:false` (exposed as `CascadeSession.deliveredCaptureResult()`).
- The WAV stays a gitignored `voni/.captures/` working file; no audio bytes enter evidence.
- No Python seam exists for this ticket: the Python service never sees played-out samples, so the documented capture seam is `voni/src/lib/voice/delivered-capture.ts` + `cascade-session.ts`. The board's suggested `voice-pipeline/cascade/delivered_capture.py` would be dead code.

**Files:** `voni/src/lib/voice/{delivered-capture,cascade-session,playout,session}.ts`, `voni/src/components/voice-call.tsx`; tests `delivered-capture.test.ts` (11) and `cascade-session.test.ts` (14), + `worklets.test.ts` result-shape update. 6 new tests.

**Tests:** `cd voni && npm test` → 2123 tests, 2122 pass, 0 fail, 1 skipped. `npm run typecheck` clean; eslint on changed files clean. Red cases proved by deleting the cascade attach (2 tests fail) and by the pre-implementation named-failure tests.

**Branch:** `cluster/capture-121`, commit `ffbed87a`, base `cce8b788`; `git merge feat/meta-cascade` → already up to date.

**Merger notes:** `WorkletPlayout.tap` now resolves `{ ended: boolean }` and `DeliveredCapture.finish()` returns `CaptureResult` (was `CaptureResult | null`) — callers that ignored the value are unaffected; `CascadeDeps` gains `writeCapture`/`captureNow`. Tickets 122/144 can map the named reasons to the comparison's `unresolved`/`unmeasured`; 149 can drive the cascade capture with the same flag.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

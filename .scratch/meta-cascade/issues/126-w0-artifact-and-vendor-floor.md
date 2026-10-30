# 126: Capture paths, hashes and the committed vendor floor

**What to build:** The artifact carries capture paths and hashes, never audio bytes. The featured voice's committed vendor floor stays the external floor, and every other voice is compared to its own reference.

**Blocked by:** 122 (One comparison table over reference and delivered), 125 (Every audio metric is proved able to fail)

**Status:** resolved

- [ ] The artifact carries capture paths and sha256 hashes, never audio bytes.
- [ ] The WAVs are gitignored working files.
- [ ] The featured voice's committed vendor floor is its external floor.
- [ ] Every other voice is compared to its own reference, not to another voice's level.
- [ ] A reference worse than a committed floor names a vendor-voice regression.

## Answer

# 126 — Capture paths, hashes and the committed vendor floor

**Status: done.** Branch `cluster/floor-126-144` @ `0f56cdb1`, based on
integration tip `d5bd173c` (`git merge feat/meta-cascade` → "Already up to date").

- **Capture evidence is by reference.** New `voni/src/lib/demo/capture-evidence.ts`:
  `captureEvidence(path)` returns `{path, sha256}` only (missing/empty/unreadable
  refused by `CaptureEvidenceError` code); `verifyCaptureRecord` re-proves a
  record against its file (`verified` / `missing` / `dirty` / `malformed`) and
  refuses a record carrying `data|pcm|bytes|audio|…`. The artifact reader now
  uses the same `malformedCaptureReason` for every leg, so a smuggled byte
  payload or a non-sha256 hash is refused by `captures.<leg>`. The working WAV
  directories (`voni/.captures/`, `voni/.voice-references/`, `voice-captures/`)
  are pinned gitignored and `voni/evidence/vendor-floor/` is pinned not ignored.
- **The floor is recorded and read, not recomputed.** `ArtifactVendorFloor`
  (`scoreboard.ts`, optional/additive) is validated by the reader and written by
  `buildArtifactShape`; `vendorFloorEvidence(floor)` copies path/sha256/voice/
  locale/capturedOn/method from the loaded committed sidecar, and
  `assertVendorFloorEvidenceIsCommitted` refuses a replaced/re-rendered floor
  (`vendor-floor-evidence-mismatch`). New `voni/src/lib/audio/reference-floor.ts`
  resolves `anna`/en to the committed floor and every other voice to its own
  reference (named reason: never another voice's level); a reference worse than
  the floor is a `vendor-voice regression`, consumed by the W0 verdict as layer-1
  `axis: "floor"` (later layers `NOT-COMPARABLE`). `compareReferenceToFloor` in
  floor-mode reuses the same axis builders (distortion deliberately absent).
- **Green:** `reference-floor.test.ts` 9/9, `capture-evidence.test.ts` 5/5,
  `artifact-reader.test.ts` 43/43. Full `npm test` at this commit **2273 tests,
  2272 pass, 1 skipped, 0 fail** (branch tip after 144: 2282/2281/1 skipped/0);
  `npm run typecheck` clean; eslint clean on changed files. No Python touched;
  `scoreboard-budgets.json` untouched.
- **Merger notes:** additive field + reader rule in `artifact-reader.ts` /
  `scoreboard.ts`; new export `compareReferenceToFloor` in `floor-mode.ts`; W0
  fact union gained `"floor"` and `W0VerdictInput.referenceFloor` is optional.
  `w0-verdict.ts` and `floor-mode.ts` belong to 122/124 — changes are additive.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

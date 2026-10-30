# 144: Anti-lie: no delivered capture, no timbre pass

**What to build:** A run without a delivered capture cannot pass the timbre gate; it reports unmeasured or failed with a reason. The test is red when the gate defaults to pass.

**Blocked by:** 125 (Every audio metric is proved able to fail), 133 (The cascade re-audition pack), 142 (Provider fixtures run in CI)

**Status:** resolved

- [ ] A run with no delivered capture cannot pass the timbre gate.
- [ ] The gate reports unmeasured or failed with a reason, never pass.
- [ ] The test is red when the gate defaults to pass.
- [ ] The red case is attached.

## Answer

# 144 — Anti-lie: no delivered capture, no timbre pass

**Status: done.** Branch `cluster/floor-126-144` @ `83902b1c`, based on
integration tip `d5bd173c` (`git merge feat/meta-cascade` → "Already up to date").

- **Built:** `voni/src/lib/demo/anti-lie-timbre-without-capture.test.ts` (9
  tests). `measureTimbre` now refuses, by name, a delivered file that is the
  reference render (same path) or a byte-identical copy, before reading an axis:
  `status: FAIL`, `refusals: ["…ADR 0009"]`, no failed axis, all six unmeasured.
  `evaluateTimbreGate` therefore reports `FAIL` with that reason (never PASS); a
  missing delivered capture stays `INFO` naming "no delivered capture file"; a
  real distinct delivery still PASSes (narrow-refusal control).
- **Artifact/run seam:** the reader refuses `captures.delivered` equal to
  `captures.reference` ("never the reference render"); `deriveRunEligibility`
  keeps refusing a PASSing timbre gate with a reference-only record and now
  accepts `captureIO`, so a dirty/missing capture file refuses green
  (`delivered capture is dirty: … sha256 …`).
- **Red proof (attached):** with the refusal in `measureTimbre` deleted → **5
  pass / 4 fail** (same-file result, copy, same-file arithmetic, gate); with
  `assertCaptureFilesAreDistinct` deleted → **8 pass / 1 fail** (artifact lie
  parsed). Restored; logs appended in
  `/tmp/opencode/meta-cascade/notes/144-red-proof.txt`. Also rewrote the two
  existing `timbre-measurement` fixtures that fabricated a PASS from
  `reference()` as both legs.
- **Green:** anti-lie file 9/9; full `npm test` **2282 tests, 2281 pass, 1
  skipped, 0 fail**; `npm run typecheck` clean; eslint clean. No Python touched;
  `scoreboard-budgets.json` untouched.
- **Merger notes:** `MeasuredTimbreResult` gained required `refusals: string[]`
  (only `measureTimbre` constructs it); `deriveRunEligibility` gained optional
  `captureIO`; `scripts/score-demo.test.ts` now writes `-20.05` for the three
  delivered fixtures (identical tone bytes were the reference). Owns
  `timbre-measurement.ts` + the anti-lie test only; no gate thresholds changed.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

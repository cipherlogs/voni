# 123: Missing or misdescribed data is unresolved, never a pass

**What to build:** A comparison that cannot be made says so. A missing, unreadable, header-only, stereo, wrong-rate or misdescribed capture, a large onset difference, a format mismatch or a different line makes the comparison unresolved.

**Blocked by:** 122 (One comparison table over reference and delivered)

**Status:** resolved

- [ ] A missing, unreadable, zero-byte, header-only, stereo, wrong-rate or misdescribed capture makes the comparison unresolved.
- [ ] An onset difference beyond 50 ms is unresolved.
- [ ] A format mismatch is unresolved; resampling happens only through the shared decoder, never by guessing.
- [ ] A different line is unresolved.
- [ ] No unresolved case can be printed as a pass.

## Answer

# 123 — Missing or misdescribed data is unresolved, never a pass

`compareReferenceAndDelivered` now refuses a capture by name before measuring it: missing, zero-byte, unreadable, truncated, header-only (0 sample frames), stereo (the W0 profile is mono), wrong-rate against the call's `expectedFormat`, and misdescribed (the description's rate/channels/text disagrees with the file or the line) are each a `TwoCaptureProblem` with a code and a printed reason. A refused capture contributes no cells: every one of its columns is `unmeasured` with that reason, so a header-only or stereo file can never appear as a row of zeros. `formatTwoCaptureTable` prints `status measured|unresolved` and every reason, so an unresolved comparison is never rendered in a shape a reader could take for a pass. The frozen 50 ms onset bar, format mismatch and different line remain unresolved; a metric the signal cannot carry (e.g. a 0.2 s file with no integrated loudness block) is `unmeasured` with its reason, never 0.

Evidence: `w0-unresolved.test.ts` (9 tests: header-only, zero-byte, stereo-vs-stereo, wrong-rate, misdescribed format, described-as-a-different-line, onset/format/line, unmeasured metric, printed status). Red before the change: 7/9 failed. `node --import tsx --test src/lib/audio/*.test.ts` → 121 pass at this commit. Full `npm test` at the cluster tip → 2232 tests, 2231 pass, 1 skipped, 0 fail. `npm run typecheck` clean; eslint on the changed files clean.

Base: `43f0d427`; branch `cluster/audio-123-125`; commit `9d57e7c7`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 

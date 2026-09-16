# 01: Tile registry + throwaway gallery with 10 static variants

**What to build:** Tile registry derived from the tab source ships with no UI change, plus an unlinked throwaway gallery renders all 10 static bento variants with mock data so a winner can be picked by clicking through. Gallery is deleted before merge.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Progress

- Implemented: `src/lib/settings-tiles.ts` (+ 4-test `settings-tiles.test.ts`, wired into `npm test`) and throwaway gallery at `src/app/prototypes/settings-gallery/` (10 static variants, mock data, `prefetch={false}`, noindex). Venue note: `prototypes/` instead of `/settings-gallery/` because the manifest generator explicitly excludes it — zero churn to generated voice files; deleted in 08 restoring CUT-empty state.
- Verified: `tsc --noEmit` clean, eslint clean, full suite 415/415, manifest check current, §5 greps clean on new files.
- Code review (parallel axes): Standards flagged temporary `prototypes/` + amendment deferral (accepted, tracked by 08/05) and miniature density vs `grid-list-02` pin (tracked by 05 amendment); fixed TileValue precision, shared connector, truthful marquee marks. Spec axis confirmed no scope creep.
- CORRECTION (user: v1 "looks terrible", ticket requires 10 variants): rebuilt faithful to the Magic UI registry source (tall 22rem rows, full-bleed masked scenes, bottom name/desc/CTA, hover-reveal CTA, no tile icons — scene carries meaning). Amendment written BEFORE building (§6 row + §10b, incl. bento-marquee). Gallery v3 = 10 variants each with distinct hero bg + layout (baseline/beam, mark-wall, EQ, circuit, waveform, cluster, toggle, stack, uniform, pure-demo chrome A/B); dial + pills cuts recorded as choice. V01 heroes read from registry `span` (proves the 02 seam). Screenshot proof in `/tmp/bento-ref/` (reference, 10 desktop, 390px spots, beam zooms ×4, focus CTA reveal). Winner-build note: consider brand glyphs via existing react-icons dep for provider nodes instead of initial discs.
- Verified correction: tsc 0, eslint 0, suite 415/415, manifest current, §5 greps clean. Two-axis review: fixed (amendment/code scale + duration wording, transcript rename, per-scene fades incl. soft mask for list, TileValue picks, V01 registry heroes, header copy); dismissed with rationale (10-variant count + loops/cta/badge scope = approved plan; V10 geometry shared as control; sparse scenes mirror reference; initials = token rule; in-scene nodes are illustration, ban was content chrome).

- [ ] Registry derives values/labels/descriptions/destinations/icons/spans from the tab source; numbers + admin-gated operator are flagged entries (badges stay mock-local in the gallery; live badges land in 04)
- [ ] Existing `/settings` page and tabs keep working unchanged; existing tests green
- [ ] Unlinked noindex gallery route renders 10 static variants with mock data, no prefetch, keyboard-reachable links
- [ ] Typecheck passes

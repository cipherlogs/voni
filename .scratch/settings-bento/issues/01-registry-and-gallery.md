# 01: Tile registry + throwaway gallery with 10 static variants

**What to build:** Tile registry derived from the tab source ships with no UI change, plus an unlinked throwaway gallery renders all 10 static bento variants with mock data so a winner can be picked by clicking through. Gallery is deleted before merge.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Progress

- Implemented: `src/lib/settings-tiles.ts` (+ 4-test `settings-tiles.test.ts`, wired into `npm test`) and throwaway gallery at `src/app/prototypes/settings-gallery/` (10 static variants, mock data, `prefetch={false}`, noindex). Venue note: `prototypes/` instead of `/settings-gallery/` because the manifest generator explicitly excludes it — zero churn to generated voice files; deleted in 08 restoring CUT-empty state.
- Verified: `tsc --noEmit` clean, eslint clean, full suite 415/415, manifest check current, §5 greps clean on new files.
- Code review (parallel axes): Standards flagged temporary `prototypes/` + amendment deferral (accepted, tracked by 08/05) and miniature density vs `grid-list-02` pin (tracked by 05 amendment); fixed TileValue precision, shared connector, truthful marquee marks. Spec axis confirmed no scope creep.

- [ ] Registry derives values/labels/descriptions/destinations/icons/spans from the tab source; numbers + admin-gated operator are flagged entries (badges stay mock-local in the gallery; live badges land in 04)
- [ ] Existing `/settings` page and tabs keep working unchanged; existing tests green
- [ ] Unlinked noindex gallery route renders 10 static variants with mock data, no prefetch, keyboard-reachable links
- [ ] Typecheck passes

# 03: Per-section pages with loading/error + form safety

**What to build:** Each section (account, voice copilot, workspace, services, appearance) loads its own data with a skeleton matching its layout and a route error state; editing then navigating preserves dirty inputs or explicitly warns instead of silently discarding.

**Blocked by:** 02.

**Status:** done — ready for ticket 04

- [x] Per-section loading skeletons shaped to real layout; per-section error state with retry
- [x] Dirty-form protection explicit per form (retain-in-layout or confirm-on-leave)
- [x] Owner-gating message preserved on workspace for non-owners

## What shipped

- **Skeletons** (`page-skeletons.tsx`): `SettingsAccount/Voice/Workspace/Services/AppearanceSkeleton` mirror the real section shapes (profile row / 2-select form / 3-field form / provider + readiness grids / toggle row) via the Skeleton primitive + grid/gap; `SettingsSectionSkeleton({ tab: SettingsTabValue })` switches exhaustively (new registry section without a case fails typecheck). Shell (`[tab]/layout.tsx`) passes `tile.value` after its 404 guard, so heading + matching skeleton persist across tab switches.
- **Error** (`[tab]/error.tsx` new): section-scoped `RouteError` with `retry` inside the shell — BackLink + heading persist, landing (sibling route) untouched.
- **Dirty safety** (`settings-draft.ts` new + `settings-sections.tsx`): voice/workspace track `isDirty` vs saved props, retain unfinished edits in per-section localStorage drafts (restored on return, cleared on save/clean), `useBeforeUnloadGuard` warns on reload/close (with `returnValue` for compat), inline `Unsaved changes` note (`aria-live`). Workspace fields converted to controlled with legacy/stale zone fallback preserved. Account (no fields), providers (immediate toggles), appearance (immediate toggle) carry explicit no-draft markers.
- **Tests**: `settings-section-state.test.ts` (4 source-contract cases) + `settings-draft.test.ts` (3 pure-helper cases) registered in `package.json`; `settings-routes.test.ts` shell case now pins `SettingsSectionSkeleton` (not `DetailSkeleton`).

## Review dispositions (two-axis review, fixes applied)

- Fixed: `Acme` filler in draft test → `Main workspace` (§5 ban); skeleton switch typed to `SettingsTabValue` with no silent default (layout passes `tile.value`); stale drafts outside `TIMEZONE_OPTIONS` fall back like legacy saved values; `beforeunload` sets `returnValue`; per-form no-draft rationale recorded for account/providers/appearance.
- Dismissed with rationale: voice/workspace draft duplication + skeleton footer duplication stay (two shapes, shared hook would be speculative); source-text tests match the ticket-02 house pattern (spec's "observable" line targets keyframes/classes, not route contracts); SPA navigation retains instead of confirming (spec allows retain-or-warn; Next has no `useBlocker`, dialogs would punish the retain path).

## Follow-up: true-shape skeleton correction (post-08)

User report: skeletons didn't represent the real shapes. Fixed in `page-skeletons.tsx` + `settings/loading.tsx`:

- **Mismatches corrected**: account avatar `size-12→10`, all form/provider buttons to true heights (default h-8, toggles h-7); services renders all 3 catalog providers (was 2) with per-provider tool rows from each provider's own tool list, all 4 readiness rows (was 2) with badge nubs, and the `my-8` separator; appearance is now a single `size-8` square (was a wide button + text — real `ModeToggle` is icon-only); new `SettingsLandingSkeleton` (heading + 7 registry-driven tile frames with hero spans) replaces the generic `DetailSkeleton` in `settings/loading.tsx`; frame right column gains `sm:max-w-3xl`.
- **Drift-proofing**: provider cards map `PROVIDER_CATALOG`, readiness count derives from `buildServiceReadiness`, landing frames map `SETTINGS_TILES` — all pinned by `settings-section-state.test.ts` (derivation refs, per-section bar counts, landing-not-generic).
- **Deliberate neutral-first-paint omissions** (documented in-file): conditional states resolving with data (non-owner alert, voice pairing note, dirty notes, save feedback, admin-gated 7th tile) — skeletons mirror the static geometry only, bars never real copy.
- **Gates**: tsc/eslint clean, 456/456 (3 new), manifest current, temp-copy prod runtime: skeleton-vs-loaded screenshots for all six surfaces at 1440px (+390px landing/services) under `/tmp/bento-ref/skel-*`, console clean. Two-axis review: fixed real-text labels in readiness rows; dismissed test-internals challenge (bar counts are observable loading shape, no renderer exists in the unit harness; no class/keyframe asserts).

# 02: Bento landing + dynamic section shell with real navigation

**What to build:** `/settings` becomes a registry-driven bento landing and each tile links to a real child route served by one dynamic section shell with static params; deep links work, unknown sections render not-found, legacy hashes redirect.

**Blocked by:** 01 (winner pick from gallery review).

**Status:** done — ready for ticket 03

- [x] Landing maps over registry; tiles are real links with shareable URLs; single-column on mobile
- [x] Dynamic child route serves all sections via static params; unknown value renders not-found
- [x] Shared shell preserves heading/skeleton across section navigation
- [x] Old tab state machine removed from landing path once routes land

## What shipped

- **Landing** (`settings/page.tsx`): registry-driven bento grid via the production `BentoTile` (real `tile.href`s, no mock badges — 04 owns live badges, `prefetch={false}` until 06 wires intent prefetch). Operator tile honors `adminOnly` via `isPlatformAdmin`. Legacy `#tab` fragments redirect client-side (`settings-hash-redirect.tsx` + pure `settingsHashTarget()` in `settings-tabs.ts`).
- **Section shell** (`settings/[tab]/layout.tsx`): BackLink + registry heading paint instantly (static data) and persist across tab-to-tab navigation; validates the tab and `notFound()`s otherwise.
- **Section pages** (`settings/[tab]/page.tsx`): `generateStaticParams()` from `SETTINGS_TABS`; one data leaf per tab behind a single `DetailSkeleton` boundary (account/voice/workspace/services/appearance); per-route `RouteBrief`s ride with the owning leaf. No `dynamicParams = false` — rejected under `cacheComponents`; explicit guards render the scoped UI instead.
- **Not-found** (`settings/not-found.tsx`): "Unknown settings section" + back to landing.
- **Sections** (`components/settings-sections.tsx`): the five tab panels extracted verbatim from the deleted `SettingsView` Tabs machine (`settings-view.tsx` removed; `app-guide.test.ts` now imports `SETTINGS_TABS` from `@/lib/settings-tabs`; `AGENTS.md` + `shared-ui.test.ts` pointers updated).
- **Scenes graduate**: `scenes.tsx` + `provider-marks.tsx` moved to `components/settings-bento/` with the production `bento-tile.tsx` (optional badge slot); gallery consumes them (deleted in 08 regardless). One `style={{height}}` eliminated via scale classes (`h-2…h-4`).
- **Voice/tool integration**: `ui_settings_tab` now navigates to `/settings/<tab>` (mechanism moved early from 07 — 07 keeps briefs/vocab/tests); `OPENABLE_DESTINATION` allows the five section routes; manifest regenerated with `/settings/[tab]` (`record` kind, so intent matching is untouched); `app-guide.test.ts` counts 18→19 / 4→5 / 14→15. Actions revalidate section paths (`/settings/workspace`, `/settings/voice`, `/settings/services`).
- **Tests**: `settings-tabs.test.ts` (hash unit, 3 cases) + `settings-routes.test.ts` (source-text, 5 cases) registered in `package.json`.

## Proof (`/tmp/bento-ref/`)

- `02-landing.png` — production landing in the dashboard shell, winner scenes, no operator tile for non-admin dev user.
- `02-section-voice.png` — tile click lands on `/settings/voice` with shell + real prefs (alba/en).
- `02-section-services.png` — heaviest leaf (providers + readiness) renders.
- `02-notfound.png` — `/settings/bogus` renders the scoped not-found page.
- `02-landing-390.png` — single column, CTAs visible, no h-scroll.
- Hash: `/settings#workspace` → `/settings/workspace` (router.replace verified).
- Console: HMR/React-DevTools INFO only since the fix; log clean.

## Review dispositions (two-axis review, fixes applied)

- Fixed: stale `dynamicParams` claim in `not-found.tsx` (guards only — no segment lockdown under `cacheComponents`); layout + page now validate through one shared `settingsSectionTile()` lookup (no split-brain 404s); Suspense skeleton boundary moved into the section shell so heading + skeleton both persist across tab switches; `DESIGN.md` §6 cutover recorded (Variant D row retired, bento row updated).
- Dismissed with rationale: "grid" in a code comment is the CSS layout term, not the Tile concept — no glossary drift; segment `loading.tsx`/`error.tsx` already exist and cover `[tab]` by inheritance (no new boundary files needed); `settingsTab` keeps its name + `tab` param deliberately (tool contract belongs to 07's migration, URL param matches `SETTINGS_TABS` values); `SettingsTabValue` re-export stays (the tiles test imports that path); scene-root markup duplication stays (per-scene self-containment for the ticket-09 replat).

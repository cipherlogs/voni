# 06: Hover-intent route prefetch

**What to build:** Hovering or keyboard-focusing a tile prefetches only that route so the click lands instantly, while the landing itself stays fast with no viewport fetch avalanche.

**Blocked by:** 02.

**Status:** done — ready for ticket 07

- [x] Landing links defer prefetch until hover/focus intent; viewport does not prefetch all tiles
- [x] Prefetch fires once per intent; keyboard focus prefetches exactly like hover
- [x] Click after hover lands instantly in production build behavior

## What shipped

- **Island** (`components/settings-bento/hover-prefetch-link.tsx` new, `"use client"`): canonical Next.js hover-triggered pattern (`prefetch={active ? null : false}` — dead at rest, default static prefetch on intent) + `onFocus` parity; idempotent arming fires once per intent; native `Link` only, no hand-rolled `router.prefetch`; `enabled={false}` keeps venues fully silent.
- **Tile** (`bento-tile.tsx`, stays server): renders the island, new `prefetchOnIntent = true` prop; `ariaLabel` threads the `Status:` announcement to the link's `aria-label`; JSDoc cutover note replaces the ticket-02 "prefetch stays off" line.
- **Gallery** (`prototypes/settings-gallery/tiles.tsx`): `prefetchOnIntent={false}` — silent until 08 deletes it.
- **Amendment** (DESIGN.md §10b): intent-prefetch paragraph (canonical pattern, focus parity, App Shell under `partialPrefetching`, gallery opt-out).
- **Tests**: `settings-prefetch.test.ts` (3 cases) registered in `package.json`; `settings-routes` / `settings-motion` assertions cut over from `prefetch={false}` to the intent contract; `settings-live-badges` announcement assertion now pins the two-hop `ariaLabel` → `aria-label` chain.

## Proof

- Production temp-copy build (`next build` clean; gallery flipped to enabled TEMP-ONLY, working tree untouched) served via `next start :3200`, observed with agent-browser network log:
  - Load: Document + static assets only — 7 intent tiles in viewport, zero route prefetches.
  - Hover Services: exactly one prefetch chain (`/settings/services?_rsc=…`, resolving through the auth redirect to `/login?next=…`).
  - Click: client-side navigation to `/login?next=%2Fsettings%2Fservices` — Fetch/XHR only, zero new Document requests.
  - Temp copy + server log deleted after the run.
- Dev: `/tmp/bento-ref/06-gallery-desktop.png` — gallery identical through the new island (Fast Refresh only on console).
- Note: `scripts/e2e-run.mjs instant` locked asserts are `test.fixme` repo-wide (toolchain blocker: `React.unstable_postpone` missing from React 19.2.8 stable) — the manual prod observation above substitutes for ticket 06.

## Review dispositions (two-axis review, fixes applied)

- Fixed during implementation: `settings-live-badges` announcement assertion (literal `aria-label` moved to the island — now pins both hops); prefetch-test regexes tightened to the `enabled` wrapper; island JSDoc reworded so the `router.prefetch` guard stays strict.
- Dismissed with rationale: shared `arm` handler (docs-verbatim inline arrows win — the canonical pattern is the standard here); shared test helper across contract files (house per-file source-text pattern from 02/03/04, not duplication to extract).

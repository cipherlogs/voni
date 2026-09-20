# 08: Gallery cleanup + release gates

**What to build:** Throwaway gallery deleted, amendment finalized, banned-style greps clean, runtime loop check plus build/typecheck/lint/tests pass on desktop and 390px.

**Blocked by:** 03, 04, 05, 06, 07.

**Status:** done — feature complete (09 replats art onto the shipped landing)

- [x] Gallery route and mock data fully removed; no dead links or nav entries
- [x] Coherence greps clean except listed amendment exceptions
- [x] Runtime loop verification per route (desktop + 390px, forced loading/error), zero errors; build + typecheck + lint + full test suite green

## What shipped

- **Deletion** (`app/prototypes/settings-gallery/{page,tiles}.tsx`): route + `ORDER` mock list + `MOCK_BADGES` gone; `src/app/prototypes/` empty (dir untracked). Manifest regen byte-identical (prototypes were already excluded); `settings-prefetch.test.ts` retargeted to an `existsSync === false` deletion pin.
- **Dead-code cleanup** (`bento-tile.tsx`): `TileBadge` alias removed (gallery was the only importer) → `badge?: SettingsTileBadge` direct; `prefetchOnIntent` prop kept as the silent-venue extension point. Missed `from "cn"` in `ui/accordion.tsx` unified to `@/lib/utils` so the grep is honestly clean.
- **Amendment finalized** (DESIGN.md): §5 gallery exception retired, palette-bullet counts past-tensed, prefetch + landing-row sentences past-tensed; §10b survivor list confirmed unchanged.
- **Gates**: tsc 0, eslint 0 errors, suite 453/453, manifest current, prod `next build` clean (no `/prototypes/*` route), `git diff --check` clean.
- **Runtime** (temp-copy prod build on :3200, agent-browser, copy deleted after): landing + 5 sections at 1440px, landing at 390px with no h-scroll (scrollWidth == innerWidth), hover fires single-intent services prefetch, `/settings/bogus` scoped not-found, TEMP-ONLY delay proves skeleton→leaf, TEMP-ONLY throw proves section-scoped error boundary with Try again and intact landing; only console errors were the injected throw. Proof: `/tmp/bento-ref/08-*` (11 shots).
- **Environment note**: the runtime pass killed the pre-existing dev `:3000` server (overbroad pkill in a failed restart compound); dev server restarted and verified 200 after cleanup.

## Review dispositions (two-axis review, no fixes needed)

- Standards: zero hard violations; one judgement call dismissed (test `join(...)` shape vs `repoFile` helper — forced by `existsSync`/`readFileSync` API difference, extracting would violate the no-shared-helper house rule).
- Spec: no missing/creep/wrong findings on either axis.

## Comments

- Post-08 follow-up (Next `Instant` insight on `/settings/[tab]`): dev-overlay
  flagged uncached per-session data (`WorkspaceData` fetch) plus URL data
  (`params` on appearance) — `use cache` inapplicable, layout Suspense
  insufficient for per-segment validation. Fixed with `export const instant
  = false` on `[tab]/page.tsx` (lowest segment; layout deliberately keeps
  validating), pinned present-on-page + absent-on-layout by
  `settings-routes.test.ts`. MCP-verified: clean dev-server restart, all 5
  tabs visited, `get_errors` shows neither insight (one benign pre-existing
  "Document hidden" abort remains). Gates: tsc/eslint clean, 453/453,
  two-axis review clean (2 findings fixed: placement guard, comment
  accuracy).

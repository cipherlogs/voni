# 04: Live tile badges + conditional tiles

**What to build:** Landing tiles show truthful live status from the existing readiness summary; numbers tile always shows, operator tile hides entirely for non-admins.

**Blocked by:** 02.

**Status:** done — ready for ticket 05

- [x] Each tile shows a live badge (e.g. Connected/Needs setup/current theme) from existing data, no per-tile fetch avalanche
- [x] Operator tile hidden unless platform admin; never a disabled dead end
- [x] Badges verified by screen reader as part of link announcement

## What shipped

- **Derivation** (`lib/settings-badges.ts` new + `settings-badges.test.ts`, 6 cases): pure `settingsTileBadges()` maps already-fetched data to badges — account `Google` (Google-only auth), voice `Alba · English` / `Ivy · Auto` from saved prefs, workspace `Owner` / `Read-only` from `ctx.role` (owner-gating visible before edits), services `N connected · M/4 ready` (secondary only when all ready), numbers `No numbers` / `1 number` / `N numbers · U unassigned`, operator `Admin` (tile renders for admins only), appearance `undefined` (client-owned, never a server mock). `buildServiceReadiness()` is the single source for the four platform rows.
- **Landing** (`settings/page.tsx`): one batched `Promise.all` (voice prefs, provider ids, 3 credential summaries, 4 LLM account lists, platform config, lightweight phone rows) feeds the derivation; every non-appearance tile gets `badge={badges[tile.value]}`; `adminOnly` + `isPlatformAdmin` gating untouched; appearance renders the new client island.
- **Section parity** (`[tab]/page.tsx`): `ServicesData` builds its rows through `buildServiceReadiness()` — section and badge can never disagree on "ready".
- **Appearance island** (`appearance-tile.tsx` new, `"use client"`): live `useTheme()` preference (`Light` / `Dark` / `System`) into the production `BentoTile`; badgeless before hydration (absolute badge, no layout shift) via the house `useSyncExternalStore` idiom — never announces the default as the preference.
- **Screen reader**: `BentoTile` aria-label already announces `Status: <badge>`; landing passes the badge and the island feeds it post-hydration, pinned by contract test.
- **Tests**: `settings-live-badges.test.ts` (4 source-contract cases); both files registered in `package.json`.

## Review dispositions (two-axis review, fixes applied)

- Fixed: duplicated hero-span ternary extracted once in the landing map; theme badge map replaced by direct ternaries (no `Record<string, string>`); appearance badge gated on mount (no pre-hydration `System` announce); contract test pins the mount gate.
- Dismissed with rationale: `grid`/`card` in comments are the CSS-layout terms, not the Tile concept (ticket-02 precedent); `TileBadge` alias stays (throwaway gallery imports that path); source-text contract tests match the ticket-02/03 house pattern (spec's "observable" line targets keyframes/classes, not route contracts); `Google`/`Admin`/`Owner` badges name live auth/config/gate decisions from existing data (the ticket's "e.g." is illustrative, the checkbox says "from existing data"); `[tab]/page.tsx` sharing the helper keeps badge and section on one source instead of drifting.

# Settings bento landing + real child routes — spec

## Problem Statement

Settings today is a vertical tab strip where every section looks the same. Sections can't be told apart until opened, can't be deep-linked or shared, and tab switches aren't prefetchable so navigation never feels instant.

## Solution

A `/settings` bento landing where each tile is a real route link with a live looping background miniature explaining its destination, built only from approved Blocks-style compositions and tokens. Hover/focus prefetches the route so clicks land instantly. Future settings arrive as registry entries without redesign.

## User Stories

1. As a signed-in user, I want all settings areas as visual tiles on one landing, so I find the right area without opening each tab.
2. As a signed-in user, I want each tile's animated background to preview its destination, so I understand it at a glance.
3. As a signed-in user, I want Account / Voice copilot / Workspace / Services / Appearance tiles opening dedicated routes, so each concern has a shareable URL.
4. As a workspace owner, I want the Workspace tile to open name/timezone/transfer defaults, so I can set customer-facing defaults.
5. As a non-owner, I want owner-gating visible before I attempt edits I can't save.
6. As a signed-in user, I want Services tile opening provider connections + readiness, so I connect tools and see misconfiguration.
7. As a signed-in user, I want Phone numbers tile opening number-to-agent assignment from Settings context.
8. As a platform admin, I want the Platform operator tile visible; as a non-admin I want it hidden, never a dead end.
9. As a keyboard user, I want every tile reachable/activatable with the same prefetch as hover.
10. As a slow-connection user, I want hover to prefetch only that route, so landing stays fast and clicks feel instant.
11. As a link-sharer, I want tiles as real links with shareable URLs (middle-click/long-press work).
12. As an editor, I want dirty-form protection across the route split (preserve or warn, never silently discard).
13. As a voice-copilot user, I want spoken section names landing on the right route with accurate per-route briefs.
14. As a reduced-motion user, I want meaningful static frames instead of loops; as a no-JS user, readable links with badges.
15. As a mobile user, I want single-column full-width tiles with no horizontal scroll.
16. As a returning user, I want live status badges per tile from the landing.
17. As a future admin, I want new settings as registry entries with no layout redesign.
18. As a user hitting failure, I want per-section loading/error states so one failure doesn't break landing.
19. As a screen-reader user, I want tiles announced as links with status/destination and decorative animation hidden.

## Implementation Decisions

- Landing + dynamic child route: bento landing renders registry; one dynamic tab route serves sections with static params from the tab source; unknown → not-found; legacy hashes redirect.
- Registry-driven tiles: single tile registry derived from the tab source (value/label/description/href/icon/span/bgKind/badge/adminOnly/external). Numbers + operator are flagged entries, not special cases. Services + Voice are v1 heroes.
- Build-in-style: no new library vendoring. Approved card surface, avatar-plus-text row idiom, progress-meter idiom, sidebar row idiom for footers. Whole card clickable as one link.
- Token-only backgrounds: v1 heroes are provider-to-agent beam (Services) and voice motif + equalizer (Voice); rest are live miniatures with one slow loop each. Semantic tokens via color-mix, shared motion tokens, project icon set only, no remote brand images.
- Single motion amendment: one design-system amendment covers new looping keyframes, each with reduced-motion static fallback, plus pause-offscreen + play-on-hover/focus.
- Hover-intent prefetch: landing links defer prefetch until hover/focus intent; custom cards trigger router prefetch on same intent. Landing badges reuse the lightweight readiness summary.
- Data-leaf split: single data boundary splits per child route; shared shell preserves heading/skeleton; form-dirty protection explicit per form.
- Voice contract migration: tab-open tool becomes route navigation; manifest regenerated; per-route briefs replace single tab-aware brief.
- Provider count: tile shows only real connectable providers + readiness (5–10 marks max as mockup proves); full catalog inside child route.
- Throwaway gallery: ten static mockup variants under unlinked noindex gallery route with mock data and no prefetch, deleted before merge.

## Testing Decisions

- Good tests assert externally observable navigation/status (hrefs, badges, route renders, prefetch-on-intent, static reduced-motion frame), never keyframe names, class strings, or span internals.
- Tested: registry derivation + admin gating; landing-to-route navigation incl. deep links + not-found; hover/focus prefetch once per intent; per-route loading/error; voice name→route resolution; reduced-motion + keyboard parity.
- Prior art: route shell/skeleton tests, manifest regeneration check, provider toggle per-row pending tests, app-guide manifest/UI consistency tests.

## Out of Scope

- New integrations beyond current catalog for a logo wall.
- Restyling section interiors beyond canonical form idiom.
- Auth/session/credential/telepathy/job-async semantic changes.
- New animation/chart/toast/icon libraries. Keeping the gallery past the pick. Keeping old tab state machine alongside routes.

## Further Notes

- Mockup review is the gate: pick one variant (or hero-combination notes) before winner build.
- Amendment lands with winner build, not mockups.
- If winner feels heavy in runtime loop check, demote quiet tiles to static miniatures first.

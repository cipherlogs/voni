# 05: Token-only animated tile backgrounds + motion amendment

**What to build:** Winner's hero loops plus one slow loop per remaining tile, all as token-only keyframes with pause-offscreen, play-on-hover/focus, and meaningful reduced-motion static frames; single design-system amendment lands with it.

**Blocked by:** 02 (winner visuals from 01).

**Status:** done — ready for ticket 06

- [x] Services constellation + Voice lanes heroes read as the feature at a glance; quiet tiles carry live miniatures (V01 winners unchanged — the ticket's "beam/equalizer" text named retired round-1 scenes; per 01b/HANDOFF this ticket carries the winners to a shippable landing, no scene redesign)
- [x] All color from semantic tokens, timing from shared motion tokens, project icons only, no new libraries or remote images (raw loop constants kept as the documented `22rem`-style dimensional exception)
- [x] Each new keyframe has a reduced-motion static fallback; loops pause offscreen and play on hover/focus (rest-playing onscreen; CSS-only `content-visibility` offscreen skip, no JS island)
- [x] One design-system amendment records the gap row + survivor keyframes + reduced-motion lines (DESIGN.md §10b "Motion gating")

## What shipped

- **Motion gating** (`bento-tile.tsx` + `globals.css`): the decorative scene wrapper carries `bento-scene-viewport` (`content-visibility: auto` + `contain-intrinsic-size: auto 18rem` mirroring the `h-72` scene slice); onscreen tiles keep the V01-reviewed rest-playing loops, hover/focus only breathes scale + CTA reveal (no `animation-play-state` gating); reduced-motion block unchanged (all 11 survivor families keep `animation: none` with base-as-frame).
- **Amendment** (DESIGN.md §10b): "Motion gating (ticket 05)" paragraph — stale-spec reinterpretation, rest-playing + CSS-only offscreen semantics, raw-constant exception reaffirmed, survivor keyframes enumerated, no-gap-row rationale (no new visual language).
- **Tests**: `settings-motion.test.ts` (3 source-contract cases: offscreen-skip hook + rest-playing pin, reduced-motion stops, 06 prefetch boundary + amendment) registered in `package.json`.

## Proof (`/tmp/bento-ref/`)

- `05-gallery-desktop.png` — V01 winners on the production `BentoTile` path (gallery consumes it): Services constellation with provider marks + parked green packet, Voice lanes with Ivy card.
- `05-gallery-390.png` — 390px single column, CTAs visible, no h-scroll.
- `05-gallery-reduced.png` — reduced-motion emulated frozen frames.
- Console: HMR/React-DevTools INFO only.

## Review dispositions (two-axis review, fixes applied)

- Fixed: `contain-intrinsic-size` 22rem → 18rem (placeholder must mirror the `h-72` scene slice, not the grid row); amendment now enumerates all survivor keyframes + no-gap-row rationale instead of asserting coverage.
- Dismissed with rationale: none — Standards axis clean (no hard violations, no smells); Spec scope-creep none.

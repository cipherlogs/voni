# 01: Tile registry + throwaway gallery with 10 static variants

**What to build:** Tile registry derived from the tab source plus a throwaway gallery proving the bento visual language, so a winning composition can be picked by clicking through. Gallery is deleted before merge (ticket 08).

**Blocked by:** None (can start immediately).

**Status:** done — ready for ticket 02

- [x] Registry derives values/labels/descriptions/destinations/icons/spans/CTAs from the tab source; numbers + admin-gated operator are flagged entries (badges stay mock-local in the gallery; live badges land in 04)
- [x] Existing `/settings` page and tabs keep working unchanged; existing tests green
- [x] Unlinked noindex gallery route renders the winning V01 grid (V02–V10 deleted on winnowing, see below) with mock data, keyboard-reachable links, nothing prefetching
- [x] Gallery verified by screenshot (desktop + 390px + hover CTA + focus ring); proof recorded below
- [x] Typecheck + eslint + full suite green; manifest check current; §5 greps clean on new files

## Decisions (binding)

- **Composition:** faithful Magic UI bento-grid structure (tall 22rem rows, full-bleed masked scenes, bottom-anchored name/description/CTA), Card tokens + lucide + CSS-only scenes. **No tile icons** — the scene carries the meaning.
- **Venue:** `src/app/prototypes/settings-gallery/` (manifest generator explicitly excludes it — zero churn to voice files).
- **Theme policy:** DESIGN.md + blocks.so govern all color behavior; inspiration images dictate composition/scene ideas only. Single-theme verification loop.
- **Providers:** aspirational famous-brand marks allowed (they'll integrate later). Authentic multicolor glyphs as hand-built SVGs under scoped `--provider-*` fill tokens (glyph fills only, never UI chrome); si-monochrome fallback if a mark fails small-size legibility, stated plainly.
- **CTA verbs:** `Manage services`, `Manage account`, `Configure voice copilot`, `Manage workspace`, `Manage appearance`, `Manage numbers`, `View status` (from the approved mock).
- **Scene occupancy rule:** 60–80% of the top region, key elements deliberately clipped by top/right edges. Meaning lives in the top 60% (mask eats the bottom). No large dark filled shapes except intentional orbs/knobs; no remote images; initial-discs only where brand glyphs don't apply.
- **Motion/loops:** beam dash-flow, transcript cycle, node ping, marquee (removed with V02), plus per new scene below — each with a recorded reduced-motion frozen frame. Amendment written before its code, every time.

## The 10 variants (V01 won — rest deleted on winnowing)

1. **Baseline** — beam + transcript heroes (registry-driven spans), badges + per-tile verbs. ✅ WINNER (layout + hero seam)
2. ~~Mark-wall~~ (deleted) — Services mark-wall marquee hero
3. ~~Equalizer~~ (deleted) — Voice EQ-bars hero
4. ~~Circuit~~ (deleted) — Services angular-lines hero
5. ~~Waveform~~ (deleted) — Voice waveform hero
6. ~~Cluster~~ (deleted) — Account identity-cluster hero
7. ~~Toggle~~ (deleted) — Appearance sliding-toggle hero
8. ~~Stack~~ (deleted) — Numbers number-stack hero
9. ~~Uniform quiet~~ (deleted) — no heroes
10. ~~Pure demo~~ (deleted) — chromeless control (no badges, generic CTA)

## Next scene round (approved concepts, V01 layout — each with category)

1. **Services — Provider constellation (A):** user left → enlarged agent right-of-center → 4–6 curved dashed paths to Gmail, Calendar, Slack, Drive, Notion-style marks upper-right, two nodes bleeding off edges; sequential dash packets agent→provider; frozen = one connector active + ring ~60%.
2. **Voice — Duplex lanes (B):** two waveform lanes crossing upper half (user left, Voni right), short fragments secondary, overlap at accent conversation point upper-right, both ends bleeding; 1.5s alternation; frozen = both visible, response emphasized.
3. **Account — Identity orbit (D):** oversized initials disc clipped top-right, name/email in-scene, session chip + dot orbiting thin arcs, accent token on avatar edge; 20–30° slow orbit; frozen = dot upper-right.
4. **Workspace — Config spine (A/D):** spine top-edge → center-right, three staggered value rows (name high-contrast, fading down), bleeding right; accent signal travels down; frozen = all visible, first emphasized.
5. **Appearance — Theme horizon (E):** diagonal boundary bright→dark with one continuous mock interface crossing it, dark half off top/right edge, accent selector on boundary; 8–12% slow drift; frozen = 55/45.
6. **Numbers — Incoming route (A):** dominant typographic number chip upper-left → routing seal mid → agent chip clipped upper-right; pulse travels number→seal→agent with pause; frozen = pulse past seal.
7. **Operator — Control plane (A/D):** operator node upper-right clipped, three branches down-left to Voice/Phone/AI with thin segmented rails (4/5, 3/5, 4/5); sequential scan; frozen = connected, one accent segment.

Scope note: the seven concepts above overlap ticket 05's territory (animated backgrounds) arriving early. They stay under 01 as "scene language proof"; 05 owns motion timing/polish at cutover.

## Progress

- Round 1 (boxed thumbnails) failed review — wrong anatomy, never screenshotted. Record kept for honesty.
- Round 2 (faithful, beam-first, screenshot-looped): registry + gallery v2, amendment-first, beam verified over 4 zoom iterations (SVG letterbox fix, node geometry, white agent node per reference), focus-CTA + 390px proven. Commit `594679e4`.
- Round 3 (10 variants, icon-free): 7 alternates + V01–V10, marquee keyframe amended first, all screenshotted desktop (+390px spots, beam zooms, focus reveal). Loop fixes: per-scene fades (soft mask for list), EQ re-anchored above mask zone, mark-wall 3-row density. Commits `31511543` + fixes. Full suite 415/415 throughout.
- Winnowing (user pick): V01 wins; V02–V10 + dead alternates + marquee CSS deleted; dial/pills cuts recorded as choice, not omission.
- Round 4 (scene language on winning V01): the seven approved concepts built as `scenes.tsx` + `provider-marks.tsx` (`TILE_SCENES` 1:1 with the renamed `TileBgKind` union, pinned by two new `settings-tiles.test.ts` cases); `BentoTile` simplified (V10 `chromeless`/`scene` props removed); dead round-1 CSS cut (`beam-flow`, `list-cycle`, `fade-soft`), duplicate horizon-light block removed, Calendar paper moved under `--provider-cal-paper`; every scene root carries `bento-fade`; scene categories recorded in comments; DESIGN.md §5 (prototypes-venue exception) + §10b (retired keyframes, round-2 loop constants) amended.

## Proof (round 4, `/tmp/bento-ref/`)

- `round4-gallery-desktop.png` — 1280px: Services + Voice heroes span 2 cols, all 7 tiles with badges, constellation/orbit/lanes/spine scenes render, horizon dark diagonal visible.
- `round4-gallery-390.png` — 390px: single column, full-width tiles, CTAs always visible, no horizontal scroll.
- `round4-gallery-hover.png` — desktop hover on Services reveals `Manage services →`; sibling CTAs stay hidden (hover-reveal intact).
- `round4-gallery-focus.png` — 390px keyboard focus on Services shows the focus ring (focus parity intact; CTA always visible below `lg` by design).
- Console: HMR-only; page errors: none. Links announced as `label — description Status: badge` (snapshot-verified).
- `round4-reviewfix-desktop.png` — after review fixes (hover breath restored on all 7 scenes, orbit session chip, horizon row dedupe): composition intact, horizon dark layer intact.
- `round4-gallery-reduced-motion.png` — emulated `prefers-reduced-motion`: frozen frames render the same composition (lanes both visible/response emphasized, orbit dot upper-right, horizon 55/45, pulse parked past seal).

## Review dispositions (two-axis review, fixed applied)

- Fixed: §10b hover breath (`scale-90` → `group-hover:scale-95`) restored on all 7 scene roots; orbit gains the `Voni session · active` chip from its approved concept; horizon light/dark row blocks deduped into one parametrized block (the full `bg-foreground` dark polygon stays — it is the dark half, not dead weight).
- Dismissed with rationale: provider-token exemption ships in-diff because the ticket pre-authorized it (amendment-before-code rule); lanes chat cards ARE the concept's "short fragments"; horizon's two clipped lists read as one continuous interface; spine rail x-position is the timeline anchor (concept's "center-right" is the signal travel direction); frozen ring parks invisible per the amendment's resting frame (overrides the concept's "ring ~60%"); `bgKind` test asserts registry derivation like the existing heroes/`span` test (spec.md's no-internals rule targets landing/route tests); `cal-paper` is a glyph fill under the same exemption; Notion ships monochrome by design (stated in `provider-marks.tsx`) — no other mark failed 20px legibility, so no si fallback was needed.

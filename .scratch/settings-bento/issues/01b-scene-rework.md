# 01b: Scene rework — containment + brand-green signal + 3 scene options per tile

**What to build:** Rework all 7 settings-bento scenes per the grill (rounds 1–3): containment framing, brand-green signal grammar, storytelling flows with recognizable endpoints — with 3 scene options (`A`/`B`/`C`) per tile so per-tile winners can be picked without a follow-up ticket. Same `prototypes/settings-gallery` venue, still deleted in ticket 08.

**Blocked by:** 01 (done — this supersedes its scenes, not its registry).

**Status:** done — final V01 committed (recombination complete)

- [x] Option-A grid: 3 reframes (services, numbers, operator) + 4 reconceives (voice, account, workspace, appearance)
- [x] Option-B grid: same endpoints, vertical-descent grammar
- [x] Option-C grid: same endpoints, seal/typographic grammar
- [x] Gallery presents the final single V01 grid with mock data, keyboard-reachable links, nothing prefetching
- [x] User picks per-tile winners; winners recombined into final V01
- [x] `DESIGN.md` amendment landed for real (01b containment + signal rules, moment-glyph extension, lower-third mask numbers, filler ban); `globals.css` narrow-scope comment extended via `.bento-signal-*` block
- [x] Screenshot proof per grid (desktop + 390px + hover/focus + reduced-motion)
- [x] Typecheck + eslint + full suite green (417/417); manifest check current; §5 + filler greps clean

## User picks (2026-09-20)

- services A, voice A, account C, workspace A, appearance A (placeholder — user liked none; first replate in ticket 09), numbers B, operator A.
- Cross-cutting: scenes reframed to the lower third (mass just above the title; mask rebalanced to transparent bottom 25%); template-filler words banned (`Acme Viewings` → `Main workspace`, `amara@acme.test` → `amara@example.com`, lorem/fixtures swept, rule in Appendix C).
- User verdict: CSS-only scenes hit a quality ceiling — finish the feature tickets, then ticket 09 uses image generation for art direction (endpoint grammar kept, rendering replated).

## Binding decisions (grill rounds 1–3, user-approved)

- **Signal color:** logo-V green (`--color-green-600`, the `.voni-arc-accent` value) via new scoped `.bento-signal-*` classes, following the voice-call narrow-scope precedent. Same value light + dark (logo + voice-call precedent). Never body text.
- **Signal grammar:** green on traveling/moment elements ONLY (packets, ping/pulse rings, orbit dot, conversation point, seal pulse, presence dots). All structure (cards, rails, glyph discs, arcs) stays graphite `--primary`/muted.
- **Framing:** containment replaces 01's bleed rule. Key glyphs never clipped; 16px minimum inset (`p-4` floor on scene content); bleed allowed only for decorative arcs/halos. Meaning still lives in the top 60% (mask eats the bottom).
- **Pattern:** every scene is a storytelling flow with recognizable endpoints (Services proved it).
- **Options axis:** same endpoints across A/B/C; visual grammar differs.
- **Presentation:** 3 full grids stacked (A, then B, then C).
- **Selection:** per-tile mix-and-match into final V01.
- **Loser polish:** one loop + recorded frozen frame; winners get full keyframes + amendment at recombination.

## Correction to Q7 (facts are mine — I was wrong)

Q7 approved an "Ivy voice card with headshot" citing `public/voices/avatars/*.webp`. Those assets do not exist (`public/voices/` holds only `.mp3`s) and `shared-ui.test.ts` asserts `AvatarImage` must NOT appear in the voice picker. The Voice endpoint is therefore the actual `/agents/new` voice idiom: initials disc + name + accent label (+ mini wave bars). Recognizable-identity intent preserved; no photos anywhere (also honors the scene rule against remote images).

## Grammar sketches (endpoints fixed, composition differs)

### Services — endpoints: you → agent → provider glyphs
- **A (reframe constellation):** current layout contained (provider stack `right-4`, user disc `left-4`, fan endpoints inside). Ping ring + halo green; green packet on the you→agent connector.
- **B (descent):** vertical — you top → agent middle → 5 glyphs in a horizontal row bottom. Green packet descends the rail.
- **C (seal):** agent seal centered + breathing green ring; you-chip left; providers as labeled glyph+name chips in a 2-col grid right; short green packets on the links.

### Voice — endpoints: caller request → Ivy voice card → Voni answer
- **A (lanes reconceive):** contained lanes; Ivy card (initials "I", "Ivy · US", mini bars) centered between user bubble and response bubble; green conversation point + traveling packet.
- **B (stack):** vertical — you bubble → Ivy card → Voni bubble on a dashed rail; green packet descends.
- **C (quote):** big request typography → Ivy chip → "Done" stamp; green underline sweep across the voice name.

### Account — endpoints: you-card → live session rows
- **A (sessions reconceive):** you-card (avatar + Amara + email) left; two session rows right (MacBook "active now" w/ green presence, iPhone "2h ago" muted); dashed connector + traveling green dot. Orbit retired.
- **A/B/C note:** B stacks (you top → sessions below, dot settles on active); C centers the identity card w/ pulsing green session-pill dot, device dots flanking.

### Workspace — endpoints: default rows → agent chips carrying them
- **A (spine reconceive):** compact default rows (no stagger-bleed) + left rail with traveling green dot; short dashed links right to 2 agent chips.
- **B (descent):** defaults card top → agent chip row bottom; green dot descends center rail.
- **C (wordmark):** "Acme Viewings" type top → default lines as type rows → agent initials row; green caret travels down the rows.

### Appearance — endpoints: light preview ↔ dark preview
- **A (controls reconceive):** explicit light + dark preview cards side by side (switch, button, slider shapes — not bars); green selector dot travels between them; cards emphasize alternately.
- **B (stack):** light card top, dark card bottom; green selector travels vertically.
- **C (transform):** single card cross-fades light→dark in place; switch knob slides; green flash on the switch at flip.

### Numbers — endpoints: number chip → seal → agent chip
- **A (reframe incoming):** chips inside (`px-4`, no `translate-x` bleed); pulse dot + agent presence dot green; seal graphite.
- **B (descent):** vertical number → seal → agent; pulse descends with seal pause.
- **C (stamp):** giant mono number top → thin route line → agent chip; green pulse with glow; "routed" check stamp appears at completion.

### Operator — endpoints: operator node → Voice/Phone/AI rails
- **A (reframe control):** node `right-4 top-4` un-clipped; arcs pulled in (decorative exception); presence dot green; scanning branch flares green at wave peak (new `bento-scan-flare`, base graphite).
- **B (descent):** operator top-center → three rail rows below; scan descends.
- **C (gauges):** three gauge rows with animated fill + status word; operator seal left; green = live row's fill tip only.

## Motion families

- Reuse: `bento-branch-cycle`, `bento-lane`, `bento-spine-travel`, `bento-node-ping`, `bento-route-pulse`, `bento-horizon-drift` (recolor where the grammar demands; base styles stay the frozen frames).
- New (amendment-before-code, each with frozen base + reduced-motion stop): `bento-descend-pulse` (vertical route pulse, B family), `bento-seal-breathe` (C seals), `bento-underline-sweep` (Voice-C), `bento-crossfade` (Appearance-C), `bento-caret-travel` (Workspace-C), `bento-scan-flare` (Operator-A), `bento-stamp-in` (Numbers-C).
- Green scope: `.bento-signal-*` classes only; the `§5` hex grep gains no new exemption (no hex — `var(--color-green-600)`).

## Progress

- Grill rounds 1–3 complete; plan confirmed; ticket claimed.
- Option A built + verified over 5 screenshot iterations (badge collisions fixed on 5 tiles, mask-relative fade bug fixed in Numbers, dark-preview pulse moved to rings, provider stack overlapped to fit, operator rows compressed).
- Option B built + verified over 2 iterations (badge collisions fixed, provider row spread full-width, Operator-B reworked from hidden branches to gutter-rail + row wave).
- Option C built + verified over 2 iterations (Services-C reworked to totem for 390px; dark-layer geometry force-verified).
- Round-2 overflow "…" disc cut from Services-A (five crisp marks beat six clipped ones); C carries "More" as a labeled chip instead.
- Hover-note (harness artifact, not a bug): headless Chromium reports `(hover: none)`, so Tailwind's hover-gated utilities can't fire in screenshots. CTA reveal is proven via keyboard focus (same classes); live hover needs a headed pass.
- Width fix (pre-pick user request): gallery root now uses the dashboard content container (`mx-auto max-w-6xl p-4 md:p-6 lg:p-8`, same as `(dashboard)/layout`) so tile widths review at production geometry instead of stretching across the viewport. Verified at 1440px (`01b-width-check.png`).

## Proof (all `/tmp/bento-ref/`)

- `01b-a-desktop.png`, `01b-a-bottom.png` — A grid desktop, all 7 contained + green.
- `01b-a-390.png` — 390px single column, CTAs visible, no h-scroll.
- `01b-a-focus.png` — focus reveals `Manage services →`.
- `01b-a-services-zoom.png` — 5 provider marks legible at size-7.
- `01b-a-reduced.png` — frozen frames (packet parked, lanes both visible).
- `01b-b-top.png`, `01b-b-bottom.png` — B grid desktop.
- `01b-c-top.png`, `01b-c-bottom2.png` — C grid desktop.
- `01b-c-390.png` — C at 390px (Services totem fits).
- `01b-c-reduced.png` — C frozen frames (underline drawn, stamp stamped, caret row 1).
- `01b-c-appearance-dark.png` — C dark-layer geometry force-verified.
- `01b-final-top.png`, `01b-final-bottom.png` — final V01 desktop (lower-third reframe).
- `01b-final-390.png` — final V01 at 390px, single column, CTAs visible.
- `01b-final-focus.png` — focus ring + `Configure voice copilot →` CTA reveal.
- `01b-final-reduced.png` — final frozen frames (packet parked, lanes both visible, spine dot at first node).
- `01b-final-operator.png` — operator rows crisp, badge clear, scan flare visible.

## Review dispositions (two-axis review, fixes applied)

- Fixed: `DESIGN.md` stale lead/exception sentences updated to the containment + signal grammar (§1 brand line, §2 green scope, §4 bento lead now glossary-clean "tiles" without `full-bleed`, voice-call exception line); `SceneSet`/`scenes` prop removed (single-set gallery needs no injection); `Beta` fixture renamed to `Palm` (filler ban is total); static halo ring removed from the Ivy card (breathe halo + selection dot + packet carry the green — no always-on ring on structure).
- Dismissed with rationale: stale scene component names (`OrbitScene` etc.) stay — `bgKind` keys are registry-pinned by tests and ticket 02 consumes them, and the gallery is deleted in 08; root-markup duplication stays — per-scene self-containment makes ticket 09 replating a clean swap; workspace dashed links dropped — rows and chips are adjacent with no gap for visible connectors, adjacency reads as the association; pause-offscreen/play-on-hover belongs to ticket 05 (its checkbox, landing cutover); `CONTEXT.md` + ADR-0001 were plan-approved and skill-mandated, not creep; the "unsequenced flare" finding was an agent misread (stagger inherits via shared `animation-delay`, screenshot-verified single-branch flare).
- CORRECTION (commit hygiene): the "DESIGN.md replate" finding was REAL, not a misread — the worktree held another session's uncommitted 491→270-line DESIGN.md rewrite, which I wrongly swept into this ticket's commit. Recovered: `DESIGN.md` restored to the frozen HEAD version with only the 01b amendments re-applied onto §4/§5/§6/§10b (43+/6-); the displaced 270-line draft is preserved at `/tmp/DESIGN-248-uncommitted.md` for its owner. Lesson: `git status` the full worktree before staging, even for "my" files.

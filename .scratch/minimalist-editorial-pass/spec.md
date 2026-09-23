Status: ready-for-agent

## Problem Statement

I open Voni and every area looks like a different app: the landing hero, auth frames, dashboard stat tiles, agent wizard, campaign forms, leads and calls tables, jobs rows, settings Tiles, and copilot shell each carry their own spacing, type scale, borders, and feedback language. I want one calm, editorial, document-style product — generous whitespace, tight-tracking headlines, flat warm-mono surfaces, pastel status only — without losing any behavior I rely on (draft machines, deployment pipelines, durable jobs, voice consent, billing gates).

## Solution

Apply the Premium Utilitarian Minimalism language across the whole app as a markup-and-token translation inside the frozen Blocks-anchored design system: keep every state machine, query, handler, and job semantic byte-identical, restyle every surface to one shared composition (macro-whitespace rhythm, constrained type measure, token-only warm monochrome, flat bento Tiles with contained Scenes, badge status, border-separated accordions, physical keys). The single approved design-system amendment is one bundled editorial serif for hero headings and quotes; everything else maps to existing tokens, pinned blocks, and build-in-style compositions. Ship big-bang in one pass, gated by the running-app route check plus enforcement greps plus existing contract tests.

## User Stories

1. As a first-time visitor, I want a calm landing hero with tight-tracking headline and plain-language subcopy, so that I understand Voni is an AI employee with a mission without hype copy.
2. As a first-time visitor, I want the live-demo widget visually integrated into the hero composition, so that trying voice does not feel like a bolted-on embed.
3. As a first-time visitor, I want a feature Tile grid with generous padding and crisp borders, so that capabilities scan like a document not a carnival.
4. As a signing-in user, I want auth screens with the same type, spacing, and footer language as the rest of the app, so that login feels like entering the product.
5. As a dashboard user, I want outcome totals as flat stat Tiles with honest drill-down links, so that numbers I see match the lists they open.
6. As a dashboard user, I want first-run setup as text-focused steps with a shared step indicator, so that progress reads without decorative icon noise.
7. As an agents-list user, I want agent rows from the shared grid-list and table idioms, so that agents, leads, calls, and campaigns all read as one table language.
8. As an agent creator, I want the multi-step wizard with onboarding steps and side-label form sections, so that creation feels guided but calm.
9. As an agent creator, I want voice choice as card interiors with deterministic motif avatars, so that selection is visual without photo assets or gendered text.
10. As an agent creator, I want tag editing from the badge plus input-group idiom, so that tags match filter-chip language elsewhere.
11. As an agent owner, I want the deploy pipeline header with one progress meter per step plus a collapsed logs overview, so that deployment failures never hide inside a collapsed panel.
12. As an agent owner, I want the status timeline capped at three entries with explicit draft, queued, deploying, ready, failed, and cancelled text, so that history is truthful and short.
13. As a campaign owner, I want the campaign form density (base-height controls, width caps, stacked heading plus description plus fields, footer outside the filled body), so that every form in the app converges on one rhythm.
14. As a form user, I want paired actions ordered secondary-left and primary-right on desktop and primary-on-top when stacked, so that destructive and primary choices are predictable everywhere.
15. As a leads user, I want filter chips and a bulk-action bar from the badge plus toggle-group idiom, so that filtering matches the calls and jobs toolbars.
16. As a calls user, I want paged, filterable call rows with stage and outcome badges, so that call triage matches lead triage.
17. As a numbers user, I want number rows with per-item pending states, so that provisioning feedback never blocks the whole list.
18. As a jobs watcher, I want job rows plus header pill from the table plus progress idiom with durable-job semantics intact, so that slow work stays a job with result destination and retry path.
19. As a jobs watcher, I want a transient self-clearing acknowledgment when active work drains to zero, so that completion is noticed without sticking to the viewport.
20. As a settings user, I want the settings landing as bento Tiles with contained Scenes dissolving into bottom-anchored titles, so that each destination previews itself without cropped key glyphs.
21. As a settings user, I want one live status badge floating top-right per Tile, so that state reads without disturbing the bottom content silhouette.
22. As a settings user, I want section pages with the same form density and intent-prefetch Tile links, so that landing never fetch-avalanches and hover intent prefetches one route shell.
23. As an operator user, I want operator defaults at the operator width with the shared form language, so that admin screens do not invent their own density.
24. As a copilot user, I want the copilot shell in the chat markup idiom with provider logic untouched, so that assistance looks native without risking the voice and jobs tool contracts.
25. As a voice user, I want the voice affordance in the chat voice-input and transcript idiom with the session and mic state machine untouched, so that consent, countdown, and failure states behave exactly as before.
26. As a motion-sensitive user, I want scroll entries as gentle fade-plus-rise with staggered reveals and offscreen Tiles skipping Scene rendering, so that the app feels quiet and stays calm under reduced motion.
27. As a keyboard user, I want Tile call-to-action rows revealed on focus-visible exactly like hover, accordions separated by hairlines with plus and minus toggles, and shortcuts rendered as physical keys, so that pointer-only affordances never gate me.
28. As a dark-theme user, I want the same token-only surfaces with the illustrative appearance preview keeping its light and dark halves fixed, so that theme previews never lie about the other theme.
29. As a mobile user, I want every route verified at narrow width with wrapping footers and full-width prose fields, so that the calm layout survives small screens.
30. As a maintainer, I want zero new visual languages — no new palette, no hard-coded color literals, no arbitrary type sizes, no custom shadows, no new icon or animation dependencies — so that the design-system bans hold after this pass.
31. As a maintainer, I want the editorial serif recorded as an explicit design-system amendment with scope limited to heroes and quotes, so that future type additions follow the same amendment process instead of drifting.
32. As a developer adding a route, I want loading, error, and empty states from the shared skeleton, route-error, and empty idioms with toasts only via the canonical toast primitive, so that feedback stays one language.

## Implementation Decisions

- Blocks-anchored translation, not literal minimalist paste: the frozen design-system file overrules the minimalist protocol wherever they conflict; every minimalist desire maps to an allowed token, a pinned block, or a build-in-style composition, or is cut. The mandate of cut over custom holds for the whole pass.
- Amendment A (approved): one bundled editorial serif for hero headings and quotes only, loaded via the framework font bundler so no third-party fetch is introduced; body, UI, buttons, and metadata stay on the blessed sans and mono. Tight tracking and balanced wrapping carry the editorial feel. Recorded in the design-system file with rationale and scope; no other typeface additions.
- Color mapping: canvas, surface, and hairline borders map to the existing semantic background, card, and border tokens; status and tags map to badge and muted variants plus chart tokens; body and secondary text map to foreground and muted-foreground. No literal color values in product code; the Scene provider-mark fills and the narrowly-scoped live-call and Signal greens remain the only exempted color sites per the existing bento amendment and ADR-0001.
- Iconography stays on the single allowed icon set; the thicker-stroke feel comes from consistent sizing and primitive-owned sizing, with no new icon dependency. Illustrations are monochrome line work with one pastel offset shape; photography is desaturated and warm; hero depth comes from token-tint washes and contained Scenes, never large primary-color fills, gradients, neon, or glass.
- Component grammar: bento Tiles compose card tokens with ring hairlines, large section padding, generous card padding, bottom-anchored content, contained Scenes with bottom-dissolving masks, hover breath plus call-to-action reveal with keyboard parity, always-visible actions below the large breakpoint. Buttons use the default and outline pair with right alignment on desktop and primary-on-top stacking on narrow screens. Tags are pill badges with small uppercase wide-tracked type. Accordions are hairline-separated with plus and minus toggles. Shortcuts render as physical keys in mono.
- Motion grammar: reuse the surviving enter primitives (auth, content, status) plus the shimmer sweep for skeletons and the one-shot success pop for job badges; overlay timing unifies on the shared standard duration; Scene loops keep their documented durations with per-family reduced-motion stops and static base frames; offscreen Tiles skip Scene rendering via the CSS-only viewport containment (no scroll-listener islands, no new looping keyframes without their own reduced-motion stop); animation limited to transform and opacity.
- Logic freeze: session gates, suspense boundaries, draft machines, validation, payloads, idempotency keys, deployment machines, query predicates and pagination clamping, bulk-selection semantics, per-item pending states, durable-job queue with result destination and retry path, voice session and mic ownership state machines with rate-limit countdowns and distinct failure states, copilot provider logic and tool contracts, and billing and auth redirects stay byte-identical; only markup and styling move.
- Form convergence: every form follows the campaign-form density — base-height controls with width caps by field kind (names medium, short selectors small, time and numeric extra-small, prose full width), section stacks of heading plus description plus fields, labels with descriptions and invalid states per the form primitives, sentence-case placeholders without trailing periods, transparent footers outside filled bodies with separator and wrapping.
- Big-bang sequencing: one branch covering landing, auth, shell, dashboard, agents, campaigns, leads, calls, numbers, jobs, settings, operator, copilot, voice, and feedback states together, ordered internally amendment first, then token sweep, then bento plus type plus whitespace, then per-area markup swaps, then gates. Accepted risk is one large diff with guaranteed manifest and catalog test churn; mitigation is frozen logic plus small reviewable commits per area inside the one branch.
- ADR-0001 respected: the scoped brand green stays restricted to traveling and moment elements inside Scenes plus the existing live-call affordances, never structure, chrome, or body text; containment (key glyphs never clipped, fixed inset floor, rebalanced mask stop) replaces any bleed rule.
- Domain vocabulary used throughout: Tile for settings landing cards, Scene for the animated miniature inside a Tile, Signal for the narrow green touch on traveling packets, pulse rings, and moment markers, Scene option for per-Tile alternatives, Grid variant for full-gallery alternatives.

## Testing Decisions

- A good test asserts external behavior, not implementation details: routes render the intended composition without console or compile errors; navigation lands on the intended destination; predicates behind cards match the lists they link to; pending, failure, retry, and empty states are distinguishable; reduced motion squashes loops to static base frames; focus reveals what hover reveals. Source-text pattern checks are acceptable only as regression pins for banned-style reintroduction, mirroring existing prior art.
- Modules under test: per-route compositions (landing, auth, dashboard, agents list plus wizard plus detail pipeline, campaigns, leads, calls, numbers, jobs, settings landing plus section pages, operator, copilot shell, voice affordance); feedback states (loading skeletons, route errors, empties, toasts); design-system coherence (no banned styles outside listed exceptions).
- Prior art to extend: the running-app browser loop (dev server plus framework diagnostics plus browser snapshot, console, tree, and boundary inspection, desktop plus narrow viewport, forced loading and error states) as the primary gate; the enforcement-grep suite (arbitrary type and background values, hard-coded palette, bespoke dark sites, inline style objects, spaced stacks, non-square icon sizes, child-composition props, toast-library references, template-filler words, control-geometry overrides) as the coherence pin; the existing contract-test corpus (copilot manifest check, element catalog, UI actuation, settings motion plus badges plus routes plus prefetch, calls pagination plus filter chips plus index, leads filters plus bulk plus stage cells, agent status entries, wizard suites, jobs suites, voice suites) as the regression pin.
- Proposed test seams (highest first, existing preferred — confirmed by user): (1) running-app route seam as the primary external-behavior gate; (2) enforcement-grep seam as the coherence gate; (3) existing contract-test modules as regression pins. Ideal seam count is one (the running app); seams two and three exist only to prevent silent reintroduction of banned styles or broken tool contracts.

## Out of Scope

- Any behavior change to jobs execution, dispatch, voice pipeline, auth, billing, Copilot tool contracts, query predicates, or deployment state machines beyond markup restyling.
- New routes, new nav destinations, information-architecture reshuffles, or command-menu ranking changes.
- Multi-workspace switching, team management, invitations, or permissions-model changes.
- New chart libraries, new icon libraries, new animation or toast dependencies, new AI SDK additions, or any new global color or motion token.
- Production theming migration, licensed font redistribution beyond the bundled subset, short-viewport refinements beyond the verification matrix, or telemetry changes.
- Silent behavior patching on failure: any behavior change must surface via the unified error presentation and test evidence.

## Further Notes

- This pass follows the settings-bento landing track as its visual proof: Tile structure, contained Scenes, Signal grammar, intent prefetch, and motion gating graduate from that track to the full app rather than being reinvented per route.
- The editorial-serif amendment is the only design-system amendment in scope; any further deviation discovered mid-pass (missing block, new token need) requires its own amendment row with rationale before landing, per the design-system amendment process — no drive-by divergence.
- Verification merges only when all gates pass: runtime loop per route, production plus preview builds, typecheck, lint, full test suite with regenerated manifest and updated UI-coupled tests, coherence greps clean except listed exceptions, and accessibility and motion review.

## Comments

- Seams confirmed by user before spec publication: running-app route seam primary; enforcement greps plus existing contract tests as pins.
- User decisions recorded: amend for editorial serif; big-bang all routes in one pass.

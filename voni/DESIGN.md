# Voni DESIGN.md — Blocks-anchored source of truth

> Status: FROZEN 2026-09-13. This file overrules prior taste, including
> `docs/shadcn-audit.md` exceptions (all retired — see Appendix B).
> Change only by explicit amendment (see §1).

## 1. Mandate

- **Blocks-anchored, not literal Blocks-only.** Blocks
  ([ephraimduncan/blocks](https://github.com/ephraimduncan/blocks),
  [blocks.so](https://blocks.so/)) is a snippet collection, not a system:
  80 blocks in 13 groups, no token package, no versioned updates, no
  governance. Blocks block compositions are the canonical patterns for
  every screen; the host shadcn `base-nova` / `neutral` + Tailwind v4 layer
  stays underneath. The result must *look* like Blocks throughout.
- **Cut > custom, always.** Where no block exists, either compose from
  allowed tokens + allowed primitives in Blocks style (`build-in-style`),
  or cut the element. Never invent a third visual language.
- **Amendment process:** any deviation needs a DESIGN.md amendment —
  gap-table row, new pinned block ID, or new exception — recorded in this
  file with rationale. No drive-by divergence.
- **License retention:** Blocks is MIT ©2025 Ephraim Duncan. When
  vendoring blocks, include the copyright + permission notice in a
  `THIRD-PARTY-NOTICES` file. Do not redistribute the repo's
  commercial-looking Berkeley Mono font files.

## 2. Tokens

"Blocks blocks + Tailwind/shadcn base" — stated explicitly, no pretending
a Blocks token system exists.

- **Color:** oklch semantic vars already in `globals.css`
  (`background/foreground/card/popover/primary/secondary/muted/accent/
  destructive/border/input/ring/chart-1…5/sidebar-*`). No new palette.
  `--brand` green is REMOVED as a global token; the live-call affordance
  is re-derived in §4 under the voice exception with a narrow scope.
- **Type:** Geist / Geist Mono stay (blessed — Blocks mandates no typeface;
  `next/font` bundles at build, no Cloudflare blocker). `--font-heading`
  = sans alias stays. Scale is Tailwind defaults only: `text-xs`/`text-sm`
  for UI; the `text-[11px]`/`text-[13px]` micro-type split is banned
  (~35 hits → map to scale).
- **Spacing:** Tailwind defaults only. No custom scale.
- **Radius:** adopt Blocks `--radius: 0.625rem` (currently `0.5rem`) with
  the same `sm–4xl` derivation. One-line change, whole-app effect.
- **Shadow:** shadcn/Tailwind defaults. No custom shadows.
- **Motion:** bespoke motion system CULLED — deleted in group 6:
  `voni-voice-*`, `copilot-bars-live`, `voni-livedot`, `field-flash`,
  `wizard-pulse`/`wizard-active-dot`, `interactive-card` lift,
  `list-enter`, `--brand`-coupled arc accent. SURVIVING listed
  exceptions (amendment 2026-09-13 — each still referenced by live
  code; deleting any breaks rendering): `voni-chip-in` + `voni-arc-morph`
  + `voni-arc-fade` + `.voni-arc` (logo mark animation; accent stroke
  re-pointed to `var(--color-green-600)`), `auth-enter` + `content-enter`
  (+ `.status-enter` alias), dashboard view-transitions
  (`dashboard-content` + `dashboard-out`/`dashboard-in`). `--motion-*` /
  `--ease-*` tokens stay while the survivors consume them. Future work
  may cull the survivors with their consumers; until then they are
  allowed. `prefers-reduced-motion` guard stays. `sidebar-02`'s
  `framer-motion` dep is REJECTED — do not adopt it; sidebar motion
  uses the token system.
- **Dark mode:** class-based + `next-themes` (as today). `dark:` utilities
  inside generated `ui/` primitives stay; the bespoke `dark:` sites
  (`connection-test-button` emerald, `bubble`, mode-toggle mechanics —
  logo hex retired 2026-09-16) are fixed per §5.

## 3. Components (pinned allow-list)

Install via `npx shadcn add @blocks-so/<id>` (alias already in
`components.json`). Record installed IDs + commit hashes here on install
(amendment). Pulled shadcn primitives must stay Base UI variants.

| Area | Pinned blocks | Pulled deps to accept |
|---|---|---|
| Auth | `login-01`, `login-07` | button/input/label/separator (+0 npm) |
| Dashboard | `dashboard-01` (hand-port, NEVER direct — its `registry:page` targets `app/page.tsx`), `stats-01…15` as needed | recharts + date-fns for dashboard-01 only |
| Tables | `table-05` (paged+selectable base), `table-02` (row actions), `table-03` (filters), `table-04` (grouped rows) | @tanstack/react-table + badge/button/checkbox/dropdown-menu/input/select/table |
| Lists | `grid-list-01…03` | — |
| Agent wizard | `dialog-11` (multi-step), `onboarding-01…04` (steps/progress), `form-layout-*` sections | — |
| Agent timeline | `onboarding-07` (collapsible pipeline wrapper) + `onboarding-06` (timeline; needs @tabler/icons-react → SWAP to lucide) | lucide only |
| Forms | `form-layout-02` (side labels), `form-layout-03` (checkbox settings) | — |
| Dialogs/menus/upload | `dialog-01…12`, `command-menu-01…03`, `file-upload-01…06` as needed | `cmdk` only for command-menu-03; per-item audit otherwise |
| Copilot shell | `chat-03`, `ai-05` (markup idiom only; 1094-line provider logic untouched) | NO `ai`-SDK addition without amendment |
| Voice affordance | `ai-01` (chat voice input), `chat-01` (voice transcript layout; no text composer); telephony card itself is the §4 exception | @shadcn/react already present |
| Shell | `sidebar-02` or `-03` idiom (restyle current shell; NO framer-motion) | — |

**Banned:** everything not listed. Notably: no new chart libs beyond
dashboard-01's recharts; no `framer-motion`; no `@tabler/icons-react`
(swap to lucide); no `sonner` (canonical toast is Base UI — see §4);
no `ai`-SDK additions without amendment; `cmdk` is allowed only for the
installed command-menu-03 adaptation.

Installed 2026-09-14: `command-menu-03` at upstream commit `f9b89ceb4979d35209705f8029877b60d6c70bc5`, `onboarding-01` at `5377a1ce792a169336c87f99a438a273867b6815`, and `chat-01` at `8f6f90c5b077628d2f4d3e41faa31cb8b608fe0b`. Registry demo data and Tabler icons were removed; Voni behavior, Lucide icons, and Base UI composition replace them.

Installed 2026-09-14: `onboarding-07` ("Onboarding Deploy Pipeline") — progress meters on top (three side-by-side `Progress` meters for created / saved version / deployment, restored from upstream), with a single `AccordionItem` "Logs overview (N)" logs item below it, collapsed by default. Deployment errors surface on the always-visible meter row plus an inline error line, so failures never hide inside the collapsed panel. Upstream demo animation data, rerun button, centered wrapper, and Tabler icons NOT adopted; Base UI Accordion + Progress primitives + Lucide + live job-driven entries replace them.

Installed 2026-09-14: `grid-list-02` — avatar + name + secondary-line card
(`Card` surface, `CardContent flex items-center gap-4 p-4`, `Avatar size-10`).
Remote avatar PNGs cut (initials fallback only); documenso sample people
replaced with neutral placeholders; `space-x-4` rebuilt as flex+gap. Pinned
2026-09-15 as the voice-card interior for the agent-creation carousel (visual
composition only — the `ToggleGroupItem` toggle stays the control, no
stretched-link `<a>`; the avatar slot is a deterministic CSS-only motif
(`VoiceMotif`, hash(voiceId) → muted/accent gradient + blurred blob pair,
oklch semantic tokens only), identical for every voice.

Installed 2026-09-15: `ai-05` — markup idiom only (copilot-shell composition
reference; 1094-line provider logic untouched), pinned at upstream commit
`54f6cbfa2c91a4377c980d9b0ac787d6ce5750a0` (feat(ai): redesign the ai-05 chat
block (#79), 2026-09-03). No `ai`-SDK addition without amendment.

Installed 2026-09-15: `sidebar-03` — full-block adoption for the app shell
(`src/components/sidebar-03/`: brand slot, main navigation with collapsible
subs, single-workspace team switcher; notifications bell reads jobs plus
recent calls from live sources, never sample data; demo `index.tsx` scaffold
NOT adopted). Manually vendored from the registry JSON (the registry carries
no commit hash, so none is pinned — the CLI install was rejected because it
would overwrite 10 shared `ui/` primitives) — shared primitives untouched, no
`framer-motion` added, no `cn` dep added. Row hover/active states use the
existing `sidebar-accent` token (the theme carries no `sidebar-muted`);
vendored-block `§5`-grep exclusion covers `src/components/sidebar-03/`.
Brand slot renders the animated Classic `BrandLogo` (amendment 2026-09-16,
user pick from the `/logo-mockups` review — concept 01, homepage loop
verbatim): expanded density loops the tight wordmark (`VoniMark animate`,
cropped viewBox, hairline gap); collapsed density holds the static chip with
one-shot `voni-chip-in`, no loop. Theme via `currentColor` + tokens — the
placeholder four-asset set (`public/brand/`, deleted with this amendment) and
its class-strategy swap are retired, along with the `next/image` dependency
in the slot and two bespoke `dark:` sites (§5). Motion stays in the §2
survivor set: no new keyframes, no `framer-motion`. The slot keeps the
upstream `h-8` height; footer stacks the single-workspace switcher above
the existing account menu; jobs count badge and active-link Suspense boundary
preserved. `sidebar-02`'s `framer-motion` rejection (§2) extends to this block.
Top bar removed 2026-09-15: search, voice entry, and jobs status live in the
rail as collapsing rows; the voice panel anchors to the viewport corner;
pages own their titles (no new title components — every page already
rendered its own `h1`); the section-title constant moved beside the nav
source with the manifest generator following it.
Header bell removed 2026-09-16 (user pick): sidebar-03 header carries brand
lockup + collapse trigger only; jobs status lives solely in the utility-group
row (NAV_ITEMS keeps /jobs for command-menu + copilot manifest, nav list
filters it, utility click marks seen). Collapse trigger matches the rail-icon
contract: 32px box, accent hover, always-shown tooltip, state-announcing
label (Collapse/Expand sidebar + ⌘B) with aria-expanded.

## 4. Patterns (one canonical composition per area)

- **Auth** (`/login`, `/signup`): `login-01`/`login-07` idiom around the
  existing Better Auth Google-only logic (session-decision leaves stay).
- **Landing** (`/`): minimal composed entry — hero + demo + feature grid
  restyled from stats/grid/form idiom. Session-gate + Suspense +
  demo-mode voice wiring stay.
- **Shell:** sidebar-02/-03 idiom; preserve Suspense resolver, static
  shell, sidebar cookie. `JobPill`/`JobRow` keep durable-job semantics,
  restyled from table-05 rows + stats-11 progress idiom.
- **Tables** (leads/calls/campaigns + details): table-05 base;
  pagination from table-05; stage/outcome cells from table-02/03 status
  badges; **filter chips + bulk-action bar** are `build-in-style`
  compositions (badge + toggle-group idiom; bar on table-05 selection) —
  no chip block exists.
- **Agents:** list from grid-list/table-02 idiom; `agents/new` wizard from
  dialog-11 + onboarding steps + form-layout (draft machine,
  validation, payloads, idempotency, copilot tools byte-identical);
  **tag field** is `build-in-style` (badge + input-group idiom).
- **Settings/operator/numbers:** form-layout-02/03; numbers list from
  table-05 or grid-list-02.
- **Form reference: campaign/new density** (amendment 2026-09-14,
  supersedes the same-day `CONTROL` blessing): every form converges on the
  `campaign-form.tsx` composition — base `h-8` controls from `ui/` with width
  caps only (no per-form `CONTROL` geometry overrides), `FormCard` >
  `FormCardSections` bodies (16px mobile / 24px desktop padding), sections as
  stacked heading + description + fields at `gap-3`, then the page footer in
  normal document flow outside any filled body. Fields compose with
  `FieldGroup` + `Field` + labels/descriptions + `data-invalid` /
  `aria-invalid` per Base UI. Width caps only: names/roles `max-w-md`, short
  selectors `max-w-xs`, time/numeric `max-w-40`, prose full width.
  `grep -rn 'CONTROL' src/components/` must be empty.
- **Transparent footers** (amendment 2026-09-14): page-form footers sit
  outside filled bodies with a separator and consistent spacing
  (`Separator` + `pt-4`, secondary-left / primary-right, wrapping on narrow
  screens). The new-agent footer is no longer wrapped in its own filled
  card. Dialog footers carry no contrasting fill (`DialogFooter` is
  border-top only; the dialog surface itself stays opaque). Data-card
  footers (dashboard stat cards) are excluded from this rule.
- **Paired-action order + right alignment** (amendment 2026-09-15):
  every paired action row follows secondary-left / primary-right on
  desktop, not just footers — draft gate, alert rows, retry cards,
  copilot proposal cards, dialog footers. Primary = `variant="default"`
  (or `destructive` for destructive confirms); secondary = `outline`;
  `ghost` is tertiary/borderless and never the boxed pair of a primary.
  Form action rows align right on desktop (`sm:justify-end`, matching
  Blocks `dialog-11` abort/confirm bar and `form-layout-*` `justify-end`);
  stacked rows use `flex-col-reverse` so the primary stays on top on
  mobile (matching `DialogFooter`'s `flex-col-reverse sm:flex-row
  sm:justify-end`). Inline `flex-wrap` rows keep DOM order = visual
  order.
- **Form widths** (amendment 2026-09-14): shells — agent
  creation/review/details + campaign form `max-w-3xl`;
  workspace/copilot settings + number entry + CSV import `max-w-xl`;
  operator defaults `max-w-2xl`; auth screens + simple confirmation dialogs
  `max-w-sm`. Controls — names/roles/email/model/connection/voice IDs
  `max-w-md`; phone/language/timezone/short selectors `max-w-xs`;
  time/numeric `max-w-40`; prose/knowledge/instructions/tag editors full
  form width. All widths stay responsive; labels/help/errors align with
  their controls; embedded forms constrain themselves without narrowing
  surrounding tables or operational pages.
- **Agent status timeline** (amendment 2026-09-14, collapsed 2026-09-14):
  `agents/[id]` renders an `onboarding-07` deploy pipeline — an
  always-visible header with one progress meter per step (created /
  latest saved configuration version / current deployment status) plus an
  inline error line when deployment failed or was cancelled, and beneath
  the meters a single collapsed `AccordionItem` "Logs overview (N)" that
  expands to reveal the `onboarding-06` vertical "Agent status" timeline — at most three
  entries (creation, latest saved configuration version, current deployment
  status) with explicit text for draft/queued/deploying/ready/failed/
  cancelled. The logs trigger shows "Logs overview (N)" plus the latest
  entry title; the entry
  type carries `error`/`neutral` states and optional timestamps;
  unavailable timestamps are omitted, never invented. The old horizontal
  step strip (step array/index, percentage state, progress bar) is deleted.
  Deployment tracking, retries, duplicate protection, generation safeguards,
  save/test gating, notifications, and global Jobs access are unchanged.
- **UI polish amendment (2026-09-15):** (a) dashboard `onboarding-01` drops
  the per-step decorative icons (`Bot`/`Upload`/`CirclePlay`) — rows are
  text-focused, status reads from the shared `StepIndicator`
  (filled primary `Check` vs muted `CircleDashed`) + header progress count;
  body indent retargeted `pl-16` → `pl-12`. (b) agent-creation voice cards
  adopt the `grid-list-02` card interior (surface, `CardContent` row,
  `size-10` avatar) inside the existing Embla carousel — interaction
  byte-identical, toggle stays the control (no stretched-link), visible
  feminine/masculine text replaced by deterministic CSS-only motif avatars
  (amendment 2026-09-15: `VoiceMotif` in `voice-field.tsx` — hash(voiceId)
  → oklch semantic-token gradient + blurred blob pair, `AvatarFallback`
  only, no image assets; uniform across all voices, so the prior 15
  `public/voices/avatars/*.webp` headshots and the `jean` initials-only
  special-case are retired), gender survives sr-only in the card `aria-label`.
  (c) form controls converge on one token set: `h-8` + `rounded-lg` +
  `border-input`, `text-base md:text-sm` on every input-like control
  (select trigger + tag composer included), focus-only
  `border-ring + ring-3 ring-ring/50`, disabled bg+opacity parity,
  `FieldError text-sm` with no usage-site overrides, select full-width by
  default with form-level `max-w-*` caps, checkbox `rounded-sm`, switch
  `h-4.5 w-8` / `h-3.5 w-6`; documented usage-site exceptions only:
  `phone-numbers min-h-11` touch target, tag box `min-h-9`, textarea
  auto-grow. Placeholders: sentence case, no trailing period. (d) theme
  default stays `system` (`layout.tsx` already) + one-time
  `voni-theme-migrated-v1` client migration clearing legacy stored
  light/dark so every profile follows the OS until an explicit override.
- **Voice exception (narrow):** `voice-call.tsx` session/mic state
  machine, 429 countdown, and distinct failure states stay; all styling
  goes Blocks idiom. The inline test uses chat-01's conversation layout
  inside a full-screen Base UI dialog. One re-derived call green, scoped to live-call
  affordances plus the §10b bento signal scope (packets, pulse rings,
  presence dots, moment glyphs) — never a general token. Everything slow stays a
  durable job + JobCenter (async protocol §8).
- **Feedback:** loading.tsx boundaries stay, skeleton markup rewritten
  in-style (no skeleton block exists — retires the skeleton split);
  RouteError restyled in-style (failures incl. 429 countdown kept);
  empty states composed from the Empty idiom (retires the Card-vs-Empty
  split); toasts via Base UI `toast.add` (retires the sonner drift —
  also fix the `sonner` mention in `voni/AGENTS.md` outside the managed
  markers).

## 5. Banned styles + enforcement greps

Run from `voni/`. Every hit must map to a token, be rebuilt in-style,
or be cut — or be a DESIGN.md-listed exception.

- `text-[` / `bg-[` arbitrary values (~35 + ~9 hits) → map to scale/tokens.
  `grep -rn 'text-\[\|bg-\[' src | grep -v 'src/components/ui/'`
- Hardcoded palette: `emerald|amber|#[0-9a-fA-F]{3,6}` outside comments
  (~20 hits; prototypes carry 12) → map to tokens; prototypes CUT with
  their CSS. `grep -rniE 'emerald|amber|#[0-9a-f]{3,6}\b' src | grep -v 'provider-'`
  (the `--provider-*` scene-glyph exception in §10b is the only exemption).
- `dark:` outside `src/components/ui/` generated code (3 remaining bespoke
  sites: connection emerald, bubble, mode-toggle mechanics — logo hex retired
  2026-09-16 with the animated Classic slot) → fix.
  `grep -rn 'dark:' src | grep -v 'src/components/ui/'`
- `style={{` (6 sites: voice-call avatar px → exception restyle;
  voice-avatar `hsl()` hash gradient → rebuild in-style;
  toggle-group `--gap`, layout `--sidebar-width-icon` → re-home to
  tokens). `grep -rn 'style={{' src`
- `space-x-|space-y-` (must be zero; use flex+gap). `grep -rn 'space-[xy]-' src`
- Non-`size-*` icon squares. `grep -rn 'h-[0-9].*w-\[0-9\]' src`
- Extra CSS files / keyframes: only `globals.css` survives; prototype
  CSS deleted with the routes. `ls src/app/prototypes` must 404-think → empty
  (exception: the ticket-01 `settings-gallery` throwaway lives under
  `prototypes/` until ticket 08 deletes it — the manifest generator already
  excludes that path, so voice files see zero churn).
- `cn` imports unify to `@/lib/utils` (remove `from "cn"` specifiers).
  `grep -rn 'from "cn"' src`
  (DONE 2026-09-13 — 13 ui/ files unified. The `"cn"` npm dep remains
  installed; remove it when no specifier references it.)
- Vendored Blocks files live under `src/components/<block-id>/` (NOT
  `src/components/ui/` — the CLI's default `ui/` overwrites are rejected;
  see foundation notes). Ban greps exclude them:
  `grep -rn 'text-\[' src --exclude-dir=node_modules | grep -v 'src/components/ui/' | grep -v 'src/components/table-05'`
  (same exclusion pattern for the other greps; table-05 is the first
  reference vendoring, more block dirs follow).
- `sonner` references must be zero (Base UI toast is canonical).
  `grep -rni 'sonner' src package.json`
- `asChild` must be zero (`render=` everywhere). `grep -rn 'asChild' src`
- Template-filler words (Acme/lorem-ipsum-class placeholders, fake-brand
  names) must be zero in user-visible design and copy; mock data uses
  functional labels (`Main workspace`) or RFC-reserved domains
  (`example.com`). Fixtures must read as plausible product data.
  `grep -rni 'acme\|lorem\|john doe\|foo bar' src scripts`
- `data-copilot-*` instrumentation: allowed to remain (functional), but
  new bespoke data-attribute styling is banned.

## 6. Gap dispositions

| Element | Disposition | Rationale |
|---|---|---|
| Dashboard stat tiles | blocks-has | stats-01…15 directly |
| Dashboard revenue/area charts | blocks-has | dashboard-01 + stats-10 |
| Extended charting beyond those | cut | No Charts group; cut > custom |
| Base data tables + pagination + stage/outcome cells | blocks-has | table-05/02/03/04 |
| Filter chips / bulk-action bar | build-in-style | No chip/bulk blocks; badge+toggle-group / table-05-selection idioms |
| Agents list / new wizard / detail timeline / voice-preview pairing | blocks-has | grid-list, dialog-11+onboarding+form-layout, onboarding-05/06, chat-01 |
| Agent tag field | build-in-style | No tag-input block |
| voice-call card | build-in-style (bound exception) | No telephony block; logic stays, styling goes Blocks |
| Jobs rows / header pill | blocks-has / build-in-style | table-05+stats-11 / badge+progress idiom, semantics kept |
| Copilot shell | blocks-has (markup idiom) | chat-03/ai-05; provider logic untouched |
| Login/signup | blocks-has | login-01/07; Better Auth logic untouched |
| Settings/operator/numbers | blocks-has | form-layout-02/03; table-05/grid-list-02 |
| Settings in-page nav (Variant D, 2026-09-16; cut over 2026-09-20, ticket 02) | build-in-style | No settings-nav block exists. Variant D served until the ticket-02 cutover, which retired the Tabs state machine outright: sections are `/settings/<tab>` routes from static params, the `ui_settings_tab` tap contract became route navigation, and the throwaway gallery's scenes graduated to `components/settings-bento/`. Only the `SETTINGS_TABS` value source survives. |
| Skeletons / RouteError / empty states / toasts | build-in-style | No blocks; boundaries+semantics kept, markup rewritten |
| Shell sidebar+header / dialogs / command menu / file upload | blocks-has | sidebar-02/03, dialog-01…12, command-menu, file-upload |
| Landing `/` | build-in-style | No marketing group; minimal composed entry |
| `/prototypes/*` + strategy.module.css + prototype.css | cut | Dev-only, light-only; delete page+content+CSS together |
| Settings bento landing (amendment 2026-09-16, landing track) | build-in-style | No bento block exists; faithful Magic UI bento-grid structure (tall 22rem rows, full-bleed masked scenes, bottom-anchored name/description with no icon — the scene carries the meaning, hover-reveal CTA) rebuilt from Card tokens + lucide + CSS-only scenes. Variant D row idiom stood production until the ticket-02 cutover (see the Settings in-page nav row); the throwaway gallery that proves the language lives under `prototypes/` and dies in ticket 08. Containment reframe 2026-09-20 (ticket 01b): scenes are contained with a 16px inset floor (key glyphs never clipped; only decorative arcs may bleed) and the mask rebalanced to a 25% stop — see §10b |

## 7. Composition rules

Base UI `render={<…/>}`, never `asChild`, never mixed per file.
`nativeButton={false}` where a Button renders an anchor.
Select/DropdownMenu items inside groups. Forms use FieldGroup+Field.
Stacks use flex+gap. `size-*` for squares. `cn()` conditionals.
Lucide icons, no sizing classes beyond the primitive's own.

## 8. Async / feedback protocols (preserved from AGENTS.md — restyle surfaces, keep state machines)

Durable jobs in `src/lib/jobs/` + JobCenter with result destination,
retry path, sanitized failure; creator-scoped visibility.
`LoadingButton` pending pattern; per-item `pendingId`; `loading.tsx`
skeletons + `RouteError`; distinct failure messages (rate-limited with
`retryAfterSeconds` countdown, mic error, dropped connection, hang-up).
Live calls stay foreground; everything slow is a job.

## 9. Verification gates (Phase 4 definition of done)

1. `next-dev-loop` runtime check per route (desktop + 390px), incl.
   forced loading/error states; zero compile/runtime errors.
2. `next build` + Cloudflare preview build + `tsc` + `eslint` +
   `npm test` (regenerate copilot manifest; update UI-coupled
   element-catalog/ui-actuation tests — rebuild breaks them by design).
3. Coherence audit: §5 greps clean except listed exceptions; one
   canonical composition per area; retired exceptions absent.
4. A11y/motion: reduced-motion squashes loops; focus from tokens;
   live-call affordances distinct.
5. Merge `redesign/blocks-only` → `main` only when all gates pass.

## 10. Delight pass amendment (2026-09-14)

Tasteful-and-restrained, Operate-mode delight. Every addition below reuses
the `--motion-*` / `--ease-*` tokens, token-only color
(`color-mix(in oklch, …)` over `bg-muted` — no hex, no new palette), and
the existing `prefers-reduced-motion` squash; each new *looping* keyframe
gets its own `animation: none` line in that media query with a static
fallback, since the blanket 1ms override reads as flicker on infinite
loops. One-shot enters are covered by the squash alone.

- **New keyframes (allowed):** `voni-shimmer` — translucent sweep across
  `Skeleton` (loading reads as "content incoming", base stays `bg-muted`
  so reduced-motion/no-JS still reads fine); `voni-done-pop` — one-shot
  scale 0.96→1 + fade on a job row's success badge when it transitions to
  terminal while mounted. Bulk-bar arrival reuses the existing
  `.status-enter` (`content-enter`); no new keyframe.
- **Overlay timing unification:** `dialog` / `select` / `dropdown-menu`
  move `duration-100` → `duration-[var(--motion-standard)]` (180ms, one
  shared enter language). `sheet`, toast transitions, and all §2 survivors
  untouched.
- **Transient job-completion beat:** when `activeCount` drops to zero from
  nonzero, `JobPill` may render a time-bound (~4s), self-clearing
  "All caught up — results are in Jobs" pill (link to `/jobs`,
  `aria-live="polite"`, manual close; never for optimistic-only states).
  This is an acknowledgment, not a resting state — "nothing finished
  sticks to the viewport" still holds. Toast-once + "Needs review"
  destination unchanged.
- **Celebrating mascot surfaces (max two):** `mood="celebrating"` only
  where the product already marks a milestone a human would call "done"
  (agent deployment `ready`, first CSV import completing). Moods stay
  static icon swaps; `VoiceBars` / `VoiceAvatar` / `voice-call.tsx` stay
  motion-free. If a surface can't justify itself in review, cut it —
  toasts + inline confirmations already satisfy the house protocol.
- **Empty-state `feature` variant:** additive `EmptyMedia` variant
  (`size-12 rounded-2xl bg-muted` icon disc) for first-run empties;
  filtered-result empties keep the compact `icon` variant. `Empty*` API
  unchanged.

## 10b. Bento amendment (2026-09-16, landing track)

Faithful-structure bento tiles for the settings landing, proven in the
throwaway gallery before cutover. Everything below reuses the `--motion-*` /
`--ease-*` tokens and token-only color; each looping keyframe gets its own
`animation: none` line in the `prefers-reduced-motion` block with the base
styles as the static frame.

- **Layout:** `.bento-grid-rows` (`grid-auto-rows: 22rem`, mirroring the
  reference rhythm — the single dimensional mirror, documented here instead
  of arbitrary values at usage sites). Tiles compose `rounded-xl bg-card`
  + `ring-1 ring-foreground/10` (Card tokens, plain div — the reference
  content pads itself, so the `Card` primitive's spacing fights it).
  Content is bottom-anchored (`justify-between` + `mt-auto`); scenes are
  contained, never bled — key glyphs fully inside a 16px inset floor, only
  decorative arcs/halos may bleed (containment reframe 2026-09-20, ticket
  01b — the round-2 "oversized, cropped top/right" rule is retired).
- **Mask fades:** `.bento-fade` (25% stop, rebalanced 2026-09-20 for the
  lower-third composition: scene mass sits just above the bottom-anchored
  title and dissolves into it) replaces the reference
  `[mask-image:...]` arbitrary properties; every scene root carries it so the
  mask eats the bottom into the content.
- **New keyframes (allowed):** `bento-node-ping` — one breath per cycle on
  the constellation agent node (invisible base is the resting frame).
  Round-1 families (`bento-beam-flow`, `bento-list-cycle`, `bento-marquee`)
  retired with deleted variants V02 and round 1.
  Scene round 2 (approved concepts) adds: `bento-branch-cycle` — shared
  6s sequential-emphasis wave for the constellation fan (1.2s apart) and
  the control-plane scan (2s apart); `bento-lane` — 3s duplex alternation
  (response lane delayed 1.5s); `bento-orbit` — 24s ±30° sweep with return;
  `bento-spine-travel` + `bento-spine-node` — 4s shared-timeline rail signal
  and node windows; `bento-horizon-drift` — 14s ±4% alternate;
  `bento-route-pulse` — 5s number→seal pause→agent travel in element
  percentages (base parks just past the seal). The mark-wall marquee left
  with deleted variant V02.
  Round 01b (rework track, final V01): `bento-orbit`, `bento-horizon`
  (+ its clip classes and always-light exemption), and flat
  `bento-route-pulse` retire with the losing options; survivors add
  `bento-packet-x` (3.2s straight travel, parks mid-track),
  `bento-scan-flare` (branch flares green at the emphasis peak; graphite
  base is the frame), `bento-point-breathe` (3s halo swell),
  `bento-shuttle-x` (6s card-to-card selector, parks at light),
  `bento-pulse-alt`/`-delay` (6s alternating emphasis, both visible at
  rest), `bento-descend-seal` (5s vertical seal-route, parks past the
  seal). Losing-option families (descend-pulse, shuttle-y, row-wave,
  seal-breathe, underline-sweep, stamp-in, caret-travel, xfade, flash)
  left with deleted options B/C — ticket 09 re-adds what it needs.
- **Provider scene tokens:** `--provider-*` fills (Gmail/Calendar/Slack/
  Drive official sets, Notion uses `currentColor`) are glyph fills ONLY
  inside the Services constellation — never UI chrome. They are the single
  exception to the §5 hex grep below: that grep gains a `grep -v
  'provider-'` exemption. Glyph geometry: Simple Icons shapes with official
  fills (PD-textlogo, trademark nominative use — sources noted beside the
  components); any mark failing small-size legibility falls back to its
  single-color si glyph, stated plainly. The theme-horizon dark layer
  carried always-light mock lines (`bg-white/xx`, `text-white`) — that
  raw-color exemption retired with the horizon in round 01b; the winning
  Appearance scene builds its dark preview from `bg-foreground` +
  `bg-primary-foreground` shapes (tokens, no exemption). Everything else
  token.
- **Scene categories:** A flow diagrams, B event streams, C interface
  miniatures, D signal scenes, E state transformations. New concept rounds
  name their category; cross-category repeats need a reason.
- **Hover language:** scenes rest at `scale-90` and breathe to `group-hover:scale-95`
  (no tile icon — removed 2026-09-16, the scene carries the meaning; bottom
  content is name/description/CTA only), CTA row reveals on `group-hover` *and*
  `group-focus-visible` (keyboard parity the reference lacks), always
  visible below `lg`. Interactive feedback (shadow, wash, CTA reveal) uses
  `duration-[var(--motion-standard)]`; scene choreography keeps
  `duration-300` hover breaths plus the round-2 loop constants (`6s`/`3s`/
  `24s`/`4s`/`14s`/`5s`, `2400ms` ping) exactly like the `22rem` rows above —
  no new palette. Overlay wash via token `bg-foreground/[0.03]`-style
  tints only.
- **Badges:** one deliberate deviation — a live status badge floats
  top-right per tile (the reference has none; settings tiles need live
  state without disturbing the bottom content silhouette).
- **Signal green (round 01b):** the logo-V brand green
  (`--color-green-600`, the `.voni-arc-accent` value) is permitted inside
  scenes as narrowly-scoped `.bento-signal-*` classes for traveling/moment
  elements only (packets, pulse rings, presence dots, moment glyphs such
  as checks and carets) — never structure, never body text. Same value in
  light and dark, following the voice-call live-green precedent (see
  ADR-0001).
- **Final V01 (round 01b, user picks 2026-09-20):** services A, voice A,
  account C, workspace A, appearance A (placeholder — no option won, first
  replate in ticket 09), numbers B, operator A. Gallery width-capped to
  the dashboard container (`max-w-6xl`) so tiles review at production
  geometry.
- **Motion gating (ticket 05, 2026-09-20):** the V01 loops ship as-is —
  the ticket's "beam/equalizer" text named retired round-1 scenes, so per
  the ticket-01b/02 handoff notes this ticket carries the winners to a
  shippable landing instead of redesigning scenes. Onscreen tiles loop at
  rest (rest-playing; hover/focus only breathes `scale-90`→`scale-95` plus
  the CTA reveal — no play-state gating, so `animation-play-state: paused`
  must not appear). Offscreen tiles skip scene rendering via
  `.bento-scene-viewport` (`content-visibility: auto` +
  `contain-intrinsic-size: auto 22rem`, mirroring the tile rhythm) — the
  CSS-only pause-offscreen, no IntersectionObserver island. Loop durations
  stay raw (`6s`/`3s`/`4s`/`5s`, `2400ms` ping) as the documented
  `22rem`-style dimensional exception, not `--motion-*` tokens.
  Reduced-motion frames are unchanged (every survivor keeps its
  `animation: none` line with base styles as the static frame). Survivor
  keyframes closed out by this ticket: `bento-node-ping`,
  `bento-branch-cycle`, `bento-lane`, `bento-spine-travel` +
  `bento-spine-node`, `bento-packet-x`, `bento-scan-flare`,
  `bento-point-breathe`, `bento-shuttle-x`, `bento-pulse-alt` / `-delay`,
  `bento-descend-seal` — retired families (round-1 beam-flow/list-cycle,
  marquee, orbit, horizon, flat route-pulse, losing B/C grammars) left
  with their deleted scenes per the §10b lists above. No gap-table row:
  no new visual language was introduced, so there is no gap to record.
- **Intent prefetch (ticket 06, 2026-09-20):** tile links are dead at rest
  (`prefetch={false}` — viewport entry fetches nothing, so the grid never
  avalanches) and restore default static prefetch on hover/focus intent
  via the `HoverPrefetchLink` client island (canonical Next.js
  hover-triggered pattern: `prefetch={active ? null : false}`; keyboard
  focus arms exactly like hover; idempotent arming fires once per intent;
  no hand-rolled `router.prefetch`). Under the project's
  `partialPrefetching` the intent prefetch resolves the per-route App
  Shell. The throwaway gallery passes `prefetchOnIntent={false}` (nothing
  prefetches there until ticket 08 deletes it).

## Appendix A — Route table (keep vs replace)

Markup replaced, logic kept, unless noted:

- `/` — KEEP session-gate/Suspense/demo voice wiring; REPLACE hero/cards.
- `/login`, `/signup` — KEEP session-decision; REPLACE frame.
- `/prototypes/*` — CUT entirely.
- `/dashboard` — KEEP summary action + branching + predicate sync; REPLACE cards/steps/funnel.
- `/agents` — KEEP query + badge derivation + stretched-link; REPLACE rows.
- `/agents/new` — KEEP full draft machine + copilot tools; REPLACE step bodies/timeline/footer/review markup.
- `/agents/[id]` — KEEP parse/normalize + deployment machine + handlers; REPLACE form + preview markup.
- `/campaigns`, `/campaigns/new`, `/campaigns/[id]` — KEEP queries/handlers/import job; REPLACE rows/form/cards.
- `/leads`, `/leads/[id]` — KEEP filter/bulk logic + queries; REPLACE table/cards/lists.
- `/calls` — KEEP pagination/filter/clamping; REPLACE table/chips/footer. **ADD missing `loading.tsx`+`error.tsx` (in scope).**
- `/calls/[id]` — KEEP 5 queries + caps + brief; REPLACE cards. **ADD missing `error.tsx` (in scope).**
- `/numbers` — KEEP handlers + per-item pending; REPLACE rows.
- `/jobs` — KEEP filter/search/select/bulk logic + result contract; REPLACE tabs/rows/toolbar/dialog.
- `/settings`, `/operator` — KEEP data leaves + gate + actions; REPLACE view markup.

## Appendix B — Retired `shadcn-audit.md` exceptions

All prior exceptions die under this file: raw hang-up red (now §4
scoped green), no-`success`-token (moot — status via badges), `data-icon`
upstream (moot), wizard-rebuild-forbidden (wizard IS rebuilt, §4),
chips/fill-shortcut keep (chips rebuilt in-style), 18-languages keep
(rendered via Blocks select idiom), consent-select (Blocks select),
logo/theme-mechanics hex (fixed per §5), toggle/logo dark: (fixed).

## Appendix C — Phase 0 open questions, decided

1. Prototypes in scope? → CUT (delete page + content.ts + CSS together).
2. Copilot restyle scope? → Logic kept (provider, RouteBrief, wizard
   tools), markup restyled to chat-03/ai-05 idiom.
3. agents/new + jobs interleaved logic/markup? → Markup-only swaps,
   handlers byte-identical.
4. Missing calls boundaries? → ADD `calls/loading.tsx`,
   `calls/error.tsx`, `calls/[id]/error.tsx` — in scope.
5. Bespoke fallbacks (NewAgentSkeleton, OperatorFrame,
   SettingsShellFallback, hand-rolled)? → Rewritten in-style, boundaries kept.

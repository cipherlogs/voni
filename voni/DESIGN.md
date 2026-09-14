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
  inside generated `ui/` primitives stay; the 4 bespoke `dark:` sites
  (`voni-logo` hex, `connection-test-button` emerald, `bubble`, mode-toggle
  mechanics) are fixed per §5.

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
- **Voice exception (narrow):** `voice-call.tsx` session/mic state
  machine, 429 countdown, and distinct failure states stay; all styling
  goes Blocks idiom. The inline test uses chat-01's conversation layout
  inside a full-screen Base UI dialog. One re-derived call green, scoped to live-call
  affordances only — never a general token. Everything slow stays a
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
  their CSS. `grep -rniE 'emerald|amber|#[0-9a-f]{3,6}\b' src`
- `dark:` outside `src/components/ui/` generated code (4 bespoke sites:
  logo hex, connection emerald, bubble, mode-toggle mechanics) → fix.
  `grep -rn 'dark:' src | grep -v 'src/components/ui/'`
- `style={{` (6 sites: voice-call avatar px → exception restyle;
  voice-avatar `hsl()` hash gradient → rebuild in-style;
  toggle-group `--gap`, layout `--sidebar-width-icon` → re-home to
  tokens). `grep -rn 'style={{' src`
- `space-x-|space-y-` (must be zero; use flex+gap). `grep -rn 'space-[xy]-' src`
- Non-`size-*` icon squares. `grep -rn 'h-[0-9].*w-\[0-9\]' src`
- Extra CSS files / keyframes: only `globals.css` survives; prototype
  CSS deleted with the routes. `ls src/app/prototypes` must 404-think → empty.
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
| Skeletons / RouteError / empty states / toasts | build-in-style | No blocks; boundaries+semantics kept, markup rewritten |
| Shell sidebar+header / dialogs / command menu / file upload | blocks-has | sidebar-02/03, dialog-01…12, command-menu, file-upload |
| Landing `/` | build-in-style | No marketing group; minimal composed entry |
| `/prototypes/*` + strategy.module.css + prototype.css | cut | Dev-only, light-only; delete page+content+CSS together |

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

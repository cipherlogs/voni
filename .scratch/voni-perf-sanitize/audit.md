# Voni frontend performance audit (ticket 01)

Scope: `voni/` Next.js 16 App Router frontend only. Out of scope: Remotion
scenes, Python voice pipeline / telephony bot, design-reference material.
Date: 2026-10-26. Base: `voni-perf-sanitize-integration` tip (= `main @
62d266ab`). No behavior change in this ticket — audit plus glossary only.

Working definition: **sanitize** = behavior-preserving performance refactor
(same pixels, same data, lower cost). Recorded in root `GLOSSARY.md`.

Every finding names the **highest-boundary seam** that contains the fix, so
each later ticket lands at one boundary and stays independently revertable.
Ticket map: 02 dashboard waterfall, 03 Call trace / lead waterfall,
04 settings waterfall, 05 bundle on-demand, 06 server dedup/auth/props,
07 client listeners + storage, 08 re-render, 09 rendering,
10 mutation UX + durable jobs + shell, 11 instant-nav + Workers guards.

## Baseline cost signals (what later tickets must improve)

Same pixels, same data — lower cost, measured as:

- Query counts: waterfalls below issue 6+ serial reads per page where 1
  parallel round would do (W1–W4, S1); per-request session/workspace reads
  re-resolved 2× per page (W4/S1).
- Payload sizes: full `AgentConfig` + 10 metadata props to the client
  (S3); full member list to the client campaign queue (S3); full `JobJson[]`
  to the client jobs filter (S3).
- Paint behavior: landing first paint eagerly bundles the whole Demo call
  voice stack (B1); every dashboard route mounts the Copilot provider even
  when Copilot is never opened (B2); long lists render unbounded DOM with
  zero culling (V1); per-row `Intl.DateTimeFormat` construction (V3/J1);
  1s-interval state ticks re-render the tree (R2).
- Interaction cost: duplicated global listeners per mount (C1); unversioned
  browser storage with shape-reject but no migration (C2); one silent
  single-`pending` control and two fire-and-forget mutations (A1); two async
  routes without loading shells (A3).

## Seam 1 — Waterfalls (preferred boundary: server data boundary)

- **W1.** Dashboard summary is 6 serial queries.
  `voni/src/app/(dashboard)/dashboard/actions.ts:49-97` awaits worked →
  connected → booked → handoff → stageRows → emptyCampaigns in sequence;
  only the 3 setup-existence checks (`:99-127`) use `Promise.all`. All share
  only the org id. Baseline: 6 sequential roundtrips + 1 parallel group per
  dashboard visit. Fix: one `Promise.all` over the six count/group queries
  at the `getDashboardSummary` service boundary; keep `limit(3)`
  empty-campaign shape. → ticket 02.
- **W2.** Call trace detail is 5 serial reads after context.
  `voni/src/app/(dashboard)/calls/[id]/page.tsx:86-154`: `callDetail(id)`
  (`:86`, itself `requireCtxOrRedirect` + uuid check + scoped join in
  `voni/src/lib/copilot/detail-data.ts:20-26`) → second
  `requireCtxOrRedirect` (`:87`, duplicate session+member resolution) →
  ownership join (`:92-115`) → turns (`:119-129`, limit 100) → tools
  (`:134-147`, limit 50) → outcome (`:149-154`). Turns/tools/outcome are
  independent once the call id is known. Same serial shape in
  `voni/src/app/(dashboard)/leads/[id]/page.tsx:68-121`: `leadDetail`
  (`detail-data.ts:12-19`) → leadCalls (`:70-82`, limit 20) → memberships
  (`:84-106`, limit 20) → activity (`:109-121`, limit 50).
  Baseline: 5 sequential reads per Call trace page, 4 per lead page.
  Fix: resolve ctx once, `Promise.all([link, turns, tools, outcome])` (lead
  page: `Promise.all([leadCalls, memberships, activity])`). The Call trace
  page already streams inside `Suspense` + `CallDetailSkeleton` (`:441-449`)
  — keep. → ticket 03.
- **W3.** Settings voice-prefetch is serial; siblings already concurrent.
  `voni/src/app/(dashboard)/settings/[tab]/page.tsx:74-83`: `VoiceData`
  awaits `requireCtxOrRedirect`, then `getCopilotVoicePrefs()`, which itself
  awaits `requireCtx()` + one select
  (`voni/src/app/(dashboard)/settings/actions.ts:372-379`). Contrast
  `WorkspaceData` (`:85-90`) and `ServicesData` (`:107-114`), both already
  `Promise.all`. Baseline: 2 sequential roundtrips on the voice settings
  tab vs 1 parallel group on sibling tabs. Fix: `Promise.all` over ctx +
  voice prefs (or hoist ctx read into the shared leaf); keep awaits in the
  branches that use them. The `export const instant = false` opt-out
  (`:54`) is deliberate — do not remove. → ticket 04.
- **W4.** Layout + page double session resolution.
  `voni/src/app/(dashboard)/layout.tsx:27-65` (`ShellAuthResolver` →
  `auth.api.getSession`) runs concurrently with every page's `getCtx()` →
  `auth.api.getSession` (`voni/src/lib/session.ts:46-133`). Zero `cache()`
  from React anywhere in `voni/src` (verified: no matches). Baseline: every
  dashboard navigation pays ≥2 session resolutions + ≥2 member lookups.
  Fix (enables 02–04): wrap the `getCtx` core in `cache()`. → ticket 06.

## Seam 2 — Bundle (preferred boundary: route composition boundary)

- **B1.** Landing first paint eagerly bundles the whole voice stack.
  `voni/src/app/page.tsx:2` → `LandingDemo`
  (`voni/src/components/landing-demo.tsx:3,18`) → `VoiceCall`
  (`voni/src/components/voice-call.tsx`, 29 import statements). Zero
  `next/dynamic` / `React.lazy` in `voni/src` (verified: no matches outside
  tests). Baseline: every visitor — including never-calling readers — ships
  the full Demo call session machinery in the first paint. Fix:
  `next/dynamic` the demo card (and `TestAgentDialog`, `CopilotShell`)
  behind their dialogs/routes with shaped skeleton fallbacks matching
  `voni/src/components/page-skeletons.tsx`; identical post-load behavior.
  → ticket 05.
- **B2.** Global Copilot provider ships the voice graph to every dashboard
  route. `voni/src/components/shell-frame.tsx:52-61` mounts `CopilotProvider`
  (`voni/src/components/copilot/copilot-provider.tsx:1-76`) for all
  dashboard routes even when Copilot never opens. The `enabled` gate is
  auth-only, not load-gating. Baseline: Copilot session/voice graph code
  loads on every dashboard route. Fix: dynamic-import provider/panel; keep
  one session surviving in-app navigation once loaded. → ticket 05.
- **B3.** Dependency weight already lean — nothing to remove.
  `voni/package.json`: `ai`, `drizzle-orm`, `better-auth`, `@base-ui/react`,
  `next@16.3.4`, `react@19.2.8`; `@tanstack/react-table` present but no
  virtualization package (`@tanstack/virtual` absent — needed by seam 6).
  Standard-library imports fine. No action.

## Seam 3 — Server (preferred boundary: server data boundary)

- **S1.** Per-request session/workspace reads never deduplicated (same root
  cause as W4). 79 `getCtx`/`requireCtx`/`requireCtxOrRedirect` call sites;
  doublings: Call trace detail (`detail-data.ts:21` + calls page `:87`),
  lead detail (`detail-data.ts:13` + leads page `:68`), settings voice
  (settings page `:75` + `actions.ts:372`). Baseline: 2 session+member
  resolutions per affected page. Fix: `cache()`-wrapped `getCtx` via
  existing Context/built-ins (no new store); expand-contract if the blast
  radius is wide. → ticket 06.
- **S2.** One auth-ordering violation: voice-prefs update parses before
  authenticating. `voni/src/app/(dashboard)/settings/actions.ts:381-393`:
  `copilotVoicePrefsSchema.safeParse` runs before `requireCtx()`. House
  rule (siblings auth-first) confirmed in `agents/actions.ts` (`requireCtx`
  at `:133,203,290,340`) and `campaigns/actions.ts` (`:59,108`). Baseline:
  uniform auth-first ordering everywhere except this mutation. Fix: move
  `requireCtx()` above parse; uniform order, no behavior change. → ticket 06.
- **S3.** Oversized server→client props. `AgentDetail` ships the full
  `AgentConfig` + 10 metadata props to client `EditAgent`
  (`voni/src/app/(dashboard)/agents/[id]/page.tsx:58-73`); campaign detail
  ships the full member list to the client queue
  (`voni/src/app/(dashboard)/campaigns/[id]/page.tsx:63-64,201-204`); the
  jobs page ships full `JobJson[]` to the client filter
  (`voni/src/app/(dashboard)/jobs/page.tsx:71-77`). Baseline: RSC payloads
  carry whole configs/member lists/job rows where the client uses fields.
  Fix: project to used fields at the server-client boundary. → ticket 06.
- **S4.** Post-response work blocks mutations. `createAgentAction` awaits
  `enqueueDeployment` inline before `revalidatePath`
  (`voni/src/app/(dashboard)/agents/actions.ts:180-182`); `console.error`
  logging inline in all settings mutations; `waitUntil` plumbed in
  `voni/src/lib/jobs/queue.ts:22-36` but no mutation defers via
  `after()`/`waitUntil`. Baseline: deployment enqueue + logging + analytics
  sit inside mutation latency. Fix: `after()` logging/analytics/cache-sweep;
  return the response first. → ticket 06.

## Seam 4 — Client (preferred boundary: client provider boundary)

- **C1.** Duplicated global listeners, no shared registry.
  `keydown` ×2 (`command-menu-03.tsx:117`, `ui/sidebar.tsx:108`);
  `visibilitychange` ×2 (`jobs-provider.tsx` visibility handler,
  `voice-call.tsx:876`); `focus`/`pagehide`/`freeze`/`online` scattered
  (`jobs-provider.tsx` focus+online handlers, `voice-call.tsx:877-878`);
  `voni:voice-preempt` in both `voice-call.tsx:1021` and
  `copilot-provider.tsx:813`; `voni:voice-prefs-changed` in
  `copilot-provider.tsx:800`; `beforeunload` per mount
  (`edit-agent.tsx:199`, `components/settings-draft.ts:57`); `matchMedia`
  change in `hooks/use-mobile.ts:9`. None use `passive: true` (verified: no
  `passive` option in `voni/src` outside a comment). Baseline: N mounted
  components = N duplicate document/window listeners, all blocking where
  they need not be. Fix: one shared listener per event family at the
  provider boundary, non-blocking where no default prevention needed.
  → ticket 07.
- **C2.** Browser storage unversioned everywhere. Keys: `voni:settings:*`
  drafts (`components/settings-draft.ts:24-26`),
  `voni:edit-draft:<id>` (`edit-agent.tsx:36`), `voni:wizard-draft` +
  `voni:wizard-consumed-jobs` (`use-wizard-draft.ts:50,163`),
  `voni:test-tag` (`lib/demo/email-test.ts`), `voni:demo-call`
  (`lib/demo/hold.ts`), `voni-job-toast-state` + `voni-job-notify`
  (`jobs-provider.tsx:55-56`), theme key + `voni-theme-migrated-v1`
  (`theme-provider.tsx`). No `{version}` envelope; shape-rejection exists
  (`parseEditDraftCache`, `parseWizardDraftCache`) but no migration — old
  shapes silently drop or pass through. Repeated reads uncached:
  `readToastState` JSON-parses on every poll; `readSettingsDraft` per
  render (verified no `version` key in settings-draft, wizard-draft,
  jobs-provider, theme-provider). Baseline: any stored-shape change risks
  silent drops; every poll pays full parse cost. Fix: versioned envelope +
  migrate + safe fallback; memoize repeated reads. → ticket 07.

## Seam 5 — Re-render (preferred boundary: client provider boundary)

- **R1.** Effect-derived drift + mirrored state/ref pairs. `voice-call.tsx`
  carries 23 `useEffect`s with mirrored pairs (`emailTest`/`emailTestRef`,
  `testTag`/`testTagRef`, state/muted/turns + refs) synced via callbacks —
  drift surface. Good precedent: `route-error.tsx:38-43` render-selection
  reset avoids set-state-in-effect. Baseline: derived values re-sync a tick
  late after the values they derive from. Fix: derive during render,
  narrow deps, move interaction logic into handlers. → ticket 08.
- **R2.** High-frequency transient state re-renders the tree.
  `voice-call.tsx:392` elapsed (1s tick), `:396` liveCaption per-word
  partials, `:386` full turns array per token; `SidebarVoiceButton` 1s
  `setInterval`→`setElapsed`
  (`sidebar-03/utility-rows.tsx:70-79`); sidebar jobs progress similarly.
  `VoiceBars` animation already culled
  (`components/copilot/voice-bars.tsx:1-8` — static bars, color-only
  speaking state — keep). Baseline: per-second/per-token renders of the
  voice tree and sidebar rows. Fix: refs for meters/word-counts/progress +
  `useTransition`/`useDeferredValue` for non-urgent updates. → ticket 08.
- **R3.** Already healthy: no component-defined-inside-component (verified
  by inspection); `useTransition` + per-item `pendingId` in
  `phone-numbers.tsx:129-130` and `settings-sections.tsx:407-408` — the
  pattern ticket 10 extends. No action.

## Seam 6 — Rendering (preferred boundary: route composition boundary)

- **V1.** Long lists render unbounded DOM, no culling. Calls/leads/campaign
  queues page at 20–50 rows (`calls/page.tsx` page size 20; lead pages limit
  20/50) with zero virtualization (verified: no implementation hits,
  `@tanstack/virtual` absent from `package.json`). Baseline: hundreds of
  Calls or leads render hundreds of rows of DOM. Fix: cull off-screen rows
  (`@tanstack/virtual`-style windowing; dep currently absent), same rows
  and order, bounded rendered output. → ticket 09.
- **V2.** Sidebar collapse already state-preserving (verify, don't
  rebuild). `SidebarProvider` default-open + `SidebarStateRestore` cookie
  (`layout.tsx` region + `app-sidebar.tsx`); `shell-frame.tsx` documents
  re-render-never-remount for jobs/Copilot providers. Ticket 09 =
  regression-guard, not rework. → ticket 09.
- **V3.** Micro-patterns mostly hoisted; two per-row `Intl` hot spots.
  `absoluteCallTime` constructs `Intl.DateTimeFormat` per row per render
  (`calls/page.tsx:83-89`); same in `calls/[id]/page.tsx:44-50`. Baseline:
  one formatter construction per table row per render. Fix: hoist
  formatters to module scope. → ticket 09 (also J1).

## Seam 7 — JavaScript (preferred boundary: highest boundary containing the loop)

- **J1.** Regex/formatter-in-render + combinable passes. Per-row
  `Intl.DateTimeFormat` (V3); `.filter(...).length` then later `.map` over
  members (`campaigns/[id]/page.tsx:64` + queue render); `stages.map` +
  `setupSteps.filter` in the dashboard page. Good precedent:
  `queueBulkAction` uses `Set` membership + single filter
  (`campaigns/actions.ts:274-279`); `[...activity].reverse()` at
  `leads/[id]/page.tsx:122` already keeps the immutable op. Baseline: extra
  formatter builds + extra array passes per render of campaign/dashboard
  lists. Fix: hoist patterns to module scope, prefer `Set.has`, combine
  passes, keep immutable non-mutating ops. → ticket 09 (with V3).

## Seam 8 — Advanced (preferred boundary: route composition boundary + existing rigs)

- **A1.** List pending state: two house-correct, one single-boolean, two
  silent. Per-item `pendingId` correct in `phone-numbers.tsx` and
  `settings-sections.tsx`; `CampaignControls` single `pending`
  (`campaign-controls.tsx:31`) acceptable on a single-action detail page
  but must not be copied to lists; `delete-agent-button.tsx` /
  `delete-campaign-button.tsx` (under `agents/` and `campaigns/` route
  dirs) rely on dialog confirm — verify under ticket 10; `openJob`/`markSeen`
  swallow failures (`.catch(()=>undefined)` in `jobs-provider.tsx`) with no
  toast — close per mutation-feedback rule (inline Alert + fire-and-forget
  `toast.add`). Baseline: one row's action can disable every row where the
  single-boolean pattern is copied; two mutations fail silently. Fix per
  ticket 10. → ticket 10.
- **A2.** Durable-jobs mechanism exists — route remaining long work through
  it. `lib/jobs/` + `components/jobs/` global JobCenter with result
  destination (`targetUrl`), retry path, visibility-aware polling (2s active
  / 30s idle / 5s hidden, `jobs-provider.tsx` tick), optimistic entries.
  Long ops to verify: agent deployment/generation, lead import,
  `lib/demo/website-read.ts` (~60s; file notes `waitUntil` covers only
  ~30s). Anything >3s not yet a durable job is the ticket-10 gap. No new
  store. → ticket 10.
- **A3.** Streaming shell coverage broad with two gaps. `loading.tsx` +
  `error.tsx` present for agents, calls, leads, campaigns, numbers, jobs,
  dashboard, operator, settings sections — all `error.tsx` render shared
  `RouteError` (retry + 429 countdown). Gaps verified: `agents/new/` has
  `error.tsx` but no `loading.tsx`; `settings/[tab]/` has `error.tsx` but
  no `loading.tsx` (relies on section layout shell). Baseline: two async
  routes paint without a shaped skeleton. Fix: add shaped skeletons from
  `page-skeletons.tsx` (`StatGridSkeleton`, `TableSkeleton`,
  `DetailSkeleton`, `PageHeaderSkeleton`). → ticket 10.
- **A4.** Instant-nav + Workers guards exist but partially green.
  `HoverPrefetchLink` (dead-at-rest + intent prefetch), `cacheComponents:
  true` + `partialPrefetching: true` (`next.config.ts:21-22`),
  `ViewTransition` on dashboard content (`layout.tsx`), rig
  `voni/instant-nav.rig.md`, `tests/e2e/instant-shell.spec.ts`,
  `test:e2e:{instant,behavior,cloudflare}` scripts, `worker.ts` +
  `wrangler.jsonc` Cloudflare path. Known toolchain blocker (record, do not
  work around): locked `instant()` asserts skip — `React.unstable_postpone`
  is not defined on Next 16.3.4 + React 19.2.8 (`instant-nav.rig.md` runs
  table: 18 pass + 8 fixme baseline). Authenticated-gate E2E deferred (test
  DB creds unavailable). → ticket 11 re-runs the full gate per change and
  maps failures back to owning tickets 02–10.

## Test suites / rigs for regression

- Node runner (~90 test files via `npm test` in `voni/`): route tests
  (calls pagination/filter-chips/index, leads, settings, agents),
  `proxy.test.ts`, auth-redirect, platform checks, jobs queue + UI helpers,
  voice session lifecycle/judges/cascade/worklets/barge-in/floor/mic-owner,
  Copilot libraries (bus, proposals, jobs-tools, voice-prefs, prefetch,
  app-manifest check), campaigns/leads filters, Demo call libs (hold,
  talk-clock, stakes-ladder, email-test, code-check, inbox), wizard flows,
  `voice-call.test.ts` (visibility/freeze/pagehide contract),
  `settings-draft.test.ts`.
- E2E/rigs: `tests/e2e/` (instant-shell, demo-*, rig-liveness),
  `voni/instant-nav.rig.md`, `scripts/e2e-run.mjs`,
  `scripts/qa-voice-session.mts`, `verify-mobile-takeover.mts`, `worker.ts`
  + `wrangler.jsonc` Cloudflare preview.

## ADRs — none reopened

Read `docs/adr/0001`–`0005` (bento signal-green + containment; built-in end
call; barge-in recovery; Test tag email matching; tool-results
send-at-once except end call). No finding contradicts any of them:
voice-session findings (R1/R2/C1) touch client render and listener hygiene,
never the barge-in judge, end-call tool timing, or tool-result transport;
Test tag storage (`voni:test-tag`) is versioned in place under C2 without
changing the matching rule; signal-green usage is untouched. Genuine-conflict
flags: none. If a later ticket meets a real conflict, it must flag it
explicitly per `docs/agents/domain.md` rather than silently overriding.

## Suggested PR order

Per spec dependencies: 07 (listeners/storage) → 06 (dedup/auth/props) →
02/03/04 (waterfalls) → 05 (bundle) → 08/09 → 10 → 11 (guards last).
Spec order differs: 01 → 02/03/04/05/07 → 06 (after 02,03,04) → 08/09
(after 02,03,05) → 10 (after 06,07) → 11 (last).

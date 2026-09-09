# Voni Next.js skills adoption — route inventory, phase status, exceptions, evidence

> Created Task 1 (recoverable starting point). Branch: `feat/next-skills-adoption`.
> Baseline: dirty working tree preserved, no reset/clean/stash/commit of unrelated work.
> Source: `myplan.md` line-by-line execution. Updated after every Task.

## Baseline fingerprint (Task 1, 2026-09-09)

- Prior branch: `main`, HEAD `778e3ffdfa80e1dda14885e4cc3669fb71b0b754`
- Implementation branch: `feat/next-skills-adoption` (dirty checkout carried over, 50 tracked-modified + 16 untracked entries)
- Next.js `16.3.4`, OpenNext Cloudflare `1.20.6`, Better Auth `1.7.2` Google-only, Turbopack, `agent-browser 0.36.0`
- Dev server lock: `voni/.next/dev/lock` → `http://localhost:3000` (PID recorded in lock file, reused, no duplicate)
- Cache Components: NOT enabled (`voni/next.config.ts` has only `turbopack.root` + OpenNext dev init + `.dev.vars` bridge)
- Partial Prefetching: NOT enabled
- shadcn: Base UI, `base-nova`, Lucide, Tailwind v4; `voni/src/components/ui` = 22 files (incl. `sonner.tsx`; plan said 23 — reconcile in Task 13, do not assume)
- Playwright rig: absent (`@next/playwright` + `@playwright/test` not in `voni/package.json`) — Task 4 must add
- E2E test DB creds: UNAVAILABLE (user-confirmed) — Task 5 prerequisite reported, authenticated production-test gate stays incomplete per `myplan.md:241`. No fallback to ordinary `DATABASE_URL`.

### Tracked modifications already present (do not overwrite intent)

`layout.tsx` (dashboard group), `settings/page.tsx` + `actions.ts`, `login/page.tsx`, `signup/page.tsx`, `page.tsx` (landing), `app-sidebar.tsx`, `copilot-provider.tsx`, `jobs-provider.tsx`, `job-row.tsx`, `settings-view.tsx`, `proxy.ts`, `manual-llm-guidance.tsx`, job system (`queue.ts`, `store.ts`, `processor.ts`, `start.ts`, `sweep.ts`, `kinds.ts`, `jobs.test.ts`), voice session, LLM index, platform llm-accounts, copilot app-guide/manifest, `ENVIRONMENT.md`, `copilot-coverage.md`, `wrangler.jsonc`, `package.json`, manifest generator + verify scripts, plus `.claude-flow/policy/state.json`, `.gitignore`, `HANDOFF.md`, `notes`, `opencode.json` housekeeping.

### Untracked files preserved (part of current app, Task 1 rule 5)

- `voni/src/app/(dashboard)/operator/` (allowlisted operator page)
- `voni/src/app/api/jobs/[id]/wake/`
- `voni/src/components/authenticated-redirect.tsx`, `landing-header.tsx`, `operator-view.tsx`
- `voni/src/lib/jobs/contracts.ts`, `voni/src/lib/jobs/queue.test.ts`
- `voni/scripts/qa-voice-session.mts`, `rotate-platform-credential.mts`
- `voni/docs/copilot-coverage-evidence.json`, `voice-session-evidence*.json`
- `.envrc`, `.github/`, `myplan.md`

## Route inventory (17 page routes, filesystem-verified)

| # | Route | File | Immediate structure (target) | Deferred content (target) |
|---|---|---|---|---|
| 1 | `/` | `voni/src/app/page.tsx` | Branding, hero, feature layout, demo frame | Session-dependent header actions; demo user-started, tool-free |
| 2 | `/login` | `voni/src/app/login/page.tsx` | Auth-page frame + loading feedback | Session decision, safe destination, OAuth error/form or authenticated redirect |
| 3 | `/signup` | `voni/src/app/signup/page.tsx` | Auth-page frame + loading feedback | Same as login, signup copy preserved |
| 4 | `/dashboard` | `voni/src/app/(dashboard)/dashboard/page.tsx` | Heading, nine stage cards, recent-activity placeholder | Shared authenticated controls only; no invented metrics |
| 5 | `/agents` | `voni/src/app/(dashboard)/agents/page.tsx` | Heading, description, New agent link | Authorized list or Empty; count-based RouteBrief after data |
| 6 | `/agents/new` | `voni/src/app/(dashboard)/agents/new/page.tsx` | Back link, stable heading, wizard frame | Job restoration + config-dependent content; draft/review/confirm retained |
| 7 | `/agents/[id]` | `voni/src/app/(dashboard)/agents/[id]/page.tsx` | Back nav + detail frame | Authorized name, config, deploy status, edit + test card |
| 8 | `/campaigns` | `voni/src/app/(dashboard)/campaigns/page.tsx` | Heading, description, creation link | Authorized list + states |
| 9 | `/campaigns/new` | `voni/src/app/(dashboard)/campaigns/new/page.tsx` | Heading, back nav, form frame | Agent options + dependent controls |
| 10 | `/campaigns/[id]` | `voni/src/app/(dashboard)/campaigns/[id]/page.tsx` | URL-independent nav + section structure | Authorized campaign, dispatch readiness, lead rows + controls |
| 11 | `/leads` | `voni/src/app/(dashboard)/leads/page.tsx` | Heading, intro, table structure | Authorized rows, counts, or Empty |
| 12 | `/leads/[id]` | `voni/src/app/(dashboard)/leads/[id]/page.tsx` | Back nav + detail structure | Authorized identity, consent, pipeline, state |
| 13 | `/calls/[id]` | `voni/src/app/(dashboard)/calls/[id]/page.tsx` | Back nav + detail structure | Authorized call data, implemented details only |
| 14 | `/numbers` | `voni/src/app/(dashboard)/numbers/page.tsx` | Heading + number-management structure | Numbers, available agents, assignment controls |
| 15 | `/jobs` | `voni/src/app/(dashboard)/jobs/page.tsx` | Heading, filter/search structure, status layout | Creator-scoped rows + URL-selected search results |
| 16 | `/settings` | `voni/src/app/(dashboard)/settings/page.tsx` | Heading + tab structure | Account/workspace values, permissions, voice prefs, service readiness |
| 17 | `/operator` | `voni/src/app/(dashboard)/operator/page.tsx` | Generic operator frame | Authorization first; admin content only after allowlist |

Layouts: `voni/src/app/layout.tsx` (root), `voni/src/app/(dashboard)/layout.tsx` (signed-in shell — Task 8 refactor target; currently awaits session+admin before rendering tree).

## Phase status

- [x] Task 1: recoverable starting point (this file + branch + fingerprint)
- [x] Task 2: instructions loaded (2026-09-09)
- [x] Task 3: dev verification established (2026-09-09)
- [x] Task 4: production rig isolated (2026-09-09)
- [ ] Task 5: BLOCKED — no E2E DB creds (prerequisite recorded, gate incomplete)
- [x] Task 6: instant() trust — unauthenticated slice (2026-09-09; 10 pass + 8 locked fixme on React.unstable_postpone toolchain blocker)
- [x] Task 7: Cache Components on — direct one-branch (2026-09-09; flag set, zero incompatible segment exports/legacy flags/force-dynamic)
- [x] Task 8: layout split (2026-09-09; sync shell + Suspense resolver + ShellAuth bridge + enabled-gated providers; dev-verified, /agents build blocker cleared)
- [x] Task 9: auth behavior retained (2026-09-09; login/signup sync frame + suspended decision, client redirect kept, landing header/footer leaves, dev-verified)
- [x] Section 5: dashboard+settings (2026-09-09; shell/leaf splits, dirty-input-safe single boundary, dev-verified, build green)
- [x] Section 5: agents (2026-09-09; list/detail/wizard splits, ?job= isolated, wizard draft intact, dev-verified, build green)
- [x] Section 5: campaigns (2026-09-09; list/new/detail splits, activation parity, dev-verified, build green)
- [x] Section 5: leads+calls (2026-09-09; table-structure shell, detail leaves, notFound in-leaf, dev-verified, build green)
- [x] Section 5: numbers+jobs+operator (2026-09-09; numbers leaf, jobs heading-out + record-search isolation, operator gate-first, denial verified, build green)
- [x] Task 10: shell markers + widths (2026-09-09; `*-shell` markers on all 17 routes, suite runs desktop+mobile, shared pending/resolved structure; locked instant-optimization deferred on toolchain blocker + Task 5 creds)
- [x] Task 11: prefetch audit flag-off (2026-09-09; zero `prefetch` props / `router.prefetch` / forwarded values — no legacy contract, no route exports, no codemod)
- [x] Task 12: Partial Prefetching on (2026-09-09; global flag, 36/36 build, unchanged suite 18 pass + 8 fixme, all-routes dev sweep + 4×404 + ?job=missing clean, zero route exports so codemod N/A; prod prefetch-request inspection rides Task 19 preview)
- [x] Task 13: shadcn audit + installs (2026-09-09; 22→33 ui files, 5 overwrites reverted incl. cursor-pointer regression, `info --json` context recorded)
- [x] Task 14: forms + composition (2026-09-09; Field/FieldGroup/SelectGroup/MenuGroup, days/voice/channels ToggleGroup, wizard exceptions recorded, dev-verified, 215/215 tests)
- [x] Task 15: styling without redesign (2026-09-09; space/size normalized, exceptions recorded, tsc+lint clean)
- [x] Task 16: Sonner→toast (2026-09-09; all call sites migrated, Toaster mounted, sonner dep removed after 215/215 tests)
- [x] Task 17: transcripts (2026-09-09; voice-call turns → MessageScroller/Message/Bubble, scroll effect removed, demo renders, no errors; proposals/job cards untouched per contract)
- [x] Task 18: Activity/jobs/voice (2026-09-09; verified — no pathname keys, single-boundary settings, stable providers, effect cleanups, harvest excludes display:none subtrees incl. Activity-hidden, refs snapshot-bound + invalidated on leave, manifest current, 215/215 tests; owner-device + two-record checks remain external)
- [x] Task 19: Cloudflare preview (2026-09-09; separate `wrangler.preview.jsonc`, local R2 cache bucket isolated from CSV staging, no --remote/creates; opennext build + preview 18 pass + 8 fixme with cleanup verified; runner mirrors tracked deletions, ephemeral .dev.vars, teardown escalation; authenticated preview checks ride Task 5 creds)
- [x] Task 20: acceptance matrix + final gates (2026-09-09; tsc/eslint/tests/manifest/build/e2e/diff-check green, route table + outstanding list above; branch local, dev server running)
- [ ] Tasks 13–17: shadcn compliance
- [ ] Task 18: Activity/jobs/voice
- [ ] Task 19: Cloudflare local preview
- [ ] Task 20: acceptance matrix + gates

Feature completion gate per feature: clean dev runtime + instant tests (where unblocked) + parity + full `next build`.

## Task 20 acceptance (2026-09-09)

Gates: `tsc` clean · `eslint` clean (0 errors, 0 warnings) · `npm test` 215/215 · `copilot:manifest:check` current · isolated `next build` 36/36 (all pages ◐) · `test:e2e` instant 18+8fixme / behavior 4 / cloudflare 18+8fixme, tmp cleaned · `git diff --check` clean. Dev server left running on `:3000`; branch `feat/next-skills-adoption` local, no push/PR/deploy.

### Completion criteria

- [x] Both flags on (`cacheComponents`, `partialPrefetching`), zero `instant=false`, zero route `prefetch` exports.
- [x] Every page has a shell/content contract (table below).
- [x] No prerender/URL-data insights left (build 36/36, dev `get_errors` empty throughout).
- [ ] Production navigation tests pass without retries — PARTIAL: unlock + redirect guards green; 8 locked asserts fixme on React.unstable_postpone toolchain blocker.
- [ ] Actual optimizations with before/after evidence — DEFERRED with the lock (no manufactured defects; guards retained).
- [ ] Auth + private-data isolation pass — PARTIAL: signed-out redirects + denial + 404s verified; role/record-matrix needs Task 5 fixtures.
- [ ] Drafts/jobs/voice/notification regressions — PARTIAL: construction-verified + unit/integration suites green; live/session scenarios outstanding (see matrix).
- [x] shadcn audit: no unresolved application violations (12 findings done/excepted).
- [x] OpenNext local compatibility passes (build + preview 18 pass, local R2 isolated).
- [x] Unrelated starting work intact (dirty baseline carried, no reset/clean/stash).

### Route-results table (immediate → streams)

| Route | Appears immediately | Streams after | Notes |
|---|---|---|---|
| `/` | Branding, hero, features, demo frame, footer shell | Header actions, footer year | Signed-in header shows only Open dashboard (dev-verified) |
| `/login`, `/signup` | Auth frame + loading text | Session decision / AuthForm / OAuth error / redirect | Redirect under bypass verified; signed-out frame in prod candidate |
| `/dashboard` | Heading, 9 stage cards, activity placeholder | Shared auth controls only | Fully static page |
| `/agents` | Heading, desc, New agent link | List/Empty + count brief | `agents-shell` |
| `/agents/new` | Back link, heading, wizard frame | Steps, ?job= restore | Draft intact (dev-verified) |
| `/agents/[id]` | Back nav + frame | Name heading, config, deploy, test card | Two-record reuse needs fixtures |
| `/campaigns` | Heading, desc, creation link | List/states | `campaigns-shell` |
| `/campaigns/new` | Heading, back nav, form frame | Agent options + form | Empty-agents branch verified |
| `/campaigns/[id]` | Back nav + Dialer/Import/Queue sections | Campaign, readiness, lead rows | Title mirror noted |
| `/leads` | Heading, intro, table head | Rows/counts/Empty | Intentional table scroll at 390 |
| `/leads/[id]` | Back nav + frame | Identity, consent, pipeline, timeline | 404 verified |
| `/calls/[id]` | Back nav + frame | Call data, transcript/trace cards | 404 verified |
| `/numbers` | Heading + structure | Numbers, agents, assignment | Per-row pending preserved |
| `/jobs` | Heading, filter/search structure | Creator rows, ?search= leaf | Tabs verified; heading outside fallback |
| `/settings` | Heading + tab bar (disabled) | Values, permissions, prefs, readiness | Dirty-safe single boundary |
| `/operator` | Generic frame | Allowlist decision → admin/denial | Denial verified (non-admin) |

### Precisely bounded external verification still outstanding

E2E DB creds (Task 5 fixtures, role/record matrix, two-record reuse, signed-in mobile Sheet nav, live job/notify flows) · locked `instant()` (React.unstable_postpone toolchain) · owner-device voice/audio · real Google OAuth sign-out loop · deployed Cloudflare Queue delivery · 768/1440 overflow sweep.

## Task 5 prerequisite report (2026-09-09 — BLOCKED, gate incomplete)

Required but unavailable: `E2E_DATABASE_URL`, expected test DB hostname/DB identifier, test-only Better Auth secret, test origin URLs, run identifier (user-confirmed 2026-09-09).
Consequences: no isolated-DB migrations, no org/user/operator fixtures, no real session rows/cookies/storage-states, no fixture agents/campaigns/leads/calls/jobs. Authenticated production-test gate stays incomplete per `myplan.md:241`. Runner refuses `E2E_DATABASE_URL` until allowlisted fixture setup lands and never falls back to `DATABASE_URL`; no email/password, no test-login endpoint, no `devBypassEnabled()` relax. Unauthenticated rig-liveness (Task 4) passes via ephemeral boot secret + placeholder-DB fail-soft. Unblocks the moment creds arrive — no Task 4 redo needed.

## Task 8 implementation notes (2026-09-09)

- New: `src/components/shell-auth.tsx` (`ShellAuthProvider`, `useShellAuth`, `ShellAuthBridge` with post-commit publish + equivalent-snapshot dedup), `src/components/shell-frame.tsx` (`ShellSidebar`, `ShellProviders` — stable instances, `enabled` derived from snapshot).
- `JobsProvider`/`CopilotProvider` accept `enabled`: no polling/listeners/token/mic/prefs-fetch while disabled; jobs state cleared on disable (render-adjustment pattern, lint-clean); copilot stops + invalidates proposals on disable; `start()` no-ops while disabled.
- `AppSidebar`: `user` optional; nav+branding render without it; footer shows account menu only when authenticated, else text status (`sessionNote`).
- `AppHeader`: voice button disabled with pending/unavailable explanation; jobs link stays navigable.
- `(dashboard)/layout.tsx`: fully synchronous; `ShellAuthResolver` in `<Suspense fallback={null}>` runs existing session/operator checks + safe login redirect; resolver failures → `unavailable` snapshot (shell explains, logged server-side).
- `proxy.ts`: `/jobs` added to protected prefixes + matcher (cookie-optimistic redirect, server session still authoritative).
- UX protocol applied: task completion + durable jobs preserved (strategyUX/leanUX); loading discoverability via text states, error prevention via disabled-until-ready (everydayUX); familiar nav untouched, no new choices (lawUX/Jakob/Hick).
- Dev verification: `get_compilation_issues []`, `/dashboard` compile clean, browser shows heading + streaming auth (pending → Dev User, voice unlocks), `get_errors []`. Build blocker `/agents` (layout session await) cleared; next blocker `/calls/[id]` client-hook → Section 5 route work.

## Known starting facts (from plan §1, to verify not assume)

- Signed-in layout awaits session+admin before rendering entire tree.
- `/dashboard` = static placeholder cards, no metrics fetch.
- Most SSR list/detail pages await data before headings.
- `/agents/new` Suspense without visible fallback; `/jobs` whole-page text fallback.
- Initial search: no explicit full/imperative prefetch — confirm wrappers in Task 11.
- OpenNext selects R2 incremental-cache handler but `NEXT_INC_CACHE_R2_BUCKET` binding missing in Wrangler — Task 19.
- Cache Components Activity preservation needs voice-copilot attention — Task 18.

## Exceptions (temporary opt-outs — must be removed before completion)

_None yet. Log here with reason + removal Task._

## Evidence log

Each entry: route | navigation | viewport | auth role | source state | command | result | screenshot/trace.

| Date | Route | Nav | Viewport | Role | Source state | Command | Result | Artifact |
|---|---|---|---|---|---|---|---|---|
| 2026-09-09 | — | — | — | — | `778e3ffd` + dirty tree on `feat/next-skills-adoption` | `git status`, `git diff --stat`, `find .../page.tsx`, `cat .next/dev/lock` | Baseline captured, dev server `http://localhost:3000` per lock | this file |
| 2026-09-09 | `/settings` | hard open via worktree session `next-dev-loop-ef2b914badef` | headed Chrome default | signed-in dev bypass (existing server state) | `778e3ffd` + dirty on `feat/next-skills-adoption` | `agent-browser open http://localhost:3000/settings`, MCP `tools/list`, `get_compilation_issues`, `get_routes`, `get_errors`, `get_page_metadata`, `get_logs` | Settings heading + Account/Voice/Workspace/Services/Appearance tabs rendered; `issues:[]`; routes match 17 filesystem pages; `configErrors:[] sessionErrors:[]`; segments identify `(dashboard)/layout` + `settings/page`; log path `.next/dev/logs/next-development.log`; session closed (state saved) | this file |
| 2026-09-09 | `/login`, `/` | isolated prod `next start :3100` (temp candidate) | Desktop 1280×800 + mobile 390×844 | signed-out (no DB; placeholder fails soft) | `HEAD=778e3ffd files=74 hash=2cb8ef8207cda8f2` | `npm run test:e2e:instant` | 4/4 pass; build logged `✓ exposeTestingApiInProductionBuild`; dev `:3000` still 200; temp cleaned | `voni/instant-nav.rig.md` |
| 2026-09-09 | `/dashboard`, `/settings`, `/login`, `/`, `/agents`, `/agents/new` | dev browser (worktree session) + MCP | headed Chrome default | dev bypass / signed-in header | `feat/next-skills-adoption` worktree | open + snapshot + `get_compilation_issues` + `get_errors` | Task 8: shell streams pending→authenticated, voice unlocks, no errors. Task 9: `/login`→dashboard redirect under bypass; landing shows only Open dashboard + hero; footer-year leaf streams. Settings: heading + 5 tabs + account panel, no errors (fixed RSC import of SETTINGS_TABS via `@/lib/settings-tabs`). Agents/new: frame + timeline + goal steps render, draft intact. | this file |

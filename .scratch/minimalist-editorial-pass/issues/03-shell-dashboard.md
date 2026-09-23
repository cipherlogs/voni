# 03: Shell and dashboard in the editorial language

**What to build:** The app frame plus its home: the vendored sidebar idiom (brand slot, rail, utility rows for search, voice, and jobs status, collapse contract, single-identity footer) with suspense resolver, static shell, and remembered collapse intact; the dashboard as flat outcome Tiles with honest drill-down links plus text-focused setup steps with the shared step indicator.

**Blocked by:** 01 (foundation — serif amendment, token sweep, motion unification).

**Status:** done

- [x] Shell preserves auth resolution, provider ordering, active-link highlight, jobs count badge semantics, and command and voice entry rows; styling only, no top-bar reintroduction
- [x] Dashboard outcome Tiles link to lists on the same grain and predicate as the numbers they show; first-run setup rows are text-focused with filled-versus-muted step states and retargeted indent
- [x] Card predicates and their linked lists agree (worked, connected, booked, handoff); empty campaigns surface a next action, not a dead end
- [x] Running-app check on shell plus dashboard (expanded rail, collapsed rail, mobile drawer, light and dark themes, forced loading and error states) with zero compile or console errors

## Evidence

- `voni/src/lib/shell-dashboard.test.ts` (4 tests, green): shell idiom pin
  (provider order auth/jobs/voice/sidebar, static-shell resolver with null
  fallback, defaultOpen + SidebarStateRestore, max-w-6xl + gap-6 content,
  no top bar, utility rows with command + voice + jobs) plus dashboard
  Tile grammar (single-column-first gap-6 grids, h-full + p-8 + flex-1 +
  mt-auto footers, hover/focus-within breath on the shared standard,
  tracking-tight tabular numbers, token-only text, honest hrefs +
  predicates, text-focused setup with StepIndicator + pl-12, next-action
  card sharing p-8, funnel links on DB casing). Shell needed no markup
  move — already conformant, pinned against regression. Wired into
  `voni/package.json` test script; full suite 541 pass.
- `voni/src/app/(dashboard)/dashboard/page.tsx` (markup-only): outcome +
  funnel grids to `grid-cols-1 gap-6 sm:grid-cols-2…`, Cards to h-full +
  py-0 with hover/focus-within breath, Content to flex-1 + gap-3 + p-8,
  numbers gain tracking-tight, footers gain mt-auto, next-action panel to
  p-8. Queries, hrefs, predicates, Suspense, and skeletons untouched.
- `tsc --noEmit` clean; `npm run lint` 0 errors (2 pre-existing warnings
  on untouched lines); §5 greps clean except listed survivors.
- Running app (dev :3000, agent-browser): `/dashboard` 200 first-run
  setup path; expanded rail, collapsed rail (Expand label +
  aria-expanded), 390px drawer via ⌘B, light + dark media, all with zero
  console errors and no overflow (1280/1280, 390/390); loading.tsx
  (StatGridSkeleton) + error.tsx (RouteError + retry) verified via pins;
  full forced-state matrix stays ticket 09's backstop.
- Code review: standards clean (Tile wording follows the ticket +
  DESIGN.md gap-table usage; shadow hover is the §10b Tile language, not
  new elevation); dead `group` class and next-action p-6 removed per
  review; commit on `redesign/minimalist-editorial-pass` (this change).

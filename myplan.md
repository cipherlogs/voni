# Voni: complete Next.js skills adoption and shadcn compliance plan

## 1. Outcome and agreed decisions

Apply these skills across the Voni app:

1. `next-dev-loop`
2. `next-cache-components-adoption`
3. `next-cache-components-optimizer`
4. `next-partial-prefetching-adoption`
5. `shadcn-ui`, governed by the project’s more specific `shadcn` workflow

Complete the work on one local branch, with reviewable checkpoints. Do not push, create PRs, deploy, or provision production resources.

The finished app must:

- Render meaningful page structure immediately, including on direct visits.
- Preserve authentication, authorization, organization isolation, and creator-scoped jobs.
- Stream fresh private data into focused loading regions.
- Preserve unsaved forms and wizard progress when navigating away and returning.
- Keep global jobs and voice state stable across signed-in navigation.
- Use the existing Base Nova design and official `@shadcn` components.
- Include automated production-mode tests that guard instant navigation.
- Pass development runtime verification and a local Cloudflare compatibility check.

Generic navigation, branding, headings, and loading placeholders may appear before authentication completes. Personal information, record data, operator controls, and authenticated operations must remain protected.

### Confirmed starting state

The planning inspection found:

| Area | Current state |
|---|---|
| App directory | `voni/src/app` |
| Next.js | `16.3.4` |
| OpenNext Cloudflare | `1.20.6` |
| Better Auth | `1.7.2`, Google-only authentication |
| Development bundler | Turbopack |
| Browser tooling | `agent-browser 0.36.0` |
| Development server | Existing server recorded at `http://localhost:3000` |
| Cache Components | Not enabled |
| Partial Prefetching | Not enabled |
| shadcn | Base UI, `base-nova`, Lucide, Tailwind v4 |
| Installed UI components | 23, including Sidebar, Skeleton, Card, Dialog, Sheet and Sonner |
| Page routes | 17, including `/operator` |
| Production navigation tests | No existing app-owned Playwright rig found |
| Git state | Substantial tracked and untracked work already present |

The current development server reported no compilation or runtime errors during the planning inspection, and Settings opened in the browser. This is not a production-build or whole-app verification result.

Important implementation facts:

- The signed-in layout awaits session and admin checks before rendering its entire tree.
- `/dashboard` contains static placeholder cards. It does not currently fetch dashboard metrics.
- Most server-rendered list/detail pages await their data before returning their headings.
- `/agents/new` wraps its client content in Suspense without a visible fallback.
- `/jobs` wraps its whole client page in a text-only fallback.
- The initial source search found no explicit full-prefetch or imperative-prefetch calls. Confirm wrappers before treating that inventory as complete.
- OpenNext selects its R2 incremental-cache handler, but Wrangler does not define that handler’s `NEXT_INC_CACHE_R2_BUCKET` binding.
- Cache Components introduces Activity-based page preservation. Hidden pages and their retained DOM require particular attention in the voice copilot.

## 2. Execution rules and preparation

### Task 1: establish a recoverable starting point

Before editing:

1. Read root `AGENTS.md`, `voni/AGENTS.md`, and the current `HANDOFF.md` Status.
2. Capture the current branch, HEAD, `git status`, tracked diff, and untracked-file inventory.
3. Record which planned files already contain user changes.
4. Create one implementation branch without discarding the dirty checkout.
5. Preserve untracked operator and jobs files. They are part of the current app.
6. Do not reset, clean, automatically stash, or commit unrelated work.
7. Do not hand-edit generated copilot manifest content or the managed Next.js AGENTS block.

Use the current working tree as the functional baseline. Historical specifications explain intent but must not overwrite newer implementation decisions.

Create these implementation artifacts when execution begins:

- `voni/docs/next-skills-adoption.md`: route inventory, phase status, exceptions, and evidence.
- `voni/instant-nav.rig.md`: exact production-test setup and commands.
- `voni/docs/shadcn-audit.md`: concrete component findings and their disposition.

Each evidence entry must identify the route, navigation, viewport, authentication role, tested source state, command, result, and relevant screenshot or trace.

### Task 2: load the correct instructions

Read the requested skills completely.

For frontend work, apply the project’s UX protocol in this order:

1. `strategyUX`
2. `leanUX`
3. `everydayUX`
4. `lawUX`

Use these to preserve task completion, discoverability, feedback, and error prevention. This is a compliance and loading-behavior change, not a redesign.

Before each relevant Next.js refactor, read the installed bundled documentation for:

- Migrating to Cache Components
- Authentication with Cache Components
- Streaming
- Instant navigation
- Adopting Partial Prefetching
- Preserving UI state
- `use cache`
- Route-segment `instant` and `prefetch`
- `PageProps` and `LayoutProps`

Resolve actual paths beneath `voni/node_modules/next/dist/docs/`.

For every distinct Next.js error encountered, fetch its linked `/docs/messages/<slug>.md` page. Apply the documented recipe rather than guessing from the abbreviated error.

### Task 3: establish development verification

Reuse the server identified by `.next/dev/lock` and its process/banner. Do not start a duplicate.

Run `agent-browser skills get core`, then derive a worktree-scoped session:

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix next-dev-loop)"
export AGENT_BROWSER_RESTORE="$AGENT_BROWSER_SESSION"

agent-browser --session "$AGENT_BROWSER_SESSION" --restore \
  --headed --enable react-devtools open http://localhost:3000/settings
```

Discover `/_next/mcp` through `tools/list`. Confirm:

- `get_compilation_issues` works with Turbopack.
- `get_routes` matches the filesystem inventory.
- `get_errors` is usable after browser navigation.
- `get_page_metadata` and `get_logs` identify the current route and diagnostics.

After each coherent app edit:

1. Check compilation issues.
2. Compile or visit the affected route.
3. Exercise the changed behavior in the browser.
4. Inspect runtime errors.
5. Inspect React state, effects, or Suspense when their behavior changed.

If prerequisites fail, stop dependent app edits and report the exact prerequisite. Do not substitute source searches for runtime verification.

## 3. Build the production verification rig first

### Task 4: isolate builds and test data

Create a local production-mode test runner.

The runner must:

- Build and serve a separate test copy of the current app.
- Exclude `.git`, `.next`, `.open-next`, local environment files, browser state, and existing artifacts when constructing that copy.
- Include current tracked modifications and relevant untracked source files.
- Use the lockfile and `npm ci`.
- Leave the user’s running development server and `.next` directory untouched.
- Record a source-content fingerprint because HEAD alone does not identify the dirty baseline.
- Own and clean up its server process group.
- Fail on a occupied test port rather than attaching to an unknown server.

Use:

- `http://localhost:3100` for the local Next production server.
- `http://localhost:3101` for local Cloudflare preview.
- A separate temporary build directory for each candidate or differential run.

`next start` is acceptable here as a local framework test server. It does not replace the Cloudflare production target.

### Test configuration

Add a test-only condition to `next.config.ts`:

```ts
experimental: {
  exposeTestingApiInProductionBuild:
    process.env.VONI_INSTANT_TEST_BUILD === "1",
}
```

Merge this with existing configuration. Preserve the `.dev.vars` loading behavior and OpenNext development initialization.

The test runner sets the variable during the build. Ordinary builds leave it unset.

Add:

- A pinned, compatible `@next/playwright` release on the installed Next.js release line.
- `@playwright/test`.
- Chromium installation instructions.
- A Playwright configuration with zero retries for instant-navigation tests.
- Desktop `1280 × 800` and mobile `390 × 844` projects.

If a matching testing package is unavailable, stop this phase. Do not replace `instant()` with elapsed-time assertions.

Expose reproducible npm commands:

| Command | Responsibility |
|---|---|
| `test:e2e:instant` | Build isolated candidate, prepare fixtures, run instant-navigation suite, clean up |
| `test:e2e:behavior` | Run authentication, state-preservation, jobs, and UI regressions against isolated production build |
| `test:e2e:cloudflare` | Build and exercise local OpenNext preview |
| `test:e2e` | Run the complete sequence |

Keep `npm test` as the existing Node test suite. Do not replace it with Playwright.

### Task 5: authenticate with real test sessions

Use a dedicated Neon test database because the app uses the Neon HTTP driver. Do not assume a plain local PostgreSQL container is a compatible replacement.

Required test inputs:

- `E2E_DATABASE_URL`
- An explicit expected test database hostname/database identifier
- A test-only Better Auth secret
- Test origin URLs
- A run identifier

The runner must refuse a database whose identity does not match its explicit test allowlist. It must not fall back to the app’s ordinary `DATABASE_URL`.

Fixture setup must:

1. Apply existing migrations only to the isolated test database.
2. Create two organizations.
3. Create an owner and member in organization A.
4. Create a user in organization B.
5. Create an allowlisted operator user.
6. Precreate memberships and workspaces to avoid first-login initialization during rendering tests.
7. Create real Better Auth session rows and correctly signed session cookies.
8. Generate separate Playwright storage states for each role.
9. Confirm each session through the app’s normal session endpoint before testing protected pages.

Use the installed Better Auth adapter/session implementation and cookie serialization utilities from test scripts. Keep session creation outside the application’s routes.

Do not enable email/password authentication, add a test-login endpoint, or relax `devBypassEnabled()`.

Create isolated fixture records for agents, campaigns, leads, calls, and jobs. Include two distinct IDs for every detail route and at least one empty organization state.

Never print cookies, session tokens, or connection strings. Delete only run-owned fixture IDs during cleanup.

If test database credentials are unavailable, report that prerequisite and leave the authenticated production-test gate incomplete.

### Task 6: prove that the navigation tests are trustworthy

Use `instant()` from `@next/playwright`.

For each target:

1. Verify the destination and marker without the lock, using the same role and navigation type.
2. Run the locked assertion.
3. Confirm a failure is caused by delayed shell rendering, not authentication, a missing fixture, a hidden selector, or a stale build.
4. Optimize only after the failure is understood.
5. Rebuild and rerun unchanged assertions.
6. For actual optimizations, remove only the optimization in an isolated comparison copy, reproduce the failure, then restore it and reproduce success.

Example soft-navigation contract:

```ts
await instant(page, async () => {
  await dashboardLink.click();
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
});
```

For a route with genuinely deferred content, also verify that content is withheld under the lock and becomes visible after release.

For hard navigation, use `page.goto()` inside `instant()` with `baseURL`. Reload without the lock before checking resolved content; do not assume the initially locked document resumes streaming after release.

Do not add hover warming, retries, arbitrary delays, or weakened selectors to force a pass.

If a navigation already passes, retain its guard and record “already instant.” Do not manufacture a performance defect. Prove lock engagement with a genuinely deferred route elsewhere in the same build.

## 4. Adopt Cache Components and refactor the shared layout

### Task 7: enable Cache Components

Use the direct, one-branch adoption strategy.

1. Set top-level `cacheComponents: true`.
2. Keep `partialPrefetching` disabled.
3. Search for incompatible segment exports and legacy flags.
4. Translate any discovered `revalidate` or `fetchCache` behavior using bundled documentation.
5. Remove `force-dynamic` only according to its documented migration.
6. Resolve root and shared-layout blockers before individual pages.

Do not run the blanket `cache-components-instant-false` codemod for this selected strategy.

Temporary opt-outs, if required during diagnosis, must remain in the work queue and be removed before completion. No blanket ancestor `instant = false` may hide unverified descendants.

### Data freshness policy

This migration does not add persistent caching for:

- Sessions or membership checks
- Operator authorization
- Organization settings
- Agents and deployment status
- Campaign readiness or dispatch status
- Leads and call records
- Credentials or platform status
- Jobs, unread results, or voice preferences

Keep these reads fresh behind Suspense.

Do not introduce `use cache: private`, `use cache: remote`, guessed cache lifetimes, new cache tags, or new invalidation systems for private data.

Pure synchronous markup and existing constants need no cache directive.

Use request-local React memoization only where repeated server reads actually need deduplication. It does not make request data static and must not become a module-global session cache.

### Task 8: separate the generic layout from authentication

Refactor `voni/src/app/(dashboard)/layout.tsx` so its top level returns the shared layout synchronously.

Preserve:

- Desktop icon rail and mobile Sheet behavior
- Existing content width and spacing
- JobPill bottom clearance
- Header voice and jobs entry points
- Existing ViewTransition behavior
- Stable JobsProvider and CopilotProvider instances across signed-in navigation

Implement a narrow client authentication-state context for the persistent layout:

```ts
type ShellAuthState =
  | { status: "pending" }
  | {
      status: "authenticated";
      user: {
        id: string;
        name: string;
        email: string;
        image: string | null;
      };
      platformAdmin: boolean;
    }
  | { status: "unavailable" };
```

This context controls presentation and provider readiness. It never authorizes server operations.

Implement the following flow:

1. The synchronous layout renders its generic frame and children.
2. A server authentication resolver runs inside a dedicated Suspense boundary.
3. The resolver performs the existing session and operator checks.
4. Missing sessions follow the existing safe login redirect.
5. Successful resolution renders a small client bridge that supplies the narrow snapshot to the stable shell context.
6. The bridge updates context after commit, never during another component’s render.
7. Equivalent snapshots do not repeatedly reset provider state.
8. A resolver error leaves authenticated capabilities disabled and renders recoverable feedback through an appropriate error boundary.

Do not add a second browser session fetch merely to populate this new context.

Split the sidebar so branding and ordinary navigation render without user information. Keep the account menu, avatar details, sign-out, and operator navigation behind authenticated state.

Add an explicit readiness input to the existing global providers:

```ts
JobsProvider: { children; enabled: boolean }
CopilotProvider: { children; enabled: boolean; platformAdmin: boolean }
```

While disabled:

- Jobs must not poll or submit authenticated requests.
- Copilot must not request tokens, acquire the microphone, or execute tools.
- Header controls must explain that the session is loading.
- Navigation remains usable.
- No previous user’s jobs, transcript, proposals, or identity may appear.

After authentication:

- Enable existing behavior once.
- Preserve provider instances on route changes.
- Clear user-specific state on sign-out or identity change.
- Invalidate pending proposals before another identity can act.

Audit private server reads independently. Rendering children beside a deferred layout guard is safe only because each private data function, action, and route handler verifies authorization itself.

Add `/jobs` to the existing proxy’s protected-prefix and matcher lists so its early redirect behavior matches the other signed-in routes. Keep cookie presence as an optimistic check; retain real server session validation.

### Task 9: retain authentication behavior

Preserve the existing client redirect component on `/login` and `/signup`.

Keep:

- `safeNextPath`
- Query-string preservation
- OAuth error messages
- Visible redirect feedback
- Direct fallback navigation
- Signed-in and signed-out landing-header actions

Do not restore the previous problematic async Server Component redirect path on these auth pages.

Move the landing page’s session-dependent header controls behind their own boundary so the hero and feature content do not await authentication.

Handle the footer’s current-year read separately if validation reports it. Use a small request-time footer leaf rather than making the entire landing page dynamic or inventing a fixed year.

## 5. Route-by-route implementation specification

For every server page:

- Keep URL-independent structure synchronous.
- Forward `params` and `searchParams` promises without awaiting them at the page root.
- Await them only inside the relevant Suspense child.
- Keep record names, counts, permissions, and data-derived briefs inside authorized data regions.
- Reuse existing skeleton primitives.
- Render common structure once, outside the boundary.
- Give each substantial pending region accessible loading text and a visible wrapper.
- Preserve resolved content, ordering, links, and actions.

Use the following route contract.

| Route | Immediate structure | Deferred content and required behavior |
|---|---|---|
| `/` | Branding, hero, feature layout, demo frame | Session-dependent header actions; demo remains user-started and tool-free |
| `/login` | Auth-page frame and loading feedback | Session decision, safe destination, OAuth error/form or authenticated redirect |
| `/signup` | Auth-page frame and loading feedback | Same protections as login, preserving signup copy |
| `/dashboard` | Existing heading, nine stage cards, recent-activity placeholder | Shared authenticated controls only; do not invent metrics |
| `/agents` | Heading, description, New agent link | Authorized list or Empty state; count-based RouteBrief after data |
| `/agents/new` | Back link, stable New agent heading and wizard frame | Job restoration and configuration-dependent content; retain draft, review and confirmation behavior |
| `/agents/[id]` | Back navigation and detail frame | Authorized agent name, config, deployment status, editing and test card |
| `/campaigns` | Heading, description, creation link | Authorized campaign list and states |
| `/campaigns/new` | Heading, back navigation, form frame | Agent options and dependent form controls |
| `/campaigns/[id]` | Existing URL-independent navigation and section structure | Authorized campaign, dispatch readiness, lead rows and controls |
| `/leads` | Heading, introduction and table structure | Authorized rows, counts, or Empty state |
| `/leads/[id]` | Back navigation and detail structure | Authorized identity, consent, pipeline and state information |
| `/calls/[id]` | Existing back navigation and detail structure | Authorized call data and currently implemented details |
| `/numbers` | Heading and number-management structure | Numbers, available agents, assignment controls |
| `/jobs` | Heading, filter/search structure and status layout | Creator-scoped rows and URL-selected search results |
| `/settings` | Heading and existing tab structure | Account/workspace values, permissions, voice preferences, service readiness |
| `/operator` | Generic operator-page frame | Authorization decision first; administrative content only after allowlist validation |

### Special handling

**Settings**

Split structural markup from fetched props. Disabled/loading controls must not initialize with fake workspace values.

Preserve dirty inputs when unrelated service readiness finishes loading. Avoid changing keys or replacing the entire form after an independent boundary resolves.

**Agent creation**

Move the stable outer frame outside the current empty Suspense boundary. Keep `useSearchParams()` and `?job=` restoration inside the URL-dependent region.

Do not rebuild the wizard, reorder steps, restore removed preview UI, or change generation/save contracts.

**Jobs**

Move the page heading outside the current whole-page fallback. Keep URL-dependent record-search presentation isolated from ordinary jobs navigation and filtering.

**Detail routes**

Use real generic structure as the shell. Keep the eventual record name as the resolved heading rather than inventing a replacement title.

Test two records on the same route pattern so a reused shell cannot retain the previous record’s name, brief, or controls.

**Missing and unauthorized records**

Preserve `notFound()` or the existing denial behavior inside the authorized leaf.

Verify the rendered result and absence of private content. Streaming can affect HTTP status timing; do not claim an HTTP 404 solely because the not-found UI appears.

### Feature completion gate

Process features in this order:

1. Root and shared layout
2. Public/auth routes
3. Dashboard and Settings
4. Agents
5. Campaigns
6. Leads and calls
7. Numbers
8. Jobs
9. Operator

Each feature requires:

- Clean development runtime verification
- Appropriate production instant-navigation tests
- Resolved-content parity
- A passing complete `next build` before moving beyond the feature checkpoint

Use scoped debug builds to diagnose failures, not to replace the complete build gate.

## 6. Optimize navigation and adopt Partial Prefetching

### Task 10: optimize meaningful shells

Start with `/settings` to `/dashboard`, then apply the same process to every route in the matrix.

For desktop soft navigation, assert:

- The destination’s real shell marker appears under `instant()`.
- Shared sidebar and header remain visible.
- Navigation does not reset global jobs or copilot state.

For mobile:

- Open the actual mobile navigation.
- Click the real destination link.
- Assert the destination shell and mobile header.
- Confirm the navigation Sheet does not trap focus after navigation.

Use markers such as `dashboard-shell`, `agents-shell`, and `settings-shell` on meaningful, visible elements. Do not place markers on empty wrappers solely to satisfy tests.

For each data-backed route, maintain a distinct content marker for its deferred region.

Keep the shell responsive at both test widths. Reuse layout structure between pending and resolved states so skeletons do not duplicate and drift from the page.

### Task 11: audit all prefetch behavior with the flag off

Audit the entire source tree:

- Direct `next/link` imports
- Re-exports
- Link wrappers
- Spread props
- Base UI `render={<Link ... />}` composition
- Bare `prefetch`
- Conditional `prefetch` values
- `router.prefetch()`

Record source, destination pattern, effective prefetch behavior, and expected immediately available UI.

The initial search found no full-prefetch sites. If the complete audit confirms zero:

- Record that there is no legacy full-prefetch preservation contract.
- Keep the optimizer suite as the flag-off baseline.
- Proceed to global adoption without manufacturing route exports or codemod work.

If full-prefetch sites are discovered:

1. Select the existing UI contract to preserve.
2. Run its unchanged preservation tests successfully with the flag off.
3. Add temporary `export const prefetch = "partial"` to each audited server destination.
4. Restore the agreed behavior without weakening authorization or inventing private-data freshness.
5. Rerun the complete preservation suite before global enablement.

Default prefetch policy for this project:

- Prefetch generic shared shells.
- Stream private and operational data after navigation.
- Do not add per-record full prefetching.
- Preserve explicit opt-outs until their reason has been verified.
- Verify imperative prefetch separately if discovered.

### Task 12: enable Partial Prefetching

After Cache Components builds and the flag-off suite passes:

```ts
cacheComponents: true,
partialPrefetching: true,
```

If temporary route-level partial-prefetch exports were introduced, remove them using:

```bash
npx @next/codemod@canary remove-partial-prefetch ./src/app
```

Run this only in an isolated implementation copy or against explicitly protected edits. Do not force a codemod over unrelated dirty work.

Check the reported files. A zero-file result is valid only when the inventory confirms no matching exports existed.

Then:

1. Rebuild the production candidate.
2. Run the unchanged instant/preservation suite.
3. Visit every route in development.
4. Resolve URL-data insights and newly exposed prerender errors.
5. Exercise multiple record IDs and relevant query-string variants.
6. Verify actual production prefetch requests and successful subsequent navigation.
7. Check for repeated prefetch requests, stuck fallbacks, and stale URL-specific content.

Do not enable `experimental.requestInsights` expecting it to report prefetch-validation issues. Use the actual error/insight tools and development logs.

## 7. Apply shadcn compliance throughout the app

### Task 13: audit and install only required components

Preserve:

- Base UI
- Base Nova
- Current colors, typography, logo, density, and responsive structure
- `@/components/ui` aliases
- Lucide icon imports

Run the project-context command from `voni/`:

```bash
npx shadcn@latest info --json
```

For each missing component:

1. Search official `@shadcn`.
2. Read its CLI-provided documentation and examples.
3. Preview affected files.
4. Install explicitly from `@shadcn`.
5. Review generated files, dependencies, aliases, and composition.
6. Verify affected pages at runtime.

Expected additions include Field, Input Group, Toggle Group, Empty, Toast, and the chat components required by existing transcript UI. Install supporting dependencies selected by their registry items.

Do not run `init`, change presets, perform a Radix migration, or use `--all --overwrite`.

### Task 14: correct forms and composition

Apply these rules across route components and shared feature components:

- Use `FieldGroup`, `Field`, labels, descriptions, and errors for forms.
- Preserve field names, IDs, controlled/default values, validation, and submission payloads.
- Use `InputGroupInput` or `InputGroupTextarea` inside InputGroup.
- Convert actual bounded selection sets of 2–7 choices to ToggleGroup.
- Keep action buttons as buttons; do not turn goal starters or “apply” commands into selection controls unless they actually represent selection.
- Place Select and DropdownMenu items inside their required groups.
- Preserve Base UI `render=` composition.
- Keep `nativeButton={false}` where Button renders an anchor.
- Ensure dialogs and sheets have accessible titles.
- Preserve Avatar fallbacks.
- Use proper Card subcomponents where the content has a title, description, body, or actions.

The installed project currently has raw Label/control wrappers and some ungrouped menu/select items. Treat the source search as a candidate inventory and verify each case against its actual component context.

The form structure follows the official [Field documentation](https://ui.shadcn.com/docs/components/base/field).

### Task 15: correct styling without redesign

- Replace application-level `space-x/y` stacks with explicit flex/grid gaps.
- Use semantic color tokens.
- Remove application-level manual dark-color overrides.
- Replace raw voice-call button colors with the appropriate semantic variant.
- Use `size-*` for equal dimensions.
- Use `cn()` for conditional class composition.
- Add `data-icon` to component-contained icons and remove redundant icon sizing overrides.
- Move repeated non-layout component styling into an appropriate component variant.
- Preserve custom brand graphics, voice visualizations, and structural HTML.

Do not mechanically rewrite upstream primitive internals because a grep matches their native HTML or special layout mechanics. Record verified upstream exceptions separately from application violations.

### Task 16: replace Sonner usage with the Base UI toast component

The project’s `shadcn` workflow requires the Base UI toast implementation.

Install official Toast, replace the root Toaster, and migrate application call sites:

- Success/error/info calls retain their existing text.
- Descriptions retain their content.
- Action buttons retain their destinations and callbacks.
- Existing notification IDs and deduplication behavior remain equivalent.
- Durable job completion still produces one notification according to existing seen/unread behavior.
- Never use `toast.promise()` to keep long work alive.

Use the documented `toast.add()` and action API. Remove the Sonner component and dependency only after all consumers are migrated and tests pass. See the official [Toast documentation](https://ui.shadcn.com/docs/components/base/toast).

### Task 17: migrate existing conversation presentation

For actual conversation/transcript lists:

- Use MessageScroller for scrolling and follow behavior.
- Use Message and Bubble for conversation entries.
- Use Marker for system events where applicable.
- Preserve speaker labels, partial/final transcript handling, and accessible names.
- Remove replaced manual scroll-to-bottom effects.
- Preserve a user’s position while reading older content.
- Provide the component’s jump-to-latest control.

Do not convert job cards, proposal forms, or record results into chat bubbles.

Do not change voice transport, audio scheduling, microphone ownership, or AssemblyAI API parameters. This task changes presentation only. The scrolling behavior comes from the official [MessageScroller documentation](https://ui.shadcn.com/docs/components/base/message-scroller).

## 8. Preserve drafts, jobs, and voice behavior under Activity

### Task 18: define retained-page behavior explicitly

Keep:

- Unsaved settings inputs
- Wizard draft and active step
- List filters
- Meaningful scroll position

Reset:

- Transient dropdowns and popovers when hidden
- Successful creation forms after submission
- Obsolete success/error feedback when its lifecycle ends
- Pending voice confirmations when their target route or snapshot is invalid
- Record-specific state when changing to another record

Do not key the entire signed-in layout by pathname. That would reset global jobs and voice state.

Review effect cleanup/restart behavior because Activity hides pages while retaining state and DOM.

### Voice coverage requirements

Hidden pages must not remain discoverable or operable by copilot.

Verify:

- Catalog building excludes hidden Activity content.
- Numeric references remain bound to the active route and snapshot.
- Leaving a route invalidates its pending mutation target.
- Returning creates a fresh registration/catalog snapshot.
- Deferred RouteBrief content never announces another record’s data.
- Global copilot survives ordinary signed-in navigation.
- Page-local test calls and audio follow their existing cleanup behavior.
- Reappearing pages do not automatically restart microphones or replay commands.

If coverage metadata changes, run:

```bash
npm run copilot:manifest
npm run copilot:manifest:check
```

Audit all 17 actual routes. Public/auth pages remain outside tool-enabled signed-in copilot access, and operator controls remain role-restricted.

### Durable jobs requirements

Preserve the existing shared job system and contracts:

- Immediate durable acceptance
- Existing job ID and duplicate-submission handling
- Global status and completion destinations
- Creator scoping
- Retry/cancel behavior
- Navigation/reload recovery
- Sanitized failures
- The existing three-second background-work message

Test that retained pages and restarted effects do not create duplicate polling loops, duplicate jobs, duplicate notifications, or repeated result navigation.

Use isolated fixture jobs and simulated voice/tool events. Do not trigger paid calls or live agent deployment to validate a UI refactor.

## 9. Cloudflare compatibility and final acceptance

### Task 19: validate the actual hosting adapter locally

Use the isolated candidate copy for OpenNext builds.

Provide a separate local-preview Wrangler configuration that:

- Retains the existing worker entrypoint.
- Uses the isolated test database and test authentication settings.
- Includes local emulated R2 under `NEXT_INC_CACHE_R2_BUCKET`.
- Keeps cache storage separate from CSV staging.
- Uses local bindings and storage.
- Does not use `--remote`.
- Does not create Cloudflare buckets, queues, environments, secrets, or deployments.

Build with OpenNext and run local preview. Verify:

- Initial HTML contains meaningful shell content.
- Private regions resolve after the shell.
- Client navigation works.
- RSC responses do not fail or hang.
- Dynamic content does not remain permanently in a fallback.
- Prefetch requests do not retry indefinitely.
- Sign-in state, access denial, and record isolation remain correct.

Cloudflare documents PPR and composable caching support, but that does not replace testing this installed adapter/version combination. See [Cloudflare’s OpenNext guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/).

If the adapter fails:

1. Reproduce against the same fixture and source state with the relevant flag off.
2. Separate an adapter problem from an app regression.
3. Check official release notes for a released compatible fix.
4. Upgrade only the required adapter dependencies if a documented fix exists.
5. Rebuild and repeat the checks.
6. If no supported fix works, report the exact blocker and leave compatibility incomplete.

Do not hide an adapter failure by disabling all prefetching or introducing broad blocking opt-outs.

### Task 20: execute the complete acceptance matrix

| Area | Required scenarios |
|---|---|
| Navigation | All 17 page routes; hard and real-Link soft navigation; desktop and mobile |
| Main target | Settings to Dashboard, including mobile navigation |
| Authentication | Signed out, valid session, expired session, malformed cookie, sign-out, refresh and Back |
| Redirects | Safe internal `next`, preserved query, unsafe external destination rejected |
| Authorization | Owner, member, another organization, operator, non-operator |
| Record isolation | Two IDs per detail pattern; unauthorized ID; missing ID |
| Loading | Shell visible while data is gated; actual content after unlocked rendering; no blank/stuck region |
| Forms | Unsaved values survive navigation; successful submission resets appropriately; validation and focus retained |
| Jobs | Navigation away, reload, duplicate submission, failure, retry, cancel, reconnect, completion elsewhere |
| Voice | Hidden-page exclusion, stale-reference rejection, confirmed mutations, route-brief accuracy |
| Notifications | Correct text/actions and no duplicate completion alerts |
| UI | Keyboard navigation, focus return, disabled states, mobile Sheet, light/dark appearance |
| Responsive layout | Shell and resolved states at 390, 768, 1280 and 1440 pixels |
| Hosting | OpenNext build and local Worker preview |

For responsive checks, allow intentional table scrolling but require no unintended document-level horizontal overflow. Confirm JobPill and copilot controls do not obscure trailing form actions.

Run the final repository gates:

```bash
npx tsc --noEmit
npm run lint
npm test
npm run copilot:manifest:check
npm run build
npm run test:e2e
git diff --check
```

Run builds in the isolated build environment so the existing development server remains undisturbed.

Do not claim live speech recognition, owner-device audio, real Google OAuth, or deployed Cloudflare Queue delivery from browser simulations or fixture sessions. Record those boundaries separately.

### Completion criteria

The implementation is complete only when:

- Both requested Next.js flags are enabled.
- Every actual page has a recorded shell/content contract.
- No unexplained Cache Components opt-outs remain.
- No unresolved prerender or URL-data insights remain.
- All required production navigation tests pass without retries.
- Actual optimizations have trustworthy before/after evidence.
- Authentication and private-data isolation pass.
- Drafts, jobs, voice references, and notification behavior pass their regression scenarios.
- The shadcn audit has no unresolved application-level violations.
- OpenNext local compatibility passes.
- Existing checks pass.
- Unrelated starting work remains intact.

Update only the handoff’s editable Status section with Now, Next, and Why. Do not hand-edit its Activity Log.

Finish with a route-results table showing what appears immediately, what streams, and any precisely bounded external verification still outstanding. Leave the branch local and the development server running.

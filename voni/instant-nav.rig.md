# Voni instant-navigation production test rig

> Exact setup + commands. Isolated candidate copies only — never disturbs running `next dev` or its `.next`.

## Decisions (from `myplan.md` Tasks 4–6, user answers 2026-09-09)

- Test servers: `http://localhost:3100` (Next production), `http://localhost:3101` (Cloudflare preview). Fail on occupied port, never attach to unknown server.
- Separate temp build dir per candidate/differential run. Own + clean up server process group.
- Copy excludes: `.git`, `.next`, `.open-next`, local env files, browser state, existing artifacts. Includes: tracked modifications + relevant untracked source files. Uses lockfile + `npm ci`.
- Source fingerprint recorded per run (HEAD alone insufficient for dirty baseline).
- `next start` acceptable as local framework test server only; Cloudflare target validated separately via OpenNext preview.
- Test-only `next.config.ts` condition (merge, preserve `.dev.vars` + OpenNext dev init):
  ```ts
  experimental: {
    exposeTestingApiInProductionBuild:
      process.env.VONI_INSTANT_TEST_BUILD === "1",
  }
  ```
  Runner sets it at build; ordinary builds leave unset.
- Playwright: pinned `@next/playwright` on installed Next line + `@playwright/test`, Chromium install notes, zero-retries config, projects Desktop `1280×800` + mobile `390×844`.
- If matching testing package unavailable: STOP, do not replace `instant()` with elapsed-time asserts.
- Auth: dedicated Neon test DB via `E2E_DATABASE_URL` + explicit expected hostname/DB id + test Better Auth secret + origins + run id. Refuse on identity mismatch, never fall back to `DATABASE_URL`. Sessions via installed Better Auth adapter/cookie utils outside app routes. No email/password, no test-login endpoint, no `devBypassEnabled()` relax. No cookie/token/connection-string logging. Cleanup deletes only run-owned fixture IDs.
- **STATUS 2026-09-09: E2E DB creds UNAVAILABLE (user-confirmed). Task 5 prerequisite reported; authenticated gate incomplete. Unauthenticated rig work proceeds.**

## Commands (to be added by Task 4)

| Command | Responsibility | Status |
|---|---|---|
| `test:e2e:instant` | Build isolated candidate, fixtures, instant suite, cleanup | ✅ 18 pass + 8 fixme (2026-09-09) |
| `test:e2e:behavior` | Auth/state/jobs/UI regressions vs isolated prod build | ✅ 4 pass unauthenticated; authenticated deferred on Task 5 |
| `test:e2e:cloudflare` | OpenNext build + local preview exercise | ✅ 18 pass + 8 fixme on `:3101` (2026-09-09) |
| `test:e2e` | Complete sequence | ✅ modes green individually |
| `npm test` | Existing Node suite (unchanged) | ✅ 215/215 |

## Test-only config + deps (Task 4, landed)

- `next.config.ts`: `experimental.exposeTestingApiInProductionBuild` gated on `VONI_INSTANT_TEST_BUILD === "1"` (merged, `.dev.vars` bridge + OpenNext dev init preserved). Ordinary builds leave it unset.
- `devDependencies`: `@next/playwright 16.3.4` (pinned to Next release line), `@playwright/test 1.63.0`. Chromium: `npx playwright install chromium`.
- `playwright.config.ts`: zero retries, Desktop `1280×800` + mobile `390×844` projects, `baseURL` from `PLAYWRIGHT_BASE_URL` (default `http://localhost:3100`).
- `scripts/e2e-run.mjs`: temp dir per run, excludes `.git/.next/.open-next`/local env/browser state/artifacts, overlays tracked modifications + allowlisted untracked source + rig files, `npm ci`, fingerprint (`HEAD + status + diffstat → hash`), owns/cleans process group, refuses occupied 3100/3101. Build+serve env = `bootEnv()`: ephemeral test-only `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` (boot-only, never real secrets); `DATABASE_URL` unset → placeholder fails soft to signed-out for unauthenticated pages. Any `E2E_DATABASE_URL` set aborts (Task 5 allowlist lives in fixture setup, not here).

## Trust protocol (Task 6)

Per target: unlock verify (same role/nav) → locked assert → classify failure (shell-delay vs auth/fixture/selector/stale-build) → optimize only after understanding → rebuild/rerun → isolated remove/restore comparison for real optimizations. Soft nav: `Link.click()` + shell marker inside `instant()`; hard nav: `page.goto()` + `baseURL` inside `instant()`, reload without lock for resolved content. No hover warming/retries/delays/weak selectors. Already-instant → keep guard + record "already instant", prove lock elsewhere on deferred route.

Example:
```ts
await instant(page, async () => {
  await dashboardLink.click();
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
});
```

## Runs

| Date | Candidate fingerprint | Command | Result | Notes |
|---|---|---|---|---|
| 2026-09-09 | `HEAD=778e3ffd files=74 hash=2cb8ef8207cda8f2` | `npm run test:e2e:instant` | 4/4 pass (desktop+mobile × login/landing) | Isolated build showed `✓ exposeTestingApiInProductionBuild`; dev `:3000` untouched (200); temp dir cleaned. Known scaffold bug fixed in-run: `npm exec` arg shape + wrong selectors + missing boot secret. |
| 2026-09-09 | `HEAD=778e3ffd files=74 hash=576a6b7c0ad2157a` | `npm run test:e2e:instant` (unlock + locked `instant-shell.spec.ts`) | 10 passed, 8 skipped (fixme) | Unlock-verify green for `/`, `/login`, `/signup` hard + landing→login soft. All 8 locked asserts skip with recorded toolchain cause: `React.unstable_postpone is not defined` from Next 16.3.4 lock path on stable React 19.2.8 (19.3.0 tarball also lacks it) — app change rejected, timing asserts forbidden. Fix/runner bugs fixed in-run: multi-spec argv, `process.exit`-vs-`finally` temp cleanup (stale `/tmp/voni-e2e-*` filled /tmp to 93% and broke candidate `npm ci` on workerd binary; cleaned, /tmp 9%). |

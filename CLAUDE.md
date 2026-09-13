IMPORTANT: You must load what's inside ~/.config/ai/AGENTS.md

+ Before writing AssemblyAI code, read https://www.assemblyai.com/docs/agent-instructions.md
and https://www.assemblyai.com/docs/llms.txt. The API has changed — do not rely on
memorized parameter names. also use the AssemblyAI MCP that I have installed

# Responsive async work protocol

Every user-triggered asynchronous action must give immediate feedback, and any
non-interactive operation that may exceed 3 seconds is durable background work:

- Return control to the user as soon as the server durably accepts the work
  (202 with a job id). Never rely on a component promise, useTransition,
  spinner, toast, or an open browser tab to keep long work alive.
- Work survives navigation, reload, disconnection, and browser closure through
  the shared job system (`voni/src/lib/jobs/`): global status indicator,
  completion notification, result destination, retry path, and sanitized
  failure state.
- If the user is still on the initiating page after 3 seconds, show: "This is
  continuing in the background. You can browse Voni and return when it is
  ready." If work finishes before 3 seconds and the user is still waiting,
  open its result directly without background messaging.
- Keep genuinely interactive sessions (live calls) in the foreground with
  continuous status and recovery feedback.
- Distinguish queued, running, succeeded, failed, cancelled, rate-limited, and
  permission-blocked states with text, never spinner alone. Never block global
  navigation or disable unrelated controls. Jobs are creator-scoped unless a
  feature explicitly requires workspace coordination.
- shadcn components only (Base UI `render=` composition, not `asChild`).
- Test navigation away, reload, duplicate submission, failure, retry,
  cancellation, reconnection, and completion from another page, verified
  through the Next MCP and next-dev-loop process.

Before implementing any new async feature, answer:
1. Can this exceed 3 seconds? 2. Does it require continuous user interaction?
3. What survives if the page disappears? 4. Where can the user see its status
globally? 5. Where does its result open? 6. How do failure, retry, and
duplicate submission work? 7. What user or workspace is allowed to see it?

# Next.js / frontend — do this before writing any frontend code

**If you touched `voni/` app code, you are not done until step 4's runtime check passes.**

The Next.js app is `voni/` (Next.js 16, App Router). **Your training data is
wrong about this version.** Follow all four steps below — they are the setup
from `https://nextjs.org/docs/app/guides/ai-agents` and
`https://nextjs.org/docs/app/guides/mcp`, already wired up in this repo.

## 1. Read the bundled, version-matched docs — not memory, not the web

Next ships its own docs inside the package. Before writing or reviewing any
App Router / React / frontend code, read the relevant guide under:

```
voni/node_modules/next/dist/docs/
├── 01-app/{01-getting-started,02-guides,03-api-reference}/
├── 02-pages/  03-architecture/  index.md
```

It mirrors the structure of nextjs.org/docs and always matches the installed
version, with no network request. Upgrading Next upgrades these docs. Heed
deprecation notices. `voni/AGENTS.md` holds the `<!-- BEGIN:nextjs-agent-rules -->`
block that `next dev` writes and re-adds automatically — never hand-edit inside
those markers (put project notes outside them), and commit the block with your
work rather than reverting it.

If you need a page that isn't bundled (e.g. `/docs/messages/*` error pages),
append `.md` to any nextjs.org/docs URL for plain Markdown, or use
`https://nextjs.org/docs/llms.txt` as the index.

## 2. Give yourself runtime visibility — use the `next-devtools` MCP server

`.mcp.json` registers `next-devtools` (`npx -y next-devtools-mcp@latest`). It
auto-discovers the running dev server via the `/_next/mcp` endpoint that Next 16
exposes. Start the server first (`cd voni && npm run dev`), then use its tools
instead of guessing:

- `get_errors` — current build, runtime, and type errors
- `get_logs` — path to the dev log file (browser console + server output)
- `get_page_metadata` / `get_project_metadata` — routes, components, rendering
  info, project config, dev server URL
- `get_routes` — all filesystem entry points, grouped by router type
- `get_server_action_by_id` — resolve a Server Action ID to its source
- `get_compilation_issues` — project-wide bundler warnings/errors (Turbopack)
- `compile_route` — compile one route on demand without an HTTP request, by
  `routeSpecifier` (`/leads/[id]`) or `path` (`/leads/abc`) (Turbopack)

`get_compilation_issues` / `compile_route` tell you whether code compiles
without running a full `next build`.

Two more runtime signals that need no tooling:
- `next dev` forwards browser console warnings and errors to the terminal
  (`logging.browserToTerminal`, default `'warn'`), so client-side failures show
  up in the output you already read.
- `voni/.next/dev/lock` holds the running server's PID, port, and URL. **Connect
  to the existing dev server; do not start a duplicate.** A second `next dev`
  just prints that URL and PID.

If the MCP server won't connect: confirm Next ≥ 16, confirm `next-devtools` is
in `.mcp.json`, make sure `npm run dev` is running, and restart it if it was
already up before the config landed.

## 3. Let errors drive the fixes

Next 16 error output prints a menu of labeled fixes (`[stream]`, `[cache]`,
`[block]`, …), each with a different trade-off, in the dev overlay, the
`next dev` terminal, and `next build` output. Read the whole menu and pick
deliberately. Follow the `Learn more:` link — the `/docs/messages/*` pages are
written for agents and carry the canonical pattern, the trade-offs, and the
gotchas (fetch them with `.md` appended). When a production build error is
minified and unhelpful, rerun with `next build --debug-prerender` for server
source maps and to continue past the first failure.

## 4. Verify at runtime with the `next-dev-loop` skill

Installed at `.agents/skills/next-dev-loop` (symlinked into `.claude/skills/`).
**After every edit to app code, verify the page still works at runtime using the
`next-dev-loop` skill** — compiling and type-checking is not evidence that it
works. It combines the framework's view (`/_next/mcp`) with the browser's view
(`agent-browser`: DOM, console, network, Web Vitals, React tree, pending
Suspense boundaries).

Framework knowledge comes from the bundled docs, not from skills. Reach for the
other Next.js skills only for multi-step migrations, and install them on demand:

```bash
npx skills add vercel/next.js --skill next-cache-components-adoption
npx skills add vercel/next.js --skill next-cache-components-optimizer
npx skills add vercel/next.js --skill next-partial-prefetching-adoption
```

## voni/ — stack notes that differ from memorized defaults
- Next.js rules are in the "Next.js / frontend" section above — read the
  bundled docs first. One gotcha worth repeating here: `params`/`searchParams`
  are Promises; use the `PageProps<'/route'>` / `LayoutProps<'/route'>` /
  `RouteContext<'/route'>` typed helpers rather than hand-typing params.
- shadcn/ui in this project is scaffolded on **Base UI** (`@base-ui/react`),
  not Radix — confirmed by `-b/--base` defaulting to `base-nova` as of the
  2026 CLI. Composition uses a `render={<Component />}` prop, **not**
  `asChild`. Check an existing `voni/src/components/ui/*.tsx` file for the
  pattern before adding a new trigger/composed component.
- DB is Neon Postgres via `drizzle-orm/neon-http` (`voni/src/lib/db`). Auth is
  Better Auth with Google-only sign-in and the `organization` plugin
  (`voni/src/lib/auth.ts`) — run `npx @better-auth/cli generate` after any
  auth config change to regenerate its tables, then `npm run db:generate` /
  `db:migrate` for our own domain tables in `voni/src/lib/db/schema.ts`.
- Hosting target is Cloudflare Workers via OpenNext (`voni/open-next.config.ts`,
  `voni/wrangler.jsonc`), not Vercel — `npm run preview`/`npm run deploy` in
  `voni/`, not `next start` in production.

# Handoff continuity (Claude Code / Codex / OpenCode)
This project keeps a `HANDOFF.md` at the repo root so work can move between
whichever of Claude Code, Codex, or OpenCode you're using (e.g. when Claude Code
hits a usage limit mid-task and work continues in one of the others). Read it at
the start of a session if it exists. Keep its **Status** section (Now/Next/Why)
current after finishing a meaningful chunk of work, or before you expect to run
low on context/usage. Never hand-edit its **Activity Log** section — it's
auto-generated.

## Voice copilot coverage

Make every signed-in screen and interactive state discoverable and operable by voice, with stable references, verified navigation, and confirmed mutations. Audit all 16 page routes; document public/auth routes as outside tool-enabled copilot access.

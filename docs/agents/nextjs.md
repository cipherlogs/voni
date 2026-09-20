# Leadcalls Next.js and frontend rules

These rules add Leadcalls-specific requirements to the global Next.js guidance.

## Before frontend work

- The Next.js app is `voni/` and uses Next.js 16 with the App Router.
- If you touch `voni/` app code, the runtime check in this document must pass before the work is complete.
- Read the relevant version-matched guide under `voni/node_modules/next/dist/docs/` before writing or reviewing App Router, React, or frontend code.
- The generated `<!-- BEGIN:nextjs-agent-rules -->` block in `voni/AGENTS.md` is maintained by `next dev`; never hand-edit inside its markers.
- If a page is not bundled, append `.md` to its nextjs.org/docs URL or use `https://nextjs.org/docs/llms.txt` as the index.

## Runtime visibility

- `.mcp.json` registers `next-devtools` with `npx -y next-devtools-mcp@latest`.
- Start the existing dev server from `voni/` with `npm run dev`, then use the Next MCP instead of guessing.
- Useful tools include `get_errors`, `get_logs`, `get_page_metadata`, `get_project_metadata`, `get_routes`, `get_server_action_by_id`, `get_compilation_issues`, and `compile_route`.
- `get_compilation_issues` and `compile_route` check compilation without a full `next build`.
- Browser console warnings and errors are forwarded to the `next dev` terminal.
- `voni/.next/dev/lock` contains the running server's PID, port, and URL. Connect to the existing server and do not start a duplicate.
- If the MCP will not connect, confirm Next 16 or newer, confirm `next-devtools` is in `.mcp.json`, ensure `npm run dev` is running, and restart it if it was already running before the config landed.

## Error handling and verification

- Read the full labeled-fix menu from Next 16 and follow its `Learn more:` link before choosing a fix.
- For unclear production build errors, use `next build --debug-prerender` for server source maps.
- After every edit to app code, use the `next-dev-loop` skill. Compilation and type-checking alone are not runtime evidence.
- The runtime check must inspect both `/_next/mcp` and the browser through `agent-browser`.

## Voni stack notes

- `params` and `searchParams` are Promises. Use `PageProps<'/route'>`, `LayoutProps<'/route'>`, and `RouteContext<'/route'>` instead of hand-typing them.
- shadcn/ui uses Base UI (`@base-ui/react`), not Radix. Composition uses `render={<Component />}`, not `asChild`. Check an existing `voni/src/components/ui/*.tsx` file before adding a composed trigger.
- The database is Neon Postgres through `drizzle-orm/neon-http` in `voni/src/lib/db`.
- Auth is Better Auth with Google-only sign-in and the `organization` plugin in `voni/src/lib/auth.ts`. After auth config changes, run `npx @better-auth/cli generate`, then `npm run db:generate` and `db:migrate` for domain tables.
- Hosting targets Cloudflare Workers through OpenNext. Use `npm run preview` or `npm run deploy` from `voni/`, not `next start` for production.

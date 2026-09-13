<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Responsive async work protocol

The permanent product rule lives in the repo-root `AGENTS.md` /
`CLAUDE.md` ("Responsive async work protocol") — same wording for every
agent. The Voni-specific application:

- Anything non-interactive that may exceed 3 seconds is a durable job in
  `src/lib/jobs/` (202 + job id, global job center, survives navigation /
  reload / closed tab). Spinners, `useTransition`, toasts, and the
  `loading.tsx` / skeleton patterns below are for *immediate* feedback and
  short waits — never the durability mechanism for long work.
- The header `JobCenter` (`src/components/jobs/`) is the global status
  indicator; every job needs a result destination, a retry path, and a
  sanitized failure state.
- Creator-scoped visibility; shadcn on Base UI (`render=`, not `asChild`).

# Visual feedback protocol

Every async operation must be visibly responsive — a click that just sits
there reads as broken, not busy. This applies to every new feature, not just
the flows that already follow it.

- **Any async trigger** (server action, fetch, mutation) must disable itself
  and show a pending state while in flight — spinner plus, where the label has
  room, changed text ("Saving…"). Use `LoadingButton`
  (`src/components/loading-button.tsx`) rather than hand-rolling the
  `LoaderCircle` + `animate-spin` + `disabled` pattern again; it works for both
  `useTransition`-driven and `useFormStatus`-driven pending state (see
  `SubmitButton` in `src/components/settings-view.tsx` for the latter).
- **Every mutation must surface success and failure.** An inline `Alert` for
  validation/blocking errors, a Base UI `toast` (`toast.add` from
  `src/components/ui/toast.tsx`) for a fire-and-forget
  confirmation — see `edit-agent.tsx` and `agents/new/page.tsx` for the house
  pattern of using both together. Never let a failed action just silently
  reset a pending flag with nothing shown (see the `catch` in
  `agent-config-form.tsx`'s save handler for the shape to copy).
- **Track pending state per-item, not with one shared boolean**, whenever a
  list can have more than one row acted on independently (see `phone-numbers.tsx`'s
  `pendingId` pattern) — otherwise clicking one row's button visually disables
  every other row with no indication of which action is actually running.
- **Any Server Component route that awaits data should ship a `loading.tsx`**
  built from the skeleton pieces in `src/components/page-skeletons.tsx`
  (`CardListSkeleton`, `TableSkeleton`, `StatGridSkeleton`, `DetailSkeleton`,
  `PageHeaderSkeleton`), shaped to match that page's real layout — and an
  `error.tsx` that renders `RouteError` (`src/components/route-error.tsx`).
  Remember Next 16's error boundary callback is `retry`, not the older
  `reset` — check the bundled docs (see above) before assuming otherwise.
- A distinct failure mode (rate-limited, quota exceeded, permission denied)
  deserves its own message, not a generic "something went wrong" — see how
  `voice-call.tsx` tells a 429 rate-limit (with a countdown from
  `RateLimitError.retryAfterSeconds` in `src/lib/voice/session.ts`) apart from
  a mic error, a dropped connection, and a normal hang-up, all of which used to
  collapse into one look.

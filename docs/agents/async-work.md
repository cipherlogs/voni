# Responsive async work protocol

Every user-triggered asynchronous action must give immediate feedback. Any non-interactive operation that may exceed 3 seconds is durable background work.

- Return control to the user as soon as the server durably accepts the work with a 202 and job id. Never rely on a component promise, `useTransition`, spinner, toast, or open browser tab to keep long work alive.
- Work survives navigation, reload, disconnection, and browser closure through `voni/src/lib/jobs/`: global status indicator, completion notification, result destination, retry path, and sanitized failure state.
- If the user is still on the initiating page after 3 seconds, show: "This is continuing in the background. You can browse Voni and return when it is ready." If work finishes before 3 seconds and the user is still waiting, open its result directly without background messaging.
- Keep genuinely interactive sessions such as live calls in the foreground with continuous status and recovery feedback.
- Distinguish queued, running, succeeded, failed, cancelled, rate-limited, and permission-blocked states with text, never spinner alone.
- Never block global navigation or disable unrelated controls.
- Jobs are creator-scoped unless a feature explicitly requires workspace coordination.
- Use shadcn components on Base UI with `render=`, not `asChild`.
- Test navigation away, reload, duplicate submission, failure, retry, cancellation, reconnection, and completion from another page through the Next MCP and `next-dev-loop` process.

Before implementing a new async feature, answer:

1. Can this exceed 3 seconds?
2. Does it require continuous user interaction?
3. What survives if the page disappears?
4. Where can the user see its status globally?
5. Where does its result open?
6. How do failure, retry, and duplicate submission work?
7. What user or workspace is allowed to see it?

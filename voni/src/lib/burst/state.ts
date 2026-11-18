/**
 * The burst form's result, shared by the card that renders it and the server
 * action that produces it.
 *
 * It lives here rather than in either one so the card can land, and be tested,
 * before `src/app/email/actions.ts` grows the action: the card takes the action
 * as a prop and only needs the shape.
 *
 * Two success shapes, and the difference is not an error:
 *   - `runUrl` — the workflow was dispatched; GitHub owns the run.
 *   - `fallback` — no `GITHUB_BURST_TOKEN` is configured, so the app did not
 *     dispatch anything and instead hands back the exact `k6 cloud run` line.
 *     The card renders it as a copyable command, never as a failure.
 */
export type BurstState = {
  ok: boolean;
  /** A failure the operator must read; rendered as a destructive Alert. */
  error?: string | null;
  /** A confirmation, e.g. that the run was queued. */
  message?: string | null;
  /** GitHub's workflow page, where the queued run appears. */
  runUrl?: string | null;
  /** The manual run, when no dispatch token is configured. */
  fallback?: { command: string } | null;
};

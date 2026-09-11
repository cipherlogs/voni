/**
 * Pure, UI-facing job helpers shared by the pill, the /jobs page, and the
 * optimistic hook. No React, no I/O — covered by ui-helpers.test.ts.
 */

/** Matches the repo's responsive-async protocol: non-interactive work that
 * may exceed this long becomes durable background work with a notice. */
export const BACKGROUND_AFTER_MS = 3000;

export type MinimalJob = {
  id: string;
  kind: string;
  status: string;
  title: string;
  progressTotal: number | null;
  progressDone: number | null;
  stage: string | null;
  errorCode: string | null;
  seenAt: string | null;
  dismissedAt: string | null;
};

const TERMINAL = ["succeeded", "failed", "cancelled"];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.includes(status);
}

/** 0..100 determinate progress, or null when it cannot be computed. */
export function getJobProgressPercent(job: MinimalJob): number | null {
  const { progressTotal, progressDone } = job;
  if (progressTotal == null || progressDone == null) return null;
  if (progressTotal <= 0) return null;
  const pct = Math.round((progressDone / progressTotal) * 100);
  return Math.min(100, Math.max(0, pct));
}

export type PartitionedJobs<T extends MinimalJob> = {
  activeJobs: T[];
  unreadJobs: T[];
  history: T[];
};

/** Active = non-terminal; unread = terminal unseen + undismissed; history =
 * terminal seen or dismissed. Mirrors the provider's derivation so the pill
 * and the /jobs page agree. */
export function partitionJobs<T extends MinimalJob>(
  jobs: T[],
): PartitionedJobs<T> {
  const activeJobs = jobs.filter((j) => !isTerminalStatus(j.status));
  const unreadJobs = jobs.filter(
    (j) => isTerminalStatus(j.status) && !j.seenAt && !j.dismissedAt,
  );
  const history = jobs.filter(
    (j) => isTerminalStatus(j.status) && (j.seenAt || j.dismissedAt),
  );
  return { activeJobs, unreadJobs, history };
}

/** Matches /agents/<id> detail pages but not /agents, /agents/, /agents/new. */
const AGENT_DETAIL_PATH = /^\/agents\/(?!new$)[^/]+$/;

/**
 * Whether the global toast for a terminal job transition should be skipped
 * because the current page already consumes the result inline.
 *
 * - agent_generation on exact /agents/new: the wizard shows submitted panel,
 *   review, and error state inline — a toast on top is pure noise.
 * - agent_deployment + succeeded on /agents/<id>: the detail watcher toasts
 *   and banners inline — a second global success toast is noise. Errors stay
 *   global (the watcher never toasts on failure).
 */
export function shouldSuppressJobToast(
  kind: string,
  status: string,
  pathname: string,
): boolean {
  if (kind === "agent_generation" && pathname === "/agents/new") return true;
  if (
    kind === "agent_deployment" &&
    status === "succeeded" &&
    AGENT_DETAIL_PATH.test(pathname)
  ) {
    return true;
  }
  return false;
}

/** Distinct failure copy per mode — never a generic "something went wrong". */
export function jobErrorCopy(errorCode: string | null): string {
  switch (errorCode) {
    case "rate-limited":
      return "The service is busy — wait a minute, then retry.";
    case "auth":
      return "Access was refused — check permissions or reconnect the account, then retry.";
    case "timeout":
      return "This took too long and timed out — retry; it resumes cleanly.";
    case "transport":
      return "The connection dropped mid-run — check your connection and retry.";
    case "provider-exhausted":
    case "provider-failure":
      return "The AI provider failed — retry, or pick a template to keep moving.";
    case "conflict":
    case "stale-version":
      return "A newer change exists — refresh and try again.";
    case "not-found":
      return "The target no longer exists — it may have been deleted.";
    case "cancelled":
      return "This was cancelled — retry to run it again.";
    default:
      return "Something went wrong — retry, or dismiss if you no longer need it.";
  }
}

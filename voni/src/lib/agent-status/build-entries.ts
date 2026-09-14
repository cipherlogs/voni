import type { JobJson } from "@/lib/jobs/serialize";
import type { TimelineEntry } from "@/components/onboarding-06/onboarding-06";

/**
 * Agent status timeline entries, derived from existing record/job data.
 *
 * At most three entries: creation, latest saved configuration version, and
 * current deployment status. Timestamps are omitted when unavailable — the
 * timeline never implies a full deployment history.
 */
export type AgentStatusInput = {
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  configVersion: number;
  deploymentStatus: string;
  deploymentError?: string | null;
  /** Latest observed deployment job (live watcher state), when one exists. */
  deploymentJob?: JobJson | null;
};

function formatTime(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}

function deploymentCopy(status: string): { title: string; description: string } {
  switch (status) {
    case "ready":
      return {
        title: "Ready",
        description: "New calls use the saved version.",
      };
    case "queued":
      return {
        title: "Queued",
        description: "Voice deployment is waiting to run in the background.",
      };
    case "deploying":
      return {
        title: "Deploying",
        description:
          "Deploying the new version — the previous version keeps taking calls.",
      };
    case "failed":
      return {
        title: "Failed",
        description:
          "Voice deployment did not complete. The previous version is still live.",
      };
    case "cancelled":
      return {
        title: "Cancelled",
        description:
          "Deployment was cancelled. The previous version is still live.",
      };
    case "draft":
    default:
      return {
        title: "Draft",
        description: "Not yet deployed. Save to queue a voice deployment.",
      };
  }
}

export function buildAgentStatusEntries(input: AgentStatusInput): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const createdTime = formatTime(input.createdAt);
  entries.push({
    id: "created",
    state: "done",
    title: "Created",
    description: "This agent was created.",
    ...(createdTime ? { time: createdTime } : {}),
  });

  const savedTime = formatTime(input.updatedAt);
  entries.push({
    id: "saved",
    state: "done",
    title: `Configuration v${input.configVersion} saved`,
    description: "The latest saved configuration.",
    ...(savedTime ? { time: savedTime } : {}),
  });

  const liveStatus = input.deploymentJob?.status;
  const status =
    liveStatus === "succeeded"
      ? "ready"
      : liveStatus === "cancelled"
        ? "cancelled"
        : liveStatus === "failed"
          ? "failed"
          : liveStatus === "running"
            ? "deploying"
            : input.deploymentStatus;
  const copy = deploymentCopy(status);
  const jobTime = formatTime(
    input.deploymentJob?.completedAt ??
      input.deploymentJob?.startedAt ??
      input.deploymentJob?.createdAt ??
      null,
  );
  const description =
    input.deploymentError && (status === "failed" || status === "cancelled")
      ? `${copy.description} ${input.deploymentError}`
      : copy.description;
  entries.push({
    id: "deployment",
    state:
      status === "failed" || status === "cancelled"
        ? "error"
        : status === "ready"
          ? "done"
          : status === "draft"
            ? "neutral"
            : "current",
    title: `Deployment: ${copy.title}`,
    description,
    ...(jobTime ? { time: jobTime } : {}),
  });

  return entries;
}

"use client";

import { useState } from "react";
import {
  CircleCheck,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { JobJson } from "@/lib/jobs/serialize";
import {
  getJobProgressPercent,
  jobErrorCopy,
} from "@/lib/jobs/ui-helpers";
import {
  formatElapsed,
  isTerminal,
  jobStatusLabel,
  useJobs,
} from "./jobs-provider";

function primaryActionLabel(job: JobJson): string {
  if (job.status !== "succeeded") return "View";
  switch (job.kind) {
    case "agent_generation":
      return "Review draft";
    case "agent_deployment":
      return "View agent";
    case "lead_csv_import":
      return "View import results";
    default:
      return "View result";
  }
}

/**
 * One job row, shared by the pill and the /jobs page. Pending state is
 * per-row (not a shared boolean) so acting on one job never disables the
 * others. Status is always text — never spinner-alone.
 */
export function JobRow({
  job,
  selected,
  onToggle,
}: {
  job: JobJson;
  /** Controlled selection for bulk retry/cancel. Omit to hide the checkbox. */
  selected?: boolean;
  onToggle?: (id: string, checked: boolean) => void;
}) {
  const { openJob, cancelJob, retryJob, dismissJob } = useJobs();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const terminal = isTerminal(job.status);
  const statusLabel =
    job.status === "failed" && job.errorCode === "auth"
      ? "Permission blocked"
      : job.status === "failed" && job.errorCode === "rate-limited"
        ? "Rate limited"
        : job.status === "queued" && job.stage === "waiting-for-worker"
          ? "Waiting for a worker"
          : job.status === "queued" && job.stage === "recovery-started"
            ? "Recovery started"
            : jobStatusLabel(job.status);
  const elapsed = formatElapsed(
    job.startedAt ?? job.createdAt,
    job.completedAt,
  );
  const percent = getJobProgressPercent(job);

  const run = async (action: string, fn: () => Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(action);
    try {
      await fn();
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-copilot-key={job.id} data-copilot-version={job.updatedAt} data-copilot-scope="jobs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {onToggle ? (
            <Checkbox
              checked={selected ?? false}
              onCheckedChange={(checked) => onToggle(job.id, checked)}
              aria-label={`Select ${job.title}`}
            />
          ) : null}
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{job.title}</p>
        </div>
        <Badge
          variant={
            job.status === "succeeded"
              ? "secondary"
              : job.status === "failed"
                ? "destructive"
                : "outline"
          }
        >
          {job.status === "failed" ? (
            <TriangleAlert data-icon="inline-start" />
          ) : job.status === "succeeded" ? (
            <CircleCheck data-icon="inline-start" />
          ) : (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          )}
          {statusLabel}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs" aria-live="polite">
          {statusLabel}
          {job.stage && !job.stage.startsWith("waiting-") && job.stage !== "recovery-started"
            ? ` · ${job.stage}`
            : ""}
          {` · ${elapsed} elapsed`}
        </p>
        {percent != null ? (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {percent}%
          </span>
        ) : job.progressTotal != null && job.progressDone != null ? (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {job.progressDone} of {job.progressTotal}
          </span>
        ) : null}
      </div>
      {percent != null && !terminal ? (
        <div
          role="progressbar"
          aria-label={`${job.title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="relative h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full origin-left bg-primary"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
      ) : null}
      {job.status === "failed" ? (
        <p className="text-destructive text-xs">
          {job.errorMessage ?? jobErrorCopy(job.errorCode)}
        </p>
      ) : null}
      {job.status === "failed" && !job.errorMessage ? (
        <p className="text-muted-foreground text-xs">{jobErrorCopy(job.errorCode)}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {job.targetUrl && (job.status === "succeeded" || job.status === "failed") ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pendingAction !== null}
            aria-label={`Open ${job.title}`} data-copilot-effect="navigation" onClick={() => void run("open", () => openJob(job))}
          >
            {pendingAction === "open" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            {primaryActionLabel(job)}
          </Button>
        ) : null}
        {!terminal ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pendingAction !== null}
            aria-label={`Cancel ${job.title}`} onClick={() => void run("cancel", () => cancelJob(job.id))}
          >
            {pendingAction === "cancel" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <X />
            )}
            Cancel
          </Button>
        ) : null}
        {(job.status === "failed" || job.status === "cancelled") &&
        job.kind !== "integration_test" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pendingAction !== null}
            aria-label={`Retry ${job.title}`} onClick={() => void run("retry", () => retryJob(job.id))}
          >
            {pendingAction === "retry" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCw />
            )}
            Retry
          </Button>
        ) : null}
        {(job.status === "failed" || job.status === "cancelled") &&
        job.kind === "integration_test" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pendingAction !== null}
            aria-label={`Retry ${job.title}`} onClick={() => void run("retry", () => retryJob(job.id))}
          >
            {pendingAction === "retry" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCw />
            )}
            Run again
          </Button>
        ) : null}
        {terminal ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pendingAction !== null}
            aria-label={`Dismiss ${job.title}`} onClick={() => void run("dismiss", () => dismissJob(job.id))}
          >
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

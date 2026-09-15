"use client";

import { useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadingButton } from "@/components/loading-button";
import { TableCell, TableRow } from "@/components/ui/table";
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

function computeStatusLabel(job: JobJson): string {
  return job.status === "failed" && job.errorCode === "auth"
    ? "Permission blocked"
    : job.status === "failed" && job.errorCode === "rate-limited"
      ? "Rate limited"
      : job.status === "queued" && job.stage === "waiting-for-worker"
        ? "Waiting for a worker"
        : job.status === "queued" && job.stage === "recovery-started"
          ? "Recovery started"
          : jobStatusLabel(job.status);
}

/**
 * Shared per-row state (never a shared boolean) so acting on one job never
 * disables the others. Status is always text — never spinner-alone.
 */
function useJobRowState(job: JobJson) {
  const { openJob, cancelJob, retryJob, dismissJob } = useJobs();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const terminal = isTerminal(job.status);
  // One-shot arrival when this row transitions to succeeded while mounted
  // (delight amendment 2026-09-14). Keyed off the transition, not the
  // render — a row that mounts already-succeeded stays still.
  const [justSucceeded, setJustSucceeded] = useState(false);
  const prevStatus = useRef(job.status);
  useEffect(() => {
    if (prevStatus.current !== "succeeded" && job.status === "succeeded") {
      setJustSucceeded(true);
    }
    prevStatus.current = job.status;
  }, [job.status]);
  const baseLabel = computeStatusLabel(job);
  // Optimistic flip: provisional per-row status while the provider mutate()
  // is in flight. Reverts when run() clears pendingAction; failure toasts
  // globally via the provider, success follows its refresh.
  const statusLabel =
    pendingAction === "cancel"
      ? "Cancelling…"
      : pendingAction === "retry"
        ? "Retrying…"
        : pendingAction === "dismiss"
          ? "Dismissing…"
          : baseLabel;
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

  return {
    openJob,
    cancelJob,
    retryJob,
    dismissJob,
    pendingAction,
    terminal,
    justSucceeded,
    statusLabel,
    elapsed,
    percent,
    run,
  };
}

type JobRowState = ReturnType<typeof useJobRowState>;

function JobStatusBadge({
  job,
  statusLabel,
  justSucceeded,
}: {
  job: JobJson;
  statusLabel: string;
  justSucceeded: boolean;
}) {
  return (
    <Badge
      className={justSucceeded ? "voni-done-pop" : undefined}
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
  );
}

function JobFailureLines({ job }: { job: JobJson }) {
  if (job.status !== "failed") return null;
  return (
    <p className="text-destructive text-xs">
      {job.errorMessage ?? jobErrorCopy(job.errorCode)}
    </p>
  );
}

function JobActionButtons({ job, row }: { job: JobJson; row: JobRowState }) {
  const {
    openJob,
    cancelJob,
    retryJob,
    dismissJob,
    pendingAction,
    terminal,
    run,
  } = row;
  return (
    <>
      {job.targetUrl && (job.status === "succeeded" || job.status === "failed") ? (
        <LoadingButton
          size="sm"
          variant="outline"
          pending={pendingAction === "open"}
          pendingText="Opening…"
          aria-label={`Open ${job.title}`} data-copilot-effect="navigation" onClick={() => void run("open", () => openJob(job))}
        >
          {primaryActionLabel(job)}
        </LoadingButton>
      ) : null}
      {!terminal ? (
        <LoadingButton
          size="sm"
          variant="ghost"
          pending={pendingAction === "cancel"}
          pendingText="Cancelling…"
          icon={<X />}
          disabled={pendingAction !== null}
          aria-label={`Cancel ${job.title}`} onClick={() => void run("cancel", () => cancelJob(job.id))}
        >
          Cancel
        </LoadingButton>
      ) : null}
      {(job.status === "failed" || job.status === "cancelled") ? (
        <LoadingButton
          size="sm"
          variant="ghost"
          pending={pendingAction === "retry"}
          pendingText={job.kind === "integration_test" ? "Starting…" : "Retrying…"}
          icon={<RotateCw />}
          disabled={pendingAction !== null}
          aria-label={`Retry ${job.title}`} onClick={() => void run("retry", () => retryJob(job.id))}
        >
          {job.kind === "integration_test" ? "Run again" : "Retry"}
        </LoadingButton>
      ) : null}
      {terminal ? (
        <LoadingButton
          size="sm"
          variant="ghost"
          pending={pendingAction === "dismiss"}
          pendingText="Dismissing…"
          disabled={pendingAction !== null}
          aria-label={`Dismiss ${job.title}`} onClick={() => void run("dismiss", () => dismissJob(job.id))}
        >
          Dismiss
        </LoadingButton>
      ) : null}
    </>
  );
}

export type JobRowProps = {
  job: JobJson;
  /** Controlled selection for bulk retry/cancel. Omit to hide the checkbox. */
  selected?: boolean;
  onToggle?: (id: string, checked: boolean) => void;
};

/**
 * One job row, shared by the pill and record-search destinations. Pending
 * state is per-row (not a shared boolean) so acting on one job never disables
 * the others. Status is always text — never spinner-alone.
 */
export function JobRow({ job, selected, onToggle }: JobRowProps) {
  const row = useJobRowState(job);
  const {
    terminal,
    justSucceeded,
    statusLabel,
    elapsed,
    percent,
  } = row;

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
        <JobStatusBadge job={job} statusLabel={statusLabel} justSucceeded={justSucceeded} />
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
      <JobFailureLines job={job} />
      <div className="flex flex-wrap gap-2">
        <JobActionButtons job={job} row={row} />
      </div>
    </div>
  );
}

/**
 * The same job row as table cells for the /jobs page. Same props as JobRow
 * so page-level selection keeps working; actions stay inline (right-aligned,
 * wrapping) rather than a dropdown so every action keeps its visible label
 * and voice reference.
 */
export function JobTableRow({ job, selected, onToggle }: JobRowProps) {
  const row = useJobRowState(job);
  const { terminal, justSucceeded, statusLabel, elapsed, percent } = row;

  return (
    <TableRow data-copilot-key={job.id} data-copilot-version={job.updatedAt} data-copilot-scope="jobs">
      <TableCell>
        {onToggle ? (
          <Checkbox
            checked={selected ?? false}
            onCheckedChange={(checked) => onToggle(job.id, checked)}
            aria-label={`Select ${job.title}`}
          />
        ) : null}
      </TableCell>
      <TableCell className="whitespace-normal">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium">{job.title}</p>
          <p className="text-muted-foreground text-xs" aria-live="polite">
            {statusLabel}
            {job.stage && !job.stage.startsWith("waiting-") && job.stage !== "recovery-started"
              ? ` · ${job.stage}`
              : ""}
            {` · ${elapsed} elapsed`}
          </p>
          <JobFailureLines job={job} />
        </div>
      </TableCell>
      <TableCell>
        <JobStatusBadge job={job} statusLabel={statusLabel} justSucceeded={justSucceeded} />
      </TableCell>
      <TableCell>
        {percent != null ? (
          <div className="flex min-w-28 flex-col gap-1">
            <span className="text-muted-foreground text-xs tabular-nums">
              {percent}%
            </span>
            {!terminal ? (
              <div
                role="progressbar"
                aria-label={`${job.title} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="relative h-1 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full origin-left bg-primary"
                  style={{ transform: `scaleX(${percent / 100})` }}
                />
              </div>
            ) : null}
          </div>
        ) : job.progressTotal != null && job.progressDone != null ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {job.progressDone} of {job.progressTotal}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1">
          <JobActionButtons job={job} row={row} />
        </div>
      </TableCell>
    </TableRow>
  );
}

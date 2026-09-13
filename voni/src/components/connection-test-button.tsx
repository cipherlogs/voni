"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { LoadingButton } from "@/components/loading-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useOptimisticJob } from "@/components/jobs/use-optimistic-job";

type TestOutcome =
  | { status: "passed"; latencyMs: number }
  | { status: "failed"; message?: string | null; error?: string | null };

/**
 * Starts an integration_test job for one service (or one LLM account) and
 * returns immediately. Connection tests can take up to ~20s (Telnyx probes
 * twice), so they run as durable jobs: fast finishes land inline, slow ones
 * demote to background with a notice while the pill tracks them, and every
 * outcome stays in Jobs with a retry path.
 *
 * A failed connectivity check is a completed result, not a job failure: the
 * job succeeds carrying `{ status: "failed" }`. Only infrastructure errors
 * fail the job itself.
 */
export function ConnectionTestButton({
  service,
  accountId,
  label = "Test",
}: {
  service: string;
  accountId?: string;
  label?: string;
}) {
  const testing = useOptimisticJob("integration_test");
  const [notice, setNotice] = useState<string | null>(null);
  const waiting =
    testing.phase === "starting" ||
    testing.phase === "waiting" ||
    testing.phase === "backgrounded";
  const backgrounded = testing.phase === "backgrounded";
  const terminalJob = testing.result?.job ?? null;
  const outcome = (terminalJob?.result ?? null) as TestOutcome | null;

  const passed =
    terminalJob?.status === "succeeded" && outcome?.status === "passed";
  const checkFailed =
    terminalJob?.status === "succeeded" && outcome?.status === "failed";
  const jobFailed =
    terminalJob?.status === "failed" || terminalJob?.status === "cancelled";
  const failureMessage = checkFailed
    ? (outcome?.message ?? outcome?.error ?? "The service could not be reached.")
    : jobFailed
      ? terminalJob.status === "cancelled"
        ? "The test was cancelled."
        : (terminalJob.errorMessage ?? "The test failed.")
      : testing.error;

  async function start() {
    if (waiting) return;
    setNotice(null);
    const started = await testing.start(
      accountId ? { service, accountId } : { service },
      { title: `Test ${service}` },
    );
    if (started?.deduped) {
      setNotice("A test is already running — showing that one instead.");
    }
  }

  return (
    <span className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <LoadingButton
          variant="outline"
          pending={waiting && !backgrounded}
          pendingText="Testing…"
          onClick={start}
        >
          {label}
        </LoadingButton>
        {waiting && backgrounded ? (
          <span className="text-muted-foreground text-xs" aria-live="polite">
            Still running in the background — the jobs pill tracks it.{" "}
            <Link href="/jobs" className="cursor-pointer rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
              View jobs
            </Link>
          </span>
        ) : null}
        {notice && !waiting ? (
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {notice}
          </span>
        ) : null}
        {passed && outcome?.status === "passed" ? (
          <span
            className="flex items-center gap-1 text-xs text-primary"
            aria-live="polite"
          >
            <CircleCheck className="h-3.5 w-3.5" />
            Passed · {(outcome.latencyMs / 1000).toFixed(1)}s
          </span>
        ) : null}
      </span>
      {failureMessage ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{failureMessage}</span>
            <LoadingButton
              type="button"
              variant="outline"
              size="sm"
              pending={waiting}
              pendingText="Starting…"
              onClick={start}
            >
              Run again
            </LoadingButton>
          </AlertDescription>
        </Alert>
      ) : null}
    </span>
  );
}

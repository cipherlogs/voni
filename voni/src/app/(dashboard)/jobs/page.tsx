"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { BellRing, CircleCheck, History, LoaderCircle, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  DestructiveDialogIcon,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingButton } from "@/components/loading-button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { JobRow } from "@/components/jobs/job-row";
import { useJobs } from "@/components/jobs/jobs-provider";
import { bulkJobsAction } from "./actions";
import { RecordSearchDestination } from "@/components/copilot/record-results";
import { RouteBrief } from "@/components/copilot/route-brief";

type Filter = "active" | "review" | "all";

/**
 * Full history surface for background work. The pill handles ambient
 * awareness; this page handles triage at volume: filter, search, retry,
 * dismiss. Every job carries a result destination and a retry path.
 *
 * URL-dependent record-search (?search=) lives in its own suspended leaf so
 * ordinary filtering never waits on it and vice versa.
 */
function RecordSearchReader() {
  const searchId = useSearchParams().get("search");
  if (!searchId) return null;
  return <RecordSearchDestination key={searchId} id={searchId} />;
}

function JobsContent() {
  const { jobs, activeJobs, unreadJobs, dismissJob, refresh } = useJobs();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOp, setBulkOp] = useState<"retry" | "cancel" | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const filtersActive = filter !== "all" || query.trim() !== "";
  const clearFilters = () => {
    setFilter("all");
    setQuery("");
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (filter === "active" && job.status !== "queued" && job.status !== "running")
        return false;
      if (filter === "review" && (job.seenAt || job.dismissedAt)) return false;
      if (filter === "review" && (job.status === "queued" || job.status === "running"))
        return false;
      if (q && !`${job.title} ${job.kind} ${job.status}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [jobs, filter, query]);

  const finished = jobs.filter(
    (j) => j.status === "succeeded" || j.status === "failed" || j.status === "cancelled",
  );

  const dismissAllFinished = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      for (const job of finished) {
        await dismissJob(job.id);
      }
    } finally {
      setDismissing(false);
    }
  };

  const pageJobs = visible.slice(0, 50);
  const selectedJobs = useMemo(
    () => jobs.filter((job) => selected.has(job.id)),
    [jobs, selected],
  );
  // Bulk retry only applies to failed/cancelled rows; bulk cancel only to
  // queued/running rows. The bar shows the applicable count on each button so
  // a mixed selection reads honestly instead of failing row by row.
  const retryable = selectedJobs.filter(
    (job) => job.status === "failed" || job.status === "cancelled",
  );
  const cancellable = selectedJobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  const runningSelected = selectedJobs.filter(
    (job) => job.status === "running",
  );
  const allPageSelected =
    pageJobs.length > 0 && pageJobs.every((job) => selected.has(job.id));
  const somePageSelected = pageJobs.some((job) => selected.has(job.id));

  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const togglePage = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const job of pageJobs) {
        if (checked) next.add(job.id);
        else next.delete(job.id);
      }
      return next;
    });

  const runBulk = async (op: "retry" | "cancel") => {
    const ids = (op === "retry" ? retryable : cancellable).map((job) => job.id);
    if (ids.length === 0 || bulkOp) return;
    setBulkOp(op);
    try {
      const result = await bulkJobsAction({ ids, op });
      if ("message" in result) {
        toast.add({ type: "error", title: result.message });
        return;
      }
      const plural = (n: number) => (n === 1 ? "" : "s");
      if (result.succeeded.length > 0) {
        toast.add({
          type: "success",
          title:
            op === "retry"
              ? `Retried ${result.succeeded.length} job${plural(result.succeeded.length)}.`
              : `Cancelled ${result.succeeded.length} job${plural(result.succeeded.length)}.`,
        });
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of result.succeeded) next.delete(id);
          return next;
        });
      }
      if (result.failed.length > 0) {
        const byId = new Map(jobs.map((job) => [job.id, job.title]));
        toast.add({
          type: "error",
          title: `${result.failed.length} job${plural(result.failed.length)} could not be ${
            op === "retry" ? "retried" : "cancelled"
          }.`,
          description: result.failed
            .slice(0, 3)
            .map((failure) => `${byId.get(failure.id) ?? "Job"}: ${failure.message}`)
            .join("\n"),
        });
      }
      await refresh();
    } finally {
      setBulkOp(null);
      setConfirmCancelOpen(false);
    }
  };

  const requestCancel = () => {
    // Cancelling queued work is instant and harmless — no confirm. Running
    // work may finish its current step first, so that choice gets a confirm.
    if (runningSelected.length > 0) {
      setConfirmCancelOpen(true);
      return;
    }
    void runBulk("cancel");
  };

  return (
    <>
      <RouteBrief
        route="/jobs"
        brief={`Background jobs: ${activeJobs.length} active, ${unreadJobs.length} need review, ${jobs.length} total.`}
      />
      {finished.length > 0 ? (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={dismissing}
            onClick={() => void dismissAllFinished()}
          >
            {dismissing ? <LoaderCircle className="animate-spin" /> : null}
            Dismiss all finished
          </Button>
        </div>
      ) : null}

      <Suspense fallback={null}>
        <RecordSearchReader />
      </Suspense>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            value={filter}
            onValueChange={(value) => setFilter(value as Filter)}
          >
            <TabsList>
              <TabsTrigger value="active">
                <LoaderCircle />
                Active{activeJobs.length > 0 ? ` · ${activeJobs.length}` : ""}
              </TabsTrigger>
              <TabsTrigger value="review">
                <BellRing />
                Needs review{unreadJobs.length > 0 ? ` · ${unreadJobs.length}` : ""}
              </TabsTrigger>
              <TabsTrigger value="all">
                <History />
                All
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            type="search"
            data-copilot-effect="view"
            placeholder="Search jobs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full sm:w-64"
            aria-label="Search jobs"
          />
          {filtersActive ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
            >
              <X data-icon="inline-start" />
              Clear
            </Button>
          ) : null}
        </div>

        {visible.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant={jobs.length === 0 ? "feature" : "icon"}>
                <CircleCheck />
              </EmptyMedia>
              <EmptyTitle>
                {jobs.length === 0
                  ? "Nothing running"
                  : "No jobs match this filter"}
              </EmptyTitle>
              <EmptyDescription>
                {jobs.length === 0
                  ? "Slow work — agent generation, deployments, imports — appears here and keeps running while you browse Voni."
                  : "Try a different filter or search."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={allPageSelected}
                indeterminate={somePageSelected && !allPageSelected}
                onCheckedChange={togglePage}
                aria-label={`Select all ${pageJobs.length} jobs on this page`}
              />
              Select all on this page
            </label>
            <div className="flex flex-col gap-3" aria-live="polite">
              {pageJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  selected={selected.has(job.id)}
                  onToggle={toggle}
                />
              ))}
            </div>
          </>
        )}

        {selected.size > 0 ? (
          <div
            role="toolbar"
            aria-label="Bulk job actions"
            className="bg-card status-enter sticky bottom-4 flex flex-wrap gap-2 rounded-lg border p-3"
          >
            <span className="text-sm font-medium" aria-live="polite">
              {selected.size} selected
            </span>
            <LoadingButton
              size="sm"
              variant="outline"
              pending={bulkOp === "retry"}
              pendingText="Retrying…"
              icon={<RotateCw />}
              disabled={retryable.length === 0}
              onClick={() => void runBulk("retry")}
            >
              Retry {retryable.length}
            </LoadingButton>
            <LoadingButton
              size="sm"
              variant="outline"
              pending={bulkOp === "cancel"}
              pendingText="Cancelling…"
              icon={<X />}
              disabled={cancellable.length === 0}
              onClick={requestCancel}
            >
              Cancel {cancellable.length}
            </LoadingButton>
            <Button
              size="sm"
              variant="ghost"
              disabled={bulkOp !== null}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DestructiveDialogIcon />
            <DialogTitle>Cancel {cancellable.length} jobs?</DialogTitle>
            <DialogDescription>
              {runningSelected.length} {runningSelected.length === 1 ? "is" : "are"} still
              running — cancelling asks {runningSelected.length === 1 ? "it" : "them"} to stop
              between steps, so the current step may finish first. Queued jobs stop
              immediately. You can retry any of them later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Keep running
            </DialogClose>
            <LoadingButton
              variant="destructive"
              pending={bulkOp === "cancel"}
              pendingText="Cancelling…"
              onClick={() => void runBulk("cancel")}
            >
              Cancel jobs
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function JobsPage() {
  return (
    <div data-testid="jobs-shell" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Background jobs</h1>
        <p className="text-muted-foreground text-sm">
          Slow work keeps running while you browse Voni. Results stay here
          for 30 days unless dismissed.
        </p>
      </div>
      {/* Ordinary filtering/navigation paints with the shell; the
          URL-selected record search resolves in its own leaf above. */}
      <Suspense
        fallback={
          <div role="status" aria-label="Loading jobs" className="flex flex-col gap-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <Skeleton className="h-9 w-full max-w-xs" />
              <Skeleton className="h-8 w-full sm:w-64" />
            </div>
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border p-3">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-full max-w-md [animation-delay:-533ms]" />
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-40 [animation-delay:-1066ms]" />
                  <Skeleton className="h-3 w-full max-w-sm [animation-delay:-533ms]" />
                </div>
              </div>
            </div>
          </div>
        }
      >
        <JobsContent />
      </Suspense>
    </div>
  );
}

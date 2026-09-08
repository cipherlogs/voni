"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { BellRing, CircleCheck, History, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JobRow } from "@/components/jobs/job-row";
import { useJobs } from "@/components/jobs/jobs-provider";
import { RecordSearchDestination } from "@/components/copilot/record-results";
import { RouteBrief } from "@/components/copilot/route-brief";

type Filter = "active" | "review" | "all";

/**
 * Full history surface for background work. The pill handles ambient
 * awareness; this page handles triage at volume: filter, search, retry,
 * dismiss. Every job carries a result destination and a retry path.
 */
function JobsContent() {
  const searchId = useSearchParams().get("search");
  const { jobs, activeJobs, unreadJobs, dismissJob } = useJobs();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [dismissing, setDismissing] = useState(false);

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

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief
        route="/jobs"
        brief={`Background jobs: ${activeJobs.length} active, ${unreadJobs.length} need review, ${jobs.length} total.`}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Background jobs</h1>
          <p className="text-muted-foreground text-sm">
            Slow work keeps running while you browse Voni. Results stay here
            for 30 days unless dismissed.
          </p>
        </div>
        {finished.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            disabled={dismissing}
            onClick={() => void dismissAllFinished()}
          >
            {dismissing ? <LoaderCircle className="animate-spin" /> : null}
            Dismiss all finished
          </Button>
        ) : null}
      </div>

      {searchId ? <RecordSearchDestination key={searchId} id={searchId} /> : null}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
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
            className="max-w-xs"
            aria-label="Search jobs"
          />
        </div>

        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
            <CircleCheck className="text-muted-foreground h-8 w-8" />
            <p className="text-sm font-medium">
              {jobs.length === 0
                ? "Nothing running"
                : "No jobs match this filter"}
            </p>
            <p className="text-muted-foreground text-sm">
              {jobs.length === 0
                ? "Slow work — agent generation, deployments, connection tests, imports — will appear here."
                : "Try a different filter or search."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3" aria-live="polite">
            {visible.slice(0, 50).map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function JobsPage() {
  return <Suspense fallback={<p role="status">Loading jobs…</p>}><JobsContent /></Suspense>;
}

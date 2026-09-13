"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronUp,
  History,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getJobProgressPercent } from "@/lib/jobs/ui-helpers";
import { JobRow } from "./job-row";
import { useJobs } from "./jobs-provider";

/**
 * Ambient global indicator for background work (Approach A).
 *
 * The pill is for work in flight only: while active (or optimistic) jobs
 * exist it names the state in text — never an ambiguous icon. Finished jobs
 * clear themselves once their result is consumed where it was started (e.g.
 * the wizard's draft review marks its generation seen); unconsumed results
 * surface once via toast and live on in /jobs "Needs review". Nothing
 * finished sticks to the viewport.
 */
export function JobPill() {
  const { activeJobs, optimisticJobs } = useJobs();
  const [expanded, setExpanded] = useState(false);

  const activeCount = activeJobs.length + optimisticJobs.length;
  const box = useRef<HTMLDivElement | null>(null);

  // Publish the rendered height so bottom-docked UI (e.g. the agent
  // wizard's sticky Talk bar) can sit above the pill instead of under it.
  // Reset on unmount: no pill, no offset.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      document.documentElement.style.setProperty("--job-pill-h", `${el.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty("--job-pill-h", "0px");
    };
  }, [expanded, activeCount]);

  if (activeCount === 0) return null;

  const firstActive = activeJobs[0];
  const firstPercent = firstActive
    ? getJobProgressPercent(firstActive)
    : null;
  const summary = `${activeCount} running${firstPercent != null ? ` · ${firstPercent}%` : ""}`;

  const visible = activeJobs.slice(0, 5);
  const overflow = activeJobs.length - visible.length;

  return (
    <div
      ref={box}
      data-copilot-scope="jobs"
      className="fixed bottom-4 left-4 z-40 w-80 max-w-[calc(100vw-2rem)]"
      aria-live="polite"
    >
      <div className="max-w-sm rounded-lg border bg-card shadow-lg">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-2">
            <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              {optimisticJobs.length > 0 && activeJobs.length === 0
                ? optimisticJobs[0].title
                : summary}
            </p>
            {firstPercent != null ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {firstPercent}%
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              data-copilot-effect="view" aria-label={expanded ? "Collapse jobs" : "Expand jobs"}
            >
              {expanded ? <ChevronDown /> : <ChevronUp />}
            </Button>
          </div>
          {firstPercent != null ? (
            <div
              role="progressbar"
              aria-label="Latest job progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={firstPercent}
              className="relative h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full origin-left bg-primary"
                style={{ transform: `scaleX(${firstPercent / 100})` }}
              />
            </div>
          ) : null}
          {expanded ? (
            <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pt-1">
              {optimisticJobs.length > 0 && activeJobs.length === 0
                ? optimisticJobs.map((entry) => (
                    <div
                      key={entry.key}
                      className="flex items-center gap-2 rounded-lg border p-3"
                    >
                      <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">
                        {entry.title}
                      </p>
                      <span className="text-muted-foreground text-xs">Starting…</span>
                    </div>
                  ))
                : null}
              {visible.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
              {overflow > 0 ? (
                <p className="text-muted-foreground text-xs">
                  +{overflow} more
                </p>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <Link href="/jobs">
                    <History />
                    View all jobs
                  </Link>
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

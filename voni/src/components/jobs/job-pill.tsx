"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  History,
  LoaderCircle,
  X,
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
 * finished sticks to the viewport — except one transient, self-clearing
 * "All caught up" acknowledgment (delight amendment 2026-09-14) so
 * completion doesn't just vanish.
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

  // Transient "All caught up" beat: when the last real job drains, show one
  // acknowledgment instead of vanishing silently. Time-bound + self-clearing
  // (and manually dismissible), so nothing finished sticks to the viewport.
  // Never fires for optimistic-only states (no real job ever ran) or when
  // the pill was never showing work. Follows the provider's previous-render
  // pattern (jobs-provider.tsx): adjust during render, never setState in an
  // effect body. The self-clear timer is the only effect, and it only
  // subscribes (setState fires from the timeout callback, not the body).
  const [prevActive, setPrevActive] = useState(false);
  const [caughtUp, setCaughtUp] = useState(false);
  const hasActive = activeJobs.length > 0;
  if (prevActive !== hasActive) {
    setPrevActive(hasActive);
    // Drain edge only (true→false): real work just finished. Optimistic-only
    // sessions never set prevActive (pill shows them via optimisticJobs, but
    // activeJobs stays empty), so they can never fire this beat.
    if (prevActive && !hasActive) setCaughtUp(true);
    if (hasActive) setCaughtUp(false);
  }
  useEffect(() => {
    if (!caughtUp) return;
    const timer = setTimeout(() => setCaughtUp(false), 4000);
    return () => clearTimeout(timer);
  }, [caughtUp]);

  if (activeCount === 0 && !caughtUp) return null;

  if (activeCount === 0 && caughtUp) {
    return (
      <div
        ref={box}
        data-copilot-scope="jobs"
        className="fixed bottom-4 left-4 z-40 w-80 max-w-[calc(100vw-2rem)]"
        aria-live="polite"
      >
        <div className="status-enter max-w-sm rounded-lg border bg-card shadow-lg">
          <div className="flex items-center gap-2 p-3">
            <CircleCheck className="size-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              All caught up — results are in Jobs.
            </p>
            <Button
              variant="ghost"
              size="icon-xs"
              nativeButton={false}
              render={<Link href="/jobs" />}
              aria-label="Open Jobs"
              data-copilot-effect="view"
            >
              <History />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setCaughtUp(false)}
              aria-label="Dismiss"
              data-copilot-effect="view"
            >
              <X />
            </Button>
          </div>
        </div>
      </div>
    );
  }

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

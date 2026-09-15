"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useJobs } from "@/components/jobs/jobs-provider";

/**
 * Live refresh island for the agents list.
 *
 * The RSC AgentsList above renders the initial rows; this island keeps their
 * badges fresh while generations/deployments settle. It subscribes to the
 * shared JobsProvider poll (no fetching of its own) and calls
 * router.refresh() debounced ~500ms ONLY when it observes a forward
 * lifecycle transition (queued -> running -> succeeded/failed/cancelled) or
 * a brand-new watched job — never on every poll, so there is no refresh
 * loop. Previous statuses live in a ref keyed by job id; the first
 * observation only seeds the baseline because the RSC snapshot already
 * renders those rows.
 */
const WATCHED_KINDS = new Set(["agent_generation", "agent_deployment"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function isForwardTransition(prev: string, next: string): boolean {
  if (prev === next) return false;
  if (prev === "queued" && (next === "running" || TERMINAL.has(next)))
    return true;
  if (prev === "running" && TERMINAL.has(next)) return true;
  return false;
}

export function LiveAgentsRefresh() {
  const router = useRouter();
  const { jobs } = useJobs();
  const prevById = useRef(new Map<string, string>());
  const seeded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevById.current;
    if (!seeded.current) {
      for (const job of jobs) {
        if (WATCHED_KINDS.has(job.kind)) prev.set(job.id, job.status);
      }
      seeded.current = true;
      return;
    }
    let transitioned = false;
    const seen = new Set<string>();
    for (const job of jobs) {
      if (!WATCHED_KINDS.has(job.kind)) continue;
      seen.add(job.id);
      const before = prev.get(job.id);
      if (before === undefined) {
        // New watched job after baseline (e.g. a generation just started):
        // its placeholder row is not in the RSC snapshot yet.
        transitioned = true;
      } else if (isForwardTransition(before, job.status)) {
        transitioned = true;
      }
      prev.set(job.id, job.status);
    }
    // Drop ids that fell out of the list (dismissed/retention) so the map
    // does not grow forever.
    for (const id of [...prev.keys()]) {
      if (!seen.has(id)) prev.delete(id);
    }
    if (!transitioned) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      router.refresh();
    }, 500);
  }, [jobs, router]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return null;
}

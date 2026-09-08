"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobJson } from "@/lib/jobs/serialize";
import { BACKGROUND_AFTER_MS } from "@/lib/jobs/ui-helpers";
import { useJobs } from "./jobs-provider";

export type OptimisticPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "backgrounded"
  | "done";

export type WatchedResult = {
  job: JobJson;
  /** True when the server returned an already-running job (dedupe). */
  deduped: boolean;
};

type StartOptions = {
  title: string;
  /** Extra fields merged into the POST body (e.g. fileName). */
  extra?: Record<string, unknown>;
  /**
   * Caller-supplied idempotency key. Voice reconciliation passes the frozen
   * proposal key so an uncertain submission resubmits identically instead of
   * duplicating work; existing callers keep the random default.
   */
  idempotencyKey?: string;
};

/**
 * The house pattern for starting durable work optimistically:
 *
 * 1. Registers an optimistic entry so the global pill appears in <100ms.
 * 2. POSTs to /api/jobs (202 + job id) and hands control back at once.
 * 3. Watches the job; after BACKGROUND_AFTER_MS without a terminal state
 *    the phase flips to `backgrounded` so the caller can show the
 *    "continuing in the background" notice instead of a stuck spinner.
 * 4. Slow work still completes through the global provider (toast + pill)
 *    if the user navigates away — this watcher is best-effort per page.
 *
 * Duplicate submissions return the already-running job (`created: false`)
 * rather than starting new work; `deduped` lets the caller say so plainly.
 */
export function useOptimisticJob(kind: string) {
  const { addOptimistic, removeOptimistic, refresh } = useJobs();
  const [phase, setPhase] = useState<OptimisticPhase>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<WatchedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const watch = useCallback(
    (id: string, onTerminal?: (job: JobJson) => void) => {
      let cancelled = false;
      later(() => {
        if (!cancelled) {
          setPhase((prev) =>
            prev === "waiting" || prev === "starting"
              ? "backgrounded"
              : prev,
          );
        }
      }, BACKGROUND_AFTER_MS);
      const poll = async () => {
        try {
          const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
          if (!res.ok || cancelled) return;
          const { job } = (await res.json()) as { job: JobJson };
          if (cancelled) return;
          if (
            job.status === "succeeded" ||
            job.status === "failed" ||
            job.status === "cancelled"
          ) {
            onTerminal?.(job);
            setPhase("done");
            return;
          }
          later(() => void poll(), 2000);
        } catch {
          if (!cancelled) later(() => void poll(), 2000);
        }
      };
      void poll();
      return () => {
        cancelled = true;
      };
    },
    [later],
  );

  const start = useCallback(
    async (
      input: Record<string, unknown>,
      options: StartOptions,
      onTerminal?: (job: JobJson) => void,
    ) => {
      setError(null);
      setResult(null);
      setPhase("starting");
      const optimisticKey = addOptimistic(options.title, kind);
      try {
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            input,
            idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
            title: options.title,
            ...options.extra,
          }),
        });
        if (!res.ok) {
          const { error: message } = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(message ?? "This could not start.");
          setPhase("idle");
          removeOptimistic(optimisticKey);
          return null;
        }
        const { jobId: id, created } = (await res.json()) as {
          jobId: string;
          created: boolean;
        };
        const deduped = !created;
        setJobId(id);
        setPhase("waiting");
        watch(id, (job) => {
          setResult({ job, deduped });
          onTerminal?.(job);
        });
        void refresh();
        return { jobId: id, deduped };
      } catch {
        setError("This could not start. Check your connection and retry.");
        setPhase("idle");
        removeOptimistic(optimisticKey);
        return null;
      }
    },
    [addOptimistic, removeOptimistic, refresh, kind, watch],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setJobId(null);
    setResult(null);
    setError(null);
  }, []);

  /**
   * Watch a job started elsewhere (multipart upload route, server action).
   * Registers the optimistic entry so the pill appears immediately, then
   * polls like `start`. Returns the stop function for useEffect cleanup.
   */
  const trackExternal = useCallback(
    (
      id: string,
      options: { title: string; kind: string },
      onTerminal?: (job: JobJson) => void,
    ) => {
      setError(null);
      setJobId(id);
      setPhase("waiting");
      const optimisticKey = addOptimistic(options.title, options.kind);
      const stop = watch(id, (job) => {
        removeOptimistic(optimisticKey);
        onTerminal?.(job);
      });
      void refresh();
      return stop;
    },
    [addOptimistic, removeOptimistic, refresh, watch],
  );

  return { phase, jobId, result, error, start, watch, trackExternal, reset, setError, setResult };
}

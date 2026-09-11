"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import type { JobJson } from "@/lib/jobs/serialize";
import { shouldSuppressJobToast } from "@/lib/jobs/ui-helpers";

export type OptimisticEntry = {
  key: string;
  title: string;
  kind: string;
  startedAt: number;
};

type JobsContextValue = {
  jobs: JobJson[];
  activeJobs: JobJson[];
  unreadJobs: JobJson[];
  /** Jobs started <1 poll ago: shown immediately so the UI feels instant. */
  optimisticJobs: OptimisticEntry[];
  notificationsOn: boolean;
  refresh: () => Promise<void>;
  openJob: (job: JobJson) => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  dismissJob: (id: string) => Promise<void>;
  /** Mark a job seen without navigating — for flows that already consumed
   *  the result inline (e.g. the agent wizard's draft review). */
  markSeen: (id: string) => Promise<void>;
  /** Register a just-started job before the first poll confirms it. */
  addOptimistic: (title: string, kind: string) => string;
  /** Drop an optimistic entry (e.g. the start request failed). */
  removeOptimistic: (key: string) => void;
  enableNotifications: () => Promise<boolean>;
};

const JobsContext = createContext<JobsContextValue | null>(null);

export function useJobs(): JobsContextValue {
  const value = useContext(JobsContext);
  if (!value) throw new Error("useJobs must be used inside JobsProvider.");
  return value;
}

const TOAST_STATE_KEY = "voni-job-toast-state";
const NOTIFY_FLAG_KEY = "voni-job-notify";

function readToastState(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TOAST_STATE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeToastState(state: Record<string, string>): void {
  try {
    localStorage.setItem(TOAST_STATE_KEY, JSON.stringify(state));
  } catch {
    // Private mode: toasts still work for this session, just not across reloads.
  }
}

const TERMINAL = ["succeeded", "failed", "cancelled"];

function initialNotificationsOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      localStorage.getItem(NOTIFY_FLAG_KEY) === "on" &&
      "Notification" in window &&
      Notification.permission === "granted"
    );
  } catch {
    return false;
  }
}

export function isTerminal(status: string): boolean {
  return TERMINAL.includes(status);
}

/** "3s" for elapsed displays, "1m 12s" beyond a minute. */
export function formatElapsed(fromIso: string | null, toIso: string | null): string {
  const from = fromIso ? new Date(fromIso).getTime() : Date.now();
  const ms = Math.max(0, new Date(toIso ?? Date.now()).getTime() - from);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function jobStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

/**
 * Dashboard-level background-jobs provider.
 *
 * Polls /api/jobs on a cadence driven by what is happening: every 2s while
 * the visible tab has active jobs, every 5s while hidden with active jobs,
 * every 30s while idle — plus an immediate refresh on focus or reconnect.
 * Terminal transitions observed while watching fire one Sonner toast (and an
 * opt-in browser notification when the tab is hidden); `seenAt` persists so
 * reloads and other tabs never repeat them.
 */
export function JobsProvider({
  children,
  enabled,
}: {
  children: React.ReactNode;
  /** While false: no polling, no authenticated requests, no retained user
   *  state. The shell sets this from auth readiness (myplan.md Task 8). */
  enabled: boolean;
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobJson[]>([]);
  const [optimisticJobs, setOptimisticJobs] = useState<OptimisticEntry[]>([]);
  const [notificationsOn, setNotificationsOn] = useState(initialNotificationsOn);
  const jobsRef = useRef<JobJson[]>([]);
  const optimisticRef = useRef<OptimisticEntry[]>([]);
  const nudgedJobsRef = useRef(new Set<string>());
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Leaving readiness clears any retained user state so no previous user's
  // jobs, or identity, can appear once authentication lapses. Adjusted
  // during render (not in an effect) per React's previous-render pattern;
  // the provider instance itself stays mounted across signed-in navigation.
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
    if (!enabled) {
      setJobs([]);
      setOptimisticJobs([]);
    }
  }

  useEffect(() => {
    optimisticRef.current = optimisticJobs;
  }, [optimisticJobs]);

  const addOptimistic = useCallback((title: string, kind: string) => {
    const key =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    const entry: OptimisticEntry = { key, title, kind, startedAt: Date.now() };
    setOptimisticJobs((prev) => [...prev, entry]);
    // Safety net: never linger longer than 60s even if polls fail.
    setTimeout(() => {
      setOptimisticJobs((prev) => prev.filter((e) => e.key !== key));
    }, 60000);
    return key;
  }, []);

  const removeOptimistic = useCallback((key: string) => {
    setOptimisticJobs((prev) => prev.filter((e) => e.key !== key));
  }, []);

  const notify = useCallback((job: JobJson) => {
    // Pages that consume a result inline suppress the global toast for it;
    // see shouldSuppressJobToast for the exact contract.
    if (shouldSuppressJobToast(job.kind, job.status, typeof window !== "undefined" ? window.location.pathname : "")) {
      return;
    }
    const title = job.status === "succeeded" ? job.title : `${job.title} — ${jobStatusLabel(job.status)}`;
    const body =
      job.status === "succeeded"
        ? "Finished. Open it from Jobs."
        : (job.errorMessage ?? "Something went wrong. Open it from Jobs.");
    try {
      if (
        localStorage.getItem(NOTIFY_FLAG_KEY) === "on" &&
        "Notification" in window &&
        Notification.permission === "granted" &&
        document.hidden
      ) {
        new Notification(title, { body });
      }
    } catch {
      // Notifications are best-effort; the in-app result is the guarantee.
    }
    if (job.status === "succeeded") {
      // Durable completion: one notification per observed transition (the
      // caller gates on seen/unread state). The action keeps its destination
      // and callback; the toast closes when acted on, as before.
      const id = toast.add({
        type: "success",
        title,
        description: "Finished. Open it from Jobs.",
        actionProps: job.targetUrl
          ? {
              children: "View",
              onClick: () => {
                void fetch(`/api/jobs/${job.id}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "seen" }),
                }).catch(() => undefined);
                router.push(job.targetUrl as string);
                toast.close(id);
              },
            }
          : undefined,
      });
    } else {
      toast.add({ type: "error", title, description: body });
    }
  }, [router]);

  const refresh = useCallback(async () => {
    if (!enabledRef.current) return;
    let next: JobJson[];
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      if (!res.ok) return;
      next = ((await res.json()) as { jobs: JobJson[] }).jobs ?? [];
    } catch {
      return;
    }
    const prev = readToastState();
    const seeded = Object.keys(prev).length > 0 || jobsRef.current.length > 0;
    const updated: Record<string, string> = { ...prev };
    for (const job of next) {
      const before = prev[job.id];
      updated[job.id] = job.status;
      // Toast only transitions observed while watching: a terminal job that
      // was already terminal on first load badges instead of toasting.
      if (seeded && before && !isTerminal(before) && isTerminal(job.status)) {
        notify(job);
      }
    }
    // Drop ids that fell out of the list (dismissed/retention) so the
    // map does not grow forever.
    for (const id of Object.keys(updated)) {
      if (!next.some((j) => j.id === id)) delete updated[id];
    }
    writeToastState(updated);
    setJobs(next);
    const now = Date.now();
    for (const job of next) {
      const createdAt = job.createdAt ? new Date(job.createdAt).getTime() : now;
      if (
        job.status === "queued" &&
        now - createdAt >= 15_000 &&
        !nudgedJobsRef.current.has(job.id)
      ) {
        nudgedJobsRef.current.add(job.id);
        void fetch(`/api/jobs/${job.id}/wake`, { method: "POST" }).catch(() => undefined);
      }
      if (job.status !== "queued") nudgedJobsRef.current.delete(job.id);
    }
    // Consume optimistic entries confirmed by a real job of the same title
    // created after the optimistic start (dedupe returns the running job,
    // which also satisfies this), or older than 60s.
    setOptimisticJobs((prev) =>
      prev.filter((entry) => {
        if (now - entry.startedAt > 60000) return false;
        const confirmed = next.some((j) => {
          if (j.title !== entry.title) return false;
          const created = j.createdAt ? new Date(j.createdAt).getTime() : 0;
          return created >= entry.startedAt - 5000;
        });
        return !confirmed;
      }),
    );
  }, [notify]);

  useEffect(() => {
    // Gated on auth readiness: while disabled there is no polling, no
    // focus/reconnect refresh, and no listeners at all.
    if (!enabled) return;
    // Cadence follows state: the timer re-arms after every poll using the
    // latest jobs, so slowing to idle (or speeding back up) needs no events.
    // The first poll is scheduled, not run inline, so the effect itself sets
    // no state.
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      const active = jobsRef.current.some((j) => !isTerminal(j.status));
      timer = setTimeout(tick, active ? (document.hidden ? 5000 : 2000) : 30000);
    };
    timer = setTimeout(tick, 0);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh, enabled]);

  const openJob = useCallback(
    async (job: JobJson) => {
      if (!enabledRef.current) return;
      await fetch(`/api/jobs/${job.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seen" }),
      }).catch(() => undefined);
      await refresh();
      if (job.targetUrl) router.push(job.targetUrl);
    },
    [refresh, router],
  );

  const mutate = useCallback(
    async (id: string, action: "cancel" | "retry" | "dismiss") => {
      if (!enabledRef.current) return;
      await fetch(`/api/jobs/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).catch(() => undefined);
      await refresh();
    },
    [refresh],
  );

  const markSeen = useCallback(
    async (id: string) => {
      if (!enabledRef.current) return;
      await fetch(`/api/jobs/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seen" }),
      }).catch(() => undefined);
      await refresh();
    },
    [refresh],
  );

  const enableNotifications = useCallback(async () => {
    if (!("Notification" in window)) return false;
    // Explicit user gesture only — permission is never requested on load.
    const permission = await Notification.requestPermission();
    const on = permission === "granted";
    try {
      localStorage.setItem(NOTIFY_FLAG_KEY, on ? "on" : "off");
    } catch {
      // Ignore; flag just will not survive reloads.
    }
    setNotificationsOn(on);
    return on;
  }, []);

  const value = useMemo<JobsContextValue>(() => {
    const activeJobs = jobs.filter((j) => !isTerminal(j.status));
    const unreadJobs = jobs.filter(
      (j) => isTerminal(j.status) && !j.seenAt && !j.dismissedAt,
    );
    return {
      jobs,
      activeJobs,
      unreadJobs,
      optimisticJobs,
      notificationsOn,
      refresh,
      openJob,
      cancelJob: (id) => mutate(id, "cancel"),
      retryJob: (id) => mutate(id, "retry"),
      dismissJob: (id) => mutate(id, "dismiss"),
      markSeen,
      addOptimistic,
      removeOptimistic,
      enableNotifications,
    };
  }, [jobs, optimisticJobs, notificationsOn, refresh, openJob, mutate, markSeen, addOptimistic, removeOptimistic, enableNotifications]);

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

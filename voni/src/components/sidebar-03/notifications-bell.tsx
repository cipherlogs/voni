"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import {
  Ban,
  Bell,
  CircleCheck,
  CircleX,
  LoaderCircle,
  PhoneIncoming,
  PhoneOutgoing,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useJobs } from "@/components/jobs/jobs-provider";
import type { JobJson } from "@/lib/jobs/serialize";
import { cn } from "@/lib/utils";

type RecentCall = {
  id: string;
  name: string | null;
  direction: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

const CALLS_CACHE_MS = 60_000;

/** Compact relative time for bell rows ("5m ago", "2h ago", "3d ago"). */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function jobState(job: JobJson): { label: string; icon: React.ReactNode } {
  switch (job.status) {
    case "succeeded":
      return { label: "Finished", icon: <CircleCheck className="size-4 text-foreground" /> };
    case "failed":
      return { label: "Failed", icon: <CircleX className="size-4 text-foreground" /> };
    case "cancelled":
      return { label: "Cancelled", icon: <Ban className="size-4 text-foreground" /> };
    default:
      return { label: "Running", icon: <LoaderCircle className="size-4 animate-spin text-foreground" /> };
  }
}

/**
 * Sidebar header bell: live jobs plus recent calls, never sample data.
 *
 * Jobs stream through the shell-level jobs provider (running plus newly
 * finished). Calls are fetched lazily on open from the org-scoped
 * recent-activity endpoint and cached briefly — no ambient polling.
 * Opening the bell marks currently-unread jobs seen, so the count means
 * something unseen.
 */
export function NotificationsBell() {
  const { activeJobs, unreadJobs, markSeen } = useJobs();
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<RecentCall[] | null>(null);
  const callsAt = useRef(0);

  const count = activeJobs.length + unreadJobs.length;
  const label = count > 0 ? `Notifications (${count} unread)` : "Notifications";

  const fetchCalls = useCallback(async () => {
    if (Date.now() - callsAt.current < CALLS_CACHE_MS) return;
    callsAt.current = Date.now();
    try {
      const res = await fetch("/api/activity/recent", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { calls?: RecentCall[] };
      setCalls(Array.isArray(body.calls) ? body.calls : []);
    } catch {
      // Bell keeps the jobs half on network failure; calls retry next open
      // once the cache window lapses.
      callsAt.current = 0;
    }
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) return;
      void fetchCalls();
      if (unreadJobs.length > 0) {
        // Fire-and-forget: each marks its own seen flag and refreshes.
        void Promise.all(unreadJobs.map((job) => markSeen(job.id)));
      }
    },
    [fetchCalls, markSeen, unreadJobs],
  );

  const jobRows = [...unreadJobs, ...activeJobs].slice(0, 6);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={label}
                  className="relative rounded-full"
                />
              }
            />
          }
        >
          <Bell className="size-5" />
          {count > 0 ? (
            <span
              aria-hidden
              className="bg-sidebar-accent text-sidebar-accent-foreground absolute top-0.5 right-0.5 rounded-full px-1 text-[10px] leading-none font-medium tabular-nums shadow-sm"
            >
              {count}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent side="right" align="center">
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="my-6 w-80" side="right" align="start">
        {/* DropdownMenuLabel is Base UI's Menu.GroupLabel, which reads
            MenuGroupContext and throws when it has no Menu.Group above
            it — keeping the label inside the group it names is both the
            fix and the correct accessible structure. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {jobRows.length === 0 && (calls === null || calls.length === 0) ? (
            <p className="text-muted-foreground px-2 py-4 text-center text-sm">
              All caught up — job results and calls land here.
            </p>
          ) : null}
          {jobRows.map((job) => {
            const state = jobState(job);
            const when = timeAgo(job.updatedAt ?? job.createdAt);
            return (
              <DropdownMenuItem
                key={job.id}
                className="flex items-start gap-3"
                render={<Link href={job.targetUrl ?? "/jobs"} />}
              >
                <span className="mt-0.5 shrink-0">{state.icon}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{job.title}</span>
                  <span className="text-muted-foreground text-xs">
                    {state.label}
                    {when ? ` · ${when}` : ""}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
          {jobRows.length > 0 && calls !== null && calls.length > 0 ? (
            <DropdownMenuSeparator />
          ) : null}
          {(calls ?? []).map((call) => (
            <DropdownMenuItem
              key={call.id}
              className="flex items-start gap-3"
              render={<Link href={`/calls/${call.id}`} />}
            >
              <span className="mt-0.5 shrink-0">
                {call.direction === "outbound" ? (
                  <PhoneOutgoing className="size-4 text-foreground" />
                ) : (
                  <PhoneIncoming className="size-4 text-foreground" />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {call.direction === "outbound" ? "Outgoing call" : "Incoming call"}
                  {call.name ? ` · ${call.name}` : ""}
                </span>
                <span className="text-muted-foreground text-xs">
                  {timeAgo(call.startedAt ?? call.endedAt)}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={cn("justify-center text-sm text-muted-foreground hover:text-primary")}
            render={<Link href="/jobs" />}
          >
            View all jobs
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn("justify-center text-sm text-muted-foreground hover:text-primary")}
            render={<Link href="/calls" />}
          >
            View all calls
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

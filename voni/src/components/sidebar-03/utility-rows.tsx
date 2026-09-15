"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CircleCheck,
  History,
  LoaderCircle,
  Mic,
} from "lucide-react";

import { CommandMenu03 } from "@/components/command-menu-03/command-menu-03";
import { useCopilot } from "@/components/copilot/copilot-provider";
import { VoiceBars, type VoiceBarsMood } from "@/components/copilot/voice-bars";
import { useShellAuth } from "@/components/shell-auth";
import { useJobs } from "@/components/jobs/jobs-provider";
import { formatCallStatus } from "@/lib/calls/call-status";
import { getJobProgressPercent } from "@/lib/jobs/ui-helpers";
import { Progress } from "@/components/ui/progress";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * Rail-aware utility rows at the bottom of the sidebar content: search,
 * voice entry point, and jobs status. They replaced the removed top bar —
 * each row renders icon plus label when the rail is expanded and collapses
 * to a tooltip'd icon when it is not.
 */

export function SidebarUtilityGroup() {
  return (
    <SidebarMenu className="mt-auto gap-1">
      <SidebarMenuItem>
        <CommandMenu03 />
      </SidebarMenuItem>
      <SidebarVoiceRow />
      <SidebarJobsRow />
    </SidebarMenu>
  );
}

/**
 * Voice copilot entry point. Same start/stop contract as the old header
 * button — tapping Voice IS consent, the way a phone call works; tap again
 * to end. The live call controls and reading panel live in CopilotShell,
 * anchored to the viewport corner.
 */
function SidebarVoiceRow() {
  return (
    <SidebarMenuItem>
      <SidebarVoiceButton />
    </SidebarMenuItem>
  );
}

function SidebarVoiceButton() {
  const authState = useShellAuth();
  const authReady = authState.status === "authenticated";
  const authNote =
    authState.status === "pending"
      ? "Session loading — voice copilot unlocks after sign-in completes."
      : "Session unavailable — voice copilot is disabled. Refresh to retry.";
  const { status, live, proposals, start, stop, noteInteraction, agentPartial } =
    useCopilot();
  // Call timer, local to the button — the provider only learns durations at
  // hang-up. Reset happens in the start tap (an event); the effect only ticks.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!live) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [live]);

  const starting = status === "starting";
  const label =
    status === "idle" || status === "error"
      ? "Start voice copilot"
      : starting
        ? "Connecting voice copilot"
        : "End voice call";

  const mood: VoiceBarsMood =
    status === "live"
      ? agentPartial
        ? "speaking"
        : "listening"
      : starting || status === "reconnecting"
        ? "connecting"
        : "idle";

  const proposalText =
    proposals.length === 1
      ? "1 suggestion to review"
      : `${proposals.length} suggestions to review`;
  const text = starting
    ? "…"
    : proposals.length > 0
      ? proposalText
      : live
        ? formatCallStatus(elapsed)
        : "Voice copilot";

  return (
    <SidebarMenuButton
      tooltip={authReady ? label : `Voice copilot unavailable: ${authNote}`}
      aria-label={authReady ? label : `Voice copilot unavailable: ${authNote}`}
      title={authReady ? undefined : authNote}
      disabled={starting || !authReady}
      onClick={() => {
        noteInteraction();
        if (status === "idle" || status === "error") {
          setElapsed(0);
          start();
        } else if (status === "live" || status === "reconnecting") stop();
      }}
      className="group-data-[collapsible=icon]:justify-center"
    >
      {starting ? (
        <LoaderCircle className="animate-spin" aria-hidden />
      ) : live ? (
        <VoiceBars mood={mood} className="size-4" />
      ) : (
        <Mic aria-hidden />
      )}
      <span
        aria-live="polite"
        className="truncate tabular-nums group-data-[collapsible=icon]:hidden"
      >
        {text}
      </span>
    </SidebarMenuButton>
  );
}

/**
 * Global jobs status: the single jobs entry in the sidebar (the nav row and
 * the header bell were removed as duplicates). Running count with live
 * percent while work is in flight, results-ready text after, quiet link
 * otherwise — always one tap from /jobs, which is the retry path.
 */
function SidebarJobsRow() {
  const { activeJobs, unreadJobs, optimisticJobs, markSeen } = useJobs();

  const activeCount = activeJobs.length + optimisticJobs.length;
  const unreadText =
    unreadJobs.length === 1
      ? "1 result ready"
      : `${unreadJobs.length} results ready`;
  const firstActive = activeJobs[0];
  const firstPercent = firstActive
    ? getJobProgressPercent(firstActive)
    : null;
  const text =
    activeCount > 0
      ? `${activeCount} running`
      : unreadJobs.length > 0
        ? unreadText
        : "Background jobs";
  const ariaLabel =
    activeCount > 0
      ? `${activeCount} background jobs running. View jobs.`
      : unreadJobs.length > 0
        ? `${unreadText}. View jobs.`
        : "View background jobs";

  // Bell removal carry-over: opening jobs settles the unread count, so the
  // badge keeps meaning something unseen. Fire-and-forget so navigation
  // never waits on the seen write.
  const handleJobsOpen = () => {
    if (unreadJobs.length === 0) return;
    void Promise.all(unreadJobs.map((job) => markSeen(job.id)));
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={text}
        render={
          <Link href="/jobs" aria-label={ariaLabel} className="relative" onClick={handleJobsOpen} />
        }
        className="group-data-[collapsible=icon]:justify-center"
      >
        {activeCount > 0 ? (
          <LoaderCircle className="animate-spin" aria-hidden />
        ) : unreadJobs.length > 0 ? (
          <CircleCheck aria-hidden />
        ) : (
          <History aria-hidden />
        )}
        <span
          aria-live="polite"
          className="truncate group-data-[collapsible=icon]:hidden"
        >
          {text}
        </span>
      </SidebarMenuButton>
      {firstPercent != null ? (
        <Progress
          value={firstPercent}
          aria-label="Latest background job progress"
          className="mx-2 mt-1 h-1 group-data-[collapsible=icon]:hidden"
        />
      ) : null}
    </SidebarMenuItem>
  );
}

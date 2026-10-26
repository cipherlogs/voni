"use client";

import Link from "next/link";
import { memo, useDeferredValue, useEffect, useState } from "react";
import {
  CircleCheck,
  History,
  LoaderCircle,
  Mic,
} from "lucide-react";

import { CommandMenu03 } from "@/components/command-menu-03/command-menu-03";
import { useCopilot } from "@/components/copilot/copilot-context";
import { VoiceBars, type VoiceBarsMood } from "@/components/copilot/voice-bars";
import { useShellAuth } from "@/components/shell-auth";
import { useJobs } from "@/components/jobs/jobs-provider";
import { formatCallStatus } from "@/lib/calls/call-status";
import { getJobProgressPercent, getSidebarJobsText } from "@/lib/jobs/ui-helpers";
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

/**
 * Ticking second, isolated (ticket 08): the 1s meter lives in this leaf, so
 * the button — auth, proposals, start/stop wiring — never re-renders for the
 * clock. Mounts at zero when a call goes live and unmounts on hang-up, which
 * is the old reset-in-the-start-tap with no handler logic.
 */
const VoiceElapsedText = memo(function VoiceElapsedText() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return <>{formatCallStatus(elapsed)}</>;
});

function SidebarVoiceButton() {
  const authState = useShellAuth();
  const authReady = authState.status === "authenticated";
  const authNote =
    authState.status === "pending"
      ? "Session loading — voice copilot unlocks after sign-in completes."
      : "Session unavailable — voice copilot is disabled. Refresh to retry.";
  const { status, live, proposals, start, stop, noteInteraction, agentPartial } =
    useCopilot();
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
        ? <VoiceElapsedText />
        : "Voice copilot";

  return (
    <SidebarMenuButton
      tooltip={authReady ? label : `Voice copilot unavailable: ${authNote}`}
      aria-label={authReady ? label : `Voice copilot unavailable: ${authNote}`}
      disabled={starting || !authReady}
      onClick={() => {
        noteInteraction();
        if (status === "idle" || status === "error") {
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
/**
 * Background-job progress bar, isolated (ticket 08): provider polls
 * re-render the row every tick, but the bar only commits when its own
 * deferred percent settles — progress paint never blocks the row's urgent
 * copy ("N running", results-ready) in the same commit.
 */
const SidebarJobProgress = memo(function SidebarJobProgress({
  value,
}: {
  value: number;
}) {
  return (
    <Progress
      value={value}
      aria-label="Latest background job progress"
      className="mx-2 mt-1 h-1 group-data-[collapsible=icon]:hidden"
    />
  );
});

function SidebarJobsRow() {
  const { activeJobs, unreadJobs, optimisticJobs, markSeen } = useJobs();

  const activeCount = activeJobs.length + optimisticJobs.length;
  // Copy derives during render from the tested helper (ticket 08) — same
  // strings, no synced state.
  const { text, ariaLabel } = getSidebarJobsText({
    activeCount,
    unreadCount: unreadJobs.length,
  });
  const firstActive = activeJobs[0];
  const firstPercent = firstActive
    ? getJobProgressPercent(firstActive)
    : null;
  // Non-urgent paint: the bar follows the poll a commit later, never ahead
  // of the row's own copy.
  const deferredPercent = useDeferredValue(firstPercent);

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
      {deferredPercent != null ? (
        <SidebarJobProgress value={deferredPercent} />
      ) : null}
    </SidebarMenuItem>
  );
}

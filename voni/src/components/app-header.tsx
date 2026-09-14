"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleCheck, History, LoaderCircle, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useCopilot } from "@/components/copilot/copilot-provider";
import { formatCallStatus } from "@/lib/calls/call-status";
import { VoiceBars, type VoiceBarsMood } from "@/components/copilot/voice-bars";
import { useShellAuth } from "@/components/shell-auth";
import { getJobProgressPercent } from "@/lib/jobs/ui-helpers";
import { useJobs } from "@/components/jobs/jobs-provider";
import { CommandMenu03 } from "@/components/command-menu-03/command-menu-03";

/**
 * The shell header. It exists to name where you are — without a title the bar
 * was a trigger followed by a separator with nothing after it, which reads as
 * a broken component rather than a deliberate empty state.
 *
 * The title is derived from the path rather than passed down, so a new route
 * gets a correct header by adding one line here instead of threading a prop
 * through every page.
 *
 * Background work is ambient: a text status link (never an ambiguous icon)
 * plus a slim progress strip for the most recent active job. Detail lives in
 * the floating pill and on /jobs.
 */
/** Single source for section titles — also feeds the voice copilot's app manifest. */
export const SECTION_TITLES: Array<[string, string]> = [
  ["/dashboard", "Dashboard"],
  ["/agents", "Agents"],
  ["/campaigns", "Campaigns"],
  ["/leads", "Leads"],
  ["/numbers", "Phone numbers"],
  ["/calls", "Calls"],
  ["/jobs", "Background jobs"],
  ["/settings", "Settings"],
];


/** Self-reading title leaf: owns the usePathname call so the boundary above
 *  covers exactly the section-title computation. */
function HeaderTitle() {
  const pathname = usePathname();
  const match = SECTION_TITLES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return <span className="text-sm font-medium">{match ? match[1] : "Voni"}</span>;
}

/**
 * Voice copilot entry point. Same start/stop as the old floating button —
 * tapping Voice IS consent, the way a phone call works; tap again to end.
 * The live call controls and reading panel live in CopilotShell, anchored
 * as a dropdown below the header.
 */
function CopilotHeaderButton({
  authReady,
  authNote,
}: {
  authReady: boolean;
  authNote: string;
}) {
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
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="cursor-pointer"
      disabled={starting || !authReady}
      title={authReady ? undefined : authNote}
      aria-label={authReady ? label : `Voice copilot unavailable: ${authNote}`}
      onClick={() => {
        noteInteraction();
        if (status === "idle" || status === "error") {
          setElapsed(0);
          start();
        } else if (status === "live" || status === "reconnecting") stop();
      }}
    >
      {starting ? (
        <LoaderCircle className="animate-spin" aria-hidden />
      ) : live ? (
        <VoiceBars mood={mood} className="size-3.5" />
      ) : (
        <Mic aria-hidden />
      )}
      <span aria-live="polite" className="hidden tabular-nums sm:inline">
        {text}
      </span>
    </Button>
  );
}

export function AppHeader() {
  const authState = useShellAuth();
  const authReady = authState.status === "authenticated";
  const authNote =
    authState.status === "pending"
      ? "Session loading — voice copilot unlocks after sign-in completes."
      : "Session unavailable — voice copilot is disabled. Refresh to retry.";
  const { activeJobs, unreadJobs, optimisticJobs } = useJobs();

  const activeCount = activeJobs.length + optimisticJobs.length;
  const unreadText =
    unreadJobs.length === 1
      ? "1 result ready"
      : `${unreadJobs.length} results ready`;
  const firstActive = activeJobs[0];
  const firstPercent = firstActive
    ? getJobProgressPercent(firstActive)
    : null;

  return (
    <header className="app-shell-header bg-background sticky top-0 z-30 flex h-14 shrink-0 flex-col justify-center border-b px-4">
      <div className="flex items-center gap-2">
        {/* Collapse toggle: the rail starts open on desktop (layout
            defaultOpen) until the user collapses it from here
            or with cmd/ctrl+B; the provider remembers the choice. */}
        <SidebarTrigger
          className="-ml-1"
          aria-label="Toggle navigation sidebar"
          aria-keyshortcuts="Control+b Meta+b"
          title="Toggle navigation sidebar (Ctrl+B or Cmd+B)"
        />
        {/* Short stub divider: h-4 defeats the vendored
            data-vertical:self-stretch, pinning the stub to flex-start,
            so my-auto centers it via flex auto margins instead. */}
        <Separator orientation="vertical" className="mr-1 h-4 my-auto" />
        {/* Section title reads the URL, so it suspends behind its own
            boundary: the bar prerenders with the default title. */}
        <Suspense fallback={<span className="text-sm font-medium">Voni</span>}>
          <HeaderTitle />
        </Suspense>
        <div className="ml-auto flex items-center gap-1">
          <CommandMenu03 />
          <CopilotHeaderButton authReady={authReady} authNote={authNote} />
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={
              <Link
                href="/jobs"
                aria-label={
                  activeCount > 0
                    ? `${activeCount} background jobs running. View jobs.`
                    : unreadJobs.length > 0
                      ? `${unreadText}. View jobs.`
                      : "View background jobs"
                }
              />
            }
          >
            {activeCount > 0 ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : unreadJobs.length > 0 ? (
              <CircleCheck aria-hidden />
            ) : (
              <History aria-hidden />
            )}
            <span aria-live="polite" className="hidden sm:inline">
              {activeCount > 0
                ? `${activeCount} running`
                : unreadJobs.length > 0
                  ? unreadText
                  : "Background jobs"}
            </span>
          </Button>
        </div>
      </div>
      {firstPercent != null ? (
        <Progress
          value={firstPercent}
          aria-label="Latest background job progress"
          className="absolute inset-x-0 bottom-0"
        />
      ) : null}
    </header>
  );
}

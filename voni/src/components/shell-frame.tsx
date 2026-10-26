/**
 * Client frame pieces for the synchronous dashboard layout (myplan.md Task 8).
 *
 * These wrappers read the narrow shell-auth snapshot and wire it into the
 * existing providers/components. They re-render — never remount — on snapshot
 * changes, so JobsProvider/CopilotProvider instances survive signed-in
 * navigation and are enabled exactly once.
 *
 * Ticket 05: the Copilot engine (`copilot-provider`: AssemblyAI session,
 * judges, prompt builders, tool graphs) and the Copilot shell are heavy
 * interactive modules, so they load on demand behind `next/dynamic` with
 * shaped skeleton fallbacks. The wrappers below keep the same names, props,
 * and `enabled` auth gate — post-load behavior is identical, and the
 * provider instance still mounts once in the layout so one session survives
 * in-app navigation once loaded.
 */

"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { JobsProvider } from "@/components/jobs/jobs-provider";
import { CopilotBootSkeleton, CopilotShellSkeleton } from "@/components/page-skeletons";
import { useShellAuth } from "@/components/shell-auth";

const CopilotProvider = dynamic(
  () => import("@/components/copilot/copilot-provider").then((mod) => mod.CopilotProvider),
  { loading: () => <CopilotBootSkeleton /> },
);

const CopilotShell = dynamic(
  () => import("@/components/copilot/copilot-shell").then((mod) => mod.CopilotShell),
  { loading: () => <CopilotShellSkeleton /> },
);

export function ShellSidebar() {
  const auth = useShellAuth();
  const authenticated = auth.status === "authenticated";
  return (
    <AppSidebar
      user={authenticated ? auth.user : undefined}
      platformAdmin={authenticated ? auth.platformAdmin : false}
      sessionNote={
        auth.status === "unavailable"
          ? "Session unavailable — refresh to retry."
          : "Session loading…"
      }
    />
  );
}

/**
 * Jobs scope for the whole shell — the sidebar included. The "Background jobs"
 * nav badge reads useJobs(), so the provider must sit above ShellSidebar.
 * The `enabled` auth gate is unchanged: no polling, no authenticated
 * requests, and no retained user state until sign-in completes (Task 8).
 */
export function ShellJobsProvider({ children }: { children: ReactNode }) {
  const auth = useShellAuth();
  const enabled = auth.status === "authenticated";
  return <JobsProvider enabled={enabled}>{children}</JobsProvider>;
}

/**
 * Voice scope for the whole shell — the sidebar included. The sidebar voice
 * row reads useCopilot(), so the provider must sit above ShellSidebar, next
 * to the jobs scope. The `enabled` auth gate is unchanged: no mic, no
 * session, and no retained voice state until sign-in completes.
 */
export function ShellCopilotProvider({ children }: { children: ReactNode }) {
  const auth = useShellAuth();
  const enabled = auth.status === "authenticated";
  const platformAdmin = auth.status === "authenticated" ? auth.platformAdmin : false;
  return (
    <CopilotProvider enabled={enabled} platformAdmin={platformAdmin}>
      {children}
    </CopilotProvider>
  );
}

/**
 * The global Copilot call pill + reading panel, anchored to the viewport
 * corner beside the sidebar's Voice row. Loads on demand with the engine;
 * renders null at rest, so first paint is unchanged.
 */
export function ShellCopilotShell() {
  return <CopilotShell />;
}

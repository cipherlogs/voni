/**
 * Client frame pieces for the synchronous dashboard layout (myplan.md Task 8).
 *
 * These wrappers read the narrow shell-auth snapshot and wire it into the
 * existing providers/components. They re-render — never remount — on snapshot
 * changes, so JobsProvider/CopilotProvider instances survive signed-in
 * navigation and are enabled exactly once.
 */

"use client";

import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { JobsProvider } from "@/components/jobs/jobs-provider";
import { CopilotProvider } from "@/components/copilot/copilot-provider";
import { useShellAuth } from "@/components/shell-auth";

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

export function ShellProviders({ children }: { children: ReactNode }) {
  const auth = useShellAuth();
  const enabled = auth.status === "authenticated";
  const platformAdmin = auth.status === "authenticated" ? auth.platformAdmin : false;
  return (
    <JobsProvider enabled={enabled}>
      <CopilotProvider enabled={enabled} platformAdmin={platformAdmin}>
        {children}
      </CopilotProvider>
    </JobsProvider>
  );
}

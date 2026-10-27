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
 * shaped skeleton fallbacks. The provider boundary itself stays synchronous:
 * children render immediately under the light copilot-context with idle
 * defaults while the engine chunk loads beside them (never around them —
 * no whole-shell boot skeleton), then upgrade to the live engine value on
 * the same boundary once the boot probe publishes it. Post-load behavior is
 * identical, and the engine instance still mounts once in the layout so one
 * session survives in-app navigation once loaded.
 */

"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { JobsProvider } from "@/components/jobs/jobs-provider";
import { CopilotShellSkeleton } from "@/components/page-skeletons";
import { useShellAuth } from "@/components/shell-auth";
import {
  CopilotContext,
  createIdleCopilotValue,
  getEngineValue,
  subscribeEngineValue,
} from "@/components/copilot/copilot-context";

// The engine boot host (real provider + upgrade probe) loads on demand in
// its own chunk; it renders nothing while loading, so the shell below paints
// immediately. Warmed once after first paint (see ShellCopilotProvider) and
// on first copilot need — never part of the first-paint bundle.
const CopilotEngineBoot = dynamic(
  () => import("@/components/copilot/copilot-engine-boot").then((mod) => mod.CopilotEngineBoot),
  { loading: () => null },
);

const CopilotShell = dynamic(
  () => import("@/components/copilot/copilot-shell").then((mod) => mod.CopilotShell),
  { loading: () => <CopilotShellSkeleton /> },
);

// Post-paint engine warm-up, shared by the mount effect and the idle value's
// first-need hooks. Retries after a failed fetch; the dynamic boundary above
// deduplicates the chunk request itself.
let engineBootPreload: Promise<unknown> | null = null;
function preloadCopilotEngine(): void {
  engineBootPreload ??= import("@/components/copilot/copilot-engine-boot").catch(() => {
    engineBootPreload = null;
    return null;
  });
}

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
 *
 * The boundary is synchronous: children render immediately under idle
 * defaults while the engine chunk loads beside them. The boot host publishes
 * the live value once loaded and this same boundary swaps idle → live —
 * re-render, never remount — so the engine behaves identically after load.
 */
export function ShellCopilotProvider({ children }: { children: ReactNode }) {
  const auth = useShellAuth();
  const enabled = auth.status === "authenticated";
  const platformAdmin = auth.status === "authenticated" ? auth.platformAdmin : false;
  // Live engine value once the on-demand chunk publishes it; null before, so
  // first paint (and the server prerender) reads the idle defaults below.
  const live = useSyncExternalStore(subscribeEngineValue, getEngineValue, () => null);
  const idle = useMemo(() => createIdleCopilotValue(preloadCopilotEngine), []);
  // Post-paint warm-up: the chunk loads on demand after first paint (never
  // blocking it), so the first voice press finds the live engine.
  useEffect(() => {
    preloadCopilotEngine();
  }, []);
  return (
    <CopilotContext.Provider value={live ?? idle}>
      {children}
      <CopilotEngineBoot enabled={enabled} platformAdmin={platformAdmin} />
    </CopilotContext.Provider>
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

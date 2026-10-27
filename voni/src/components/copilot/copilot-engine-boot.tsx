/**
 * On-demand Copilot engine host (shell review fix).
 *
 * This module is the heavy side of the shell seam: it statically imports
 * the real CopilotProvider (AssemblyAI session, judges, prompt builders,
 * tool graphs), so all of that lands in its own chunk. The shell mounts
 * this host via next/dynamic beside — never around — its children, so
 * first paint renders immediately under idle defaults while this chunk
 * loads. The probe below publishes the live context value to the light
 * upgrade slot, swapping the shell from idle to live without remounting
 * anything: post-load behavior is the engine's own.
 */

"use client";

import { useEffect } from "react";
import { CopilotProvider } from "@/components/copilot/copilot-provider";
import { publishEngineValue, useCopilot } from "@/components/copilot/copilot-context";

/**
 * Null-rendering probe: reads the live engine value from the real provider
 * above it and publishes it to the shell's upgrade slot. No UI, no state —
 * the shell re-renders (never remounts) with the live value.
 */
function CopilotEngineProbe() {
  const value = useCopilot();
  useEffect(() => {
    publishEngineValue(value);
    return () => publishEngineValue(null);
  }, [value]);
  return null;
}

export function CopilotEngineBoot({
  enabled,
  platformAdmin = false,
}: {
  /** Same gate as the engine: no token, mic, or session until sign-in. */
  enabled: boolean;
  platformAdmin?: boolean;
}) {
  return (
    <CopilotProvider enabled={enabled} platformAdmin={platformAdmin}>
      <CopilotEngineProbe />
    </CopilotProvider>
  );
}

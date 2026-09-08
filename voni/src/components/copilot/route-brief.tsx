/**
 * One-line route registration for screens with no voice-mutable controls:
 * publishes the screen brief (and the global tools) without handlers.
 * Screens with proposals register their own tools instead — see the wizard.
 */

"use client";

import { useMemo } from "react";
import { useCopilotRoute } from "./copilot-provider";

export function RouteBrief({ route, brief }: { route: string; brief: string }) {
  const config = useMemo(
    () => ({ tools: [], targets: new Map(), brief }),
    [brief],
  );
  useCopilotRoute(route, config);
  return null;
}

"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Tooltip for one control — the replacement for native `title=`, which is
 * slow, unstyled, and never shows on touch or keyboard focus. The child keeps
 * its own aria-label; the tip only adds the visible hint.
 */
export function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

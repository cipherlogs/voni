"use client";

import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/status-dot";
import { cn } from "@/lib/utils";

/**
 * Floating dirty indicator for the agent editor (Goal 5).
 *
 * A zero-height sticky layer: it takes no room in the column (no gap to
 * reserve, nothing shifts when it appears) and pins the pill to the top-right
 * of the viewport while a long form scrolls — under the phone header
 * (`top-14`), at `top-4` on desktop where there is no top bar.
 *
 * Bound to an `isDirty` boolean only — informational, never actions.
 * `aria-live="polite"` announces the change without stealing focus.
 */
export function UnsavedPill({ isDirty }: { isDirty: boolean }) {
  return (
    <div
      aria-live="polite"
      className="sticky top-14 z-20 flex h-0 justify-end md:top-4"
    >
      <Badge
        variant="secondary"
        className={cn("shadow-sm", !isDirty && "invisible")}
        data-testid="unsaved-pill"
      >
        <StatusDot tone="warning" className="text-xs">
          Unsaved changes
        </StatusDot>
      </Badge>
    </div>
  );
}

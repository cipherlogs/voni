"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Floating dirty indicator for the agent editor (Goal 5).
 *
 * The pill sticks below the dashboard header (`h-14` = 3.5rem, sticky
 * `z-30`) while the user scrolls a long form, so the dirty state stays
 * visible from anywhere. `z-20` keeps it under the header; the row reserves
 * its height whether visible or not so the footer below never shifts.
 *
 * Bound to an `isDirty` boolean only — informational text plus a dot, never
 * actions. Save/Discard stay in the form footer. `aria-live="polite"` so
 * screen readers announce the state change without stealing focus.
 */
export function UnsavedPill({ isDirty }: { isDirty: boolean }) {
  return (
    <div
      aria-live="polite"
      className="sticky top-14 z-20 flex min-h-7 items-center justify-start"
    >
      <Badge
        variant="secondary"
        className={cn(!isDirty && "invisible")}
        data-testid="unsaved-pill"
      >
        <span
          aria-hidden
          className="inline-block size-2 rounded-full bg-chart-2"
        />
        Unsaved changes
      </Badge>
    </div>
  );
}

"use client";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { WIZARD_STEPS } from "./use-wizard-draft";

/**
 * Onboarding-06 timeline idiom: one connected row, a marker per step plus
 * two-line text (Step N over the label). Connector segments join the
 * markers; done steps show a lucide Check on a filled circle, the active
 * step a primary ring, upcoming steps a muted outline. No percentage
 * display.
 */
export function TimelineBar({
  current,
  completed,
  onSelect,
}: {
  current: number;
  completed: boolean[];
  onSelect: (step: number) => void;
}) {
  return (
    <ol className="flex items-stretch gap-1" aria-label="Creation progress">
      {WIZARD_STEPS.map((label, i) => {
        const done = completed[i] || i < current;
        const active = i === current;
        return (
          <li key={label} className="flex min-w-0 flex-1">
            <Button
              variant="ghost"
              data-copilot-effect="view"
              type="button"
              onClick={() => onSelect(i)}
              aria-current={active ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${label}${done ? " (done)" : active ? " (current)" : ""}`}
              className="flex h-auto flex-1 items-center justify-center rounded-md px-1 py-2 text-center pointer-coarse:min-h-14"
            >
              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                {i > 0 ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-1/2 left-0 h-px w-4 -translate-y-1/2",
                      done || active ? "bg-primary" : "bg-border",
                    )}
                  />
                ) : null}
                <span
                  aria-hidden
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-xs",
                    done && "bg-primary text-primary-foreground",
                    active && !done && "border border-primary text-primary ring-1 ring-primary/30",
                    !done && !active && "border text-muted-foreground",
                  )}
                >
                  {done ? <Check aria-hidden className="size-3" /> : i + 1}
                </span>
                <span
                  className={cn(
                    "flex min-w-0 flex-col items-start gap-0.5 text-left",
                    active ? "font-medium" : "text-muted-foreground",
                  )}
                >
                  <span className="text-xs">Step {i + 1}</span>
                  <span className="min-w-0 truncate text-sm">{label}</span>
                </span>
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

"use client";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { WIZARD_STEPS } from "./use-wizard-draft";

/**
 * Three equal-width step buttons. One centered row (number + label, wraps
 * when needed), compact by default with a touch floor on coarse pointers.
 * No percentage display.
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
              variant={active ? "secondary" : "ghost"}
              data-copilot-effect="view"
              type="button"
              onClick={() => onSelect(i)}
              aria-current={active ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${label}${done ? " (done)" : active ? " (current)" : ""}`}
              className="flex h-auto flex-1 cursor-pointer items-center justify-center rounded-md px-1 py-2 text-center pointer-coarse:min-h-14"
            >
              <span
                className={cn(
                  "flex min-w-0 items-center justify-center gap-1.5 text-xs break-words sm:text-sm",
                  active ? "font-medium" : "text-muted-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
                    done && "bg-primary text-primary-foreground",
                    active && !done && "border border-primary text-primary",
                    !done && !active && "border text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0">{label}</span>
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

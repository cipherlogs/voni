"use client";
import { Button } from "@/components/ui/button";

import { Check } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { WIZARD_STEPS } from "./use-wizard-draft";

export function wizardProgressText(step: number, total: number): string {
  const pct = Math.round(((step + 1) / total) * 100);
  return `Step ${step + 1} of ${total} · ${pct}%`;
}

function StepNode({
  done,
  active,
  index,
}: {
  done: boolean;
  active: boolean;
  index: number;
}) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full",
        done && "bg-primary text-primary-foreground",
        active && !done && "border border-primary text-primary",
        !done && !active && "border text-muted-foreground",
      )}
      aria-hidden
    >
      {done ? (
        <Check className="size-3" />
      ) : active ? (
        <span className="wizard-active-dot size-1.5 rounded-full bg-primary" />
      ) : (
        <span className="text-xs">{index + 1}</span>
      )}
    </span>
  );
}

/**
 * Vertical stepper rail (A1). Completed steps pop a check; the active step
 * pulses inside the 220ms token; the connector fill animates on advance.
 */
export function TimelineRail({
  current,
  completed,
  onSelect,
}: {
  current: number;
  completed: boolean[];
  onSelect: (step: number) => void;
}) {
  const progress = Math.round(((current + 1) / WIZARD_STEPS.length) * 100);
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1">
        {WIZARD_STEPS.map((label, i) => {
          const done = completed[i] || i < current;
          const active = i === current;
          return (
            <li key={label}>
              <Button
                variant="ghost"
                data-copilot-effect="view"
                type="button"
                onClick={() => onSelect(i)}
                aria-current={active ? "step" : undefined}
                className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              >
                <span aria-hidden><StepNode done={done} active={active} index={i} /></span>
                <span className={active ? "font-medium" : "text-muted-foreground"}>{label}</span>
              </Button>
            </li>
          );
        })}
      </ol>
      <Progress value={progress} className="h-2 [&_[data-slot=progress-track]]:h-2" aria-label={wizardProgressText(current, WIZARD_STEPS.length)} />
      <p className="text-muted-foreground text-xs" aria-hidden>
        {wizardProgressText(current, WIZARD_STEPS.length)}
      </p>
    </div>
  );
}

/**
 * Horizontal segmented bar (A2/A3). Each segment fills as its step
 * completes; the active segment's node pulses. Same tokens, rotated.
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
    <ol className="flex items-start gap-1" aria-label="Creation progress">
        {WIZARD_STEPS.map((label, i) => {
          const done = completed[i] || i < current;
          const active = i === current;
          return (
            <li key={label} className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Button
                variant="ghost"
                data-copilot-effect="view"
                type="button"
                onClick={() => onSelect(i)}
                aria-current={active ? "step" : undefined}
                aria-label={`${label}${done ? " (done)" : active ? " (current)" : ""}`}
                className="group flex cursor-pointer flex-col gap-1.5 rounded-md p-1"
              >
                <span
                  className={cn(
                    "h-2 w-full rounded-full transition-colors md:h-2.5",
                    done ? "bg-primary" : active ? "bg-primary/40" : "bg-muted",
                  )}
                  aria-hidden
                />
                <span className="flex items-center gap-1.5">
                  <span aria-hidden><StepNode done={done} active={active} index={i} /></span>
                  <span
                    className={cn(
                      "truncate text-xs",
                      active ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                </span>
              </Button>
            </li>
          );
        })}
      </ol>
  );
}

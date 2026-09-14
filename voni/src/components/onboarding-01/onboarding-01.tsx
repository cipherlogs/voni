"use client";

/**
 * Adapted from Blocks `@blocks-so/onboarding-01` (MIT, Ephraim Duncan).
 * Voni keeps the progress header and expandable step rows, while completion
 * comes only from persisted workspace data supplied by the dashboard.
 */

import Link from "next/link";
import {
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  CirclePlay,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import type { DashboardSetupStep } from "@/lib/dashboard/setup";
import { cn } from "@/lib/utils";

const STEP_ICONS = {
  agent: Bot,
  leads: Upload,
  activation: CirclePlay,
} as const;

function StepIndicator({ completed }: { completed: boolean }) {
  if (completed) {
    return (
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check aria-hidden="true" />
      </span>
    );
  }
  return <CircleDashed aria-hidden="true" className="shrink-0 text-muted-foreground" />;
}

export function Onboarding01({ steps }: { steps: DashboardSetupStep[] }) {
  const [openStepId, setOpenStepId] = useState<string | null>(
    () => steps.find((step) => !step.completed)?.id ?? null,
  );
  const completedCount = steps.filter((step) => step.completed).length;
  const progress = steps.length > 0 ? (completedCount / steps.length) * 100 : 0;

  return (
    <Card className="gap-0 p-0">
      <CardHeader className="gap-3 p-6 pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <CardTitle>Get ready for your first campaign</CardTitle>
          <span className="shrink-0 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{completedCount}</span>
            {` / ${steps.length} completed`}
          </span>
        </div>
        <CardDescription>
          Complete the next real workspace step. Progress updates from saved data.
        </CardDescription>
        <Progress
          value={progress}
          aria-label={`${completedCount} of ${steps.length} setup steps completed`}
        />
      </CardHeader>
      <CardContent className="flex flex-col p-3 pt-0">
        {steps.map((step) => {
          const Icon = STEP_ICONS[step.id];
          const isOpen = openStepId === step.id;
          return (
            <Collapsible
              key={step.id}
              open={isOpen}
              onOpenChange={(nextOpen) => setOpenStepId(nextOpen ? step.id : null)}
              className={cn("rounded-lg", isOpen && "bg-muted")}
            >
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className="group/button h-auto w-full justify-start px-3 py-3 text-left"
                  />
                }
              >
                <StepIndicator completed={step.completed} />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon aria-hidden="true" />
                  <span className="truncate font-medium">{step.title}</span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="ml-auto shrink-0 transition-transform group-data-panel-open/button:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col items-start gap-3 px-4 pb-4 pl-16">
                <p className="max-w-prose text-sm leading-6 text-muted-foreground">
                  {step.description}
                </p>
                <Button
                  nativeButton={false}
                  size="sm"
                  render={<Link href={step.actionHref} />}
                >
                  {step.actionLabel}
                </Button>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </CardContent>
    </Card>
  );
}

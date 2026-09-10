"use client";

import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

/**
 * The submitted state for /agents/new: shows the instant the user clicks
 * Generate, before the 3s background threshold. A mini success ("Brief
 * received") proves the click landed, the progress states what is happening,
 * and the safe-to-leave line answers the real question — can I go? The form
 * stays hidden behind this panel until the job reaches a terminal state.
 */
export function GenerationSubmitted({ onOpenJobs }: { onOpenJobs?: () => void }) {
  return (
    <Alert aria-live="polite" className="border-primary/30 bg-primary/5">
      <LoaderCircle className="animate-spin" aria-hidden />
      <AlertTitle>Generating your agent…</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Check aria-hidden className="size-4 shrink-0 text-primary" />
          Brief received — the form is submitted.
        </span>
        <Progress value={null} aria-label="Generation in progress" />
        <span>
          Safe to leave: this keeps running in the background and the draft
          will be waiting here when it is ready.
        </span>
        <span className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenJobs}
          >
            Open Jobs
            <ArrowRight aria-hidden />
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The background-state pattern for /agents/new: an actionable Alert (not a
 * muted paragraph) with a path to Jobs. The job itself still runs through
 * useOptimisticJob + the global pill — this is only the inline notice.
 */
export function GenerationNotice({
  title,
  onOpenJobs,
  onKeepEditing,
}: {
  title: string;
  onOpenJobs?: () => void;
  onKeepEditing?: () => void;
}) {
  return (
    <Alert aria-live="polite" className="border-primary/30 bg-primary/5">
      <LoaderCircle className="animate-spin" aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>
          This is continuing in the background. You can browse Voni and return
          when it is ready — the draft will be waiting here.
        </span>
        <Progress value={null} aria-label="Generation in progress" />
        <span className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenJobs}
          >
            Open Jobs
            <ArrowRight aria-hidden />
          </Button>
          {onKeepEditing ? (
            <Button type="button" size="sm" variant="ghost" onClick={onKeepEditing}>
              Keep editing
            </Button>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}

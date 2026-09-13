"use client";

import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

/**
 * The single generation status card for /agents/new: one stable Alert across
 * the working (<3s) and backgrounded phases — same border, padding, and
 * actions, so the 3s threshold flip never re-lays the panel mid-read. Only
 * the title line swaps; the safe-to-leave line and the Open Jobs action are
 * identical in both phases.
 */
export function GenerationStatusCard({
  phase,
  onOpenJobs,
  onKeepEditing,
  onCancel,
}: {
  phase: "working" | "backgrounded";
  onOpenJobs?: () => void;
  onKeepEditing?: () => void;
  /** Cancels the in-flight generation job (durable cancel via Jobs). */
  onCancel?: () => void;
}) {
  return (
    <Alert aria-live="polite" className="border-primary/30 bg-primary/5">
      <LoaderCircle className="animate-spin" aria-hidden />
      <AlertTitle>
        {phase === "working" ? "Generating your agent…" : "Still generating your draft…"}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Check aria-hidden className="size-4 shrink-0 text-primary" />
          Brief received — safe to leave; the draft will wait here.
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
          {onCancel ? (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel generation
            </Button>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}

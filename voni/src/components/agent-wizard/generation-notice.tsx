"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

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

"use client";

import { LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

/**
 * The minimal generation wait state for /agents/new: one stable Alert across
 * the working (<3s) and backgrounded phases — same border, padding, and
 * Cancel action, so the 3s threshold flip never re-lays the panel mid-read.
 * Only the title line swaps. Cancel-only by design: the wizard stays hidden
 * until the job reaches a terminal state.
 */
export function GenerationStatusCard({
  phase,
  onCancel,
}: {
  phase: "working" | "backgrounded";
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
        <span className="font-medium text-foreground">
          Brief received — safe to leave; the draft will wait here.
        </span>
        <Progress value={null} aria-label="Generation in progress" />
        {onCancel ? (
          <span className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel generation
            </Button>
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

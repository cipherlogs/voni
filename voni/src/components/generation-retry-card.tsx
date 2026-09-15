"use client";

import { CircleAlert, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";

/**
 * Terminal-generation retry card (Goal 6).
 *
 * Adapts the blocks.so onboarding-02 StepCard idiom: indicator + title +
 * description + action button, with the active-state surface
 * (`border-primary/30 bg-muted/50`). Single step (index 0, never completed —
 * the retry IS the step), so the indicator is a static numbered disc plus an
 * error icon. Secondary "View in Jobs" is text-only; the primary Retry mints
 * a fresh idempotency key at the call site.
 *
 * Copy contract: (1) the draft didn't finish, (2) the retry action starts a
 * fresh attempt, (3) a completed draft appears here for review. Failure copy
 * itself comes from jobErrorCopy(errorCode) at the call site — never generic.
 */
export function GenerationRetryCard({
  title,
  description,
  retrying,
  onRetry,
  onOpenJobs,
  retryTestId,
}: {
  title: string;
  description: string;
  retrying: boolean;
  onRetry: () => void;
  onOpenJobs: () => void;
  retryTestId?: string;
}) {
  return (
    <div
      data-testid="generation-retry-card"
      className="rounded-lg border border-primary/30 bg-muted/50 p-4"
    >
      <div className="flex gap-3">
        <div className="mt-0.5 shrink-0">
          <div className="flex size-7 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-xs">
            1
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground leading-6">{title}</p>
              <p className="mt-0.5 text-muted-foreground text-sm leading-5">
                {description}
              </p>
              <span className="mt-3 flex flex-wrap items-center gap-2">
                <LoadingButton
                  type="button"
                  size="sm"
                  pending={retrying}
                  pendingText="Starting…"
                  icon={<RotateCw />}
                  onClick={onRetry}
                  data-testid={retryTestId ?? "generation-retry"}
                >
                  Retry generation
                </LoadingButton>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onOpenJobs}
                >
                  View in Jobs
                </Button>
              </span>
            </div>
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-muted-foreground/40"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

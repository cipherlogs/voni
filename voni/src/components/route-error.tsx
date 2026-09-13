"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Shared error-boundary UI for every dashboard route segment's `error.tsx`.
 * Next 16 error boundaries call back with `retry`, not the older `reset`.
 *
 * Restyled in-style per voni/DESIGN.md §4 (feedback): Alert + Button idiom,
 * flex-col + gap, text-sm, no arbitrary values. Failures incl. the 429
 * countdown stay here; voice-call session/mic/dropped/hangup states stay in
 * voice-call, copilot RecoveryHint stays in copilot.
 */
export function RouteError({
  error,
  retry,
  retryAfterSeconds,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  /** Optional 429-style backoff: disables retry behind a live countdown, then auto-enables. */
  retryAfterSeconds?: number;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // 429 countdown mirroring the voice-call pattern: "Try again in Ns" that
  // auto-enables at zero. Null (no backoff passed) means retry is immediate.
  const [retryIn, setRetryIn] = useState<number | null>(
    retryAfterSeconds ?? null,
  );
  // A new error resets a stale countdown; a changed backoff re-arms it.
  // (keyed by error so the set happens during render selection, not as a
  // passive effect — avoids the set-state-in-effect lint and the extra tick.)
  const [armedFor, setArmedFor] = useState<unknown>(error);
  if (armedFor !== error) {
    setArmedFor(error);
    setRetryIn(retryAfterSeconds ?? null);
  }
  useEffect(() => {
    if (retryIn === null || retryIn <= 0) return;
    const id = window.setTimeout(() => setRetryIn(retryIn - 1), 1000);
    return () => window.clearTimeout(id);
  }, [retryIn]);
  const waiting = retryIn !== null && retryIn > 0;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          {error.message || "This page could not be loaded. Try again."}
        </AlertDescription>
      </Alert>
      <div>
        <Button variant="outline" disabled={waiting} onClick={() => retry()}>
          {waiting ? `Try again in ${retryIn}s` : "Try again"}
        </Button>
      </div>
    </div>
  );
}

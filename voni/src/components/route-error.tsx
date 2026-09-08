"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Shared error-boundary UI for every dashboard route segment's `error.tsx`.
 * Next 16 error boundaries call back with `retry`, not the older `reset`.
 */
export function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          {error.message || "This page could not be loaded. Try again."}
        </AlertDescription>
      </Alert>
      <div>
        <Button variant="outline" onClick={() => retry()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

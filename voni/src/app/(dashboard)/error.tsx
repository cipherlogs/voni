"use client";

import { RouteError } from "@/components/route-error";

/**
 * Group boundary for every dashboard route: any segment failure renders the
 * shared RouteError card with a retry — never Next's "missing required
 * error components" fallback.
 */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} />;
}

"use client";

import { RouteError } from "@/components/route-error";
import { PUBLIC_CONTAINER } from "@/lib/public-container";

/** Next 16 hands the boundary `retry`, not the older `reset`. */
export default function EmailControlError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="flex min-h-svh flex-1 flex-col">
      <div className={`${PUBLIC_CONTAINER} flex flex-col gap-6 py-8 md:py-10`}>
        <RouteError error={error} retry={retry} />
      </div>
    </main>
  );
}

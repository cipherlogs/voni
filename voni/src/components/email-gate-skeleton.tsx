import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PUBLIC_CONTAINER } from "@/lib/public-container";

/**
 * The `/email` gate's shape, shared by every place that draws it: the real gate
 * screen in `page.tsx` (after the page password has been checked) and both
 * loading fallbacks before that check has run — `page.tsx`'s Suspense fallback
 * and the route's `loading.tsx`.
 *
 * Deliberately not panel-shaped. A visitor without the page cookie is locked
 * out, so neither the gate nor either fallback may show panel chrome: no header
 * bar, no title describing the check, no card or table skeletons.
 */
export function GateFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh flex-1 flex-col">
      <div className={`${PUBLIC_CONTAINER} flex flex-1 items-center py-16`}>
        <div className="mx-auto grid w-full max-w-md gap-6">{children}</div>
      </div>
    </main>
  );
}

/**
 * Title, one line of copy, then a form-sized block — the gate screen's own
 * heights, so the swap to the real form does not move anything.
 */
export function GateSkeleton() {
  return (
    <GateFrame>
      <div role="status" aria-label="Loading email page" className="grid gap-6">
        <div className="grid gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </div>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </GateFrame>
  );
}

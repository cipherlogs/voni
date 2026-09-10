import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Header row shared by every list page: a title/subtitle pair and an optional action button. */
export function PageHeaderSkeleton({ withAction = true }: { withAction?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      {withAction ? <Skeleton className="h-8 w-28" /> : null}
    </div>
  );
}

/** Matches the agents/campaigns list shape: a stack of cards, each one row. */
export function CardListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i}>
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-full max-w-md" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-8 w-16 shrink-0" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Matches the leads/numbers table shape. */
export function TableSkeleton({ rows = 6, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex flex-col gap-4">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-4">
              {Array.from({ length: columns }, (_, j) => (
                <Skeleton key={j} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Matches the dashboard's pipeline-stage stat grid. */
export function StatGridSkeleton({ cards = 5 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: cards }, (_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-20" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-7 w-10" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** A single detail page: a header block plus a couple of content cards. */
export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 py-6">
          <Skeleton className="h-4 w-full max-w-sm" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-full max-w-xs" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-3 py-6">
          <Skeleton className="h-4 w-full max-w-sm" />
          <Skeleton className="h-4 w-full max-w-md" />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Mirrors the /agents/new 2-step creator: heading, timeline bar, one form
 * card with two labeled sections, and the Back/primary footer row.
 */
export function NewAgentSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-hidden>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <Skeleton className="h-2 w-full" />
      <Card>
        <CardContent className="flex flex-col gap-6 py-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full max-w-xs" />
            <Skeleton className="h-16 w-full" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full max-w-xs" />
            <Skeleton className="h-16 w-full" />
          </div>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}

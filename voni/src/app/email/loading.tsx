import { CardListSkeleton, TableSkeleton } from "@/components/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { PUBLIC_CONTAINER } from "@/lib/public-container";

/** The static shell, then the panel's two real shapes while they stream in. */
export default function EmailControlLoading() {
  return (
    <main className="flex min-h-svh flex-1 flex-col">
      <header className="border-b">
        <div className={`${PUBLIC_CONTAINER} flex h-14 items-center justify-between`}>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-20" />
        </div>
      </header>

      <div className={`${PUBLIC_CONTAINER} flex flex-col gap-6 py-8 md:py-10`}>
        <div className="flex max-w-2xl flex-col gap-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-full max-w-lg" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>

        <div
          role="status"
          aria-label="Loading email control panel"
          className="grid gap-6"
        >
          <CardListSkeleton rows={2} />
          <TableSkeleton rows={6} columns={6} />
        </div>
      </div>
    </main>
  );
}

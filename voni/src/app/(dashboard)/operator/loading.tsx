import { DetailSkeleton, PageHeaderSkeleton } from "@/components/page-skeletons";

export default function OperatorLoading() {
  return (
    <div data-testid="operator-shell" className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeaderSkeleton />
      <div role="status" aria-label="Loading operator console">
        <DetailSkeleton />
      </div>
    </div>
  );
}

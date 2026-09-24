import { FlatFormSkeleton, PageHeaderSkeleton } from "@/components/page-skeletons";

export default function OperatorLoading() {
  return (
    <div data-testid="operator-shell" className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <div role="status" aria-label="Loading operator console">
        <FlatFormSkeleton sections={5} />
      </div>
    </div>
  );
}

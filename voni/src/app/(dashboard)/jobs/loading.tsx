import { PageHeaderSkeleton, TableSkeleton } from "@/components/page-skeletons";

export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <TableSkeleton rows={6} columns={5} />
    </div>
  );
}

import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/page-skeletons";

export default function LeadsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <TableSkeleton />
    </div>
  );
}

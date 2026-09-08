import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/page-skeletons";

export default function NumbersLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <TableSkeleton />
    </div>
  );
}

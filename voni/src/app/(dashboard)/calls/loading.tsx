import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/page-skeletons";

export default function CallsLoading() {
  return (
    <div
      role="status"
      aria-label="Loading calls"
      className="flex flex-col gap-6"
    >
      <PageHeaderSkeleton withAction={false} />
      {/* Five columns to match the calls table: Lead, Direction,
          Started, Duration, and the sr-only Open column. */}
      <TableSkeleton rows={6} columns={5} />
    </div>
  );
}

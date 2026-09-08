import {
  CardListSkeleton,
  PageHeaderSkeleton,
} from "@/components/page-skeletons";

/** Group fallback while any dashboard segment loads without its own shape. */
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardListSkeleton />
    </div>
  );
}

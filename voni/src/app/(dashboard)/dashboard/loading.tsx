import {
  PageHeaderSkeleton,
  StatGridSkeleton,
} from "@/components/page-skeletons";

export default function DashboardHomeLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton withAction={false} />
      <StatGridSkeleton cards={4} />
    </div>
  );
}

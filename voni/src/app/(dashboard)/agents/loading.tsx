import {
  CardListSkeleton,
  PageHeaderSkeleton,
} from "@/components/page-skeletons";

export default function AgentsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardListSkeleton />
    </div>
  );
}

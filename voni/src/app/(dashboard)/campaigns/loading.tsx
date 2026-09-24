import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/page-skeletons";

export default function CampaignsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <TableSkeleton rows={4} columns={5} />
    </div>
  );
}

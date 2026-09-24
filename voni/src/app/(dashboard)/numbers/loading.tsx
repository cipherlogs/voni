import {
  FlatFormSectionSkeleton,
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/page-skeletons";
import { Separator } from "@/components/ui/separator";

export default function NumbersLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <FlatFormSectionSkeleton rows={3} />
      <Separator />
      <TableSkeleton rows={4} columns={4} />
    </div>
  );
}

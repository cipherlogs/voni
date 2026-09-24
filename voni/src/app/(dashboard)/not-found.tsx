import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * A record that no longer exists (deleted agent, campaign, lead, or call) or
 * belongs to another workspace. Renders inside the shell so the sidebar stays.
 */
export default function DashboardNotFound() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle>Nothing here</EmptyTitle>
        <EmptyDescription>
          This record was deleted, or it belongs to another workspace.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button nativeButton={false} render={<Link href="/dashboard" />} variant="outline">
          Go to the dashboard
        </Button>
      </EmptyContent>
    </Empty>
  );
}

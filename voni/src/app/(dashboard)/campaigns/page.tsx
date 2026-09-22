import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Megaphone, Plus } from "lucide-react";
import { CardListSkeleton } from "@/components/page-skeletons";
import { listCampaigns } from "./actions";
import { CampaignDeleteButton } from "./delete-campaign-button";
import {
  describeCallingWindow,
  parseCallingWindow,
} from "@/lib/campaigns/policy";
import { RouteBrief } from "@/components/copilot/route-brief";

const STATUS_VARIANT = {
  active: "default",
  draft: "secondary",
  paused: "outline",
  completed: "outline",
} as const;

/**
 * Authorized campaign list leaf: rows and states resolve after the shell.
 */
async function CampaignsList() {
  const rows = await listCampaigns();

  return (
    <>
      <RouteBrief
        route="/campaigns"
        brief={`Campaign list: ${rows.length} campaigns with status, lead counts, and calling windows. New campaigns start on the creation screen.`}
      />
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="feature">
              <Megaphone />
            </EmptyMedia>
            <EmptyTitle>No campaigns yet</EmptyTitle>
            <EmptyDescription>
              Create an agent first, then assign it leads to work.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              nativeButton={false}
              render={<Link href="/campaigns/new" />}
              variant="outline"
            >
              Create your first campaign
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Calling window</TableHead>
                <TableHead>Leads</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((campaign) => (
                <TableRow key={campaign.id}>
                  <TableCell className="font-medium">{campaign.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANT[campaign.status]}>
                        {campaign.status}
                      </Badge>
                      {/* An unpublished agent is the most common reason a
                          campaign silently never dials, so it is called out in
                          the list rather than only on the detail page. */}
                      {campaign.agentDeployed ? null : (
                        <Badge variant="outline">agent is a draft</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {campaign.agentName} ·{" "}
                    {describeCallingWindow(parseCallingWindow(campaign.callingWindow))}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {campaign.total} leads · {campaign.queued} queued ·{" "}
                    {campaign.reached} reached
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        nativeButton={false}
                        variant="outline"
                        size="sm"
                        render={<Link href={`/campaigns/${campaign.id}`} />}
                      >
                        Open
                      </Button>
                      <CampaignDeleteButton
                        id={campaign.id}
                        name={campaign.name}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

export default function CampaignsPage() {
  return (
    <div data-testid="campaigns-shell" className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground text-sm">
            Which leads an agent should call, when it may call, and what
            happens if no one answers.
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/campaigns/new" />}>
          <Plus />
          New campaign
        </Button>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading campaigns">
            <CardListSkeleton />
          </div>
        }
      >
        <CampaignsList />
      </Suspense>
    </div>
  );
}

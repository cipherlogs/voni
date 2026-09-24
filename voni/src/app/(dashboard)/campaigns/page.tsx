import { Suspense } from "react";
import { PageHeading } from "@/components/wizard/form-layout";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table";
import { StatusDot } from "@/components/status-dot";
import { CAMPAIGN_STATUS } from "@/lib/campaigns/status";
import { RecordRowActions } from "@/components/record-row-actions";
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
import { TableSkeleton } from "@/components/page-skeletons";
import { listCampaigns } from "./actions";
import {
  describeCallingWindow,
  parseCallingWindow,
} from "@/lib/campaigns/policy";
import { RouteBrief } from "@/components/copilot/route-brief";


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
        <DataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden lg:table-cell">Calling window</TableHead>
                <TableHead className="hidden md:table-cell">Leads</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((campaign) => {
                const status = CAMPAIGN_STATUS[campaign.status];
                // An unpublished agent is the most common reason a campaign
                // silently never dials, so the list calls it out rather than
                // only the detail page.
                const agentNote = campaign.agentDeployed ? null : (
                  <StatusDot tone="warning" className="text-muted-foreground">
                    Agent is a draft
                  </StatusDot>
                );
                return (
                  <TableRow key={campaign.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <Link
                          href={`/campaigns/${campaign.id}`}
                          className="w-fit text-sm font-medium underline-offset-4 hover:underline"
                        >
                          {campaign.name}
                        </Link>
                        <span className="text-muted-foreground text-sm">
                          {campaign.agentName}
                        </span>
                        {/* Phones: status folds under the name. */}
                        <div className="flex flex-col gap-1 sm:hidden">
                          <StatusDot tone={status.tone}>{status.label}</StatusDot>
                          {agentNote}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex flex-col gap-1">
                        <StatusDot tone={status.tone}>{status.label}</StatusDot>
                        {agentNote}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-sm lg:table-cell">
                      {describeCallingWindow(parseCallingWindow(campaign.callingWindow))}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                      {campaign.total} leads · {campaign.queued} queued ·{" "}
                      {campaign.reached} reached
                    </TableCell>
                    <TableCell className="text-right">
                      <RecordRowActions
                        kind="campaign"
                        id={campaign.id}
                        name={campaign.name}
                        openHref={`/campaigns/${campaign.id}`}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </DataTable>
      )}
    </>
  );
}

export default function CampaignsPage() {
  return (
    <div data-testid="campaigns-shell" className="flex flex-col gap-6">
      <PageHeading
        title="Campaigns"
        description="Which leads an agent should call, when it may call, and what happens if no one answers."
        actions={
          <Button nativeButton={false} render={<Link href="/campaigns/new" />}>
            <Plus data-icon="inline-start" />
            New campaign
          </Button>
        }
      />

      <Suspense
        fallback={
          <div role="status" aria-label="Loading campaigns">
            <TableSkeleton rows={4} columns={5} />
          </div>
        }
      >
        <CampaignsList />
      </Suspense>
    </div>
  );
}

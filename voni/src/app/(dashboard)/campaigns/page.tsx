import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Megaphone, Plus } from "lucide-react";
import { CardListSkeleton } from "@/components/page-skeletons";
import { listCampaigns } from "./actions";
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
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Megaphone className="text-muted-foreground size-10" />
            <div>
              <p className="font-medium">No campaigns yet</p>
              <p className="text-muted-foreground text-sm">
                Create an agent first, then assign it leads to work.
              </p>
            </div>
            <Button
              nativeButton={false}
              render={<Link href="/campaigns/new" />}
              variant="outline"
            >
              Create your first campaign
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((campaign) => (
            <Card key={campaign.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{campaign.name}</span>
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
                  <p className="text-muted-foreground truncate text-sm">
                    {campaign.agentName} ·{" "}
                    {describeCallingWindow(parseCallingWindow(campaign.callingWindow))}
                  </p>
                  <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
                    <span>{campaign.total} leads</span>
                    <span>·</span>
                    <span>{campaign.queued} queued</span>
                    <span>·</span>
                    <span>{campaign.reached} reached</span>
                  </div>
                </div>
                <Button
                  nativeButton={false}
                  variant="outline"
                  size="sm"
                  render={<Link href={`/campaigns/${campaign.id}`} />}
                >
                  Open
                </Button>
              </CardContent>
            </Card>
          ))}
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

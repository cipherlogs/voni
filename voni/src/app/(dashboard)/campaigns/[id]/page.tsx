import { Suspense } from "react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { BackLink } from "@/components/back-link";
import { BookOpen, PhoneOutgoing, Clock } from "lucide-react";
import { CampaignControls } from "@/components/campaign-controls";
import { CampaignQueue } from "@/components/campaign-queue";
import { LeadImport } from "@/components/lead-import";
import { describeCallingWindow } from "@/lib/campaigns/policy";
import { getCampaign, getCampaignDispatchStatus } from "../actions";

const STATUS_VARIANT = {
  active: "default",
  draft: "secondary",
  paused: "outline",
  completed: "outline",
} as const;

export default function CampaignPage({
  params,
}: PageProps<"/campaigns/[id]">) {
  return (
    <div data-testid="campaign-shell" className="flex flex-col gap-6">
      <div>
        <BackLink href="/campaigns" label="Campaigns" />
      </div>

      {/* URL-independent section structure: titles paint with the shell while
          the authorized campaign, dispatch readiness, and lead rows stream.
          Titles intentionally mirror the resolved sections below. */}
      <Suspense
        fallback={
          <div role="status" aria-label="Loading campaign" className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dialer</CardTitle>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-5 w-2/3" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Import leads</CardTitle>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Queue</CardTitle>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-24 w-full" />
              </CardContent>
            </Card>
          </div>
        }
      >
        <CampaignDetail params={params} />
      </Suspense>
    </div>
  );
}

/**
 * Authorized campaign leaf: record, dispatch readiness, and lead rows.
 * Missing/denied records keep notFound() inside this leaf.
 */
async function CampaignDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [data, dispatch] = await Promise.all([
    getCampaign(id),
    getCampaignDispatchStatus(id),
  ]);
  if (!data || !dispatch) notFound();

  const { campaign, members } = data;
  const queued = members.filter((m) => m.status === "queued").length;

  // The activate button's precondition, phrased for a human. Mirrors what
  // setCampaignStatusAction enforces server-side; shown up front so the
  // operator does not have to click to discover it.
  const activationBlocker =
    !campaign.agentDeployed
      ? `${campaign.agentName} is still a draft — publish it before activating.`
      : queued === 0
        ? "Import leads before activating this campaign."
        : null;

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief route={`/campaigns/${id}`} brief={`Campaign ${campaign.name}. Status ${campaign.status}. ${members.length} leads, ${queued} queued. ${dispatch.dueNow} due now. ${activationBlocker ?? ""} ${dispatch.blockers.join(". ")}`} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {campaign.name}
              </h1>
              <Badge variant={STATUS_VARIANT[campaign.status]}>
                {campaign.status}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">
              {campaign.agentName} ·{" "}
              {describeCallingWindow(dispatch.window)} · up to{" "}
              {campaign.maxAttempts} attempt
              {campaign.maxAttempts === 1 ? "" : "s"} per lead
            </p>
          </div>
          <CampaignControls
            id={campaign.id}
            status={campaign.status}
            activationBlocker={activationBlocker}
          />
        </div>
      </div>

      {/* Why the dialer is or is not working right now. A campaign that is
          simply outside its calling window is indistinguishable from a broken
          one without this. */}
      <section aria-labelledby="campaign-dialer-heading">
        <div className="flex items-center gap-2">
          {dispatch.blockers.length === 0 ? (
            <PhoneOutgoing className="size-4" />
          ) : (
            <Clock className="text-muted-foreground size-4" />
          )}
          <h2 id="campaign-dialer-heading" className="text-base font-medium">
            Dialer
          </h2>
          {dispatch.blockers.length === 0 ? (
            <Badge>Ready</Badge>
          ) : (
            <Badge variant="outline">Not dialing</Badge>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-1">
          {dispatch.blockers.length === 0 ? (
            <>
              <p className="font-medium">
                Ready to dial — {dispatch.dueNow} lead
                {dispatch.dueNow === 1 ? "" : "s"} due now.
              </p>
              <p className="text-muted-foreground text-sm">
                Due leads are picked up automatically once the dialer is
                running. Activating this campaign alone does not start
                calls.
              </p>
              <Button
                nativeButton={false}
                variant="outline"
                size="sm"
                className="w-fit"
                render={
                  <a
                    href="https://github.com/cipherlogs/voni/blob/main/telephony-bot/campaign_runner.py"
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                <BookOpen />
                Start calling (runbook)
              </Button>
            </>
          ) : (
            <>
              <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-5 text-sm">
                {dispatch.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              {dispatch.dueNow > 0 && !dispatch.windowOpen ? (
                <p className="text-muted-foreground mt-1 text-sm">
                  {dispatch.dueNow} lead{dispatch.dueNow === 1 ? " is" : "s are"}{" "}
                  waiting for the window to open.
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>

      <Separator />

      {/* id="import": the dashboard first-run step 2 deep-links here, so a
          campaign waiting for its CSV lands on the import form — with the
          sticky header's height accounted for via scroll-margin. */}
      <section aria-labelledby="campaign-import-heading" id="import" className="scroll-mt-20">
        <h2 id="campaign-import-heading" className="text-base font-medium">
          Import leads
        </h2>
        <div className="mt-2 max-w-3xl">
          <LeadImport campaignId={campaign.id} />
        </div>
      </section>

      <Separator />

      <section aria-labelledby="campaign-queue-heading">
        <h2 id="campaign-queue-heading" className="text-base font-medium">
          Queue ({members.length} lead{members.length === 1 ? "" : "s"})
        </h2>
        <div className="mt-2 overflow-x-auto rounded-lg border">
          <CampaignQueue
            members={members}
            maxAttempts={campaign.maxAttempts}
            campaignId={campaign.id}
          />
        </div>
      </section>
    </div>
  );
}

import { Suspense } from "react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CampaignDetailSkeleton } from "@/components/page-skeletons";
import { BackLink } from "@/components/back-link";
import { BookOpen } from "lucide-react";
import { CampaignControls } from "@/components/campaign-controls";
import { RecordRowActions } from "@/components/record-row-actions";
import { StatusDot } from "@/components/status-dot";
import { CAMPAIGN_STATUS } from "@/lib/campaigns/status";
import {
  FormSection,
  FormSectionHeading,
  FormSectionSeparator,
  PageHeading,
} from "@/components/wizard/form-layout";
import { CampaignQueue } from "@/components/campaign-queue";
import { LeadImport } from "@/components/lead-import";
import { describeCallingWindow } from "@/lib/campaigns/policy";
import { getCampaign, getCampaignDispatchStatus } from "../actions";


export default function CampaignPage({
  params,
}: PageProps<"/campaigns/[id]">) {
  return (
    <div data-testid="campaign-shell" className="flex flex-col gap-6">
      <BackLink href="/campaigns" label="Campaigns" />

      {/* URL-independent section structure: titles paint with the shell while
          the authorized campaign, dispatch readiness, and lead rows stream.
          Titles intentionally mirror the resolved sections below. */}
      <Suspense
        fallback={
          <div role="status" aria-label="Loading campaign">
            <CampaignDetailSkeleton />
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
      <PageHeading
        title={campaign.name}
        meta={<StatusDot tone={CAMPAIGN_STATUS[campaign.status].tone}>{CAMPAIGN_STATUS[campaign.status].label}</StatusDot>}
        description={
          <>
            {campaign.agentName} · {describeCallingWindow(dispatch.window)} · up
            to {campaign.maxAttempts} attempt
            {campaign.maxAttempts === 1 ? "" : "s"} per lead
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <CampaignControls
              id={campaign.id}
              status={campaign.status}
              activationBlocker={activationBlocker}
            />
            <RecordRowActions
              kind="campaign"
              id={campaign.id}
              name={campaign.name}
              redirectTo="/campaigns"
            />
          </div>
        }
      />

      {/* Why the dialer is or is not working right now. A campaign that is
          simply outside its calling window is indistinguishable from a broken
          one without this. */}
      <FormSection
        aria-labelledby="campaign-dialer-heading"
        heading={
          <FormSectionHeading
            id="campaign-dialer-heading"
            title="Dialer"
            description="Whether calls can go out right now, and why not."
          />
        }
      >
        <div className="flex flex-col gap-2">
          {dispatch.blockers.length === 0 ? (
            <>
              <StatusDot tone="success" className="font-medium">
                Ready to dial — {dispatch.dueNow} lead
                {dispatch.dueNow === 1 ? "" : "s"} due now
              </StatusDot>
              <p className="text-muted-foreground text-sm">
                Due leads are picked up automatically once the dialer is
                running. Activating this campaign alone does not start calls.
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
                <BookOpen data-icon="inline-start" />
                Start calling (runbook)
              </Button>
            </>
          ) : (
            <>
              <StatusDot tone="neutral" className="font-medium">
                Not dialing
              </StatusDot>
              <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-5 text-sm">
                {dispatch.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              {dispatch.dueNow > 0 && !dispatch.windowOpen ? (
                <p className="text-muted-foreground text-sm">
                  {dispatch.dueNow} lead{dispatch.dueNow === 1 ? " is" : "s are"}{" "}
                  waiting for the window to open.
                </p>
              ) : null}
            </>
          )}
          {campaign.status !== "active" && activationBlocker ? (
            <p
              id={`campaign-blocker-${campaign.id}`}
              role="note"
              className="text-sm"
            >
              To activate: {activationBlocker}
            </p>
          ) : null}
        </div>
      </FormSection>

      <FormSectionSeparator className="my-2" />

      {/* id="import": the dashboard first-run step 2 deep-links here, so a
          campaign waiting for its CSV lands on the import form. */}
      <FormSection
        id="import"
        className="scroll-mt-20"
        aria-labelledby="campaign-import-heading"
        heading={
          <FormSectionHeading
            id="campaign-import-heading"
            title="Import leads"
            description="Rows are validated in the import job; nothing is called until the campaign is active."
          />
        }
      >
        <LeadImport campaignId={campaign.id} />
      </FormSection>

      <FormSectionSeparator className="my-2" />

      <section aria-labelledby="campaign-queue-heading" className="flex flex-col gap-4">
        <FormSectionHeading
          id="campaign-queue-heading"
          title={`Queue · ${members.length} lead${members.length === 1 ? "" : "s"}`}
        />
        <CampaignQueue
          members={members}
          maxAttempts={campaign.maxAttempts}
          campaignId={campaign.id}
        />
      </section>
    </div>
  );
}

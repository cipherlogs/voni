import { Suspense } from "react";
import { PageHeading } from "@/components/wizard/form-layout";
import { eq } from "drizzle-orm";
import { CampaignFormPageSkeleton } from "@/components/page-skeletons";
import { BackLink } from "@/components/back-link";
import { CampaignForm } from "@/components/campaign-form";
import { RouteBrief } from "@/components/copilot/route-brief";
import { listAgentOptions } from "../actions";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import { requireCtxOrRedirect } from "@/lib/session";

/**
 * Agent options leaf: the select choices plus the workspace timezone resolve
 * after the form frame. The form keeps its own state; this single boundary
 * never remounts it.
 */
async function CampaignAgentOptions() {
  const ctx = await requireCtxOrRedirect("/campaigns/new");
  const [agents, [settings]] = await Promise.all([
    listAgentOptions(),
    db
      .select({ timezone: organizationSettings.timezone })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, ctx.organizationId))
      .limit(1),
  ]);
  return (
    <CampaignForm
      agents={agents}
      workspaceTimezone={settings?.timezone ?? undefined}
    />
  );
}

export default function NewCampaignPage() {
  return (
    <div data-testid="campaigns-new-shell" className="flex w-full max-w-3xl flex-col gap-6">
      <RouteBrief
        route="/campaigns/new"
        brief="New campaign form: lead list, agent, calling window, and fallback policy. Voice reads here; changes stay manual for now."
      />
      <BackLink href="/campaigns" label="Campaigns" />
      <PageHeading title="New campaign" description="Give an agent a list of people to reach and the rules for reaching them." />
      <Suspense
        fallback={
          <div role="status" aria-label="Loading campaign form">
            <CampaignFormPageSkeleton withHeader={false} />
          </div>
        }
      >
        <CampaignAgentOptions />
      </Suspense>
    </div>
  );
}

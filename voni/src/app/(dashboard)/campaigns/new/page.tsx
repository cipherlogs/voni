import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { Skeleton } from "@/components/ui/skeleton";
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
    <div data-testid="campaigns-new-shell" className="flex flex-col gap-6">
      <RouteBrief
        route="/campaigns/new"
        brief="New campaign form: lead list, agent, calling window, and fallback policy. Voice reads here; changes stay manual for now."
      />
      <div className="flex flex-col gap-2">
        <div>
          <BackLink href="/campaigns" label="Campaigns" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New campaign</h1>
          <p className="text-muted-foreground text-sm">
            Give an agent a list of people to reach and the rules for reaching
            them.
          </p>
        </div>
      </div>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading campaign form" className="flex flex-col gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        }
      >
        <CampaignAgentOptions />
      </Suspense>
    </div>
  );
}

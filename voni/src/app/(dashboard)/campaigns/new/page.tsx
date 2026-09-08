import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { CampaignForm } from "@/components/campaign-form";
import { RouteBrief } from "@/components/copilot/route-brief";
import { listAgentOptions } from "../actions";

export default async function NewCampaignPage() {
  const agents = await listAgentOptions();

  return (
    <div className="flex flex-col gap-6">
      <RouteBrief
        route="/campaigns/new"
        brief="New campaign form: lead list, agent, calling window, and fallback policy. Voice reads here; changes stay manual for now."
      />
      <div className="flex flex-col gap-2">
        <Button
          nativeButton={false}
          render={<Link href="/campaigns" />}
          variant="ghost"
          size="sm"
          className="w-fit -ml-2"
        >
          <ChevronLeft />
          Campaigns
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New campaign</h1>
          <p className="text-muted-foreground text-sm">
            Give an agent a list of people to reach and the rules for reaching
            them.
          </p>
        </div>
      </div>
      <CampaignForm agents={agents} />
    </div>
  );
}

export type DashboardSetupState = {
  agentCreated: boolean;
  leadsImported: boolean;
  campaignActivated: boolean;
};

export type DashboardSetupStep = {
  id: "agent" | "leads" | "activation";
  title: string;
  description: string;
  completed: boolean;
  actionLabel: string;
  actionHref: string;
};

export function getDashboardSetupSteps(
  setup: DashboardSetupState,
  emptyCampaigns: Array<{ id: string; name: string }>,
): DashboardSetupStep[] {
  const waitingCampaign = emptyCampaigns[0];

  return [
    {
      id: "agent",
      title: "Create and review an agent",
      description:
        "Give your caller a voice, a clear goal, and the details it should collect.",
      completed: setup.agentCreated,
      actionLabel: setup.agentCreated ? "View agents" : "Create an agent",
      actionHref: setup.agentCreated ? "/agents" : "/agents/new",
    },
    {
      id: "leads",
      title: waitingCampaign
        ? `Import leads into ${waitingCampaign.name}`
        : "Create a campaign and import leads",
      description: waitingCampaign
        ? "This campaign is ready for the people you want Voni to call."
        : "Create the campaign, then import the people you want Voni to call.",
      completed: setup.leadsImported,
      actionLabel: setup.leadsImported
        ? "View campaigns"
        : waitingCampaign
          ? `Import into ${waitingCampaign.name}`
          : "Create a campaign",
      actionHref: setup.leadsImported
        ? "/campaigns"
        : waitingCampaign
          ? `/campaigns/${waitingCampaign.id}#import`
          : "/campaigns/new",
    },
    {
      id: "activation",
      title: "Activate a campaign",
      description:
        "Review the calling window and consent policy, then switch the campaign on.",
      completed: setup.campaignActivated,
      actionLabel: setup.campaignActivated
        ? "View campaigns"
        : "Open campaigns",
      actionHref: "/campaigns",
    },
  ];
}

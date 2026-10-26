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

/**
 * First-run brief numbers in one pass (ticket 09 J1).
 *
 * The dashboard brief used to walk the three setup steps twice —
 * `.filter(completed).length` for the count plus `.find(!completed)`
 * for the next open step. One loop answers both; the "done" fallback
 * keeps the brief's wording when every step completes.
 */
export function summarizeSetupSteps(steps: DashboardSetupStep[]): {
  completed: number;
  total: number;
  nextIncompleteTitle: string;
} {
  let completed = 0;
  let nextIncompleteTitle = "done";
  let seenIncomplete = false;
  for (const step of steps) {
    if (step.completed) {
      completed += 1;
    } else if (!seenIncomplete) {
      seenIncomplete = true;
      nextIncompleteTitle = step.title;
    }
  }
  return { completed, total: steps.length, nextIncompleteTitle };
}

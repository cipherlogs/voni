import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight, Bot, CirclePlay, Upload } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatGridSkeleton } from "@/components/page-skeletons";
import { pipelineStateLabel } from "@/lib/leads/stage-filter";
import { RouteBrief } from "@/components/copilot/route-brief";
import { getDashboardSummary } from "./actions";

/**
 * First-run setup path: when the workspace has no outcomes yet, the zero
 * grid would be a dead end — four "0" cards and a collapsed funnel with no
 * next step. Task-led links instead, one row per setup step, so a new
 * operator can act rather than interpret. Empty campaigns waiting for a
 * CSV count as setup, not outcomes: step 2 then names the campaign and
 * deep-links its import section instead of the campaign-creation form.
 * Once the first outcome lands, this branch stops rendering and the
 * outcome grid takes over.
 */
function SetupSteps({
  emptyCampaigns,
}: {
  emptyCampaigns: Array<{ id: string; name: string }>;
}) {
  const firstEmpty = emptyCampaigns[0];
  const steps = [
    {
      icon: <Bot />,
      title: "1. Create an agent",
      body: "Give the caller a voice, a goal, and the questions it should ask.",
      href: "/agents/new",
      linkLabel: "Create an agent",
    },
    firstEmpty
      ? {
          icon: <Upload />,
          title: `2. Import leads into ${firstEmpty.name}`,
          body: "The campaign is waiting — import its CSV to get started.",
          href: `/campaigns/${firstEmpty.id}#import`,
          linkLabel: `Import into ${firstEmpty.name}`,
        }
      : {
          icon: <Upload />,
          title: "2. Create a campaign",
          body: "Campaigns bring the leads — create one, then import a CSV into it.",
          href: "/campaigns/new",
          linkLabel: "Create a campaign",
        },
    {
      icon: <CirclePlay />,
      title: "3. Activate",
      body: "Review the campaign and switch it on — calls start when the dialer is live.",
      href: "/campaigns",
      linkLabel: "Open campaigns",
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Get set up</CardTitle>
        <CardDescription>
          Three steps to your first call — nothing to report yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-4">
          {steps.map((step) => (
            <li key={step.title} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md [&_svg]:size-5"
              >
                {step.icon}
              </span>
              <span className="flex flex-col gap-1">
                <span className="font-medium">{step.title}</span>
                <span className="text-muted-foreground text-sm">
                  {step.body}{" "}
                  <Link
                    href={step.href}
                    className="cursor-pointer rounded-sm font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {step.linkLabel}
                  </Link>
                </span>
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/**
 * Conversion view: four outcome totals backed by recorded rows. Each card
 * links to its filtered list (`?stage=` / `?outcome=`) so the drill-down
 * the numbers imply actually exists — and lead-grain cards (worked,
 * appointments booked, handoff) reuse the same predicate as their lead
 * list, so card and list agree. The Connected calls card counts calls:
 * linking it to a call list (`?outcome=connected`) keeps that grain
 * honest — one lead can have several. Keep card and list predicates in
 * sync — they are parallel queries, and the agreement only holds while
 * both sides match. The raw stage funnel survives below as a collapsed
 * secondary view, and campaigns with no leads surface a next action
 * rather than a dead end.
 */
async function DashboardOutcomes() {
  const summary = await getDashboardSummary();
  const cards: Array<{
    label: string;
    value: number;
    href: string;
    linkLabel: string;
    hint?: string;
  }> = [
    {
      label: "Leads worked",
      value: summary.leadsWorked,
      href: "/leads?stage=worked",
      linkLabel: "View worked leads",
    },
    {
      label: "Connected calls",
      value: summary.connectedCalls,
      href: "/calls?outcome=connected",
      linkLabel: "View connected calls",
      hint: "Counts calls, not leads — one lead can have several.",
    },
    {
      // Lead grain: counts distinct booked leads and links to the lead
      // list on the same grain — never an appointment-row count against a
      // lead list.
      label: "Booked leads",
      value: summary.appointmentsBooked,
      href: "/leads?stage=booked",
      linkLabel: "View booked leads",
    },
    {
      label: "Needs human handoff",
      value: summary.needsHandoff,
      href: "/leads?stage=handoff",
      linkLabel: "View handoff leads",
    },
  ];

  if (summary.isFirstRun) {
    return (
      <>
        <RouteBrief
          route="/dashboard"
          brief="Dashboard: fresh workspace, no outcomes yet. Three setup steps: create an agent, import leads into a campaign, activate. Voice reads here."
        />
        <SetupSteps emptyCampaigns={summary.emptyCampaigns} />
      </>
    );
  }

  return (
    <>
      <RouteBrief
        route="/dashboard"
        brief={`Dashboard: ${summary.leadsWorked} leads worked, ${summary.connectedCalls} connected calls, ${summary.appointmentsBooked} booked leads, ${summary.needsHandoff} needing handoff. Voice reads here.`}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label} className="interactive-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {card.label}
              </CardTitle>
              {card.hint ? (
                <CardDescription>{card.hint}</CardDescription>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div
                aria-label={`${card.label}: ${card.value}`}
                className="text-2xl font-semibold tabular-nums"
              >
                {card.value}
              </div>
              <Link
                href={card.href}
                aria-label={card.linkLabel}
                className="text-muted-foreground inline-flex w-fit cursor-pointer items-center gap-1 rounded-sm text-xs underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                View
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
      {summary.emptyCampaigns.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Next action</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {summary.emptyCampaigns.map((campaign) => (
              <span
                key={campaign.id}
                className="flex flex-wrap items-center gap-2"
              >
                <span>{campaign.name} has no leads yet.</span>
                <Link
                  href={`/campaigns/${campaign.id}#import`}
                  className="cursor-pointer rounded-sm font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Import leads
                </Link>
              </span>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <details className="group">
        <summary className="text-muted-foreground w-fit cursor-pointer rounded-sm text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          Pipeline funnel by stage
        </summary>
        {/* Funnel drill-down: each stage card links to its filtered leads
            list (`?stage=` + chip + Clear, same as the outcome cards above).
            The link carries the DB's own stage casing; the shared filter
            normalizes and matches case-insensitively. */}
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {summary.stages.map((stage) => (
            <Card key={stage.stage} className="interactive-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-muted-foreground text-sm font-medium">
                  {pipelineStateLabel(stage.stage)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div
                  aria-label={`${pipelineStateLabel(stage.stage)}: ${stage.value}`}
                  className="text-2xl font-semibold tabular-nums"
                >
                  {stage.value}
                </div>
                <Link
                  href={`/leads?stage=${encodeURIComponent(stage.stage)}`}
                  aria-label={`View ${pipelineStateLabel(stage.stage)} leads`}
                  className="text-muted-foreground inline-flex w-fit cursor-pointer items-center gap-1 rounded-sm text-xs underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  View
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </details>
    </>
  );
}

export default function DashboardPage() {
  return (
    <div data-testid="dashboard-shell" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          Outcomes across all active campaigns.
        </p>
      </div>
      <Suspense
        fallback={
          <div role="status" aria-label="Loading dashboard">
            <StatGridSkeleton cards={4} />
          </div>
        }
      >
        <DashboardOutcomes />
      </Suspense>
    </div>
  );
}

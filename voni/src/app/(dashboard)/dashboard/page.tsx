import { Suspense } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatGridSkeleton } from "@/components/page-skeletons";
import { RouteBrief } from "@/components/copilot/route-brief";
import { getDashboardSummary } from "./actions";

/**
 * Conversion view: four outcome totals backed by recorded rows. The raw
 * stage funnel survives below as a collapsed secondary view, and campaigns
 * with no leads surface a next action rather than a dead end.
 *
 * The cards are deliberately NOT links: neither /leads nor /calls accepts
 * a filter param today, so a "filtered list" href would land on the same
 * unfiltered table with a promise the URL does not keep. When list
 * filtering exists, re-link each card to its filtered view.
 */
async function DashboardOutcomes() {
  const summary = await getDashboardSummary();
  const cards = [
    {
      label: "Leads worked",
      value: summary.leadsWorked,
    },
    {
      label: "Connected",
      value: summary.connectedCalls,
    },
    {
      label: "Appointments booked",
      value: summary.appointmentsBooked,
    },
    {
      label: "Needs human handoff",
      value: summary.needsHandoff,
    },
  ];

  return (
    <>
      <RouteBrief
        route="/dashboard"
        brief={`Dashboard: ${summary.leadsWorked} leads worked, ${summary.connectedCalls} connected, ${summary.appointmentsBooked} appointments booked, ${summary.needsHandoff} needing handoff. Voice reads here.`}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                aria-label={`${card.label}: ${card.value}`}
                className="text-2xl font-semibold tabular-nums"
              >
                {card.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {summary.emptyCampaigns.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Next action
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {summary.emptyCampaigns.map((campaign) => (
              <span
                key={campaign.id}
                className="flex flex-wrap items-center gap-2"
              >
                <span>
                  {campaign.name} has no leads yet.
                </span>
                <Link
                  href={`/campaigns/${campaign.id}`}
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
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {summary.stages.map((stage) => (
            <Card key={stage.stage}>
              <CardHeader className="pb-2">
                <CardTitle className="text-muted-foreground text-sm font-medium">
                  {stage.stage}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">
                  {stage.value}
                </div>
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
        <h1 className="text-2xl font-semibold tracking-tight">
          Dashboard
        </h1>
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

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
 * Conversion view: four outcome totals backed by recorded rows, each
 * linking to its filtered list. The raw stage funnel survives below as
 * a collapsed secondary view, and campaigns with no leads surface a
 * next action rather than a dead end.
 */
async function DashboardOutcomes() {
  const summary = await getDashboardSummary();
  const cards = [
    {
      label: "Leads worked",
      value: summary.leadsWorked,
      href: "/leads",
    },
    {
      label: "Connected",
      value: summary.connectedCalls,
      href: "/calls",
    },
    {
      label: "Appointments booked",
      value: summary.appointmentsBooked,
      href: "/calls",
    },
    {
      label: "Needs human handoff",
      value: summary.needsHandoff,
      href: "/leads",
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
              <Link
                href={card.href}
                aria-label={`${card.label}: ${card.value}`}
                className="cursor-pointer rounded-sm text-2xl font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {card.value}
              </Link>
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

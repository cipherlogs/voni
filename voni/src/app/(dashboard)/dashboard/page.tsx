import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatGridSkeleton } from "@/components/page-skeletons";
import { pipelineStateLabel } from "@/lib/leads/stage-filter";
import { RouteBrief } from "@/components/copilot/route-brief";
import { Onboarding01 } from "@/components/onboarding-01/onboarding-01";
import { getDashboardSetupSteps } from "@/lib/dashboard/setup";
import { getDashboardSummary } from "./actions";

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
    const setupSteps = getDashboardSetupSteps(
      summary.setup,
      summary.emptyCampaigns,
    );
    return (
      <>
        <RouteBrief
          route="/dashboard"
          brief={`Dashboard: no outcomes yet. Setup is ${setupSteps.filter((step) => step.completed).length} of ${setupSteps.length} complete. The next incomplete step is ${setupSteps.find((step) => !step.completed)?.title ?? "done"}. Voice reads here.`}
        />
        <Onboarding01 steps={setupSteps} />
      </>
    );
  }

  return (
    <>
      <RouteBrief
        route="/dashboard"
        brief={`Dashboard: ${summary.leadsWorked} leads worked, ${summary.connectedCalls} connected calls, ${summary.appointmentsBooked} booked leads, ${summary.needsHandoff} needing handoff. Voice reads here.`}
      />
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Card
            key={card.label}
            className="h-full gap-0 py-0 transition-shadow duration-[var(--motion-standard)] hover:shadow-md focus-within:shadow-md"
          >
            <CardContent className="flex flex-1 flex-col gap-3 p-8">
              <span className="text-muted-foreground text-sm">
                {card.label}
              </span>
              {card.hint ? (
                <span className="text-muted-foreground text-sm">
                  {card.hint}
                </span>
              ) : null}
              <span
                aria-label={`${card.label}: ${card.value}`}
                className="mt-1 text-3xl font-semibold tracking-tight tabular-nums"
              >
                {card.value}
              </span>
            </CardContent>
            <CardFooter className="mt-auto justify-end p-0">
              <Link
                href={card.href}
                aria-label={card.linkLabel}
                className="inline-flex cursor-pointer items-center gap-1 rounded-sm px-6 py-3 text-sm font-medium text-primary outline-none hover:text-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                View
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </Link>
            </CardFooter>
          </Card>
        ))}
      </div>
      {summary.emptyCampaigns.length > 0 ? (
        <Card className="gap-0 py-0">
          <CardHeader className="p-8 pb-2">
            <CardTitle className="text-base">Next action</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground p-8 pt-4 text-sm">
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
        <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {summary.stages.map((stage) => (
            <Card
              key={stage.stage}
              className="h-full gap-0 py-0 transition-shadow duration-[var(--motion-standard)] hover:shadow-md focus-within:shadow-md"
            >
              <CardContent className="flex flex-1 flex-col gap-3 p-8">
                <span className="text-muted-foreground text-sm">
                  {pipelineStateLabel(stage.stage)}
                </span>
                <span
                  aria-label={`${pipelineStateLabel(stage.stage)}: ${stage.value}`}
                  className="mt-1 text-3xl font-semibold tracking-tight tabular-nums"
                >
                  {stage.value}
                </span>
              </CardContent>
              <CardFooter className="mt-auto justify-end p-0">
                <Link
                  href={`/leads?stage=${encodeURIComponent(stage.stage)}`}
                  aria-label={`View ${pipelineStateLabel(stage.stage)} leads`}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-sm px-6 py-3 text-sm font-medium text-primary outline-none hover:text-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  View
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </Link>
              </CardFooter>
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

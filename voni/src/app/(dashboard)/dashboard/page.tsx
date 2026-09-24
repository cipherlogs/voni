import { Suspense } from "react";
import { DisclosureTrigger } from "@/components/disclosure";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { PageHeading } from "@/components/wizard/form-layout";
import Link from "next/link";
import { ArrowUpRight, CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatGridSkeleton } from "@/components/page-skeletons";
import { pipelineStateLabel } from "@/lib/leads/stage-filter";
import { RouteBrief } from "@/components/copilot/route-brief";
import { Onboarding01 } from "@/components/onboarding-01/onboarding-01";
import { getDashboardSetupSteps } from "@/lib/dashboard/setup";
import { getDashboardSummary } from "./actions";

type Stat = {
  label: string;
  value: number;
  href: string;
  linkLabel: string;
  hint?: string;
};

/**
 * One bordered strip of linked figures (blocks.so dashboard-01 KPI row):
 * shared by the outcome totals and the funnel so both read as one language.
 * Each cell is the whole link, so the drill-down the number implies exists.
 */
function StatStrip({ stats, columns }: { stats: Stat[]; columns: string }) {
  return (
    <div className={`grid grid-cols-1 overflow-hidden rounded-lg border sm:grid-cols-2 ${columns}`}>
      {stats.map((stat) => (
        <Link
          key={stat.label}
          href={stat.href}
          aria-label={`${stat.label}: ${stat.value}. ${stat.linkLabel}`}
          className="group hover:bg-muted/50 focus-visible:ring-ring -mt-px -ml-px flex flex-col gap-1 border-t border-l p-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset"
        >
          <span className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
            {stat.label}
            <ArrowUpRight
              aria-hidden="true"
              className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </span>
          <span className="text-3xl font-semibold tracking-tight tabular-nums">{stat.value}</span>
          {stat.hint ? (
            <span className="text-muted-foreground text-xs">{stat.hint}</span>
          ) : null}
        </Link>
      ))}
    </div>
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
      <StatStrip stats={cards} columns="lg:grid-cols-4" />
      {summary.emptyCampaigns.length > 0 ? (
        <Alert>
          <CircleAlert />
          <AlertTitle>Next action</AlertTitle>
          <AlertDescription>
            {summary.emptyCampaigns.map((campaign) => (
              <span key={campaign.id} className="flex flex-wrap items-center gap-2">
                <span>{campaign.name} has no leads yet.</span>
                <Link
                  href={`/campaigns/${campaign.id}#import`}
                  className="text-foreground focus-visible:ring-ring rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2"
                >
                  Import leads
                </Link>
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      <Collapsible>
        <DisclosureTrigger>Pipeline funnel by stage</DisclosureTrigger>
        <CollapsibleContent>
        {/* Funnel drill-down: each stage card links to its filtered leads
            list (`?stage=` + chip + Clear, same as the outcome cards above).
            The link carries the DB's own stage casing; the shared filter
            normalizes and matches case-insensitively. */}
        <div className="mt-4">
          <StatStrip
            columns="md:grid-cols-3 lg:grid-cols-5"
            stats={summary.stages.map((stage) => ({
              label: pipelineStateLabel(stage.stage),
              value: stage.value,
              href: `/leads?stage=${encodeURIComponent(stage.stage)}`,
              linkLabel: `View ${pipelineStateLabel(stage.stage)} leads`,
            }))}
          />
        </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

export default function DashboardPage() {
  return (
    <div data-testid="dashboard-shell" className="flex flex-col gap-6">
      <PageHeading title="Dashboard" description="Outcomes across your campaigns, and what to do next." />
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

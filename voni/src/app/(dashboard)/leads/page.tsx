import { Suspense } from "react";
import { DisclosureTrigger } from "@/components/disclosure";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { DataTable } from "@/components/data-table";
import { StatusDot } from "@/components/status-dot";
import { consentStatus } from "@/lib/campaigns/status";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FilterChips } from "@/components/filter-chips";
import { LeadsSelectAll, LeadsSelectCell, LeadsSelection } from "@/components/leads-bulk-bar";
import { PageHeading } from "@/components/wizard/form-layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Users, Upload } from "lucide-react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { normalizeStageFilter, pipelineStateLabel, stageFilterLabel } from "@/lib/leads/stage-filter";
import { listLeads } from "./actions";

const LEAD_TABLE_COLUMNS = 7;

/** Curated filter chips: All + the dashboard outcomes (?stage=). */
function leadsChips(active: string | undefined) {
  return [
    { label: "All", href: "/leads", active: !active },
    { label: "Worked", href: "/leads?stage=worked", active: active === "worked" },
    { label: "Booked", href: "/leads?stage=booked", active: active === "booked" },
    {
      label: "Needs handoff",
      href: "/leads?stage=handoff",
      active: active === "handoff",
    },
  ];
}

type LeadsSearchParams = { stage?: string | string[] };

/** Next action on the first line, intent and blocker beneath: the state
 *  reads without hover, so keyboard, touch, and mobile users get the same
 *  "reasoning you can see" as pointer users. The cell is a plain div — no
 *  tabIndex on non-interactive text — and the full context already sits in
 *  the accessible name. When the context runs long it collapses at two
 *  lines behind a real <details> expander, so the cut text stays one
 *  keypress away instead of silently clipped. */
const STATE_CONTEXT_CLAMP_THRESHOLD = 140;

export function LeadStateCell({
  intent,
  blocker,
  nextAction,
}: {
  intent: string | null;
  blocker: string | null;
  nextAction: string | null;
}) {
  const context = [intent, blocker].filter(
    (part): part is string => part !== null,
  );
  const fullContext =
    context.length > 0 ? context.join(" · ") : "No recorded context yet.";
  const accessibleName = nextAction
    ? `Next action: ${nextAction}. Context: ${fullContext}`
    : "No next action recorded";
  const isLong = fullContext.length > STATE_CONTEXT_CLAMP_THRESHOLD;
  // Never called: one dash says it; two lines of placeholder was noise.
  if (!nextAction && context.length === 0) {
    return (
      <span aria-label={accessibleName} className="text-muted-foreground text-sm">
        —
      </span>
    );
  }
  return (
    <div
      aria-label={accessibleName}
      className="block max-w-55 text-sm"
    >
      <span className="text-foreground block font-medium">
        {nextAction ?? "—"}
      </span>
      {isLong ? (
        <Collapsible className="group/context">
          {/* Clamped preview while closed; the panel holds the full text. */}
          <span className="text-muted-foreground line-clamp-2 block group-has-[[data-panel-open]]/context:hidden">
            {fullContext}
          </span>
          <CollapsibleContent>
            <span className="text-muted-foreground block">{fullContext}</span>
          </CollapsibleContent>
          <DisclosureTrigger className="text-xs">
            <span className="group-data-[panel-open]/disclosure:hidden">Show full context</span>
            <span className="hidden group-data-[panel-open]/disclosure:inline">Show less</span>
          </DisclosureTrigger>
        </Collapsible>
      ) : (
        <span className="text-muted-foreground block">{fullContext}</span>
      )}
    </div>
  );
}

/**
 * RouteBrief renders nothing but must not sit inside a <table>: React
 * hydrates a component boundary as a DOM node, and a node between <table>
 * and <tbody> reads as a nested <div> — invalid table HTML that logs a
 * hydration error on every list visit. A client leaf here keeps the count
 * in the brief without breaking the table structure.
 */
function LeadsBrief({ count }: { count: number }) {
  return (
    <RouteBrief
      route="/leads"
      brief={`Lead list: ${count} leads with pipeline stages across phone and WhatsApp. Voice reads here.`}
    />
  );
}

/**
 * Authorized rows leaf: rows, counts, and Empty state resolve after the
 * table structure shell.
 */
async function LeadsRows({
  searchParams,
}: {
  searchParams: Promise<LeadsSearchParams>;
}) {
  // URL data is read here, inside the Suspense boundary below — not in the
  // page shell above it. Awaiting searchParams in the shell would tie the
  // App Shell to one URL and break instant navigation (E1439); the shell
  // (h1, table frame, header) stays static and only these rows stream.
  const params = await searchParams;
  const { rows, total, stage } = await listLeads(200, {
    stage: params.stage,
  });
  // The table caps at 200 rows; the count always reads the full filtered
  // set so operators can tell a short list from a capped one.
  const countLabel = stage
    ? `${total} ${total === 1 ? "lead" : "leads"} · stage ${stageFilterLabel(stage)}`
    : `${total} ${total === 1 ? "lead" : "leads"}`;

  return (
    <>
      <LeadsBrief count={total} />
      {rows.length > 0 ? (
        <TableBody>
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={LEAD_TABLE_COLUMNS} className="py-2">
              <span
                role="status"
                aria-label={stage ? `Filtered results: ${countLabel}` : `Results: ${countLabel}`}
                className="text-muted-foreground text-xs"
              >
                {countLabel}
              </span>
            </TableCell>
          </TableRow>
        </TableBody>
      ) : null}
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={LEAD_TABLE_COLUMNS} className="p-8">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant={stage ? "icon" : "feature"}>
                    <Users />
                  </EmptyMedia>
                  <EmptyTitle>
                    {stage ? "No leads match this filter" : "No leads yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {stage
                      ? "Try a different stage."
                      : "Import a CSV via a campaign to get started — leads are created when a campaign runs an import."}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    nativeButton={false}
                    render={<Link href={stage ? "/leads" : "/campaigns"} />}
                    variant="outline"
                    size="sm"
                  >
                    {stage ? "Clear the filter" : "Open campaigns"}
                  </Button>
                </EmptyContent>
              </Empty>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((lead) => {
            const consent = consentStatus(lead.consentStatus);
            const stageLabel = pipelineStateLabel(lead.pipelineState);
            return (
            <TableRow key={lead.id} data-copilot-key={lead.id}>
              <LeadsSelectCell id={lead.id} name={lead.name} />
              {/* Frozen identity column: keeps the who visible while the
                  state columns scroll away on mid-width screens. */}
              <TableCell className="bg-background sticky left-0 z-10">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    href={`/leads/${lead.id}`}
                    className="w-fit rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {lead.name ?? "Unnamed"}
                  </Link>
                  {/* Phones: phone and stage fold under the name so the
                      table never scrolls sideways. */}
                  <span className="text-muted-foreground font-mono text-xs md:hidden">
                    {lead.phone}
                  </span>
                  <span className="text-muted-foreground text-xs sm:hidden">
                    {stageLabel}
                  </span>
                </div>
              </TableCell>
              <TableCell className="hidden font-mono text-xs md:table-cell">
                {lead.phone}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <StatusDot tone={consent.tone}>{consent.label}</StatusDot>
              </TableCell>
              <TableCell className="hidden text-sm sm:table-cell">{stageLabel}</TableCell>
              <TableCell className="hidden tabular-nums md:table-cell">{lead.callCount}</TableCell>
              <TableCell className="hidden md:table-cell">
                <LeadStateCell
                  intent={lead.intent}
                  blocker={lead.blocker}
                  nextAction={lead.nextAction}
                />
              </TableCell>
            </TableRow>
            );
          })
        )}
      </TableBody>
    </>
  );
}

/**
 * Curated filter chips resolve here — this leaf awaits searchParams, so the
 * shell stays URL-free (E1439). It renders above the table, never inside the
 * <table>: a <nav> child of <table> is invalid HTML and logs a hydration
 * error on every visit.
 */
async function LeadsChips({
  searchParams,
}: {
  searchParams: Promise<LeadsSearchParams>;
}) {
  const params = await searchParams;
  const active = normalizeStageFilter(params.stage);
  return <FilterChips label="Lead filters" chips={leadsChips(active)} />;
}

export default function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<LeadsSearchParams>;
}) {
  return (
    <div data-testid="leads-shell" className="flex flex-col gap-6">
      {/* Import belongs to a campaign — a lead list with no campaign has
          nothing to be worked by — so this points at the place where the
          import actually happens rather than opening a second path to it. */}
      <PageHeading
        title="Leads"
        description="Every lead, reachable across phone and WhatsApp, with one shared pipeline stage."
        actions={
          <Button
            nativeButton={false}
            render={<Link href="/campaigns" />}
            variant="outline"
          >
            <Upload data-icon="inline-start" />
            Import via a campaign
          </Button>
        }
      />
      {/* One table: header and Suspense rows share it so columns size
          together. The rows leaf renders LeadsBrief (a null render — no DOM
          node, so the table structure stays valid) plus the TableBody; the
          filter leaf renders in the frame toolbar, outside the <table>.
          Selection state wraps the whole frame (a plain div provider — no
          table node), and the checkbox column header is a client island
          resolving inside the existing selection context (E1439: the shell
          never reads the URL). */}
      <LeadsSelection>
        <DataTable
          toolbar={
            <Suspense fallback={null}>
              <LeadsChips searchParams={searchParams} />
            </Suspense>
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" aria-label="Select leads">
                  <LeadsSelectAll />
                </TableHead>
                <TableHead className="bg-background sticky left-0 z-10">
                  Name
                </TableHead>
                <TableHead className="hidden md:table-cell">Phone</TableHead>
                <TableHead className="hidden lg:table-cell">Consent</TableHead>
                <TableHead className="hidden sm:table-cell">Stage</TableHead>
                <TableHead className="hidden md:table-cell">Calls</TableHead>
                <TableHead className="hidden md:table-cell">Latest call</TableHead>
              </TableRow>
            </TableHeader>
            <Suspense
              fallback={
                <TableBody>
                  <TableRow>
                    <TableCell
                      colSpan={LEAD_TABLE_COLUMNS}
                      className="h-40 text-center"
                    >
                      <span
                        role="status"
                        aria-label="Loading leads"
                        className="text-muted-foreground text-sm"
                      >
                        Loading leads…
                      </span>
                    </TableCell>
                  </TableRow>
                </TableBody>
              }
            >
              <LeadsRows searchParams={searchParams} />
            </Suspense>
          </Table>
        </DataTable>
      </LeadsSelection>
    </div>
  );
}

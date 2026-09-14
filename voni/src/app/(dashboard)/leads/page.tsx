import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterChips } from "@/components/filter-chips";
import {
  LeadsSelectAll,
  LeadsSelectCell,
  LeadsSelection,
} from "@/components/leads-bulk-bar";
import { Card, CardContent } from "@/components/ui/card";
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
import { ChevronDown, Users, Upload, X } from "lucide-react";
import { RouteBrief } from "@/components/copilot/route-brief";
import {
  normalizeStageFilter,
  pipelineStateLabel,
  stageFilterLabel,
} from "@/lib/leads/stage-filter";
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
  return (
    <div
      aria-label={accessibleName}
      className="block max-w-55 text-sm"
    >
      <span className="text-foreground block font-medium">
        {nextAction ?? "—"}
      </span>
      {isLong ? (
        <details className="group">
          <span className="text-muted-foreground line-clamp-2 block group-open:hidden">
            {fullContext}
          </span>
          <span className="text-muted-foreground hidden group-open:block">
            {fullContext}
          </span>
          <summary className="text-muted-foreground inline-flex w-fit cursor-pointer items-center gap-1 rounded-sm text-xs underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 transition-transform group-open:rotate-180"
            />
            <span className="group-open:hidden">Show full context</span>
            <span className="hidden group-open:inline">Show less</span>
          </summary>
        </details>
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
  // (h1, Card, table header) stays static and only these rows stream.
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
      <TableBody>
            <TableRow>
              <TableCell colSpan={LEAD_TABLE_COLUMNS} className="py-3">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    role="status"
                    aria-label={stage ? `Filtered results: ${countLabel}` : `Results: ${countLabel}`}
                    className="text-muted-foreground"
                  >
                    {countLabel}
                  </span>
                  {stage ? (
                    <>
                      <Badge>{stageFilterLabel(stage)}</Badge>
                      <Button
                        nativeButton={false}
                        render={<Link href="/leads" />}
                        variant="ghost"
                        size="sm"
                      >
                        <X data-icon="inline-start" />
                        Clear
                      </Button>
                    </>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
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
              rows.map((lead) => (
                <TableRow key={lead.id} data-copilot-key={lead.id}>
                  <LeadsSelectCell id={lead.id} name={lead.name} />
                  {/* Frozen identity column: keeps the who visible while the
                      state columns scroll away on narrow screens. */}
                  <TableCell className="bg-card sticky left-0 z-10">
                    <Link
                      href={`/leads/${lead.id}`}
                      className="cursor-pointer rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {lead.name ?? "Unnamed"}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {lead.phone}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        lead.consentStatus === "granted"
                          ? "default"
                          : lead.consentStatus === "revoked"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {lead.consentStatus === "granted"
                        ? "Consented"
                        : lead.consentStatus === "revoked"
                          ? "Opted out"
                          : "Unknown"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {pipelineStateLabel(lead.pipelineState)}
                    </Badge>
                  </TableCell>
                  <TableCell>{lead.callCount}</TableCell>
                  <TableCell>
                    <LeadStateCell
                      intent={lead.intent}
                      blocker={lead.blocker}
                      nextAction={lead.nextAction}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
    </>
  );
}

/**
 * Curated filter chips resolve here — this leaf awaits searchParams, so the
 * shell stays URL-free (E1439). It renders above the Card, never inside the
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Leads
          </h1>
          <p className="text-muted-foreground text-sm">
            Every lead, reachable across phone and WhatsApp, with one shared
            pipeline stage.
          </p>
        </div>
        {/* Import belongs to a campaign — a lead list with no campaign has
            nothing to be worked by — so this points at the place where the
            import actually happens rather than opening a second path to it.
            The hint says the same in the UI: the button goes to Campaigns,
            where each campaign imports its own CSV. */}
        <div className="flex flex-col items-end gap-1">
          <Button
            nativeButton={false}
            render={<Link href="/campaigns" />}
            variant="outline"
          >
            <Upload />
            Import via a campaign
          </Button>
          <p className="text-muted-foreground text-xs">
            Opens Campaigns — each campaign imports its own CSV.
          </p>
        </div>
      </div>
      {/* One table: header and Suspense rows share it so columns size
          together and horizontal scroll moves them as one unit. The rows
          leaf renders LeadsBrief (a null render — no DOM node, so the
          table structure stays valid) plus the TableBody; the curated
          chips leaf above renders outside the table (a <nav> child of
          <table> is invalid HTML). Selection state wraps the whole Card
          (a plain div provider — no table node), and the checkbox column
          header is a client island resolving inside the existing
          selection context (E1439: the shell never reads the URL). */}
      <Suspense fallback={null}>
        <LeadsChips searchParams={searchParams} />
      </Suspense>
      <LeadsSelection>
        <Card>
          <CardContent className="p-0">
            {/* Scroll containment: the State column (next action + context)
                overflows at 390px without this — same wrapper as calls. */}
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" aria-label="Select leads">
                    <LeadsSelectAll />
                  </TableHead>
                <TableHead className="bg-card sticky left-0 z-10">
                  Name
                </TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Consent</TableHead>
                <TableHead>
                  Stage
                  <span className="text-muted-foreground block text-xs font-normal">
                    Pipeline position
                  </span>
                </TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>
                  State
                  <span className="text-muted-foreground block text-xs font-normal">
                    Latest call context
                  </span>
                </TableHead>
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
          </div>
        </CardContent>
      </Card>
      </LeadsSelection>
      {/* Shortcut discovery: one line, inert text — the global handler reads
          the ? key; this hint only names it. */}
      <p className="text-muted-foreground text-xs">
        Press{" "}
        <kbd
          data-slot="kbd"
          className="rounded border bg-muted px-1 font-mono text-xs font-medium"
        >
          ?
        </kbd>{" "}
        for keyboard shortcuts.
      </p>
    </div>
  );
}

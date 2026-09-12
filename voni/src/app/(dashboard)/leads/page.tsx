import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Users, Upload } from "lucide-react";
import { RouteBrief } from "@/components/copilot/route-brief";
import { listLeads } from "./actions";

const LEAD_TABLE_COLUMNS = 6;

/** Intent, blocker, and next action share one State cell: the action
 *  leads, the rest sit truncated behind a tooltip. */
function LeadStateCell({
  intent,
  blocker,
  nextAction,
}: {
  intent: string | null;
  blocker: string | null;
  nextAction: string | null;
}) {
  const rest = [intent, blocker].filter(
    (part): part is string => part !== null,
  );
  const detail =
    rest.length > 0 ? rest.join(" · ") : "No recorded context yet.";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="text-muted-foreground block max-w-55 cursor-default truncate text-left text-sm">
            <span className="text-foreground">
              {nextAction ?? "—"}
            </span>
            {rest.length > 0 ? ` · ${rest.join(" · ")}` : ""}
          </span>
        }
      />
      <TooltipContent side="top">{detail}</TooltipContent>
    </Tooltip>
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
async function LeadsRows() {
  const rows = await listLeads();

  return (
    <>
      <LeadsBrief count={rows.length} />
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={LEAD_TABLE_COLUMNS}
              className="h-40 text-center"
            >
              <div className="text-muted-foreground flex flex-col items-center gap-2">
                <Users className="size-8" />
                No leads yet — import a CSV via a campaign to get started.
              </div>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((lead) => (
            <TableRow key={lead.id} data-copilot-key={lead.id}>
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
              <TableCell>{lead.pipelineState}</TableCell>
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

export default function LeadsPage() {
  return (
    <div data-testid="leads-shell" className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
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
            import actually happens rather than opening a second path to it. */}
        <Button
          nativeButton={false}
          render={<Link href="/campaigns" />}
          variant="outline"
        >
          <Upload />
          Import via a campaign
        </Button>
      </div>
      {/* One table: header and Suspense rows share it so columns size
          together and horizontal scroll moves them as one unit. The rows
          leaf renders LeadsBrief (a null render — no DOM node, so the
          table structure stays valid) plus the TableBody. */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="bg-card sticky left-0 z-10">
                  Name
                </TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Consent</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>State</TableHead>
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
              <LeadsRows />
            </Suspense>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

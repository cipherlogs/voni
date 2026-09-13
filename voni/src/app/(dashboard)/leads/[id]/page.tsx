import { Suspense } from "react";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { Phone } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { RouteBrief } from "@/components/copilot/route-brief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DetailSkeleton } from "@/components/page-skeletons";
import { dialOutcomeLabel } from "@/lib/campaigns/outcome-label";
import { pipelineStateLabel } from "@/lib/leads/stage-filter";
import { cn } from "@/lib/utils";
import { Fragment } from "react";
import {
  callDuration,
  relativeCallTime,
} from "@/lib/calls/format";
import { leadDetail } from "@/lib/copilot/detail-data";
import { db } from "@/lib/db";
import {
  campaignLeads,
  campaigns,
  calls,
  leads,
  messages,
} from "@/lib/db/schema";

const MEMBERSHIP_LABEL: Record<string, string> = {
  queued: "Queued",
  dialing: "Dialing",
  reached: "Reached",
  exhausted: "No answer",
  skipped: "Skipped",
};

/** Human consent label in the shared list badge shape. */
function ConsentBadge({ status }: { status: string }) {
  const label =
    status === "granted"
      ? "Consented"
      : status === "revoked"
        ? "Opted out"
        : "Unknown";
  return (
    <Badge
      variant={
        status === "granted"
          ? "default"
          : status === "revoked"
            ? "destructive"
            : "secondary"
      }
    >
      {label}
    </Badge>
  );
}

/**
 * House link treatment (same string as the campaign page and the
 * list rows), hoisted so no edited line exceeds the 80-col cap.
 */
const LINK =
  "cursor-pointer rounded-sm underline-offset-4 outline-none " +
  "hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Authorized identity leaf: identity, consent, pipeline, state,
 * linked calls, campaign queue rows, and messages resolve here.
 * notFound()/denial stay inside detail-data, called from this leaf.
 * The record name remains the resolved heading — no invented title.
 */
async function LeadDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Org scoping + uuid validation + notFound live here; every
  // query below keys off this row's id.
  const { lead, state } = await leadDetail(id);

  const leadCalls = await db
    .select({
      id: calls.id,
      direction: calls.direction,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      campaignName: campaigns.name,
    })
    .from(calls)
    .leftJoin(campaigns, eq(campaigns.id, calls.campaignId))
    .where(eq(calls.leadId, id))
    .orderBy(desc(calls.startedAt))
    .limit(20);

  const memberships = await db
    .select({
      id: campaignLeads.id,
      status: campaignLeads.status,
      attempts: campaignLeads.attempts,
      lastOutcome: campaignLeads.lastOutcome,
      campaignId: campaignLeads.campaignId,
      campaignName: campaigns.name,
    })
    .from(campaignLeads)
    .innerJoin(
      campaigns,
      eq(campaigns.id, campaignLeads.campaignId),
    )
    .innerJoin(leads, eq(leads.id, campaignLeads.leadId))
    .where(
      and(
        eq(campaignLeads.leadId, id),
        eq(leads.organizationId, lead.organizationId),
      ),
    )
    .orderBy(desc(campaignLeads.createdAt))
    .limit(20);

  // WhatsApp + call turns for this lead, newest first.
  const activity = await db
    .select({
      id: messages.id,
      channel: messages.channel,
      direction: messages.direction,
      content: messages.content,
      callId: messages.callId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.leadId, id))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const recent = [...activity].reverse();

  const channelLabel =
    activity.length > 0
      ? activity[0].channel === "call"
        ? "a call"
        : "WhatsApp"
      : "none yet";
  const brief =
    `Lead ${lead.name ?? "Unnamed"}, ${lead.phone}. ` +
    `State ${pipelineStateLabel(lead.pipelineState)}. ` +
    `Consent ${lead.consentStatus}. ` +
    `Intent ${state?.intent ?? "not recorded"}. ` +
    `Next action ${state?.nextAction ?? "not recorded"}. ` +
    `${leadCalls.length} calls, ` +
    `${memberships.length} campaign queues, ` +
    `${activity.length} messages. ` +
    `Last contact over ${channelLabel}.`;
  const blockers = Array.isArray(state?.blockers)
    ? state.blockers.join(", ") || "None recorded"
    : "Not recorded";

  return (
    <>
      <RouteBrief route={`/leads/${id}`} brief={brief} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {lead.name ?? "Unnamed lead"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {lead.phone}
          </p>
        </div>
        <Badge variant="secondary">
          {pipelineStateLabel(lead.pipelineState)}
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm">
              Intent
            </CardTitle>
            <CardDescription>
              What the lead is after, as recorded after the last contact.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-lg font-medium">
            {state?.intent ?? "Not recorded"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm">
              Blocker
            </CardTitle>
            <CardDescription>
              What is stopping this lead from booking.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-lg font-medium">
            {blockers}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm">
              Next action
            </CardTitle>
            <CardDescription>
              The follow-up the agent planned for this lead.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-lg font-medium">
            {state?.nextAction ?? "Not recorded"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm">
              Consent
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ConsentBadge status={lead.consentStatus} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm">
              Source
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-medium">
            {lead.source ?? "Not recorded"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm">
              Goal
            </CardTitle>
            <CardDescription>
              Campaign goal status for this lead: active, success, or
              failed.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-lg font-medium">
            {state?.goalStatus ?? "Not recorded"}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Calls ({leadCalls.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {leadCalls.length === 0 ? (
            <div className="p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Phone />
                  </EmptyMedia>
                  <EmptyTitle>No calls yet</EmptyTitle>
                  <EmptyDescription>
                    Calls with this lead appear here
                    once the first one is placed or
                    answered.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Call</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Campaign</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leadCalls.map((row) => {
                    const directionLabel =
                      row.direction === "inbound"
                        ? "Inbound"
                        : "Outbound";
                    const when = relativeCallTime(
                      row.startedAt,
                    );
                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <Link
                            href={`/calls/${row.id}`}
                            aria-label={`${directionLabel} call, ${when}`}
                            className={LINK}
                          >
                            Open call
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.direction === "inbound"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {directionLabel}
                          </Badge>
                        </TableCell>
                        <TableCell
                          className="text-muted-foreground text-sm"
                          title={
                            row.startedAt?.toISOString() ??
                            undefined
                          }
                        >
                          {relativeCallTime(row.startedAt)}
                        </TableCell>
                        <TableCell
                          className="font-mono text-xs text-muted-foreground"
                        >
                          {callDuration(
                            row.startedAt,
                            row.endedAt,
                          )}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-sm">
                          {row.campaignName ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Grouped-rows idiom (table-04): each campaign queues this lead
          once, so every row is its own group — the header names the campaign,
          the row carries attempts + last outcome + the queue link. */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-4 px-4 pt-4">
          <h2 className="text-base font-semibold tracking-tight">
            Campaigns ({memberships.length})
          </h2>
        </div>
        {memberships.length === 0 ? (
          <p className="text-muted-foreground px-4 py-4 text-center text-sm">
            This lead is not in any campaign queue.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-medium">Status</TableHead>
                  <TableHead className="font-medium">Attempts</TableHead>
                  <TableHead className="font-medium">Last outcome</TableHead>
                  <TableHead>
                    <span className="sr-only">Open campaign queue</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberships.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableCell
                        className="py-2 font-semibold"
                        colSpan={4}
                      >
                        {row.campaignName ?? "Unnamed campaign"}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>
                        <Badge
                          className={cn("gap-1.5 rounded-full")}
                          variant="outline"
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "size-1.5 rounded-full",
                              row.status === "reached"
                                ? "bg-primary"
                                : row.status === "skipped"
                                  ? "bg-destructive"
                                  : "bg-muted-foreground",
                            )}
                          />
                          {MEMBERSHIP_LABEL[row.status] ?? row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.attempts} attempt
                        {row.attempts === 1 ? "" : "s"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.lastOutcome
                          ? dialOutcomeLabel(row.lastOutcome)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/campaigns/${row.campaignId}`}
                          aria-label={`Open ${row.campaignName ?? "campaign"}`}
                          className={LINK}
                        >
                          Open queue
                        </Link>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Messages ({activity.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              No WhatsApp or call messages recorded
              for this lead.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {recent.map((message) => {
                const speaker =
                  message.channel === "call"
                    ? message.direction === "inbound"
                      ? (lead.name ?? "Lead")
                      : "Agent"
                    : message.direction === "inbound"
                      ? "Lead (WhatsApp)"
                      : "Agent (WhatsApp)";
                return (
                  <li
                    key={message.id}
                    className="flex flex-col gap-1"
                  >
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-sm font-medium">
                        {speaker}
                      </span>
                      <span
                        className="text-muted-foreground shrink-0 text-xs"
                        title={message.createdAt.toISOString()}
                      >
                        {relativeCallTime(message.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm">
                      {message.content?.trim()
                        ? message.content
                        : message.callId ? (
                            <Link
                              href={`/calls/${message.callId}`}
                              aria-label="Open the call this turn belongs to"
                              className={LINK}
                            >
                              Open call
                            </Link>
                          ) : (
                            "No text recorded."
                          )}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <nav
        aria-label="Related records"
        className="flex flex-wrap gap-2"
      >
        <Button
          nativeButton={false}
          render={<Link href="/calls" />}
          variant="outline"
          size="sm"
        >
          All calls
        </Button>
        {memberships.length > 0 ? (
          <Button
            nativeButton={false}
            render={
              <Link
                href={`/campaigns/${memberships[0].campaignId}`}
              />
            }
            variant="outline"
            size="sm"
          >
            Open campaign queue
          </Button>
        ) : null}
        <Button
          nativeButton={false}
          render={<Link href="/jobs" />}
          variant="outline"
          size="sm"
        >
          Job center
        </Button>
      </nav>
    </>
  );
}

export default function LeadDetailPage({
  params,
}: PageProps<"/leads/[id]">) {
  return (
    <div data-testid="lead-shell" className="flex flex-col gap-6">
      <BackLink href="/leads" label="Leads" />
      {/* Generic detail structure: back navigation renders with the shell;
          identity and state stream in the leaf below. */}
      <Suspense
        fallback={
          <div role="status" aria-label="Loading lead">
            <DetailSkeleton />
          </div>
        }
      >
        <LeadDetail params={params} />
      </Suspense>
    </div>
  );
}

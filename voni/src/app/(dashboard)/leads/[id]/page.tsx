import { Suspense } from "react";
import { DataTable } from "@/components/data-table";
import { StatusDot } from "@/components/status-dot";
import { consentStatus, goalLabel, queueStatus } from "@/lib/campaigns/status";
import {
  FormSection,
  FormSectionHeading,
  FormSectionSeparator,
} from "@/components/wizard/form-layout";
import { PageHeading } from "@/components/wizard/form-layout";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { Phone } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { RouteBrief } from "@/components/copilot/route-brief";
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
import { LeadDetailSkeleton } from "@/components/page-skeletons";
import { dialOutcomeLabel } from "@/lib/campaigns/outcome-label";
import { pipelineStateLabel } from "@/lib/leads/stage-filter";
import { Fragment } from "react";
import { callDuration, relativeCallTime } from "@/lib/calls/format";
import { leadDetail } from "@/lib/copilot/detail-data";
import { db } from "@/lib/db";
import {
  campaignLeads,
  campaigns,
  calls,
  leads,
  messages,
} from "@/lib/db/schema";

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
  const consent = consentStatus(lead.consentStatus);
  const blockers = Array.isArray(state?.blockers)
    ? state.blockers.join(", ") || "None recorded"
    : "Not recorded";

  return (
    <>
      <RouteBrief route={`/leads/${id}`} brief={brief} />
      <PageHeading
        title={lead.name ?? "Unnamed lead"}
        meta={
          <span className="text-muted-foreground text-sm">
            {pipelineStateLabel(lead.pipelineState)}
          </span>
        }
        description={<span className="font-mono">{lead.phone}</span>}
      />

      <FormSection
        aria-labelledby="lead-summary-heading"
        heading={
          <FormSectionHeading
            id="lead-summary-heading"
            title="Summary"
            description="What the agent recorded after the last contact."
          />
        }
      >
        {/* Description list (dashboard-01 detail idiom): label column,
            value column — one surface instead of six small cards. */}
        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">Intent</dt>
          <dd className="min-w-0">{state?.intent ?? "Not recorded"}</dd>
          <dt className="text-muted-foreground">Blocker</dt>
          <dd className="min-w-0">{blockers}</dd>
          <dt className="text-muted-foreground">Next action</dt>
          <dd className="min-w-0">{state?.nextAction ?? "Not recorded"}</dd>
          <dt className="text-muted-foreground">Consent</dt>
          <dd>
            <StatusDot tone={consent.tone}>{consent.label}</StatusDot>
          </dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="min-w-0">{lead.source ?? "Not recorded"}</dd>
          <dt className="text-muted-foreground">Goal</dt>
          <dd className="min-w-0">{goalLabel(state?.goalStatus)}</dd>
        </dl>
      </FormSection>

      <FormSectionSeparator className="my-2" />

      <section aria-labelledby="lead-calls-heading" className="flex flex-col gap-4">
        <FormSectionHeading
          id="lead-calls-heading"
          title={`Calls · ${leadCalls.length}`}
        />
        <DataTable>
          {leadCalls.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Phone />
                </EmptyMedia>
                <EmptyTitle>No calls yet</EmptyTitle>
                <EmptyDescription>
                  Calls with this lead appear here once the first one is placed
                  or answered.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead className="hidden sm:table-cell">Direction</TableHead>
                  <TableHead className="hidden sm:table-cell">Duration</TableHead>
                  <TableHead className="hidden md:table-cell">Campaign</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leadCalls.map((row) => {
                  const directionLabel =
                    row.direction === "inbound" ? "Inbound" : "Outbound";
                  const when = relativeCallTime(row.startedAt);
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link
                          href={`/calls/${row.id}`}
                          aria-label={`${directionLabel} call, ${when}`}
                          className={LINK}
                        >
                          {when}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
                        {directionLabel}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">
                        {callDuration(row.startedAt, row.endedAt)}
                      </TableCell>
                      <TableCell className="hidden max-w-48 truncate text-sm md:table-cell">
                        {row.campaignName ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </DataTable>
      </section>

      <section aria-labelledby="lead-campaigns-heading" className="flex flex-col gap-4">
        <FormSectionHeading
          id="lead-campaigns-heading"
          title={`Campaigns · ${memberships.length}`}
        />
        <DataTable>
          {memberships.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Not in any campaign</EmptyTitle>
                <EmptyDescription>
                  This lead is not in any campaign queue.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="hidden sm:table-cell">Attempts</TableHead>
                  <TableHead className="hidden md:table-cell">Last outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberships.map((row) => {
                  const status = queueStatus(row.status);
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link href={`/campaigns/${row.campaignId}`} className={LINK}>
                          {row.campaignName ?? "Unnamed campaign"}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusDot tone={status.tone}>{status.label}</StatusDot>
                      </TableCell>
                      <TableCell className="hidden text-sm tabular-nums sm:table-cell">
                        {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-sm md:table-cell">
                        {row.lastOutcome ? dialOutcomeLabel(row.lastOutcome) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </DataTable>
      </section>

      <section aria-labelledby="lead-messages-heading" className="flex flex-col gap-4">
        <FormSectionHeading
          id="lead-messages-heading"
          title={`Messages · ${activity.length}`}
        />
        <DataTable>
          {recent.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No messages yet</EmptyTitle>
                <EmptyDescription>
                  No WhatsApp or call messages recorded for this lead.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y">
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
                  <li key={message.id} className="flex flex-col gap-1 px-4 py-3">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-sm font-medium">{speaker}</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {relativeCallTime(message.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm">
                      {message.content?.trim() ? (
                        message.content
                      ) : message.callId ? (
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
        </DataTable>
      </section>
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
            <LeadDetailSkeleton />
          </div>
        }
      >
        <LeadDetail params={params} />
      </Suspense>
    </div>
  );
}

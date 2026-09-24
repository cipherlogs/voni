import { Suspense } from "react";
import { DisclosureTrigger } from "@/components/disclosure";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { StatusDot } from "@/components/status-dot";
import { consentStatus, goalLabel } from "@/lib/campaigns/status";
import { FormSection, FormSectionHeading, FormSectionSeparator } from "@/components/wizard/form-layout";
import { PageHeading } from "@/components/wizard/form-layout";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  and,
  asc,
  desc,
  eq,
} from "drizzle-orm";
import { Phone, Wrench } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { RouteBrief } from "@/components/copilot/route-brief";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { CallDetailSkeleton } from "@/components/page-skeletons";
import type { ReactNode } from "react";
import { callDuration, relativeCallTime } from "@/lib/calls/format";
import { callDetail } from "@/lib/copilot/detail-data";
import { db } from "@/lib/db";
import {
  agents,
  calls,
  campaigns,
  conversationStates,
  leads,
  messages,
  toolCallLogs,
} from "@/lib/db/schema";
import { requireCtxOrRedirect } from "@/lib/session";
import { pipelineStateLabel } from "@/lib/leads/stage-filter";

function formatWhen(value: Date | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

/**
 * House link treatment (same string as the campaign page and the
 * list rows), hoisted so no edited line exceeds the 80-col cap.
 */
const LINK =
  "cursor-pointer rounded-sm underline-offset-4 outline-none " +
  "hover:underline focus-visible:ring-2 focus-visible:ring-ring";

function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/**
 * Authorized call leaf: facts, the recorded turns, the recorded
 * actions, and the state this call produced resolve here.
 * notFound()/denial stay inside detail-data, called from this leaf.
 */
async function CallDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const call = await callDetail(id);
  const ctx = await requireCtxOrRedirect(`/calls/${id}`);

  // Ownership-proving join: every query below keys off ids from
  // this row, and it resolves the lead/campaign/agent ids the
  // onward links need. callDetail already 404s on a miss.
  const [link] = await db
    .select({
      leadId: calls.leadId,
      campaignId: calls.campaignId,
      agentId: calls.agentId,
      consent: leads.consentStatus,
      pipeline: leads.pipelineState,
      campaignName: campaigns.name,
      agentName: agents.name,
    })
    .from(calls)
    .innerJoin(leads, eq(calls.leadId, leads.id))
    .leftJoin(
      campaigns,
      eq(campaigns.id, calls.campaignId),
    )
    .leftJoin(agents, eq(agents.id, calls.agentId))
    .where(
      and(
        eq(calls.id, id),
        eq(leads.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  if (!link) notFound();

  // Recorded turns for this call, oldest first for reading order.
  const turns = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.callId, id))
    .orderBy(asc(messages.createdAt))
    .limit(100);
  const spoken = turns.filter(
    (turn) => (turn.content ?? "").trim().length > 0,
  );

  const tools = await db
    .select({
      id: toolCallLogs.id,
      toolName: toolCallLogs.toolName,
      arguments: toolCallLogs.arguments,
      result: toolCallLogs.result,
      latencyMs: toolCallLogs.latencyMs,
      isError: toolCallLogs.isError,
      createdAt: toolCallLogs.createdAt,
    })
    .from(toolCallLogs)
    .where(eq(toolCallLogs.callId, id))
    .orderBy(asc(toolCallLogs.createdAt))
    .limit(50);

  const [outcome] = await db
    .select()
    .from(conversationStates)
    .where(eq(conversationStates.sourceCallId, id))
    .orderBy(desc(conversationStates.createdAt))
    .limit(1);

  const directionLabel =
    call.direction === "inbound" ? "Inbound" : "Outbound";
  const duration = callDuration(call.startedAt, call.endedAt);
  const sub = call.startedAt
    ? `${directionLabel} · ` +
      `${relativeCallTime(call.startedAt)} · ${duration}`
    : `${directionLabel} · Start time not recorded`;
  const brief =
    `${directionLabel} call with ` +
    `${call.name ?? call.phone}. Started ` +
    `${call.startedAt?.toISOString() ?? "not recorded"}. ` +
    `${call.endedAt
      ? "Ended " + call.endedAt.toISOString()
      : "End time not recorded"}. ` +
    `${spoken.length} transcript turns, ` +
    `${tools.length} actions taken.`;
  const leadLabel = call.name ?? call.phone;

  return (
    <>
      <RouteBrief route={`/calls/${id}`} brief={brief} />
      <PageHeading title={`Call with ${leadLabel}`} description={sub} />

      <FormSection
        aria-labelledby="call-details-heading"
        heading={
          <FormSectionHeading
            id="call-details-heading"
            title="Call details"
          />
        }
      >
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
            <Fact label="Lead">
              <Link
                href={`/leads/${link.leadId}`}
                aria-label={`Open lead ${leadLabel}`}
                className={LINK}
              >
                {leadLabel}
              </Link>
            </Fact>
            <Fact label="Phone">
              <span className="font-mono text-xs">
                {call.phone}
              </span>
            </Fact>
            <Fact label="Direction">
              {directionLabel}
            </Fact>
            <Fact label="Started">
              {formatWhen(call.startedAt)}
            </Fact>
            <Fact label="Ended">
              {call.endedAt
                ? formatWhen(call.endedAt)
                : call.startedAt
                  ? "Ongoing"
                  : "—"}
            </Fact>
            <Fact label="Duration">{duration}</Fact>
          </dl>
      </FormSection>

      <FormSectionSeparator className="my-2" />

      <FormSection
        aria-labelledby="call-setup-heading"
        heading={
          <FormSectionHeading
            id="call-setup-heading"
            title="Call setup"
          />
        }
      >
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
            <Fact label="Campaign">
              {link.campaignId ? (
                <Link
                  href={`/campaigns/${link.campaignId}`}
                  aria-label={`Open campaign ${link.campaignName ?? "unnamed"}`}
                  className={LINK}
                >
                  {link.campaignName ?? "Unnamed campaign"}
                </Link>
              ) : (
                "—"
              )}
            </Fact>
            <Fact label="Agent">
              {link.agentId ? (
                <Link
                  href={`/agents/${link.agentId}`}
                  aria-label={`Open agent ${link.agentName ?? "unnamed"}`}
                  className={LINK}
                >
                  {link.agentName ?? "Unnamed agent"}
                </Link>
              ) : (
                "—"
              )}
            </Fact>
            <Fact label="Consent">
              <StatusDot tone={consentStatus(link.consent).tone}>
                {consentStatus(link.consent).label}
              </StatusDot>
            </Fact>
            <Fact label="Pipeline">
              {pipelineStateLabel(link.pipeline)}
            </Fact>
          </dl>
      </FormSection>

      <FormSectionSeparator className="my-2" />

      <FormSection
        aria-labelledby="call-conversation-heading"
        heading={
          <FormSectionHeading
            id="call-conversation-heading"
            title="Conversation"
            description={spoken.length >= 100 ? "Showing the first 100 turns." : undefined}
          />
        }
      >
          {spoken.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Phone />
                </EmptyMedia>
                <EmptyTitle>No turns recorded</EmptyTitle>
                <EmptyDescription>
                  No transcript turns were saved for
                  this call.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-4">
              {spoken.map((turn) => (
                <li
                  key={turn.id}
                  className="flex flex-col gap-1"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-sm font-medium">
                      {turn.direction === "inbound"
                        ? leadLabel
                        : (link.agentName ?? "Agent")}
                    </span>
                    <span
                      className="text-muted-foreground shrink-0 text-xs"
                      title={turn.createdAt.toISOString()}
                    >
                      {relativeCallTime(turn.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm">{turn.content}</p>
                </li>
              ))}
            </ul>
          )}
      </FormSection>

      <FormSectionSeparator className="my-2" />

      <FormSection
        aria-labelledby="call-actions-heading"
        heading={
          <FormSectionHeading
            id="call-actions-heading"
            title="Actions taken"
            description={tools.length >= 50 ? "Showing the first 50." : "Tools the agent used during this call."}
          />
        }
      >
          {tools.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Wrench />
                </EmptyMedia>
                <EmptyTitle>No actions recorded</EmptyTitle>
                <EmptyDescription>
                  This call ran without taking any actions.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {tools.map((tool) => (
                <li
                  key={tool.id}
                  className="flex flex-col gap-1"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <span
                      className="min-w-0 truncate text-sm font-medium"
                      title={`${tool.toolName} · ${tool.createdAt.toISOString()}`}
                    >
                      {tool.toolName}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {tool.isError ? (
                        <Badge variant="destructive">
                          Error
                        </Badge>
                      ) : null}
                      <span className="text-muted-foreground text-xs">
                        {tool.latencyMs != null
                          ? `${tool.latencyMs} ms`
                          : "—"}
                      </span>
                    </span>
                  </div>
                  {tool.arguments != null ||
                  tool.result != null ? (
                    <Collapsible>
                      <DisclosureTrigger className="text-xs">
                        Arguments and result
                      </DisclosureTrigger>
                      <CollapsibleContent>
                      <pre className="bg-muted/50 mt-1 max-h-48 overflow-auto rounded-lg p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                        {JSON.stringify(
                          {
                            arguments: tool.arguments,
                            result: tool.result,
                          },
                          null,
                          2,
                        )}
                      </pre>
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
      </FormSection>

      {outcome ? (
        <>
        <FormSectionSeparator className="my-2" />
        <FormSection
        aria-labelledby="call-outcome-heading"
        heading={
          <FormSectionHeading
            id="call-outcome-heading"
            title="Outcome"
          />
        }
      >
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
              <Fact label="Goal">{goalLabel(outcome.goalStatus)}</Fact>
              <Fact label="Intent">
                {outcome.intent ?? "Not recorded"}
              </Fact>
              <Fact label="Blockers">
                {Array.isArray(outcome.blockers)
                  ? outcome.blockers.join(", ") ||
                    "None recorded"
                  : "Not recorded"}
              </Fact>
              <Fact label="Next action">
                {outcome.nextAction ?? "Not recorded"}
              </Fact>
            </dl>
        </FormSection>
        </>
      ) : null}

    </>
  );
}

export default function CallDetailPage({
  params,
}: PageProps<"/calls/[id]">) {
  return (
    <div data-testid="call-shell" className="flex flex-col gap-6">
      <BackLink href="/calls" label="Calls" />
      {/* Existing back navigation + detail structure shell; authorized call
          data streams in the leaf below. */}
      <Suspense
        fallback={
          <div role="status" aria-label="Loading call">
            <CallDetailSkeleton />
          </div>
        }
      >
        <CallDetail params={params} />
      </Suspense>
    </div>
  );
}

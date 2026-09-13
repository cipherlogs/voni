import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, campaigns } from "@/lib/db/schema";
import { dispatchIdleLabel } from "./outcome-label";
import {
  allowedConsentStatuses,
  evaluateCallingWindow,
  parseCallingWindow,
  parseConsentPolicy,
} from "./policy";

/**
 * Outbound dial dispatch (plan Day 7-8).
 *
 * The dialer lives in the Python bridge, not here, and that is forced by the
 * media path rather than chosen: Telnyx needs `stream_url:
 * wss://<PUBLIC_HOST>/media-stream`, and PUBLIC_HOST is the bridge's tunnel
 * hostname, which this app never learns. So Voni owns the queue and the
 * policy, the bridge asks "who next", and the two talk over the same
 * `VONI_TOOL_SECRET` channel the tool API already uses.
 *
 * There are two modes and the difference is the whole safety story:
 *
 *   preview — evaluate everything, mutate nothing. What the runner uses by
 *             default, so the entire window/consent/backoff loop can be proven
 *             against real data without placing a call or spending anything.
 *   claim   — the same evaluation, then atomically take the lead. Only reached
 *             when the operator started the runner with `--live`.
 *
 * Both go through `eligibleWhere` so the dry run cannot quietly disagree with
 * what the live run would have done — a preview that lies is worse than no
 * preview.
 */

export type DialTarget = {
  campaignLeadId: string;
  campaignId: string;
  campaignName: string;
  leadId: string;
  leadName: string | null;
  phone: string;
  agentId: string;
  assemblyaiAgentId: string;
  /** Attempt number this dial would be (1-based), for logging and caps. */
  attempt: number;
  maxAttempts: number;
};

export type DispatchDecision =
  | { status: "dial"; target: DialTarget }
  | { status: "idle"; reason: string };

/**
 * An IN list with one bound parameter per value.
 *
 * `= ANY($1)` reads better but does not survive neon-http: the driver sends a
 * JS array as a plain string and Postgres rejects it with 22P02. Binding the
 * values individually keeps the statement parameterised.
 */
function consentList(consent: string[]) {
  return sql.join(
    consent.map((status) => sql`${status}`),
    sql`, `,
  );
}

/**
 * The eligibility predicate, in one place.
 *
 * `next_attempt_after` uses the database clock rather than an application
 * timestamp so that backoff cannot be skipped by a runner with a fast clock.
 * The calling *window*, by contrast, is evaluated in TypeScript — it needs IANA
 * timezone arithmetic that would be far less readable as SQL, and it applies to
 * the whole campaign rather than to individual rows.
 */
function eligibleWhere(campaignId: string, maxAttempts: number, consent: string[]) {
  return sql`
        cl.campaign_id = ${campaignId}
    AND cl.status = 'queued'
    AND cl.attempts < ${maxAttempts}
    AND (cl.next_attempt_after IS NULL OR cl.next_attempt_after <= now())
    -- EXISTS rather than a join: the claim below wraps this in FOR UPDATE, and
    -- a joined \`leads\` would be locked too — rows that other calls are
    -- legitimately writing to.
    AND EXISTS (
      SELECT 1 FROM leads l
      WHERE l.id = cl.lead_id AND l.consent_status IN (${consentList(consent)})
    )
  `;
}

type LeadRow = {
  id: string;
  attempts: number;
  lead_id: string;
  lead_name: string | null;
  phone: string;
};

/**
 * Pick the next lead to dial for an organization, or explain why there is none.
 *
 * Campaigns are considered oldest-first and the first one with work wins. That
 * is deliberately simple — the plan budgets "tens of leads" for demo and early
 * pilot scale and explicitly rules out queue infrastructure — but it does mean
 * a busy campaign can starve a newer one. Revisit when a real pilot has more
 * than a handful of concurrent campaigns.
 */
export async function nextDialTarget(
  organizationId: string,
  mode: "preview" | "claim",
  now: Date = new Date(),
): Promise<DispatchDecision> {
  const active = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      callingWindow: campaigns.callingWindow,
      consentPolicy: campaigns.consentPolicy,
      maxAttempts: campaigns.maxAttempts,
      agentId: agents.id,
      assemblyaiAgentId: agents.assemblyaiAgentId,
    })
    .from(campaigns)
    .innerJoin(agents, eq(agents.id, campaigns.agentId))
    .where(
      and(
        eq(campaigns.organizationId, organizationId),
        eq(campaigns.status, "active"),
      ),
    )
    .orderBy(campaigns.createdAt);

  // Idle reasons leave here as operator sentences (`dispatchIdleLabel`),
  // not the raw dispatcher shorthand: the bridge runner logs `reason`
  // verbatim to the operator (`logger.info(f"idle: ...")`), so the mapping
  // must happen at the source rather than at any one consumer.
  if (active.length === 0) {
    return {
      status: "idle",
      reason: dispatchIdleLabel("no active campaigns") ?? "no active campaigns",
    };
  }

  // One bridge process holds one media stream, so a second dial while a call is
  // live would be answered by nobody. The `dialing` row is already the record
  // of an in-flight call, so it doubles as the concurrency guard and no
  // separate lock is needed. `requeueStaleClaims` is what stops a crashed
  // runner from wedging this forever.
  const inFlight = await db.execute(sql`
    SELECT cl.id FROM campaign_leads cl
    JOIN campaigns c ON c.id = cl.campaign_id
    WHERE c.organization_id = ${organizationId} AND cl.status = 'dialing'
    LIMIT 1
  `);
  if (inFlight.rows.length > 0) {
    return {
      status: "idle",
      reason:
        dispatchIdleLabel("a call is already in progress") ??
        "a call is already in progress",
    };
  }

  // Reasons accumulate so an idle runner can say *why* rather than just
  // sitting there — "outside 09:00-18:00 Asia/Dubai" is the difference between
  // a working system and a broken one, and they look identical otherwise.
  const reasons: string[] = [];

  for (const campaign of active) {
    if (!campaign.assemblyaiAgentId) {
      reasons.push(`${campaign.name}: agent is not deployed`);
      continue;
    }

    const window = evaluateCallingWindow(parseCallingWindow(campaign.callingWindow), now);
    if (!window.allowed) {
      reasons.push(`${campaign.name}: ${window.reason}`);
      continue;
    }

    const consent = allowedConsentStatuses(parseConsentPolicy(campaign.consentPolicy));
    const where = eligibleWhere(campaign.id, campaign.maxAttempts, consent);

    let row: LeadRow | undefined;
    if (mode === "preview") {
      const result = await db.execute(sql`
        SELECT cl.id, cl.attempts, cl.lead_id, l.name AS lead_name, l.phone
        FROM campaign_leads cl
        JOIN leads l ON l.id = cl.lead_id
        WHERE ${where}
        ORDER BY cl.created_at ASC
        LIMIT 1
      `);
      row = (result.rows as LeadRow[])[0];
    } else {
      // One statement, so it is atomic without an interactive transaction —
      // which neon-http does not offer anyway. SKIP LOCKED means a second
      // runner takes the next lead rather than blocking or, far worse, dialling
      // the same person twice.
      const result = await db.execute(sql`
        UPDATE campaign_leads AS target
        SET status = 'dialing',
            attempts = target.attempts + 1,
            last_attempt_at = now(),
            updated_at = now()
        WHERE target.id = (
          SELECT cl.id
          FROM campaign_leads cl
          WHERE ${where}
          ORDER BY cl.created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING target.id,
                  target.attempts,
                  target.lead_id,
                  (SELECT name FROM leads WHERE leads.id = target.lead_id) AS lead_name,
                  (SELECT phone FROM leads WHERE leads.id = target.lead_id) AS phone
      `);
      row = (result.rows as LeadRow[])[0];
    }

    if (!row) {
      reasons.push(`${campaign.name}: no leads due`);
      continue;
    }

    return {
      status: "dial",
      target: {
        campaignLeadId: row.id,
        campaignId: campaign.id,
        campaignName: campaign.name,
        leadId: row.lead_id,
        leadName: row.lead_name,
        phone: row.phone,
        agentId: campaign.agentId,
        assemblyaiAgentId: campaign.assemblyaiAgentId,
        // In preview nothing was incremented, so the attempt this *would* be is
        // one past what is stored; in claim mode the row already carries it.
        attempt: mode === "preview" ? row.attempts + 1 : row.attempts,
        maxAttempts: campaign.maxAttempts,
      },
    };
  }

  const raw = reasons.join("; ") || "no leads due";
  return { status: "idle", reason: dispatchIdleLabel(raw) ?? raw };
}

/** Outcomes the bridge reports back after a dial completes. */
export const DIAL_OUTCOMES = [
  "answered",
  "no_answer",
  "busy",
  "failed",
  "cancelled",
] as const;
export type DialOutcome = (typeof DIAL_OUTCOMES)[number];

/**
 * Record what happened to a claimed lead and decide whether it is still work.
 *
 * `answered` retires the lead from the queue even if the conversation went
 * badly: whether the goal was met is the extraction pipeline's judgement
 * (Day 9-10), not the dialer's, and re-dialling someone we just spoke to is
 * the single most annoying thing an outbound system can do.
 */
export async function recordDialOutcome(
  organizationId: string,
  campaignLeadId: string,
  outcome: DialOutcome,
  callId?: string | null,
): Promise<{ ok: boolean; status?: string; message?: string }> {
  const result = await db.execute(sql`
    UPDATE campaign_leads cl
    SET status = CASE
          WHEN ${outcome} = 'answered' THEN 'reached'::campaign_lead_status
          WHEN cl.attempts >= c.max_attempts THEN 'exhausted'::campaign_lead_status
          ELSE 'queued'::campaign_lead_status
        END,
        next_attempt_after = CASE
          WHEN ${outcome} = 'answered' OR cl.attempts >= c.max_attempts THEN NULL
          ELSE now() + make_interval(mins => c.retry_after_minutes)
        END,
        last_outcome = ${outcome},
        last_call_id = COALESCE(${callId ?? null}::uuid, cl.last_call_id),
        updated_at = now()
    FROM campaigns c
    WHERE cl.campaign_id = c.id
      AND cl.id = ${campaignLeadId}
      -- The bridge is a trusted caller, but it still may not touch another
      -- workspace's queue; the id it sends is not authority on its own.
      AND c.organization_id = ${organizationId}
    RETURNING cl.status
  `);

  const row = (result.rows as { status: string }[])[0];
  if (!row) return { ok: false, message: "Campaign lead not found." };
  return { ok: true, status: row.status };
}

/**
 * Return a claimed lead to the queue without consuming its attempt.
 *
 * Used when a dial is abandoned before it reaches the carrier — the runner was
 * stopped, or Telnyx rejected the request outright. Without this a crashed
 * runner leaves rows stuck in `dialing` forever, which looks exactly like an
 * empty queue.
 */
export async function releaseDialClaim(
  organizationId: string,
  campaignLeadId: string,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE campaign_leads cl
    SET status = 'queued',
        attempts = GREATEST(cl.attempts - 1, 0),
        last_outcome = ${reason},
        updated_at = now()
    FROM campaigns c
    WHERE cl.campaign_id = c.id
      AND cl.id = ${campaignLeadId}
      AND c.organization_id = ${organizationId}
      AND cl.status = 'dialing'
  `);
}

/**
 * Requeue claims left behind by a runner that died mid-dial.
 *
 * A call that connects is finished within minutes, so anything still `dialing`
 * after the grace period is orphaned rather than in progress. Called at the top
 * of each dispatch request, which is cheap and means recovery needs no cron.
 */
export async function requeueStaleClaims(
  organizationId: string,
  staleMinutes = 15,
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE campaign_leads cl
    SET status = 'queued',
        last_outcome = 'requeued after stalled dial',
        updated_at = now()
    FROM campaigns c
    WHERE cl.campaign_id = c.id
      AND cl.status = 'dialing'
      AND c.organization_id = ${organizationId}
      AND cl.last_attempt_at < now() - make_interval(mins => ${staleMinutes})
    RETURNING cl.id
  `);
  return result.rows.length;
}

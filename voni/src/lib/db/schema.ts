import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  uuid,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization, user } from "./auth-schema";

// ---------------------------------------------------------------------------
// Better Auth core tables (user/session/account/verification) + the
// organization plugin's tables (organization/member/invitation) are generated
// separately via `npx @better-auth/cli generate` once DATABASE_URL is set —
// see src/lib/auth.ts. Domain tables below reference `organization.id` /
// `user.id` by plain text FK (Better Auth's default id type) rather than
// importing its generated schema, to keep this file the single source of
// truth for our own tables and avoid a circular generate/import cycle.
// ---------------------------------------------------------------------------

// Re-exported so the single `schema` object handed to drizzle() (and therefore
// drizzleAdapter) contains the auth tables too. Without this the adapter has no
// `user`/`session` model to resolve and every sign-in fails at lookup time.
export * from "./auth-schema";

export const channelEnum = pgEnum("channel", [
  "call",
  "whatsapp_text",
  "whatsapp_voice",
]);

export const directionEnum = pgEnum("direction", ["inbound", "outbound"]);

export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "active",
  "paused",
  "completed",
]);

export const goalStatusEnum = pgEnum("goal_status", [
  "active",
  "success",
  "failed",
]);

// One lead's position in one campaign's work queue. `queued` is eligible now
// (subject to window/consent/backoff), `dialing` is claimed by a runner and
// must not be handed out twice, and the three terminal states record *why* the
// lead stopped being work: reached, out of attempts, or filtered out.
export const campaignLeadStatusEnum = pgEnum("campaign_lead_status", [
  "queued",
  "dialing",
  "reached",
  "exhausted",
  "skipped",
]);

export const integrationCheckStatusEnum = pgEnum("integration_check_status", [
  "passed",
  "failed",
]);

export const providerConnectionStatusEnum = pgEnum(
  "provider_connection_status",
  ["connected", "error"],
);

/**
 * Workspace-scoped third-party provider connections (GOAL 4A: Gmail / Zoho /
 * Google Docs). One row per (organization, provider); absence means
 * disconnected ("needs setup" on the agent page).
 *
 * `organizationId` is plain text like `agents.organizationId` (not an FK) so
 * connection state still persists under the dev-bypass ctx, which carries a
 * synthetic org id with no `organization` row. `connectedBy` keeps the audit
 * FK to `user.id` (the dev connect action materializes the bypass stub row,
 * mirroring `ensurePrefsOwner` in settings/actions.ts).
 *
 * No credentials live here — connect records only status + display label.
 * Disconnecting deletes the row; saved agent configs are never touched (the
 * agent page surfaces needs-setup state from the store accessors instead).
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    providerId: text("provider_id").notNull(),
    status: providerConnectionStatusEnum("status")
      .notNull()
      .default("connected"),
    accountLabel: text("account_label"),
    connectedBy: text("connected_by")
      .notNull()
      .references(() => user.id),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_connections_org_provider_uidx").on(
      table.organizationId,
      table.providerId,
    ),
  ],
);

// Global, operator-managed secret overrides. AES-GCM appends its authentication
// tag to `ciphertext`; the random IV is stored separately. The root key never
// enters the database.
export const platformCredentials = pgTable("platform_credentials", {
  name: text("name").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  updatedBy: text("updated_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Multiple operator-owned accounts per free-tier LLM provider (e.g. several
// Groq accounts), so a rate-limited or failing account is skipped in favor of
// the next rather than falling through to a weaker provider prematurely.
// `priority` fixes rotation order within a provider; `cooldownUntil` holds an
// account out of rotation after a failure until the backoff window passes.
export const llmProviderAccounts = pgTable("llm_provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: text("provider_id").notNull(),
  label: text("label").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(0),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  updatedBy: text("updated_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const integrationChecks = pgTable("integration_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  service: text("service").notNull(),
  status: integrationCheckStatusEnum("status").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  error: text("error"),
  testedBy: text("tested_by")
    .notNull()
    .references(() => user.id),
  testedAt: timestamp("tested_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationSettings = pgTable("organization_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("Asia/Dubai"),
  humanTransferNumber: text("human_transfer_number"),
  updatedBy: text("updated_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-user voice copilot preferences. One row per user, created on first
// save — absence means defaults (ivy + pinned English, the historical
// behaviour). Voice/language apply at the next conversation start: the
// AssemblyAI voice is immutable once a session is established.
export const copilotVoicePrefs = pgTable("copilot_voice_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  voiceId: text("voice_id").notNull().default("ivy"),
  /** "auto" = omit language_codes (detect across all recognised languages). */
  language: text("language").notNull().default("en"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Agent: reusable worker config (Plan Section D)
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  // Mission / rules / knowledge / tools / success / fallback / followup / channels
  config: jsonb("config").notNull(),
  assemblyaiAgentId: text("assemblyai_agent_id"),
  // Durable deployment lifecycle. Saves are local-first: the config row is
  // written and an agent_deployment job enqueued, and the previous deployed
  // version keeps serving calls until a new deployment succeeds. `configVersion`
  // increments on every save and the deployment job carries the version it was
  // created for, so an older save can never overwrite a newer configuration.
  // `deploymentLease` is held by the job currently allowed to publish.
  deploymentStatus: text("deployment_status").notNull().default("draft"),
  deploymentError: text("deployment_error"),
  configVersion: integer("config_version").notNull().default(1),
  deploymentLease: text("deployment_lease"),
  lastDeployedAt: timestamp("last_deployed_at", { withTimezone: true }),
  /**
   * Fingerprint of the exact remote body the last successful deployment
   * published (`deploymentFingerprint`). Recomputed locally on read: a
   * mismatch means the platform moved under a deployed agent (new tools,
   * prompt rules, tuning) and it is owed a redeploy — no server round trip
   * needed to notice. Null = deployed before fingerprints existed: stale.
   */
  deployedFingerprint: text("deployed_fingerprint"),
  /**
   * Wizard placeholder linkage: set when /agents/new creates the list row up
   * front at Generate time, cleared when the reviewed config is saved over
   * it. The list derives the badge from the live job row (never a stored
   * flag), so abandoned placeholders decay to plain drafts on their own.
   */
  generationJobId: text("generation_job_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Non-secret global defaults. These are separate from encrypted credentials so
// they can be returned to the operator UI and bridge without decryption.
export const platformConfiguration = pgTable("platform_configuration", {
  id: text("id").primaryKey().default("default"),
  groqModel: text("groq_model").notNull().default("llama-3.3-70b-versatile"),
  cerebrasModel: text("cerebras_model").notNull().default("llama-3.3-70b"),
  geminiModel: text("gemini_model").notNull().default("gemini-2.0-flash"),
  openrouterModel: text("openrouter_model")
    .notNull()
    .default("meta-llama/llama-3.3-70b-instruct:free"),
  llmProviderOrder: jsonb("llm_provider_order")
    .$type<string[]>()
    .notNull()
    .default(["groq", "cerebras", "gemini", "openrouter"]),
  telnyxConnectionId: text("telnyx_connection_id"),
  telnyxCallerNumber: text("telnyx_caller_number"),
  cartesiaVoiceId: text("cartesia_voice_id"),
  bridgeOrganizationId: text("bridge_organization_id").references(
    () => organization.id,
    { onDelete: "set null" },
  ),
  bridgeAgentId: uuid("bridge_agent_id").references(() => agents.id, {
    onDelete: "set null",
  }),
  updatedBy: text("updated_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Campaign: assignment of work to an agent (Plan Section D)
export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  name: text("name").notNull(),
  leadFilter: jsonb("lead_filter"),
  callingWindow: jsonb("calling_window"), // { start: "09:00", end: "18:00", timezone, daysOfWeek }
  consentPolicy: jsonb("consent_policy"),
  channelFallbackPolicy: jsonb("channel_fallback_policy"), // e.g. no-answer x2 -> whatsapp template
  status: campaignStatusEnum("status").notNull().default("draft"),
  // Dial pacing lives in columns rather than inside `channel_fallback_policy`
  // because the dispatcher's claim query filters on both of them, and a jsonb
  // path lookup in that WHERE clause would be unindexable for no benefit.
  maxAttempts: integer("max_attempts").notNull().default(2),
  retryAfterMinutes: integer("retry_after_minutes").notNull().default(60),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Campaign membership and per-lead dial state (plan Day 7-8).
 *
 * `Campaign.lead_filter` describes *which* leads belong; this table records the
 * concrete work. A filter alone cannot hold attempt counts, backoff, or the
 * outcome of the last try, and the dispatcher needs a row it can claim
 * atomically so two runners never dial the same person at once.
 */
export const campaignLeads = pgTable(
  "campaign_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    status: campaignLeadStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    // Timezone-aware on purpose, unlike the older bookkeeping columns above:
    // these are compared against "now" by a runner that may sit in a different
    // timezone from both the database and the campaign's calling window, and a
    // naive timestamp there is an off-by-hours bug waiting to happen.
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAfter: timestamp("next_attempt_after", { withTimezone: true }),
    lastOutcome: text("last_outcome"), // answered | no_answer | busy | failed | <skip reason>
    lastCallId: uuid("last_call_id").references(() => calls.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Importing the same CSV twice, or re-running an import after adding rows,
    // must not queue a lead for the same campaign a second time — otherwise a
    // re-import silently doubles how many times someone gets phoned.
    uniqueIndex("campaign_leads_campaign_lead_uidx").on(
      table.campaignId,
      table.leadId,
    ),
  ],
);

/**
 * A phone number bound to an agent, so an inbound call can be answered by the
 * right agent instead of the single global bridge default (plan Day 7-8,
 * "inbound number binding").
 *
 * `e164` is globally unique rather than unique per organization: a real phone
 * number exists once in the world, and two workspaces claiming the same DID
 * would make inbound routing ambiguous at the exact moment someone is calling.
 */
export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    e164: text("e164").notNull(),
    label: text("label"),
    // Nullable: a number can be registered before an agent is chosen for it,
    // and clearing the agent should park the number rather than delete it.
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    inboundEnabled: boolean("inbound_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("phone_numbers_e164_uidx").on(table.e164)],
);

// Lead: the person being pursued, canonical identity = phone (Plan Section D/J)
export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  name: text("name"),
  phone: text("phone").notNull(), // canonical identity, E.164 normalized
  whatsappId: text("whatsapp_id"),
  instagramId: text("instagram_id"), // reserved, not used in MVP
  source: text("source"),
  consentStatus: text("consent_status").notNull().default("unknown"), // unknown | granted | revoked
  propertyPreferences: jsonb("property_preferences"),
  pipelineState: text("pipeline_state").notNull().default("new"), // New -> Contacted -> ... -> Completed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Phone is the canonical cross-channel identity (plan Section D/J), and the
  // telephony bridge upserts on it for every inbound call. Without this,
  // two concurrent calls from one number create two Leads and the "same
  // ConversationState across channels" guarantee silently breaks — the exact
  // failure mode Section J says to get right.
  uniqueIndex("leads_org_phone_uidx").on(table.organizationId, table.phone),
]);

// Call: a single phone conversation via the AssemblyAI Voice Agent API
export const calls = pgTable("calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  // Nullable on purpose: the telephony bridge (telephony-bot/server.py) answers
  // inbound calls with an *inline* AssemblyAI agent config, so a call can exist
  // before any stored `agents` row does. Populated once calls are placed from a
  // saved Agent (plan Day 3-4).
  agentId: uuid("agent_id").references(() => agents.id),
  assemblyaiSessionId: text("assemblyai_session_id"),
  // Telnyx's opaque Call Control identifier. Kept server-side so a tool call
  // can transfer the correct live leg without accepting a carrier id from the
  // model or browser.
  telnyxCallControlId: text("telnyx_call_control_id"),
  direction: directionEnum("direction").notNull(),
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  recordingUrl: text("recording_url"), // Cloudflare R2 object key/URL
  transcript: jsonb("transcript"), // structured utterances, not just plain text
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Message: single inbound/outbound event on any non-call channel (Plan Section D/J)
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  // Set for channel="call" turns so the unified timeline (plan Section J) and
  // the /calls/[id] reasoning trace can join turns to their conversation.
  // Null for WhatsApp messages, which have no parent call.
  callId: uuid("call_id").references(() => calls.id),
  channel: channelEnum("channel").notNull(),
  direction: directionEnum("direction").notNull(),
  externalId: text("external_id"), // WhatsApp message id, etc.
  content: text("content"),
  mediaUrl: text("media_url"), // R2 object key for voice notes
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ConversationState: history-tracked structured state per lead (Plan Section D)
export const conversationStates = pgTable("conversation_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  goalStatus: goalStatusEnum("goal_status").notNull().default("active"),
  intent: text("intent"),
  blockers: jsonb("blockers").notNull().default([]),
  state: text("state").notNull(), // pipeline stage snapshot at this point in time
  nextAction: text("next_action"),
  memorySummary: text("memory_summary"), // injected into system_prompt on next call
  sourceCallId: uuid("source_call_id").references(() => calls.id),
  sourceMessageId: uuid("source_message_id").references(() => messages.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ToolCallLog: feeds the reasoning-trace UI (Plan Section E)
export const toolCallLogs = pgTable(
  "tool_call_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    // AssemblyAI's tool.call call_id. It is scoped to the parent call and is
    // the idempotency key for every side-effecting tool.
    externalCallId: text("external_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments"),
    result: jsonb("result"),
    isError: boolean("is_error").notNull().default(false),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tool_call_logs_call_external_uidx").on(
      table.callId,
      table.externalCallId,
    ),
  ],
);

// Property: seed data for the real estate launch template
export const properties = pgTable(
  "properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    location: text("location").notNull(),
    price: integer("price"),
    currency: text("currency").notNull().default("AED"),
    type: text("type"), // apartment | villa | townhouse ...
    bedrooms: integer("bedrooms"),
    amenities: jsonb("amenities").notNull().default([]),
    // { timezone: "Asia/Dubai", weekly: { sunday: [{start,end}], ... } }
    availability: jsonb("availability").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("properties_org_reference_uidx").on(
      table.organizationId,
      table.reference,
    ),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id),
    propertyId: uuid("property_id").references(() => properties.id),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    status: text("status").notNull().default("proposed"), // proposed | confirmed | completed | cancelled
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Bookings start on the hour, so this partial unique index is also the
    // concurrency guard: two callers racing for the same active slot cannot
    // both insert. Cancelled/completed history does not block a new booking.
    uniqueIndex("appointments_property_slot_active_uidx")
      .on(table.propertyId, table.scheduledAt)
      .where(sql`${table.status} in ('proposed', 'confirmed')`),
  ],
);

export const followUps = pgTable("follow_ups", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  channel: text("channel").notNull(), // phone | whatsapp
  note: text("note"),
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Public demo support (landing-page live call)
// ---------------------------------------------------------------------------

/**
 * AssemblyAI stored agents backing the public demo, one per persona+voice.
 *
 * The public demo MUST bind to a stored `agent_id` rather than sending a
 * `system_prompt` inline, because inline configuration means the *browser*
 * chooses what the model does — which on an unauthenticated endpoint is free
 * LLM access on our account to anyone who finds it. Binding to a stored agent
 * makes the prompt server-owned and the caller's only input their voice.
 *
 * Rows are created lazily on first request for a combination and cached here,
 * so we never re-create an agent AssemblyAI already has.
 */
export const demoAgents = pgTable(
  "demo_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personaId: text("persona_id").notNull(),
    voiceId: text("voice_id").notNull(),
    assemblyaiAgentId: text("assemblyai_agent_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /**
     * Fingerprint of the exact remote body published (`demoAgentFingerprint`).
     * Recomputed on every token request: a mismatch PUT-updates the cached
     * demo agent in place, so platform upgrades propagate without wiping
     * rows. Null = provisioned before fingerprints existed: refresh once.
     */
    fingerprint: text("fingerprint"),
  },
  (table) => [
    uniqueIndex("demo_agents_persona_voice_uidx").on(
      table.personaId,
      table.voiceId,
    ),
  ],
);

/**
 * Demo Test tags (docs/adr/0004-test-tag-email-matching.md): the word + two
 * digits a visitor puts in their email's subject so Voni finds it in the
 * shared test inbox. A tag lives a day; tags are unique among live ones
 * (enforced at issue time, test-tag-registry.ts). The match columns record
 * which email carried it, and `linkedTagId` points at an earlier tag the
 * same sender matched (a returning visitor on another device).
 */
export const demoTestTags = pgTable(
  "demo_test_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tag: text("tag").notNull(),
    language: text("language").notNull(),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    matchedFrom: text("matched_from"),
    matchedMessageId: text("matched_message_id"),
    matchedThreadId: text("matched_thread_id"),
    matchedAt: timestamp("matched_at"),
    linkedTagId: uuid("linked_tag_id"),
  },
  (table) => [
    index("demo_test_tags_expires_idx").on(table.expiresAt),
    index("demo_test_tags_matched_from_idx").on(table.matchedFrom),
  ],
);

/**
 * One public demo call (keyed by its call token's id), recorded at token
 * mint: its language, and the code check's state (ticket 04). The code
 * itself is derived from the call id and the server key (code-check.ts),
 * never stored.
 *
 * ponytail: no expiry or sweep; bounded by the demo's daily call cap (~60
 * rows/day). Add a cleanup when 06's Prospect record takes over what's kept.
 */
export const demoCalls = pgTable("demo_calls", {
  callId: text("call_id").primaryKey(),
  tagId: uuid("tag_id"),
  language: text("language").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  /** Set when the reply's send starts (the once-per-call claim), cleared if it fails. */
  replyStartedAt: timestamp("reply_started_at"),
  replyMessageId: text("reply_message_id"),
  codeAttempts: integer("code_attempts").notNull().default(0),
  codeVerifiedAt: timestamp("code_verified_at"),
});

/**
 * Counter buckets for rate limiting, keyed by an opaque bucket string
 * (e.g. "demo:ip:<hash>:2026-09-05T14" or "demo:global:2026-09-05").
 *
 * Postgres rather than memory on purpose: the deploy target is Cloudflare
 * Workers, where each request may hit a different isolate, so an in-process
 * counter enforces nothing. One upsert per token request is affordable —
 * tokens are minted once per call, not per audio frame.
 */
export const rateLimits = pgTable("rate_limits", {
  bucket: text("bucket").primaryKey(),
  count: integer("count").notNull().default(0),
  /** Rows past this are dead and can be swept; also what makes reuse safe. */
  expiresAt: timestamp("expires_at").notNull(),
});

// ---------------------------------------------------------------------------
// Durable background jobs (responsive async work protocol)
// ---------------------------------------------------------------------------

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Durable record for any non-interactive operation that may exceed ~3 seconds
 * (agent generation, agent deployment, connection tests, CSV imports).
 *
 * Postgres is the source of truth; Cloudflare Queues carry only
 * `{ jobId, kind }` so messages stay far below the 128 KB limit. Queue
 * delivery is at-least-once, so claiming is a conditional
 * `queued -> running` update and duplicate deliveries are ignored safely.
 *
 * Visibility is creator-scoped: every read filters on both
 * `organization_id` and `creator_id` unless a feature explicitly needs
 * workspace coordination.
 *
 * `input`/`result` hold validated JSON only — never API keys, authorization
 * headers, encrypted reasoning content, provider response bodies, or CSV
 * contents. Failures store a sanitized `error_code`/`error_message` pair.
 */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    creatorId: text("creator_id").notNull(),
    kind: text("kind").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    title: text("title").notNull(),
    targetUrl: text("target_url"),
    idempotencyKey: text("idempotency_key").notNull(),
    relatedId: text("related_id"),
    input: jsonb("input").notNull().default({}),
    result: jsonb("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    stage: text("stage"),
    progressTotal: integer("progress_total"),
    progressDone: integer("progress_done"),
    attemptCount: integer("attempt_count").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Client-generated idempotency keys: submitting the same work twice
    // (double click, retry, reconnect) returns the existing job instead of
    // starting a duplicate.
    uniqueIndex("background_jobs_org_creator_key_uidx").on(
      table.organizationId,
      table.creatorId,
      table.idempotencyKey,
    ),
    index("background_jobs_creator_status_idx").on(
      table.organizationId,
      table.creatorId,
      table.status,
      table.createdAt,
    ),
  ],
);

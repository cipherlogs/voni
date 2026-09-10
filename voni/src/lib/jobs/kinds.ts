import { recordSearchInputSchema, recordSearchResultSchema } from "@/lib/copilot/record-contracts";
import { z } from "zod";
import { agentConfigSchema } from "@/lib/agents/config";
import { wizardDraftSchema } from "@/lib/agents/wizard";

/**
 * Typed contracts for every durable job kind.
 *
 * `input` is validated when a job is created; `result` is validated before a
 * job is marked succeeded. Both are stored as JSON in Postgres, while queue
 * messages carry only `{ jobId, kind }` so they stay far below Cloudflare's
 * 128 KB message limit.
 */

export const JOB_KINDS = [
  "agent_generation",
  "agent_deployment",
  "integration_test",
  "lead_csv_import",
  "record_search",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export const jobKindSchema = z.enum(JOB_KINDS);

export const agentGenerationInputSchema = z.object({
  brief: z.string().trim().min(10).max(4000),
  /** Structured wizard draft. Optional so brief-only jobs stay valid. */
  wizardDraft: wizardDraftSchema.optional(),
});

export const agentGenerationResultSchema = z.object({
  config: agentConfigSchema,
  provider: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  /** Echo of the validated submitted snapshot, when the job was wizard-driven. */
  wizardDraft: wizardDraftSchema.optional(),
});

export const agentDeploymentInputSchema = z.object({
  agentId: z.string().uuid(),
  /** The agents.config_version this job was created for. */
  configVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(120),
  config: agentConfigSchema,
});

export const agentDeploymentResultSchema = z.object({
  agentId: z.string().uuid(),
  remoteAgentId: z.string(),
  deployedAt: z.string(),
});

export const integrationServiceSchema = z.enum([
  "groq",
  "cerebras",
  "gemini",
  "openrouter",
  "assemblyai",
  "telnyx",
  "cartesia",
]);

export type IntegrationTestService = z.infer<typeof integrationServiceSchema>;

export const integrationTestInputSchema = z.object({
  service: integrationServiceSchema,
  /** LLM providers test one specific operator account. */
  accountId: z.string().uuid().optional(),
});

export const integrationTestResultSchema = z.object({
  service: integrationServiceSchema,
  status: z.enum(["passed", "failed"]),
  latencyMs: z.number(),
  error: z.string().nullable(),
  testedAt: z.string(),
});

export const leadCsvImportInputSchema = z
  .object({
    campaignId: z.string().uuid(),
    fileName: z.string().max(255).optional(),
    /** Production path: CSV bytes staged in R2 by the upload route. */
    r2Key: z.string().max(512).optional(),
    /** Dev fallback when no R2 binding exists (still capped at 2 MB). */
    csvText: z.string().max(2_000_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.r2Key && !value.csvText) {
      ctx.addIssue({
        code: "custom",
        message: "Either r2Key or csvText is required.",
      });
    }
  });

export const leadCsvImportResultSchema = z.object({
  campaignId: z.string().uuid(),
  imported: z.number(),
  queued: z.number(),
  alreadyInCampaign: z.number(),
  duplicatesInFile: z.number(),
  rejected: z
    .array(z.object({ line: z.number(), message: z.string() }))
    .max(20),
});

export const JOB_INPUT_SCHEMAS = {
  record_search: recordSearchInputSchema,
  agent_generation: agentGenerationInputSchema,
  agent_deployment: agentDeploymentInputSchema,
  integration_test: integrationTestInputSchema,
  lead_csv_import: leadCsvImportInputSchema,
} as const;

export const JOB_RESULT_SCHEMAS = {
  record_search: recordSearchResultSchema,
  agent_generation: agentGenerationResultSchema,
  agent_deployment: agentDeploymentResultSchema,
  integration_test: integrationTestResultSchema,
  lead_csv_import: leadCsvImportResultSchema,
} as const;

export type JobInput<K extends JobKind = JobKind> = z.infer<
  (typeof JOB_INPUT_SCHEMAS)[K]
>;

export type JobResult<K extends JobKind = JobKind> = z.infer<
  (typeof JOB_RESULT_SCHEMAS)[K]
>;

/** Where the job center sends the user for a finished job of each kind. */
export function targetUrlFor(
  kind: JobKind,
  jobId: string,
  input: JobInput,
): string {
  switch (kind) {
    case "record_search":
      return `/jobs?search=${jobId}`;
    case "agent_generation":
      return `/agents/new?job=${jobId}`;
    case "agent_deployment":
      return `/agents/${(input as { agentId: string }).agentId}`;
    case "integration_test":
      return "/operator";
    case "lead_csv_import":
      return `/campaigns/${(input as { campaignId: string }).campaignId}`;
  }
}

/** Stable error codes stored on failed jobs (sanitized, user-safe). */
export const JOB_ERROR_CODES = [
  "invalid-input",
  "cancelled",
  "provider-exhausted",
  "provider-failure",
  "transport",
  "timeout",
  "rate-limited",
  "auth",
  "conflict",
  "not-found",
  "stale-version",
  "lease-exhausted",
  "unknown",
] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

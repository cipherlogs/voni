import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  JOB_INPUT_SCHEMAS,
  JOB_RESULT_SCHEMAS,
  jobKindSchema,
  targetUrlFor,
} from "./kinds";
import { isTransientJobError } from "./processor";
import { sanitizeJobError } from "./store";
import { NoProviderAvailableError } from "@/lib/llm";
import { REAL_ESTATE_TEMPLATE } from "@/lib/agents/config";
import { deploymentFingerprint } from "@/lib/agents/provision";

test("job kinds accept exactly the four known kinds", () => {
  assert.ok(jobKindSchema.safeParse("agent_generation").success);
  assert.ok(jobKindSchema.safeParse("agent_deployment").success);
  assert.ok(jobKindSchema.safeParse("integration_test").success);
  assert.ok(jobKindSchema.safeParse("lead_csv_import").success);
  assert.ok(!jobKindSchema.safeParse("campaign_dispatch").success);
});

test("generation input requires a real brief", () => {
  const schema = JOB_INPUT_SCHEMAS.agent_generation;
  assert.ok(schema.safeParse({ brief: "Call new property leads nightly." }).success);
  assert.ok(!schema.safeParse({ brief: "short" }).success);
  assert.ok(!schema.safeParse({}).success);
});

test("deployment input requires agent, version, name, and config", () => {
  const schema = JOB_INPUT_SCHEMAS.agent_deployment;
  assert.ok(!schema.safeParse({}).success);
  assert.ok(
    !schema.safeParse({
      agentId: crypto.randomUUID(),
      configVersion: 2,
      name: "Layla",
      config: {},
    }).success,
  );
});

test("CSV import input requires a staged source", () => {
  const schema = JOB_INPUT_SCHEMAS.lead_csv_import;
  assert.ok(
    schema.safeParse({ campaignId: crypto.randomUUID(), r2Key: "org/job/file.csv" }).success,
  );
  assert.ok(
    schema.safeParse({ campaignId: crypto.randomUUID(), csvText: "phone\n+9715" }).success,
  );
  assert.ok(!schema.safeParse({ campaignId: crypto.randomUUID() }).success);
  assert.ok(!schema.safeParse({ campaignId: "not-a-uuid", r2Key: "k" }).success);
});

test("integration test results keep failed checks as data, not errors", () => {
  const parsed = JOB_RESULT_SCHEMAS.integration_test.safeParse({
    service: "telnyx",
    status: "failed",
    latencyMs: 120,
    error: "The service could not be reached.",
    testedAt: new Date().toISOString(),
  });
  assert.ok(parsed.success);
});

test("target URLs route each kind to its result destination", () => {
  const agentId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  // Generation pre-placeholder fallback: start.ts keeps the ?job= URL until
  // completion resolves the placeholder detail URL (step 5); processor.ts
  // keeps it when no placeholder row exists (older jobs, failed write).
  assert.equal(
    targetUrlFor("agent_generation", "job-1", { brief: "x".repeat(10) }),
    "/agents/new?job=job-1",
  );
  assert.equal(
    targetUrlFor("agent_deployment", "job-2", {
      agentId,
      configVersion: 1,
      name: "Layla",
      config: {},
    } as never),
    `/agents/${agentId}`,
  );
  assert.equal(
    targetUrlFor("integration_test", "job-3", { service: "groq" }),
    "/operator",
  );
  assert.equal(
    targetUrlFor("lead_csv_import", "job-4", { campaignId }),
    `/campaigns/${campaignId}`,
  );
});

test("finished generation jobs land on the placeholder detail page", () => {
  // Step 5 destination: once the placeholder row exists (created client-side
  // after start), start.ts stores `/agents/<placeholderId>` and processor.ts
  // rewrites it again at completion; without a row the ?job= fallback stays.
  const kindsSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "kinds.ts"),
    "utf8",
  );
  const startSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "start.ts"),
    "utf8",
  );
  const processorSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "processor.ts"),
    "utf8",
  );
  const storeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "store.ts"),
    "utf8",
  );
  // kinds.ts still computes the pre-placeholder ?job= fallback URL.
  assert.ok(kindsSource.includes("`/agents/new?job=${jobId}`"));
  // start.ts resolves the placeholder to its detail URL at creation time.
  assert.ok(startSource.includes("findGenerationPlaceholderId"));
  assert.ok(startSource.includes("targetUrl = `/agents/${placeholderId}`"));
  // processor.ts rewrites the target again at completion for the landed row.
  assert.ok(processorSource.includes("findGenerationPlaceholderId"));
  assert.ok(processorSource.includes("targetUrl = `/agents/${placeholderId}`"));
  assert.ok(processorSource.includes("completeJob(jobId, result, database, targetUrl)"));
  // The lookup is org-scoped on the generation job id.
  assert.ok(storeSource.includes("eq(agents.generationJobId, jobId)"));
});

test("failed generation jobs route back through the wizard, not the placeholder detail", () => {
  // Misdirection fix: when generation fails after a placeholder exists, the
  // targetUrl set at start time points at /agents/<placeholderId>, whose
  // did-not-finish banner cannot show the error or retry. failJob rewrites it
  // to the ?job= restore URL so the job center, toasts, and pills land on the
  // wizard error path (message, guidance, step jump, retry).
  const storeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "store.ts"),
    "utf8",
  );
  const processorSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "processor.ts"),
    "utf8",
  );
  // One choke point in failJob covers the processor's permanent/invalid-input
  // failures and the sweep's lease-exhausted path — callers pass no targetUrl.
  assert.ok(storeSource.includes("`/agents/new?job=${id}`"));
  assert.ok(!processorSource.includes("failJob(jobId, code, sanitizeJobError(error), database,"));
  // Non-generation failures keep their existing targetUrl (no blanket rewrite).
  assert.ok(storeSource.includes('job?.kind === "agent_generation"'));
});

test("terminal generation rows never replay on the same idempotency key", () => {
  // Goal 6 idempotency rule: the stable generation:<djb2> key dedupes
  // queued/running resubmits via createJob, but a key that maps to a TERMINAL
  // (succeeded/failed/cancelled) row must not replay that dead row — a retry
  // is new work that starts clean. start.ts swaps in a fresh random key and
  // falls through to a new submission.
  const startSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "start.ts"),
    "utf8",
  );
  assert.ok(startSource.includes("getJobByIdempotencyKey"));
  assert.ok(startSource.includes('prior.status === "succeeded"'));
  assert.ok(startSource.includes('prior.status === "failed"'));
  assert.ok(startSource.includes('prior.status === "cancelled"'));
  assert.ok(startSource.includes("idempotencyKey: crypto.randomUUID()"));
  // Guard placement: only after the active-job dedupe (mid-flight resubmits
  // still return the running job), and scoped to agent_generation — other
  // kinds keep their existing dedupe behavior.
  const genBlock = startSource.slice(startSource.indexOf('kind === "agent_generation"'));
  assert.ok(genBlock.indexOf("findActiveJobs") < genBlock.indexOf("getJobByIdempotencyKey"));
});

test("sanitizeJobError redacts secrets and truncates", () => {
  const dirty =
    "fetch failed for Bearer abc123 with api_key=sk-live-xyz " +
    `and reasoning.encrypted_content="abcdef" ` +
    "x".repeat(600);
  const clean = sanitizeJobError(new Error(dirty));
  assert.ok(!clean.includes("abc123"));
  assert.ok(!clean.includes("sk-live-xyz"));
  assert.ok(!clean.includes("abcdef"));
  assert.ok(clean.includes("[redacted]"));
  assert.ok(clean.length <= 500);
});

test("sanitizeJobError keeps ordinary messages readable", () => {
  assert.equal(sanitizeJobError(new Error("Campaign not found.")), "Campaign not found.");
  assert.equal(sanitizeJobError("plain string"), "plain string");
});

test("transient errors are retried, permanent ones are not", () => {
  for (const message of [
    "fetch failed",
    "The request timed out.",
    "HTTP 429 Too Many Requests",
    "Service returned HTTP 503.",
    "getaddrinfo EAI_AGAIN api.meta.ai",
    "socket hang up",
  ]) {
    assert.ok(isTransientJobError(new Error(message)), message);
  }
  for (const message of [
    "HTTP 401 Unauthorized",
    "Service returned HTTP 404.",
    "returned JSON that failed validation (mission)",
    "No LLM provider is configured.",
    "Campaign not found.",
    "The service could not be reached.",
  ]) {
    assert.ok(!isTransientJobError(new Error(message)), message);
  }
  assert.ok(!isTransientJobError(new z.ZodError([])));
  assert.ok(
    !isTransientJobError(
      new NoProviderAvailableError(
        [{ provider: "Groq (Primary)", error: "HTTP 429" }],
        [],
      ),
    ),
  );
});

test("deployment fingerprints are deterministic and configuration-sensitive", () => {
  const first = deploymentFingerprint("Layla", REAL_ESTATE_TEMPLATE);
  const repeated = deploymentFingerprint("Layla", { ...REAL_ESTATE_TEMPLATE });
  const changed = deploymentFingerprint("Layla", {
    ...REAL_ESTATE_TEMPLATE,
    greeting: "Welcome to Voni.",
  });
  assert.equal(first, repeated);
  assert.notEqual(first, changed);
  assert.match(first, /^[0-9a-f]{64}$/);
});

import assert from "node:assert/strict";
import test from "node:test";
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

test("generation input accepts the draft-first agent id", () => {
  const schema = JOB_INPUT_SCHEMAS.agent_generation;
  assert.ok(schema.safeParse({ brief: "Call new property leads nightly." }).success);
  assert.ok(
    schema.safeParse({ brief: "Call new property leads nightly.", agentId: crypto.randomUUID() }).success,
  );
  assert.ok(!schema.safeParse({ brief: "Call new property leads nightly.", agentId: "nope" }).success);
});

test("target URLs route each kind to its result destination", () => {
  const agentId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  // Legacy brief-only jobs still restore on /agents/new.
  assert.equal(
    targetUrlFor("agent_generation", "job-1", { brief: "x".repeat(10) }),
    "/agents/new?job=job-1",
  );
  // Draft-first jobs land on the draft they belong to.
  assert.equal(
    targetUrlFor("agent_generation", "job-9", { brief: "x".repeat(10), agentId }),
    `/agents/${agentId}?job=job-9`,
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toEditAgentProps } from "@/lib/agents/detail-props";

// Ticket 06, seam: the AgentDetail server-to-client boundary
// (agents/[id]/page.tsx -> client EditAgent). Catches: oversized props —
// the projector returns exactly the fields the editor renders, so a future
// column can never leak across silently. Misses: wire bytes (runtime check).
// Behavioral: the projector is pure, so same-data/smaller-payload is asserted
// on real values; the page wiring and DB projection are asserted on source.
const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(here, "[id]", "page.tsx"), "utf8");
const actionsSource = readFileSync(join(here, "actions.ts"), "utf8");

const input = {
  id: "agent-1",
  name: "Greeter",
  config: { mission: "Say hi" },
  deploymentStatus: "draft",
  deploymentError: null,
  assemblyaiAgentId: null,
  generationJobId: "job-9",
  generationStatus: "running",
  generationError: null,
  isBridgeAgent: false,
  phoneReady: true,
  whatsappReady: null,
  initialDeploymentAttention: false,
} as Parameters<typeof toEditAgentProps>[0];

test("projector passes the same data the editor renders", () => {
  assert.deepEqual(toEditAgentProps(input), {
    id: "agent-1",
    name: "Greeter",
    config: { mission: "Say hi" },
    initialDeploymentAttention: false,
    deploymentStatus: "draft",
    deploymentError: null,
    assemblyaiAgentId: null,
    generationJobId: "job-9",
    generationStatus: "running",
    generationError: null,
    isGenerationStub: true,
    isBridgeAgent: false,
    phoneReady: true,
    whatsappReady: null,
  });
});

test("projector derives the generation-stub flag like the page did", () => {
  assert.equal(
    toEditAgentProps({ ...input, deploymentStatus: "ready", generationJobId: null })
      .isGenerationStub,
    false,
  );
  assert.equal(
    toEditAgentProps({ ...input, deploymentStatus: "draft", generationJobId: null })
      .isGenerationStub,
    false,
  );
});

test("projector carries only used fields — no row extras cross", () => {
  const withExtras = {
    ...input,
    organizationId: "org-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    configVersion: 3,
  } as Parameters<typeof toEditAgentProps>[0];
  assert.deepEqual(Object.keys(toEditAgentProps(withExtras)).sort(), [
    "assemblyaiAgentId",
    "config",
    "deploymentError",
    "deploymentStatus",
    "generationError",
    "generationJobId",
    "generationStatus",
    "id",
    "initialDeploymentAttention",
    "isBridgeAgent",
    "isGenerationStub",
    "name",
    "phoneReady",
    "whatsappReady",
  ]);
});

test("page renders through the projector and keeps the same data", () => {
  assert.ok(
    pageSource.includes("toEditAgentProps"),
    "AgentDetail projects through toEditAgentProps",
  );
  // Same data: config still parses + normalizes, brief still carries the
  // version, attention still comes from the query.
  assert.ok(pageSource.includes("agentConfigSchema.safeParse"));
  assert.ok(pageSource.includes("normalizeConfig"));
  assert.ok(pageSource.includes("configVersion"));
  assert.ok(pageSource.includes('query.deployment === "attention"'));
});

test("getAgent selects only the columns the detail renders", () => {
  const fn = actionsSource.slice(actionsSource.indexOf("export async function getAgent("));
  const body = fn.slice(0, fn.indexOf("export async function getAgentWithGeneration"));
  assert.ok(!body.includes(".select()"), "no full-row select in getAgent");
  for (const column of [
    "agents.id",
    "agents.name",
    "agents.config",
    "agents.deploymentStatus",
    "agents.deploymentError",
    "agents.assemblyaiAgentId",
    "agents.generationJobId",
    "agents.configVersion",
  ]) {
    assert.ok(body.includes(column), `getAgent selects ${column}`);
  }
});

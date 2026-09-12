import assert from "node:assert/strict";
import { REAL_ESTATE_TEMPLATE } from "../src/lib/agents/config";
import { provisionAgent } from "../src/lib/agents/provision";

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is required.");

let remoteId: string | null = null;
try {
  const created = await provisionAgent(
    `voni-verification-${Date.now()}`,
    REAL_ESTATE_TEMPLATE,
  );
  if (!created.ok) throw new Error(created.error);
  assert.equal(created.ok, true);
  remoteId = created.agentId;

  const updated = await provisionAgent(
    `voni-verification-updated-${Date.now()}`,
    REAL_ESTATE_TEMPLATE,
    remoteId,
  );
  if (!updated.ok) throw new Error(updated.error);
  assert.equal(updated.agentId, remoteId);

  const response = await fetch(
    `https://agents.assemblyai.com/v1/agents/${encodeURIComponent(remoteId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(response.ok, true);
  const agent = (await response.json()) as {
    tools: Array<{ name: string; execution_mode: string }>;
    input?: {
      format?: { encoding?: string; sample_rate?: number };
      transcription_mode?: string;
      turn_detection?: { min_silence?: number; max_silence?: number };
    };
    output?: { format?: { encoding?: string } };
    system_prompt: string;
  };
  const tools = agent.tools;
  assert.deepEqual(tools.map((tool) => tool.name), [...REAL_ESTATE_TEMPLATE.tools]);
  assert.equal(tools.length, 8);
  assert.equal(
    tools.find((tool) => tool.name === "search_properties")?.execution_mode,
    "interactive",
  );
  assert.equal(
    tools.find((tool) => tool.name === "book_viewing")?.execution_mode,
    "hold",
  );
  assert.equal(agent.input?.format?.encoding, "audio/pcmu");
  assert.equal(agent.input?.format?.sample_rate, 8000);
  assert.equal(agent.input?.transcription_mode, "min_latency");
  assert.equal(agent.input?.turn_detection?.min_silence, 100);
  assert.equal(agent.input?.turn_detection?.max_silence, 500);
  assert.equal(agent.output?.format?.encoding, "audio/pcmu");
  console.log(
    JSON.stringify({
      storedAgent: "created, updated, and read back",
      businessTools: 8,
      input: "PCMU 8000 Hz min_latency",
      output: "PCMU 8000 Hz",
    }),
  );
} finally {
  if (remoteId) {
    const deleted = await fetch(
      `https://agents.assemblyai.com/v1/agents/${encodeURIComponent(remoteId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`Could not remove verification agent: ${deleted.status}`);
    }
  }
}

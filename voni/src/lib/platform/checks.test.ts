import assert from "node:assert/strict";
import test from "node:test";
import { probeIntegration, type IntegrationService } from "./checks";
import { DEFAULT_PLATFORM_CONFIG } from "./types";

const config = {
  ...DEFAULT_PLATFORM_CONFIG,
  telnyxConnectionId: "connection/with spaces",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("all LLM checks make a minimal authenticated completion and validate its shape", async () => {
  for (const service of ["groq", "cerebras", "gemini", "openrouter"] as IntegrationService[]) {
    let request: { url: string; init?: RequestInit } | undefined;
    await probeIntegration(service, "provider-secret", config, async (input, init) => {
      request = { url: String(input), init };
      return json({ choices: [{ message: { content: "OK" } }] });
    });
    assert.match(request!.url, /chat\/completions$/);
    assert.equal((request!.init!.headers as Record<string, string>).Authorization, "Bearer provider-secret");
    const payload = JSON.parse(String(request!.init!.body));
    assert.equal(payload.max_tokens, 4);
    assert.equal(typeof payload.model, "string");
  }
});

test("AssemblyAI uses the documented authenticated stored-agent list endpoint", async () => {
  await probeIntegration("assemblyai", "aai-secret", config, async (input, init) => {
    assert.equal(String(input), "https://agents.assemblyai.com/v1/agents");
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer aai-secret");
    return json({ items: [] });
  });
});

test("Telnyx validates balance and the configured Call Control application without a call", async () => {
  const requests: string[] = [];
  await probeIntegration("telnyx", "telnyx-secret", config, async (input, init) => {
    requests.push(String(input));
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer telnyx-secret");
    return requests.length === 1 ? json({ data: { balance: "1" } }) : json({ data: { id: "app" } });
  });
  assert.deepEqual(requests, [
    "https://api.telnyx.com/v2/balance",
    "https://api.telnyx.com/v2/call_control_applications/connection%2Fwith%20spaces",
  ]);
});

test("Cartesia lists one voice with its API version header", async () => {
  await probeIntegration("cartesia", "cartesia-secret", config, async (input, init) => {
    assert.equal(String(input), "https://api.cartesia.ai/voices?limit=1");
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], "cartesia-secret");
    assert.equal(headers["Cartesia-Version"], "2025-04-16");
    return json({ data: [] });
  });
});

test("provider probes reject malformed bodies and HTTP failures", async () => {
  await assert.rejects(
    probeIntegration("assemblyai", "key", config, async () => json({ agents: [] })),
    /unexpected response/,
  );
  await assert.rejects(
    probeIntegration("cartesia", "key", config, async () => json({}, 401)),
    /HTTP 401/,
  );
});

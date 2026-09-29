import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { __llmTest, NoProviderAvailableError } from "./index";
import { META_PROVIDER, type Provider } from "./providers";
import type { UsableLlmAccount } from "@/lib/platform/llm-accounts";

const schema = z.object({ answer: z.string() });
const options = {
  system: "Return JSON.",
  user: "Give me an answer.",
  maxTokens: 200_000,
  timeoutMs: 5_000,
};

const freeProvider: Provider = {
  id: "groq",
  label: "Groq",
  baseUrl: "https://free.example/v1",
  model: "free-model",
  supportsJsonMode: true,
};

const freeAccount: UsableLlmAccount = {
  id: "account-1",
  providerId: "groq",
  label: "Primary",
  value: "free-secret",
};

function metaResponse(text: string): Response {
  return Response.json({
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: "completed",
    model: META_PROVIDER.model,
    output: [
      {
        id: "msg_test",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

function freeResponse(answer: string): Response {
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ answer }) } }],
  });
}

function testDependencies({
  metaKey,
  fetch,
  providers = [freeProvider],
  accounts = [freeAccount],
  warnings = [],
  successes = [],
  failures = [],
}: {
  metaKey?: string;
  fetch: typeof globalThis.fetch;
  providers?: Provider[];
  accounts?: UsableLlmAccount[];
  warnings?: string[];
  successes?: string[];
  failures?: { id: string; reason: string }[];
}) {
  let now = 100;
  return {
    metaApiKey: async () => metaKey,
    providerChain: async () => providers,
    usableAccounts: async () => accounts,
    markAccountSuccess: async (id: string) => {
      successes.push(id);
    },
    markAccountFailure: async (id: string, reason: string) => {
      failures.push({ id, reason });
    },
    fetch,
    now: () => {
      now += 7;
      return now;
    },
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

test("Meta descriptor records the fixed premium model contract", () => {
  assert.deepEqual(META_PROVIDER, {
    id: "meta",
    label: "Meta Model API",
    baseUrl: "https://api.meta.ai/v1",
    model: "muse-spark-1.3-contributor",
    contextLimit: 1_048_576,
    outputLimit: 131_072,
    input: ["text", "image", "pdf", "video"],
    output: ["text"],
    reasoning: {
      enabled: true,
      effort: "high",
      summary: "auto",
      include: ["reasoning.encrypted_content"],
    },
  });
});

test("Meta uses the Responses endpoint, capped output, and reasoning options", async () => {
  const apiKey = "meta-test-secret";
  let request: { url: string; headers: Headers; body: unknown } | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
    return metaResponse('{"answer":"meta"}');
  };

  const result = await __llmTest.generateJSONWithDependencies(
    schema,
    options,
    testDependencies({ metaKey: apiKey, fetch }),
  );

  assert.equal(request?.url, "https://api.meta.ai/v1/responses");
  assert.equal(request?.headers.get("authorization"), `Bearer ${apiKey}`);
  assert.deepEqual(request?.body, {
    model: META_PROVIDER.model,
    input: [
      { role: "developer", content: options.system },
      {
        role: "user",
        content: [{ type: "input_text", text: options.user }],
      },
    ],
    max_output_tokens: META_PROVIDER.outputLimit,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high", summary: "auto" },
  });
  assert.deepEqual(result, {
    data: { answer: "meta" },
    provider: "Meta Model API",
    model: META_PROVIDER.model,
    latencyMs: 7,
  });
});

test("a missing Meta key skips Meta without recording a failure", async () => {
  const warnings: string[] = [];
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(String(input));
    return freeResponse("free");
  };

  const result = await __llmTest.generateJSONWithDependencies(
    schema,
    options,
    testDependencies({ fetch, warnings }),
  );

  assert.deepEqual(urls, ["https://free.example/v1/chat/completions"]);
  assert.deepEqual(warnings, []);
  assert.equal(result.provider, "Groq (Primary)");
  assert.deepEqual(result.data, { answer: "free" });
});

test("a Meta transport failure falls through to a free account", async () => {
  const warnings: string[] = [];
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/responses")) throw new Error("Meta is unavailable");
    return freeResponse("fallback");
  };

  const result = await __llmTest.generateJSONWithDependencies(
    schema,
    options,
    testDependencies({ metaKey: "meta-secret", fetch, warnings }),
  );

  assert.deepEqual(urls, [
    "https://api.meta.ai/v1/responses",
    "https://free.example/v1/chat/completions",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Meta Model API failed/);
  assert.equal(result.provider, "Groq (Primary)");
  assert.deepEqual(result.data, { answer: "fallback" });
});

test("Meta JSON that fails the schema falls through to a free account", async () => {
  const warnings: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) =>
    String(input).endsWith("/responses")
      ? metaResponse('{"answer":42}')
      : freeResponse("valid");

  const result = await __llmTest.generateJSONWithDependencies(
    schema,
    options,
    testDependencies({ metaKey: "meta-secret", fetch, warnings }),
  );

  assert.match(warnings[0], /returned JSON that failed validation \(answer\)/);
  assert.equal(result.provider, "Groq (Primary)");
  assert.deepEqual(result.data, { answer: "valid" });
});

test("a caller can lower Meta's reasoning effort for one request", async () => {
  let body: { reasoning?: { effort?: string } } | undefined;
  const fetch: typeof globalThis.fetch = async (_, init) => {
    body = JSON.parse(String(init?.body));
    return metaResponse('{"answer":"meta"}');
  };
  await __llmTest.generateJSONWithDependencies(schema, { ...options, metaEffort: "low" }, testDependencies({ metaKey: "k", fetch }));
  assert.equal(body?.reasoning?.effort, "low");
});

test("Meta failures redact the API key and encrypted reasoning content", async () => {
  const apiKey = "meta-key-that-must-not-leak";
  const encrypted = "opaque-reasoning-that-must-not-leak";
  const warnings: string[] = [];
  const fetch: typeof globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          message: `rejected ${apiKey}; "encrypted_content":"${encrypted}"`,
          type: "invalid_request_error",
          code: "bad_request",
        },
      },
      { status: 400 },
    );

  await assert.rejects(
    __llmTest.generateJSONWithDependencies(
      schema,
      options,
      testDependencies({
        metaKey: apiKey,
        fetch,
        providers: [],
        accounts: [],
        warnings,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof NoProviderAvailableError);
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      assert.doesNotMatch(error.message, new RegExp(encrypted));
      assert.match(error.message, /"encrypted_content":\[redacted\]/);
      return true;
    },
  );
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], new RegExp(apiKey));
  assert.doesNotMatch(warnings[0], new RegExp(encrypted));
});

function metaExhaustedResponse(): Response {
  return Response.json({
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    model: META_PROVIDER.model,
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 0,
      total_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 16384 },
    },
  });
}

test("Meta reasoning-budget exhaustion reports specifically, not generic no-text", async () => {
  const warnings: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) =>
    String(input).endsWith("/responses")
      ? metaExhaustedResponse()
      : freeResponse("valid");

  const result = await __llmTest.generateJSONWithDependencies(
    schema,
    { ...options, maxTokens: 2048, metaMaxTokens: 16384 },
    testDependencies({ metaKey: "meta-secret", fetch, warnings }),
  );

  assert.match(warnings[0], /reasoning budget/);
  assert.doesNotMatch(warnings[0], /no text content/);
  assert.equal(result.provider, "Groq (Primary)");
});

test("metaMaxTokens widens only the Meta request, not free providers", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return String(input).endsWith("/responses")
      ? metaExhaustedResponse()
      : freeResponse("valid");
  };

  await __llmTest.generateJSONWithDependencies(
    schema,
    { ...options, maxTokens: 2048, metaMaxTokens: 16384 },
    testDependencies({ metaKey: "meta-secret", fetch }),
  );

  const meta = bodies[0] as { max_output_tokens: number };
  const free = bodies[1] as { max_tokens: number };
  assert.equal(meta.max_output_tokens, 16384);
  assert.equal(free.max_tokens, 2048);
});

test("without metaMaxTokens the Meta request keeps the shared budget", async () => {
  let maxOutput: unknown;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/responses")) {
      maxOutput = (JSON.parse(String(init?.body)) as { max_output_tokens: number })
        .max_output_tokens;
    }
    return metaResponse('{"answer":"meta"}');
  };

  await __llmTest.generateJSONWithDependencies(
    schema,
    { ...options, maxTokens: 2048 },
    testDependencies({ metaKey: "meta-secret", fetch }),
  );
  assert.equal(maxOutput, 2048);
});

test("a length-truncated free response falls through with a specific reason", async () => {
  const warnings: string[] = [];
  const fetch: typeof globalThis.fetch = async () =>
    Response.json({
      choices: [{ message: { content: null }, finish_reason: "length" }],
    });

  await assert.rejects(
    __llmTest.generateJSONWithDependencies(
      schema,
      options,
      testDependencies({ fetch, warnings }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof NoProviderAvailableError);
      assert.match(error.message, /cut off at the token limit/);
      return true;
    },
  );
});

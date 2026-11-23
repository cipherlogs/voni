/**
 * The shared GitHub dispatch, proved without GitHub: what a missing token, a
 * 204, a 403 body, a 404 and a transport failure each become when the caller
 * names its own repository, workflow, token variable and action, and that the
 * token never reaches a string the panel could render.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPATCH_TIMEOUT_MS,
  dispatchWorkflow,
  workflowRunUrl,
  type DispatchOutcome,
  type WorkflowDispatch,
} from "./dispatch";

const TOKEN = "ghp_genericsecretvalue456";
const REPO = "cipherlogs/voni";
const WORKFLOW = "browser-check.yml";
const TOKEN_ENV = "GITHUB_DISPATCH_TOKEN";
const ACTION = "browser";

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown = null) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function request(overrides: Partial<WorkflowDispatch> = {}): WorkflowDispatch {
  return {
    repo: REPO,
    workflowFile: WORKFLOW,
    tokenEnv: TOKEN_ENV,
    action: ACTION,
    inputs: { os: "ubuntu", targets: '["https://example.com/a"]' },
    manualCommand: "node scripts/browser-click.mjs --os ubuntu",
    ...overrides,
  };
}

test("a missing token hands back the caller's command and makes no request", async () => {
  const { fetcher, calls } = stubFetch(204);
  const result = await dispatchWorkflow(
    request({ fetcher, readSecret: async () => undefined }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "manual");
  if (result.mode !== "manual") throw new Error("unreachable");
  assert.equal(
    result.fallback.command,
    "node scripts/browser-click.mjs --os ubuntu",
  );
  assert.equal(calls.length, 0, "an unconfigured dispatch must not reach GitHub");
});

test("the token is read from the caller's variable name", async () => {
  const seen: string[] = [];
  const { fetcher } = stubFetch(204);
  await dispatchWorkflow(
    request({
      fetcher,
      readSecret: async (name) => {
        seen.push(name);
        return TOKEN;
      },
    }),
  );

  assert.deepEqual(seen, [TOKEN_ENV]);
});

test("a 204 answers with the workflow's page and sends the caller's inputs", async () => {
  const { fetcher, calls } = stubFetch(204);
  const inputs = { os: "macos", interval: "60" };
  const result = await dispatchWorkflow(
    request({ fetcher, readSecret: async () => TOKEN, inputs }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "dispatched");
  if (result.mode !== "dispatched") throw new Error("unreachable");
  assert.equal(result.runUrl, workflowRunUrl(REPO, WORKFLOW));
  assert.equal(
    result.runUrl,
    "https://github.com/cipherlogs/voni/actions/workflows/browser-check.yml",
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://api.github.com/repos/cipherlogs/voni/actions/workflows/browser-check.yml/dispatches",
  );
  assert.equal(calls[0]!.init.method, "POST");

  const body = JSON.parse(String(calls[0]!.init.body)) as {
    ref: string;
    inputs: Record<string, string>;
  };
  assert.equal(body.ref, "main");
  assert.deepEqual(body.inputs, inputs);
});

test("the dispatch carries the exact headers, the timeout and no cache", async () => {
  const { fetcher, calls } = stubFetch(204);
  await dispatchWorkflow(request({ fetcher, readSecret: async () => TOKEN }));

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.deepEqual(headers, {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    // GitHub 403s a UA-less request with a body that reads like a permission
    // refusal, so the UA is part of the contract, not decoration.
    "user-agent": "voni-browser",
  });
  assert.equal(calls[0]!.init.cache, "no-store");
  assert.ok(calls[0]!.init.signal, "the dispatch must carry a timeout signal");
});

test("the timeout ceiling is ten seconds", () => {
  assert.equal(DISPATCH_TIMEOUT_MS, 10_000);
});

test("a caller can name its own ref and User-Agent", async () => {
  const { fetcher, calls } = stubFetch(204);
  await dispatchWorkflow(
    request({
      fetcher,
      readSecret: async () => TOKEN,
      ref: "release",
      userAgent: "voni-custom-agent",
    }),
  );

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["user-agent"], "voni-custom-agent");
  assert.equal(JSON.parse(String(calls[0]!.init.body)).ref, "release");
});

test("401, 403, 404, 429 and any other status read differently and name the caller", async () => {
  const sentences = new Map<number, string>();

  for (const status of [401, 403, 404, 429, 500]) {
    const { fetcher } = stubFetch(status, {
      message:
        status === 403
          ? "Resource not accessible by integration"
          : `message for ${status}`,
    });
    const result = await dispatchWorkflow(
      request({ fetcher, readSecret: async () => TOKEN }),
    );
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, new RegExp(String(status)));
    sentences.set(status, result.error);
  }

  const unauthorized = sentences.get(401) ?? "";
  assert.match(unauthorized, new RegExp(TOKEN_ENV));
  assert.match(unauthorized, /cipherlogs\/voni/);

  const forbidden = sentences.get(403) ?? "";
  assert.match(forbidden, new RegExp(TOKEN_ENV));
  assert.match(forbidden, /cipherlogs\/voni/);
  assert.match(forbidden, /browser/);
  // GitHub's own explanation survives; the operator needs it to tell a
  // permission refusal from a token that was never issued.
  assert.match(forbidden, /Resource not accessible by integration/);

  const missing = sentences.get(404) ?? "";
  assert.match(missing, /browser-check\.yml/);
  assert.match(missing, /cipherlogs\/voni/);

  const rateLimited = sentences.get(429) ?? "";
  assert.match(rateLimited, /rate-limited/, "a 429 is its own failure mode");
  assert.match(rateLimited, /429/);
  assert.doesNotMatch(
    rateLimited,
    /needs Actions write access|expired|does not exist/,
    "a temporary rate limit must not read as a bad credential or a bad workflow",
  );

  const other = sentences.get(500) ?? "";
  assert.match(other, /browser/);

  assert.equal(new Set(sentences.values()).size, 5);
});

test("a plain-text refusal reaches the operator, not just the status", async () => {
  const fetcher = (async () =>
    new Response("Request forbidden by administrative rules.", {
      status: 403,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;

  const result = await dispatchWorkflow(
    request({ fetcher, readSecret: async () => TOKEN }),
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.error, /administrative rules/);
});

test("a transport failure names the action and redacts the token", async () => {
  const fetcher = (async () => {
    throw new Error(`fetch failed with ${TOKEN}`);
  }) as unknown as typeof fetch;

  const result = await dispatchWorkflow(
    request({ fetcher, readSecret: async () => TOKEN }),
  );

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.error, /Could not reach GitHub/);
  assert.match(result.error, /browser/);
  assert.match(result.error, /\[redacted\]/);
  assert.equal(result.error.includes(TOKEN), false);
});

test("no returned string ever contains the token", async () => {
  const outcomes: Array<() => Promise<DispatchOutcome>> = [
    async () => {
      const { fetcher } = stubFetch(204);
      return dispatchWorkflow(request({ fetcher, readSecret: async () => TOKEN }));
    },
    async () => {
      const { fetcher } = stubFetch(204);
      return dispatchWorkflow(
        request({ fetcher, readSecret: async () => undefined }),
      );
    },
    ...[401, 403, 404, 429, 500].map((status) => async () => {
      // A body that echoes the credential back must not reach the operator.
      const { fetcher } = stubFetch(status, { message: `token ${TOKEN} nope` });
      return dispatchWorkflow(request({ fetcher, readSecret: async () => TOKEN }));
    }),
    async () => {
      const fetcher = (async () => {
        throw new Error(`connect failed while sending ${TOKEN}`);
      }) as unknown as typeof fetch;
      return dispatchWorkflow(request({ fetcher, readSecret: async () => TOKEN }));
    },
  ];

  for (const outcome of outcomes) {
    const result = await outcome();
    const text = JSON.stringify(result);
    assert.equal(text.includes(TOKEN), false, text);
  }
});

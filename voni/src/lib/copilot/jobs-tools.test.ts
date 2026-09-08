import test from "node:test";
import assert from "node:assert/strict";
import { ExecutorFailure } from "./bus";
import {
  buildScheduleProposal,
  executeCancelJob,
  executeRetryJob,
  executeScheduleJob,
  proposeScheduleArgs,
  readJobStatus,
} from "./jobs-tools";

type Route = { method: string; path: string; status: number; body: unknown; throws?: boolean };
const calls: { method: string; url: string; body: string | null }[] = [];
let routes: Route[] = [];

function stubFetch(defs: Route[]) {
  routes = defs;
  calls.length = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    const method = init?.method ?? "GET";
    const path = url.split("?")[0];
    calls.push({ method, url, body: init?.body ?? null });
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`unstubbed ${method} ${url}`);
    if (route.throws) throw new Error("socket died mid-send");
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  };
}

const SCHEDULE = {
  kind: "agent_generation",
  title: "Generate agent draft",
  input: { brief: "book more viewings please" },
  idempotencyKey: "voice-test-key-1",
};

test("schedule posts once and returns durable acceptance", async () => {
  stubFetch([
    {
      method: "POST",
      path: "/api/jobs",
      status: 202,
      body: { jobId: "job-1", targetUrl: "/agents/new?job=job-1", created: true },
    },
  ]);
  const ran = await executeScheduleJob(SCHEDULE, {
    userId: "u",
    organizationId: "o",
    sessionId: "s",
    route: "/",
    registration: 1,
    readTarget: () => null,
  });
  assert.deepEqual(ran.result, {
    job_id: "job-1",
    target_url: "/agents/new?job=job-1",
    already_running: false,
  });
  const sent = JSON.parse(calls[0].body as string) as Record<string, unknown>;
  assert.equal(sent["idempotencyKey"], "voice-test-key-1");
});

test("rejected input fails definitively, not unknown", async () => {
  stubFetch([
    { method: "POST", path: "/api/jobs", status: 400, body: { error: "Brief too short." } },
  ]);
  await assert.rejects(executeScheduleJob(SCHEDULE, {
    userId: "u",
    organizationId: "o",
    sessionId: "s",
    route: "/",
    registration: 1,
    readTarget: () => null,
  }), (error: unknown) => {
    assert.ok(error instanceof ExecutorFailure);
    assert.equal(error.retryable, false);
    assert.match(error.message, /Brief too short/);
    return true;
  });
});

test("lost acceptance adopts the existing row — same key, one job", async () => {
  stubFetch([
    { method: "POST", path: "/api/jobs", status: 202, body: {}, throws: true },
    {
      method: "GET",
      path: "/api/jobs/by-key",
      status: 200,
      body: { job: { id: "job-9", targetUrl: "/agents/new?job=job-9" } },
    },
  ]);
  const ran = await executeScheduleJob(SCHEDULE, {
    userId: "u",
    organizationId: "o",
    sessionId: "s",
    route: "/",
    registration: 1,
    readTarget: () => null,
  });
  assert.deepEqual(ran.result, {
    job_id: "job-9",
    target_url: "/agents/new?job=job-9",
    already_running: true,
  });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("absent row resubmits the identical payload once", async () => {
  let posts = 0;
  calls.length = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ?? null });
    if (method === "POST") {
      posts += 1;
      if (posts === 1) throw new Error("socket died mid-send");
      return {
        ok: true,
        status: 202,
        json: async () => ({ jobId: "job-2", targetUrl: null, created: true }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: "No job." }) };
  };
  const ran = await executeScheduleJob(SCHEDULE, {
    userId: "u",
    organizationId: "o",
    sessionId: "s",
    route: "/",
    registration: 1,
    readTarget: () => null,
  });
  assert.deepEqual(ran.result, { job_id: "job-2", target_url: null, already_running: false });
  const bodies = calls
    .filter((c) => c.method === "POST")
    .map((c) => (JSON.parse(c.body as string) as { idempotencyKey: string }).idempotencyKey);
  assert.deepEqual(bodies, ["voice-test-key-1", "voice-test-key-1"]);
});

test("retry refuses an already-succeeded job without touching the server", async () => {
  stubFetch([
    {
      method: "GET",
      path: "/api/jobs/job-1",
      status: 200,
      body: {
        job: { id: "job-1", kind: "agent_generation", status: "succeeded", title: "Draft", targetUrl: null, errorMessage: null },
      },
    },
  ]);
  await assert.rejects(
    executeRetryJob(
      { job_id: "job-1" },
      { userId: "u", organizationId: "o", sessionId: "s", route: "/", registration: 1, readTarget: () => null },
    ),
    /already succeeded/,
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("cancel posts the action and returns the fresh status", async () => {
  stubFetch([
    {
      method: "GET",
      path: "/api/jobs/job-7",
      status: 200,
      body: {
        job: { id: "job-7", kind: "lead_csv_import", status: "running", title: "Import", targetUrl: null, errorMessage: null },
      },
    },
    {
      method: "POST",
      path: "/api/jobs/job-7",
      status: 200,
      body: {
        job: { id: "job-7", kind: "lead_csv_import", status: "cancelled", title: "Import", targetUrl: null, errorMessage: null },
      },
    },
  ]);
  const ran = await executeCancelJob(
    { job_id: "job-7" },
    { userId: "u", organizationId: "o", sessionId: "s", route: "/", registration: 1, readTarget: () => null },
  );
  assert.deepEqual(ran.result, { job_id: "job-7", status: "cancelled", title: "Import" });
  const sent = JSON.parse(calls[1].body as string) as Record<string, unknown>;
  assert.equal(sent["action"], "cancel");
});

test("status read surfaces state for narration", async () => {
  stubFetch([
    {
      method: "GET",
      path: "/api/jobs/job-3",
      status: 200,
      body: {
        job: { id: "job-3", kind: "agent_generation", status: "succeeded", title: "Draft", targetUrl: "/agents/new?job=job-3", errorMessage: null },
      },
    },
  ]);
  assert.deepEqual(await readJobStatus("job-3"), {
    status: "succeeded",
    title: "Draft",
    target_url: "/agents/new?job=job-3",
    error_message: null,
  });
});

test("propose args demand kind-specific fields", () => {
  assert.ok(
    proposeScheduleArgs.safeParse({ kind: "agent_generation", brief: "book viewings now please" }).success,
  );
  assert.ok(
    proposeScheduleArgs.safeParse({ kind: "integration_test", service: "telnyx" }).success,
  );
  // Generation without a brief, or a test without a service, is rejected.
  assert.equal(
    proposeScheduleArgs.safeParse({ kind: "agent_generation" }).success,
    false,
  );
  assert.equal(
    proposeScheduleArgs.safeParse({ kind: "integration_test" }).success,
    false,
  );
});

test("schedule proposal copy is frozen and readback-ready", () => {  const built = buildScheduleProposal({ kind: "agent_generation", brief: "book viewings now please" });
  assert.equal(built.title, "Generate agent draft");
  assert.match(built.summary, /background/);
  assert.ok(built.keyPhrases.length > 0);
  const test = buildScheduleProposal({ kind: "integration_test", service: "telnyx" });
  assert.equal(test.title, "Test telnyx connection");
});

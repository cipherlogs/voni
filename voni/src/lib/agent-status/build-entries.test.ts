import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentStatusEntries } from "./build-entries";
import type { JobJson } from "@/lib/jobs/serialize";

const base = {
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
  configVersion: 3,
  deploymentStatus: "ready",
};

function job(overrides: Partial<JobJson>): JobJson {
  return {
    id: "job-1",
    kind: "agent_deployment",
    status: "succeeded",
    title: "Deploy",
    targetUrl: null,
    relatedId: "agent-1",
    result: null,
    errorCode: null,
    errorMessage: null,
    stage: null,
    progressTotal: null,
    progressDone: null,
    attemptCount: 1,
    cancelRequested: false,
    createdAt: "2026-09-02T10:00:00.000Z",
    startedAt: "2026-09-02T10:01:00.000Z",
    completedAt: "2026-09-02T10:02:00.000Z",
    seenAt: null,
    dismissedAt: null,
    updatedAt: "2026-09-02T10:02:00.000Z",
    ...overrides,
  };
}

describe("buildAgentStatusEntries", () => {
  for (const status of ["draft", "queued", "deploying", "ready", "failed", "cancelled"] as const) {
    it(`maps ${status} to explicit text`, () => {
      const entries = buildAgentStatusEntries({ ...base, deploymentStatus: status });
      assert.equal(entries.length, 3);
      assert.equal(entries[0]?.id, "created");
      assert.match(entries[1]?.title ?? "", /Configuration v3 saved/);
      assert.ok(entries[2]?.title.startsWith("Deployment: "));
      assert.ok(!/Step \d/i.test(entries[2]?.title ?? ""));
    });
  }

  it("marks failed and cancelled as error", () => {
    assert.equal(
      buildAgentStatusEntries({ ...base, deploymentStatus: "failed" })[2]?.state,
      "error",
    );
    assert.equal(
      buildAgentStatusEntries({ ...base, deploymentStatus: "cancelled" })[2]?.state,
      "error",
    );
  });

  it("marks draft as neutral", () => {
    assert.equal(
      buildAgentStatusEntries({ ...base, deploymentStatus: "draft" })[2]?.state,
      "neutral",
    );
  });

  it("omits timestamps when unavailable", () => {
    const entries = buildAgentStatusEntries({
      createdAt: null,
      updatedAt: null,
      configVersion: 1,
      deploymentStatus: "draft",
    });
    assert.equal(entries[0]?.time, undefined);
    assert.equal(entries[1]?.time, undefined);
    assert.equal(entries[2]?.time, undefined);
  });

  it("prefers live job status over the stored row", () => {
    const entries = buildAgentStatusEntries({
      ...base,
      deploymentStatus: "queued",
      deploymentJob: job({ status: "running" }),
    });
    assert.match(entries[2]?.title ?? "", /Deploying/);
    assert.equal(entries[2]?.state, "current");
  });

  it("surfaces the sanitized job error on failure", () => {
    const entries = buildAgentStatusEntries({
      ...base,
      deploymentStatus: "failed",
      deploymentError: "Voice deployment did not complete.",
    });
    assert.match(entries[2]?.description ?? "", /Voice deployment did not complete/);
  });
});

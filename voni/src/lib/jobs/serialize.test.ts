import test from "node:test";
import assert from "node:assert/strict";
import { jobToJson, type JobJson } from "./serialize";
import { publicRecordResult } from "@/lib/copilot/record-contracts";

// Ticket 06, seam: the server-to-client job payload boundary
// (jobToJson — feeds the jobs provider, rows, and record surfaces).
// Catches: oversized payloads (the 2 MB staged-CSV `input` must never cross
// the boundary). Misses: byte counts on the wire — key-set assertions plus
// the runtime check cover those. Behavioral: jobToJson is pure, so outcomes
// are asserted on real rows, not source text.
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    kind: "lead_csv_import",
    status: "succeeded",
    title: "Import leads",
    targetUrl: "/campaigns/c-1#import",
    relatedId: "c-1",
    input: { csvText: "phone\n+1".repeat(1000) },
    result: { ok: true },
    errorCode: null,
    errorMessage: null,
    stage: null,
    progressTotal: null,
    progressDone: null,
    attemptCount: 1,
    cancelRequested: false,
    createdAt: new Date("2026-10-26T10:00:00Z"),
    startedAt: new Date("2026-10-26T10:00:01Z"),
    completedAt: new Date("2026-10-26T10:00:02Z"),
    seenAt: null,
    dismissedAt: null,
    updatedAt: new Date("2026-10-26T10:00:03Z"),
    ...overrides,
  } as Parameters<typeof jobToJson>[0];
}

test("job payload never carries the staged input", () => {
  const json = jobToJson(row());
  assert.ok(!("input" in json), "input (up to 2 MB staged CSV) stays server-side");
  assert.equal(json.id, "job-1");
  assert.equal(json.title, "Import leads");
});

test("job payload keeps every field the client renders", () => {
  const json: JobJson = jobToJson(row());
  // job-row, jobs-provider, optimistic entries, and record surfaces read
  // these; dropping any of them blanks the UI. Additions stay allowed —
  // only the input exclusion above is locked.
  for (const key of [
    "id",
    "kind",
    "status",
    "title",
    "targetUrl",
    "relatedId",
    "result",
    "errorCode",
    "errorMessage",
    "stage",
    "progressTotal",
    "progressDone",
    "attemptCount",
    "cancelRequested",
    "createdAt",
    "startedAt",
    "completedAt",
    "seenAt",
    "dismissedAt",
    "updatedAt",
  ] as const) {
    assert.ok(key in json, `payload keeps ${key}`);
  }
  assert.equal(json.createdAt, "2026-10-26T10:00:00.000Z");
});

test("record_search results cross trimmed to the public contract", () => {
  const result = {
    matches: [
      {
        ref: "m-1",
        id: "11111111-1111-4111-8111-111111111111",
        kind: "leads",
        label: "Ada",
        description: "Lead",
      },
    ],
    next: null,
  };
  const json = jobToJson(row({ kind: "record_search", result }));
  assert.deepEqual(json.result, publicRecordResult(result));
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  ToolLogError,
  normalizeToolLogRow,
  summarizeToolResult,
  toolLogEntry,
  toolLogRowFromStored,
  type ToolLogRow,
} from "./tool-log";

/**
 * The demo's tool log is the evidence the X evaluators read. It records what a
 * tool did, never who the caller is: a status, a returning flag, whether a
 * reply was sent, success, a closed code and a latency. The tests pin that
 * shape and the redaction, because a log that copies an address or a warm line
 * makes every certificate a PII artifact.
 */

test("a check_email result keeps the status and the returning fact, never the address or name", () => {
  const facts = summarizeToolResult("check_email", {
    ok: true,
    data: {
      status: "found",
      address: "andres@casaverde.pt",
      name: "Andres",
      exact: true,
      returning: true,
      instructions: "say the invite",
    },
  });

  assert.deepEqual(facts, {
    status: "found",
    returning: true,
    sent: false,
    ok: true,
    code: null,
  });
  const text = JSON.stringify(facts);
  assert.ok(!text.includes("andres@casaverde.pt"));
  assert.ok(!text.includes("Andres"));
  assert.ok(!text.includes("say the invite"));
});

test("a personal-domain check is the gate, recorded as its own status", () => {
  assert.deepEqual(
    summarizeToolResult("check_email", {
      ok: true,
      data: { status: "free", address: "someone@gmail.com" },
    }),
    { status: "free", returning: false, sent: false, ok: true, code: null },
  );
});

test("a sent reply is recorded as one send, without its id or the caller's address", () => {
  const facts = summarizeToolResult("send_code_reply", {
    ok: true,
    data: { sent: true, website: "read", instructions: "say it went" },
  });
  assert.deepEqual(facts, {
    status: null,
    returning: false,
    sent: true,
    ok: true,
    code: null,
  });
});

test("a failed tool keeps its failure class from the closed code, never the prose", () => {
  const facts = summarizeToolResult("check_email", {
    ok: false,
    error: "The tool is temporarily unavailable: sk_live_do_not_copy",
    retryable: true,
  });
  assert.deepEqual(facts, {
    status: null,
    returning: false,
    sent: false,
    ok: false,
    code: null,
  });
  assert.ok(!JSON.stringify(facts).includes("sk_live"));
});

test("an unknown tool is a named refusal, because its result has no known shape", () => {
  assert.throws(
    () => summarizeToolResult("delete_everything", { ok: true, data: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ToolLogError);
      assert.equal(error.code, "unknown-tool");
      assert.match(error.message, /delete_everything/);
      return true;
    },
  );
});

test("a log row is normalised with no free-form argument or result payload", () => {
  const row: ToolLogRow = {
    toolCallId: "call_7",
    toolName: "check_email",
    status: "found",
    returning: false,
    sent: false,
    ok: true,
    code: null,
    latencyMs: 812,
    attempts: 1,
    createdAt: "2026-10-31T10:00:00.000Z",
  };
  const normalized = normalizeToolLogRow(row);
  assert.deepEqual(normalized, row);

  assert.throws(
    () =>
      normalizeToolLogRow({
        ...row,
        // A caller address must not ride along in the evidence.
        address: "andres@casaverde.pt",
      } as unknown as ToolLogRow),
    (error: unknown) => {
      assert.ok(error instanceof ToolLogError);
      assert.equal(error.code, "malformed-entry");
      assert.match(error.message, /address/);
      return true;
    },
  );
});

test("the insert row carries ids and facts only, never the result payload", () => {
  const entry = toolLogEntry({
    callId: "8f1c...",
    toolCallId: "call_7",
    toolName: "check_email",
    credential: "service",
    result: { ok: true, data: { status: "found", address: "a@b.co", returning: true } },
    latencyMs: 912.6,
  });
  assert.deepEqual(entry, {
    callId: "8f1c...",
    toolCallId: "call_7",
    toolName: "check_email",
    credential: "service",
    status: "found",
    returning: true,
    sent: false,
    ok: true,
    code: null,
    latencyMs: 913,
  });
  assert.ok(!JSON.stringify(entry).includes("a@b.co"));
});

test("a stored row is read back with its Date as an ISO string", () => {
  const row = toolLogRowFromStored({
    toolCallId: "call_7",
    toolName: "send_code_reply",
    status: null,
    returning: false,
    sent: true,
    ok: true,
    code: null,
    latencyMs: 1_400,
    attempts: 2,
    createdAt: new Date("2026-10-31T10:00:00.000Z"),
  });
  assert.equal(row.createdAt, "2026-10-31T10:00:00.000Z");
  assert.equal(row.attempts, 2);
  assert.equal(row.sent, true);
});

test("a malformed log row is refused by name, not silently treated as no tool", () => {
  for (const broken of [
    { toolCallId: "" },
    { toolName: "" },
    { ok: "yes" },
    { latencyMs: -1 },
    { attempts: 0 },
  ]) {
    assert.throws(
      () =>
        normalizeToolLogRow({
          toolCallId: "call_7",
          toolName: "check_email",
          status: null,
          returning: false,
          sent: false,
          ok: true,
          code: null,
          latencyMs: 10,
          attempts: 1,
          createdAt: "2026-10-31T10:00:00.000Z",
          ...broken,
        } as unknown as ToolLogRow),
      (error: unknown) => {
        assert.ok(error instanceof ToolLogError);
        assert.equal(error.code, "malformed-entry");
        return true;
      },
    );
  }
});

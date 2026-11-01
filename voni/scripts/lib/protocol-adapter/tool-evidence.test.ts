import test from "node:test";
import assert from "node:assert/strict";

import { collectToolEvidence, type ToolEvidenceDeps } from "./tool-evidence";
import type { ToolLogRow } from "@/lib/demo/tool-log";

/**
 * The collector is where the run learns whether the golden path's email is
 * real. These tests prove it never invents a delivery: a missing database, a
 * minted tag without an email, and an unreadable inbox are named gaps that make
 * X4 fail closed.
 */

const LOG: ToolLogRow = {
  toolCallId: "c1",
  toolName: "check_email",
  status: "found",
  returning: false,
  sent: false,
  ok: true,
  code: null,
  latencyMs: 900,
  attempts: 1,
  createdAt: "2026-10-31T10:00:00.000Z",
};

const ENV = {
  DATABASE_URL: "postgresql://test",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  DEMO_INBOX_REFRESH_TOKEN: "refresh",
} as const;

function deps(overrides: Partial<ToolEvidenceDeps> = {}): ToolEvidenceDeps {
  return {
    readLog: async () => [LOG],
    readTag: async () => ({
      tag: "Lime 42",
      issuedAt: new Date("2026-10-31T10:00:00.000Z"),
      matchedMessageId: "m1",
      matchedThreadId: "thread-m1",
    }),
    findTaggedMessage: async () => ({
      found: true,
      messageId: "m1",
      threadId: "thread-m1",
      senderKind: "work",
      receivedAt: 1,
    }),
    countThreadReplies: async () => 1,
    ...overrides,
  };
}

test("a logged tool and a real tagged email produce the delivery record", async () => {
  const collected = await collectToolEvidence({
    callId: "call-1",
    env: ENV,
    deps: deps(),
  });
  assert.equal(collected.gap, null);
  assert.equal(collected.log.length, 1);
  assert.deepEqual(collected.delivery, {
    verified: true,
    tag: "Lime 42",
    messageId: "m1",
    threadId: "thread-m1",
    senderKind: "work",
    repliesFromInbox: 1,
  });
});

test("a database-less run names the tool-log gap and reads nothing", async () => {
  let reads = 0;
  const collected = await collectToolEvidence({
    callId: "call-1",
    env: { ...ENV, DATABASE_URL: "" },
    deps: deps({
      readLog: async () => {
        reads += 1;
        return [];
      },
    }),
  });
  assert.equal(reads, 0);
  assert.equal(collected.delivery, null);
  assert.match(collected.gap ?? "", /DATABASE_URL/);
});

test("a call with no tag names the golden-path gap", async () => {
  const collected = await collectToolEvidence({
    callId: "call-1",
    env: ENV,
    deps: deps({ readTag: async () => null }),
  });
  assert.equal(collected.delivery, null);
  assert.match(collected.gap ?? "", /no Test tag/);
});

test("a tag with no delivered message is a gap, never a delivery", async () => {
  const collected = await collectToolEvidence({
    callId: "call-1",
    env: ENV,
    deps: deps({ findTaggedMessage: async () => ({ found: false }) }),
  });
  assert.equal(collected.delivery, null);
  assert.match(collected.gap ?? "", /Lime 42/);
  assert.match(collected.gap ?? "", /unverified/);
});

test("an unreadable inbox keeps its named refusal in the gap", async () => {
  const collected = await collectToolEvidence({
    callId: "call-1",
    env: ENV,
    deps: deps({
      findTaggedMessage: async () => {
        throw Object.assign(new Error("HTTP 503"), { code: "inbox-unreachable" });
      },
    }),
  });
  assert.equal(collected.delivery, null);
  assert.match(collected.gap ?? "", /inbox-unreachable/);
  assert.match(collected.gap ?? "", /503/);
});

test("a failed log query names the database's own cause, not just its SQL", async () => {
  // Drizzle wraps the driver's error: the message is the SQL, the reason is
  // the cause. A gap that stops at the SQL cannot say a table is missing.
  const driver = Object.assign(
    new Error('relation "demo_tool_calls" does not exist'),
    { code: "42P01" },
  );
  const collected = await collectToolEvidence({
    callId: "call-1",
    env: ENV,
    deps: deps({
      readLog: async () => {
        throw Object.assign(new Error('Failed query: select * from "demo_tool_calls"'), {
          cause: driver,
        });
      },
    }),
  });
  assert.equal(collected.log.length, 0);
  assert.match(collected.gap ?? "", /demo tool log could not be read/);
  assert.match(collected.gap ?? "", /42P01/);
  assert.match(collected.gap ?? "", /relation "demo_tool_calls" does not exist/);
});

test("a thread with two replies is carried into the delivery as the double send", async () => {
  const collected = await collectToolEvidence({
    callId: "call-1",
    env: ENV,
    deps: deps({ countThreadReplies: async () => 2 }),
  });
  assert.equal(collected.delivery?.repliesFromInbox, 2);
});

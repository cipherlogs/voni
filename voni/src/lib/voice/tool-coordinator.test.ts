import test from "node:test";
import assert from "node:assert/strict";
import { ToolCoordinator } from "./tool-coordinator";
import type { ToolResponse } from "@/lib/tools/execute";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test("sends an interactive result the moment it is ready, mid-reply", async () => {
  // Measured live (scripts/eval-demo-agent.mts, 2026-09-27): the server holds
  // the calling reply open until the result arrives, so holding the result
  // for that reply's reply.done deadlocks until the tool times out
  // (sess_c477d8f8: a 5s stall, then an invented answer).
  const sent: Record<string, unknown>[] = [];
  const result = deferred<ToolResponse>();
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: () => result.promise,
  });
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-1",
    name: "search_properties",
    arguments: {},
  });
  result.resolve({ ok: true, data: { count: 0 } });
  await tick();
  assert.equal(sent.length, 1, "not held for reply.done");
  coordinator.onReplyDone(false);
  assert.equal(sent.length, 1, "sent once");
});

test("flushes a slow interactive result when reply.done already arrived", async () => {
  const sent: Record<string, unknown>[] = [];
  const result = deferred<ToolResponse>();
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: () => result.promise,
  });
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-2",
    name: "check_calendar",
    arguments: { date: "2026-09-06" },
  });
  coordinator.onReplyDone(false);
  result.resolve({ ok: true, data: { slots: [] } });
  await tick();
  assert.equal(sent.length, 1);
});

test("returns results immediately and marks errors", async () => {
  const sent: Record<string, unknown>[] = [];
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: async () => ({ ok: false, error: "occupied", retryable: false }),
  });
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-3",
    name: "book_viewing",
    arguments: {},
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].is_error, true);
});

test("discards a pending result when its reply is interrupted", async () => {  const sent: Record<string, unknown>[] = [];
  const result = deferred<ToolResponse>();
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: () => result.promise,
  });
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-4",
    name: "search_properties",
    arguments: {},
  });
  coordinator.onReplyDone(true);
  result.resolve({ ok: true, data: { count: 1 } });
  await tick();
  assert.equal(sent.length, 0);
});

test("sends a late result even while a newer user turn is in flight", async () => {
  const sent: Record<string, unknown>[] = [];
  const result = deferred<ToolResponse>();
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: () => result.promise,
  });
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-5",
    name: "search_properties",
    arguments: {},
  });
  coordinator.onReplyDone(false);
  result.resolve({ ok: true, data: { count: 1 } });
  await tick();
  assert.equal(sent.length, 1);
  coordinator.onReplyDone(false);
  assert.equal(sent.length, 1, "sent once");
});

test("reports every sent result with its tool name", async () => {
  const seen: { name: string; result: ToolResponse }[] = [];
  const coordinator = new ToolCoordinator({
    send: () => {},
    execute: async () => ({ ok: true, hangup: true, data: { ended: true } }),
    onResult: (name, result) => seen.push({ name, result }),
  });
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-7",
    name: "end_call",
    arguments: { closing_line: "Goodbye!" },
  });
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, "end_call");
  assert.equal(seen[0].result.ok, true);
});

test("a held tool's result waits for reply.done, and is still sent when that reply is interrupted", async () => {
  const sent: Record<string, unknown>[] = [];
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: async () => ({ ok: true, hangup: true, data: { ended: true } }),
    holdUntilReplyDone: (name) => name === "end_call",
  });
  coordinator.onToolCall({ type: "tool.call", call_id: "bye", name: "end_call", arguments: {} });
  await tick();
  assert.equal(sent.length, 0);
  coordinator.onReplyDone(false);
  assert.equal(sent.length, 1);

  const cut = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: async () => ({ ok: true, hangup: true, data: { ended: true } }),
    holdUntilReplyDone: () => true,
  });
  cut.onToolCall({ type: "tool.call", call_id: "bye2", name: "end_call", arguments: {} });
  await tick();
  cut.onReplyDone(true);
  // The platform waits for it either way (never sending it stalled the next
  // reply until the tool timed out); the session decides whether to hang up.
  assert.equal(sent.length, 2, "sent at the interrupted reply.done");
  cut.onReplyDone(false);
  assert.equal(sent.length, 2, "once");
});

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

test("holds an interactive result until matching reply.done", async () => {
  const sent: Record<string, unknown>[] = [];
  const result = deferred<ToolResponse>();
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: () => result.promise,
    modeFor: () => "interactive",
  });
  coordinator.onReplyStarted("reply-1");
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-1",
    name: "search_properties",
    arguments: {},
  });
  result.resolve({ ok: true, data: { count: 0 } });
  await tick();
  assert.equal(sent.length, 0);
  coordinator.onReplyDone("reply-1", false);
  assert.equal(sent.length, 1);
});

test("flushes a slow interactive result when reply.done already arrived", async () => {
  const sent: Record<string, unknown>[] = [];
  const result = deferred<ToolResponse>();
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: () => result.promise,
    modeFor: () => "interactive",
  });
  coordinator.onReplyStarted("reply-2");
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-2",
    name: "check_calendar",
    arguments: { date: "2026-09-06" },
  });
  coordinator.onReplyDone("reply-2", false);
  result.resolve({ ok: true, data: { slots: [] } });
  await tick();
  assert.equal(sent.length, 1);
});

test("returns hold-mode results immediately and marks errors", async () => {
  const sent: Record<string, unknown>[] = [];
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: async () => ({ ok: false, error: "occupied", retryable: false }),
    modeFor: () => "hold",
  });
  coordinator.onReplyStarted("reply-3");
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
    modeFor: () => "interactive",
  });
  coordinator.onReplyStarted("reply-4");
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-4",
    name: "search_properties",
    arguments: {},
  });
  coordinator.onReplyDone("reply-4", true);
  result.resolve({ ok: true, data: { count: 1 } });
  await tick();
  assert.equal(sent.length, 0);
});

test("holds a late result through a newer user turn", async () => {
  const sent: Record<string, unknown>[] = [];
  const result = deferred<ToolResponse>();
  const coordinator = new ToolCoordinator({
    send: (message) => sent.push(message),
    execute: () => result.promise,
    modeFor: () => "interactive",
  });
  coordinator.onReplyStarted("reply-5");
  coordinator.onToolCall({
    type: "tool.call",
    call_id: "tool-5",
    name: "search_properties",
    arguments: {},
  });
  coordinator.onReplyDone("reply-5", false);
  coordinator.onInputSpeechStarted();
  result.resolve({ ok: true, data: { count: 1 } });
  await tick();
  assert.equal(sent.length, 0);
  coordinator.onReplyDone("reply-6", false);
  assert.equal(sent.length, 1);
});

test("reports every sent result with its tool name", async () => {
  const seen: { name: string; result: ToolResponse }[] = [];
  const coordinator = new ToolCoordinator({
    send: () => {},
    execute: async () => ({ ok: true, hangup: true, data: { ended: true } }),
    modeFor: () => "hold",
    onResult: (name, result) => seen.push({ name, result }),
  });
  coordinator.onReplyStarted("reply-7");
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

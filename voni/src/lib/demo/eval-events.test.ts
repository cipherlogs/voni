import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvalEventWriter,
  EVAL_EVENT_TYPES,
  readEvalEvents,
  summarizeEvalEvents,
} from "./eval-events";

const dir = () => mkdtempSync(join(tmpdir(), "eval-events-"));

test("a null path is a no-op stream: no file, no event object", () => {
  const writer = createEvalEventWriter(null);
  assert.equal(writer.path, null);
  assert.equal(writer.emit("cut", { sessionId: "sess_x" }), null);
  writer.close();
});

test("the writer creates valid JSONL with run-relative and explicit atMs", () => {
  const path = join(dir(), "nested", "events.jsonl");
  const writer = createEvalEventWriter(path, { startedAtMs: 1_000, now: () => 1_250 });
  assert.ok(existsSync(path), "the file exists before the first emit");
  writer.emit("scenario.start", { scenario: "stop-over", run: 1 });
  writer.emit("cut", { sessionId: "sess_abc", cutMs: 1_448, atMs: 700 });
  writer.close();

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  const second = JSON.parse(lines[1]) as Record<string, unknown>;
  assert.deepEqual(first, { atMs: 250, type: "scenario.start", scenario: "stop-over", run: 1 });
  assert.deepEqual(second, { atMs: 700, type: "cut", sessionId: "sess_abc", cutMs: 1_448 });
});

test("the writer strips secret keys, key-shaped values and PCM payloads", () => {
  const path = join(dir(), "events.jsonl");
  const writer = createEvalEventWriter(path);
  writer.emit("tool.result", {
    sessionId: "sess_abc",
    name: "check_email",
    apiKey: "sk_live_should_never_appear",
    token: "tok_secret",
    authorization: "Bearer abc123",
    pcm: "AAAA",
    data: "base64audio",
    nested: { api_key: "nope", note: "key sk_live_abcdefgh1234 leaked" },
  });
  writer.close();

  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /should_never_appear/);
  assert.doesNotMatch(text, /tok_secret/);
  assert.doesNotMatch(text, /Bearer abc123/);
  assert.doesNotMatch(text, /base64audio/);
  assert.doesNotMatch(text, /sk_live_/);
  const event = JSON.parse(text) as Record<string, unknown>;
  assert.equal(event.apiKey, undefined);
  assert.equal(event.token, undefined);
  assert.equal(event.pcm, undefined);
  assert.deepEqual(event.nested, { note: "key [redacted] leaked" });
});

test("the writer rejects an unknown event type instead of writing it", () => {
  const writer = createEvalEventWriter(join(dir(), "events.jsonl"));
  assert.throws(
    () => writer.emit("raw.pcm" as never),
    /unknown eval event type/,
  );
});

test("readEvalEvents parses the stream and names a malformed line", () => {
  const path = join(dir(), "events.jsonl");
  const writer = createEvalEventWriter(path);
  writer.emit("session.ready", { sessionId: "sess_a" });
  writer.emit("hangup", { sessionId: "sess_a", delayMs: 956 });
  writer.close();
  const events = readEvalEvents(path);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["session.ready", "hangup"]);

  const broken = join(dir(), "broken.jsonl");
  writeFileSync(broken, '{"atMs":1,"type":"cut"}\nnot json\n');
  assert.throws(() => readEvalEvents(broken), /broken\.jsonl:2: not valid JSON/);
});

test("summarizeEvalEvents counts every type and keeps the triage timeline", () => {
  const writer = createEvalEventWriter(join(dir(), "events.jsonl"));
  const events = [
    writer.emit("scenario.start", { scenario: "over-talk", run: 1 }),
    writer.emit("session.ready", { sessionId: "sess_a" }),
    writer.emit("reply.create", { sessionId: "sess_a", checkIn: false }),
    writer.emit("reply.first_audio", { sessionId: "sess_a", replyId: "r1" }),
    writer.emit("cut", { sessionId: "sess_a", cutMs: 15_870, overlapMs: 0 }),
    writer.emit("tool.call", { sessionId: "sess_a", name: "show_test_address" }),
    writer.emit("tool.result", { sessionId: "sess_a", name: "show_test_address", ok: true }),
    writer.emit("goodbye.drain", { sessionId: "sess_a", coverage: 0.97, inboxNamed: true }),
    writer.emit("hangup", { sessionId: "sess_a", delayMs: 956 }),
    writer.emit("aside", { sessionId: "sess_a", cutMs: 15_870 }),
    writer.emit("end_call", { sessionId: "sess_a", held: true }),
    writer.emit("scenario.end", { scenario: "over-talk", run: 1, passed: true }),
  ].filter((event): event is NonNullable<typeof event> => event !== null);
  const summary = summarizeEvalEvents(events);
  assert.equal(summary.total, EVAL_EVENT_TYPES.length);
  for (const type of EVAL_EVENT_TYPES) assert.equal(summary.counts[type], 1, type);
  assert.deepEqual(
    summary.timeline.map((row) => row.type),
    ["cut", "tool.call", "tool.result", "goodbye.drain", "hangup", "aside", "end_call"],
  );
  assert.match(summary.timeline[0].detail, /sess_a cut 15870ms overlap 0ms/);
  assert.match(summary.timeline[3].detail, /coverage 0\.97 inbox named/);
});

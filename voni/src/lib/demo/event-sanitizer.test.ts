import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeEventFields } from "./event-sanitizer";
import { createEvalEventWriter } from "./eval-events";

const dir = () => mkdtempSync(join(tmpdir(), "event-sanitizer-"));

test("a forbidden key is dropped and reported by name", () => {
  const result = sanitizeEventFields({
    sessionId: "sess_abc",
    text: "caller words",
    transcript: "caller words",
    audio: "AAAA",
    pcm: "AAAA",
    authorization: "Bearer abc",
    token: "tok_secret",
    api_key: "sk_live_abcdefgh1234",
    secret: "hunter2",
    data: "base64audio",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.value, { sessionId: "sess_abc" });
  assert.deepEqual(result.rejectedKeys.toSorted(), [
    "api_key",
    "audio",
    "authorization",
    "data",
    "pcm",
    "secret",
    "text",
    "token",
    "transcript",
  ]);
});

test("a key-shaped value inside an allowed field is redacted, not dropped", () => {
  const result = sanitizeEventFields({
    reason: "provider fallback to wss://edge:supersecret@cascade.example/ws timed out",
    header: "Bearer eyJhbGciOiJIUzI1NiJ9.payload",
    note: "key sk_live_abcdefgh1234 leaked",
    trace: "https://cascade.example/health",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.rejectedKeys, []);
  assert.equal(result.value.reason, "provider fallback to wss://[redacted]@cascade.example/ws timed out");
  assert.equal(result.value.header, "[redacted]");
  assert.equal(result.value.note, "key [redacted] leaked");
  assert.equal(result.value.trace, "https://cascade.example/health");
});

test("a forbidden key nested in an object or array is dropped and named by path", () => {
  const result = sanitizeEventFields({
    nested: { text: "nested caller words", note: "key sk_live_abcdefgh1234 leaked" },
    items: [{ transcript: "nested caller words" }, { ok: true }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.value, { nested: { note: "key [redacted] leaked" }, items: [{}, { ok: true }] });
  assert.deepEqual(result.rejectedKeys, ["nested.text", "items.transcript"]);
});

test("the shared bounds hold: depth 4 cap, 500-char truncation, non-finite to null", () => {
  const result = sanitizeEventFields({
    deep: { a: { b: { c: { d: { e: 1 } } } } },
    long: "a".repeat(600),
    infinite: Number.POSITIVE_INFINITY,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.deep, { a: { b: { c: { d: "[depth-limit]" } } } });
  assert.equal((result.value.long as string).length, 501);
  assert.ok((result.value.long as string).endsWith("…"));
  assert.equal(result.value.infinite, null);
});

test("the managed writer reports forbidden key names and still writes the sanitized line", () => {
  const path = join(dir(), "events.jsonl");
  const rejected: { type: string; keys: string[] }[] = [];
  const writer = createEvalEventWriter(path, { onRejected: (line) => rejected.push(line) });
  writer.emit("turn.user_final", { sessionId: "sess_abc", text: "caller words", token: "tok_secret" });
  writer.close();

  assert.deepEqual(rejected, [{ type: "turn.user_final", keys: ["text", "token"] }]);
  const event = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(typeof event.atMs, "number");
  delete event.atMs;
  assert.deepEqual(event, { type: "turn.user_final", sessionId: "sess_abc" });
});

test("managed event lines stay byte-identical to the current output", () => {
  const path = join(dir(), "events.jsonl");
  const writer = createEvalEventWriter(path, { startedAtMs: 0, now: () => 0 });
  writer.emit("turn.user_final", {
    sessionId: "sess_abc",
    turnId: "turn-1",
    callMs: 1_200,
    atMs: 1_200,
    text: "caller words",
    token: "tok_secret",
    nested: { note: "key sk_live_abcdefgh1234 leaked" },
  });
  writer.close();

  assert.equal(
    readFileSync(path, "utf8"),
    '{"atMs":1200,"type":"turn.user_final","sessionId":"sess_abc","turnId":"turn-1","callMs":1200,"nested":{"note":"key [redacted] leaked"}}\n',
  );
});

test("the eval stream imports the one denylist instead of keeping a private copy", () => {
  const source = readFileSync(new URL("./eval-events.ts", import.meta.url), "utf8");
  assert.match(source, /from "\.\/event-sanitizer"/);
  assert.doesNotMatch(source, /FORBIDDEN_EVENT_KEYS\s*=\s*new Set/);
  assert.doesNotMatch(source, /KEY_SHAPED_VALUE\s*=/);
  assert.doesNotMatch(source, /function sanitizeValue/);
});


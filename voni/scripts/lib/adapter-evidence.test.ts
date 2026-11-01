import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  defaultEventsDir,
  eligibilityOf,
  firstRow,
  parseTrace,
  turnIds,
  turnRows,
} from "./adapter-evidence";

/**
 * The one trace layer both adapters read. The eligibility rule is the
 * anti-lie rule: a provider fallback or a budget stop makes the call
 * ineligible. It is proven here once, so a fix cannot land on one adapter and
 * leave the other claiming a clean call.
 */

const error = (code: string, message: string) => new Error(`${code}: ${message}`);

test("the trace parser refuses a malformed line by name", () => {
  assert.throws(() => parseTrace('{"type":"end"}\nnot json', "trace.jsonl", error), /trace-malformed/);
  assert.throws(
    () => parseTrace('{"type":"end"}\n["array"]', "trace.jsonl", error),
    /trace-malformed/,
  );
  assert.equal(parseTrace('{"type":"end"}\n\n', "trace.jsonl", error).length, 1);
});

test("turn ids are each turn once, in trace order", () => {
  const rows = [
    { turn: "t1", type: "turn.user_final" },
    { type: "cost.priced" },
    { turn: "t2", type: "turn.reply_start" },
    { turn: "t1", type: "turn.first_audio" },
  ];
  assert.deepEqual(turnRows(rows).length, 3);
  assert.deepEqual(turnIds(rows), ["t1", "t2"]);
});

test("firstRow returns the first row of the named type, never a later one", () => {
  const rows = [{ type: "a", n: 1 }, { type: "a", n: 2 }];
  assert.equal(firstRow(rows, "a")?.n, 1);
  assert.equal(firstRow(rows, "missing"), null);
});

test("a provider fallback makes the call ineligible and names the leg", () => {
  const fact = eligibilityOf({
    callId: "call-1",
    scenario: "golden-flow-hello",
    end: { type: "end" },
    rows: [{ type: "provider_fallback", leg: "stt", phase: "turn" }],
  });
  assert.equal(fact.providerFallback, "stt at turn");
  assert.equal(fact.budgetStop, null);
});

test("a budget stop is read from the end message, the trace row or endedBy", () => {
  const fromEnd = eligibilityOf({
    callId: "call-1",
    scenario: "s",
    end: { type: "end", budget: { reasons: "ceiling" } },
    rows: [],
  });
  assert.equal(fromEnd.budgetStop, "ceiling");

  const fromRow = eligibilityOf({
    callId: "call-1",
    scenario: "s",
    end: { type: "end" },
    rows: [{ type: "budget.stopped", reason: "spend" }],
  });
  assert.equal(fromRow.budgetStop, "spend");

  const fromEndedBy = eligibilityOf({
    callId: "call-1",
    scenario: "s",
    end: { type: "end", endedBy: "budget" },
    rows: [],
  });
  assert.equal(fromEndedBy.budgetStop, "budget ceiling");

  const clean = eligibilityOf({ callId: "call-1", scenario: "s", end: null, rows: [] });
  assert.equal(clean.providerFallback, null);
  assert.equal(clean.budgetStop, null);
});

test("both adapters import the one rule; neither declares its own copy", () => {
  const read = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8");
  for (const file of [
    "./browser-adapter/evidence.ts",
    "./protocol-adapter/evidence.ts",
  ]) {
    const text = read(file);
    assert.match(text, /from "\.\.\/adapter-evidence"/, `${file} imports the shared layer`);
    assert.doesNotMatch(
      text,
      /function\s+eligibilityOf\s*\(/,
      `${file} must not carry a second eligibility rule`,
    );
    assert.doesNotMatch(
      text,
      /function\s+parseTrace\s*\(/,
      `${file} must not carry a second trace parser`,
    );
    assert.doesNotMatch(text, /function\s+turnIds\s*\(/, `${file} must not carry a second turnIds`);
    assert.doesNotMatch(text, /function\s+firstRow\s*\(/, `${file} must not carry a second firstRow`);
  }
});

test("both adapters resolve the pipeline's own trace directory, not a voni/ copy", () => {
  // The service writes `<repo>/voice-pipeline/.events` (its DEFAULT_EVENTS_DIR).
  // A reader that looks under `voni/voice-pipeline/.events` finds no trace and
  // refuses a real call as if it had produced no evidence.
  const resolved = defaultEventsDir({});
  assert.match(resolved, /(^|[/\\])voice-pipeline[/\\]\.events$/, resolved);
  assert.doesNotMatch(resolved, /voni[/\\]voice-pipeline/, resolved);
  assert.ok(
    existsSync(join(resolved, "..", "server.py")),
    `the resolved directory must sit beside voice-pipeline/server.py: ${resolved}`,
  );
  assert.equal(
    defaultEventsDir({ VOICE_PIPELINE_EVENTS_DIR: "/tmp/elsewhere" }),
    "/tmp/elsewhere",
    "a configured directory still wins",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventEnvelopeError,
  EVENT_SCHEMA_VERSION,
  buildEventEnvelope,
  parseEventEnvelope,
  readEventEnvelopeFile,
} from "./event-envelope";

const FIXTURES = JSON.parse(
  readFileSync(new URL("./event-envelope.fixtures.json", import.meta.url), "utf8"),
) as {
  managedCallScoped: Record<string, unknown>;
  cascadeCallScoped: Record<string, unknown>;
  cascadeOperational: Record<string, unknown>;
};

function envelopeWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FIXTURES.cascadeCallScoped, ...overrides };
}

function refused(fn: () => unknown): EventEnvelopeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof EventEnvelopeError, `expected an EventEnvelopeError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal");
}

test("both engines carry the same envelope and differ only by the pipeline value", () => {
  const managed = parseEventEnvelope(FIXTURES.managedCallScoped, "managed.jsonl");
  const cascade = parseEventEnvelope(FIXTURES.cascadeCallScoped, "cascade.jsonl");

  assert.deepEqual(Object.keys(managed).toSorted(), Object.keys(cascade).toSorted());
  const withoutPipeline = (event: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(event).filter(([key]) => key !== "pipeline"));
  assert.deepEqual(withoutPipeline(managed), withoutPipeline(cascade));
  assert.equal(managed.pipeline, "managed");
  assert.equal(cascade.pipeline, "cascade");
});

test("an operational event carries the leg in place of subject and turn", () => {
  const operational = parseEventEnvelope(FIXTURES.cascadeOperational, "breaker.jsonl");

  assert.equal(operational.type, "breaker.transition");
  assert.equal(operational.leg, "llm");
  assert.equal("subject" in operational, false);
  assert.equal("turn" in operational, false);
});

test("an unknown schema version is refused by name, never guessed or coerced", () => {
  const cases: { version: unknown; valueName: string }[] = [
    { version: 99, valueName: "99" },
    { version: 0, valueName: "0" },
    { version: "1", valueName: '"1"' },
    { version: null, valueName: "null" },
    { version: undefined, valueName: "missing" },
  ];
  for (const { version, valueName } of cases) {
    const raw = { ...FIXTURES.cascadeCallScoped, schemaVersion: version };
    if (version === undefined) delete raw.schemaVersion;
    const error = refused(() => parseEventEnvelope(raw, "future.jsonl"));
    assert.equal(error.field, "schemaVersion", valueName);
    assert.match(error.message, new RegExp(valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(error.message, new RegExp(String(EVENT_SCHEMA_VERSION)));
  }
});

test("a missing required field is refused, not defaulted", () => {
  for (const field of ["callId", "type", "subject", "turn", "atMs", "phase"] as const) {
    const raw = { ...FIXTURES.cascadeCallScoped };
    delete raw[field];
    const error = refused(() => parseEventEnvelope(raw, `${field}.jsonl`));
    assert.equal(error.field, field, `${field} must be named`);
    assert.match(error.message, /missing required field/, `${field} must be refused as missing`);
  }
});

test("a missing pipeline discriminator is refused, not defaulted to managed", () => {
  const raw = { ...FIXTURES.cascadeCallScoped };
  delete raw.pipeline;

  const error = refused(() => parseEventEnvelope(raw, "no-pipeline.jsonl"));

  assert.equal(error.field, "pipeline");
  assert.match(error.message, /missing required field/);
});

test("an unknown pipeline or phase is refused by name", () => {
  const pipeline = refused(() => parseEventEnvelope(envelopeWith({ pipeline: "phone" }), "phone.jsonl"));
  assert.equal(pipeline.field, "pipeline");
  assert.match(pipeline.message, /"phone"/);
  assert.match(pipeline.message, /managed, cascade/);

  const phase = refused(() => parseEventEnvelope(envelopeWith({ phase: "thinking" }), "phase.jsonl"));
  assert.equal(phase.field, "phase");
  assert.match(phase.message, /"thinking"/);
  assert.match(phase.message, /connect, turn, tool, drain, end/);
});

test("an operational event cannot carry subject or turn, and a call event cannot carry a leg", () => {
  for (const field of ["subject", "turn"] as const) {
    const error = refused(() =>
      parseEventEnvelope({ ...FIXTURES.cascadeOperational, [field]: "x" }, "operational.jsonl"),
    );
    assert.equal(error.field, field);
    assert.match(error.message, /leg in place of subject and turn/);
  }

  const leg = refused(() =>
    parseEventEnvelope({ ...FIXTURES.cascadeCallScoped, leg: "llm" }, "call.jsonl"),
  );
  assert.equal(leg.field, "leg");
  assert.match(leg.message, /not a leg/);

  const missingLeg = refused(() => {
    const raw = { ...FIXTURES.cascadeOperational };
    delete raw.leg;
    return parseEventEnvelope(raw, "no-leg.jsonl");
  });
  assert.equal(missingLeg.field, "leg");
  assert.match(missingLeg.message, /missing required field/);
});

test("a managed envelope carrying a cascade-only event is refused by name", () => {
  for (const type of ["provider_fallback", "budget.crossing", "budget.stopped"]) {
    const error = refused(() => parseEventEnvelope(envelopeWith({ pipeline: "managed", type }), "managed.jsonl"));
    assert.equal(error.field, "type");
    assert.match(error.message, new RegExp(type.replace(/\./g, "\\.")));
    assert.match(error.message, /managed/);
  }
});

test("a cascade envelope carrying a managed-only field is refused by name", () => {
  const platform = refused(() =>
    parseEventEnvelope(envelopeWith({ platformCapture: { path: "a.wav", sha256: "a".repeat(64) } }), "cascade.jsonl"),
  );
  assert.equal(platform.field, "platformCapture");
  assert.match(platform.message, /cascade/);

  const vendor = refused(() =>
    parseEventEnvelope(envelopeWith({ vendorOwned: { stt: "assemblyai" } }), "cascade.jsonl"),
  );
  assert.equal(vendor.field, "vendorOwned");
  assert.match(vendor.message, /cascade/);
});

test("the writer builds the recorded envelope and runs payload fields through the one sanitizer", () => {
  const { event, rejectedKeys } = buildEventEnvelope({
    pipeline: "cascade",
    callId: "call-107",
    type: "turn.reply_start",
    subject: "demo anna (en, browser)",
    turn: "turn-1",
    atMs: 1200,
    phase: "turn",
    fields: {
      sessionId: "sess_abc",
      reason: "fallback to wss://edge:supersecret@cascade.example/ws",
      text: "caller words",
      transcript: "caller words",
      audio: "AAAA",
      pcm: "AAAA",
      token: "tok_secret",
    },
  });

  assert.deepEqual(rejectedKeys.toSorted(), ["audio", "pcm", "text", "token", "transcript"]);
  assert.deepEqual(event, {
    ...FIXTURES.cascadeCallScoped,
    sessionId: "sess_abc",
    reason: "fallback to wss://[redacted]@cascade.example/ws",
  });
  assert.doesNotMatch(JSON.stringify(event), /caller words|AAAA|tok_secret|supersecret/);
});

test("the writer refuses a payload that would overwrite the envelope, and pipeline-invalid shapes", () => {
  const collision = refused(() =>
    buildEventEnvelope({
      pipeline: "cascade",
      callId: "call-107",
      type: "turn.reply_start",
      subject: "demo anna (en, browser)",
      turn: "turn-1",
      atMs: 1200,
      phase: "turn",
      fields: { callId: "call-other" },
    }),
  );
  assert.equal(collision.field, "callId");
  assert.match(collision.message, /collides with the envelope/);

  const cascadeOnly = refused(() =>
    buildEventEnvelope({
      pipeline: "managed",
      callId: "call-107",
      type: "provider_fallback",
      subject: "demo anna (en, browser)",
      turn: null,
      atMs: 0,
      phase: "connect",
    }),
  );
  assert.equal(cascadeOnly.field, "type");
  assert.match(cascadeOnly.message, /provider_fallback/);

  const managedOnly = refused(() =>
    buildEventEnvelope({
      pipeline: "cascade",
      callId: "call-107",
      type: "turn.reply_start",
      subject: "demo anna (en, browser)",
      turn: null,
      atMs: 0,
      phase: "turn",
      fields: { platformCapture: { path: "a.wav", sha256: "a".repeat(64) } },
    }),
  );
  assert.equal(managedOnly.field, "platformCapture");
});

test("the reader refuses a stream line that still carries a forbidden key, by name", () => {
  const error = refused(() =>
    parseEventEnvelope(envelopeWith({ text: "caller words", nested: { audio: "AAAA" } }), "line.jsonl"),
  );

  assert.equal(error.field, "text");
  assert.match(error.message, /"text"/);
  assert.match(error.message, /nested\.audio/);
});

test("one reader reads a managed and a cascade stream through the same entry point", () => {
  const path = join(mkdtempSync(join(tmpdir(), "event-envelope-")), "events.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify(FIXTURES.managedCallScoped)}\n${JSON.stringify(FIXTURES.cascadeCallScoped)}\n`,
    { mode: 0o600 },
  );

  const events = readEventEnvelopeFile(path);

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.pipeline), ["managed", "cascade"]);
});

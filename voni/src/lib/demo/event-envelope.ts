/**
 * One call-event envelope, one writer, one reader (meta-cascade M12, ticket 107).
 *
 * The managed eval stream and the cascade stream are the same stream: every
 * call-scoped line carries `schemaVersion`, `pipeline`, `callId`, `type`,
 * `subject`, `turn` (a logical id or null), `atMs` and `phase`. An operational
 * event (`breaker.transition`) carries `leg` in place of `subject`/`turn`. The
 * only difference between the two engines is the `pipeline` value; a second
 * schema or a second vocabulary is a review failure.
 *
 * This module is also where the reader refuses instead of guessing: an unknown
 * schema version, an unknown pipeline or phase, a missing required field, a
 * line that still carries a forbidden key, a managed run claiming a
 * cascade-only event and a cascade run claiming a managed-only field all fail
 * by name. Payload fields on write go through the one sanitizer
 * (`event-sanitizer.ts`), so a cascade reason is redacted and caller text or
 * audio never reaches the stream.
 */
import { readFileSync } from "node:fs";
import { sanitizeEventFields } from "./event-sanitizer";
import { ShapeError, objectOf, showValue } from "./shape";

/** The one schema version this reader reads. Unknown values are refused. */
export const EVENT_SCHEMA_VERSION = 1;

/** The engine that produced the call. Both engines share every other field. */
export const EVENT_PIPELINES = ["managed", "cascade"] as const;
export type EventPipeline = (typeof EVENT_PIPELINES)[number];

export function isEventPipeline(value: unknown): value is EventPipeline {
  return typeof value === "string" && (EVENT_PIPELINES as readonly string[]).includes(value);
}

/** The call phases an event belongs to; anything else is refused. */
export const EVENT_PHASES = ["connect", "turn", "tool", "drain", "end"] as const;
export type EventPhase = (typeof EVENT_PHASES)[number];

export function isEventPhase(value: unknown): value is EventPhase {
  return typeof value === "string" && (EVENT_PHASES as readonly string[]).includes(value);
}

/** Every field a call-scoped event carries, in write order. */
export const CALL_SCOPED_EVENT_FIELDS = [
  "schemaVersion",
  "pipeline",
  "callId",
  "type",
  "subject",
  "turn",
  "atMs",
  "phase",
] as const;

/** Every field an operational event carries: `leg` replaces subject and turn. */
export const OPERATIONAL_EVENT_FIELDS = [
  "schemaVersion",
  "pipeline",
  "callId",
  "type",
  "leg",
  "atMs",
  "phase",
] as const;

/**
 * Event types that are operational, not turn events. A breaker transition has
 * no subject and no turn; it names the leg it moved.
 */
export const OPERATIONAL_EVENT_TYPES = ["breaker.transition"] as const;

export function isOperationalEventType(type: string): boolean {
  return (OPERATIONAL_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Event types only a cascade run can emit (M12). A managed run has no provider
 * choice, breaker or cascade budget to report, so a managed envelope claiming
 * one is invalid. The artifact reader shares this one list.
 */
export const CASCADE_ONLY_EVENT_TYPES = [
  "provider_fallback",
  "breaker.transition",
  "budget.crossing",
  "budget.stopped",
] as const;

export function isCascadeOnlyEvent(type: string): boolean {
  return (CASCADE_ONLY_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Fields only a managed run can populate: the platform capture leg and the
 * vendor-owned provider table (M12/M13). The cascade has neither, so a cascade
 * envelope claiming one is invalid.
 */
export const MANAGED_ONLY_EVENT_FIELDS = ["platformCapture", "vendorOwned"] as const;

/**
 * Envelope-owned names per shape. A call-scoped event owns subject/turn; an
 * operational event owns leg. `leg` is a legitimate payload field on a
 * call-scoped event (`provider_fallback` names the leg it moved), so each
 * shape reserves only its own names.
 */
const CALL_SCOPED_ENVELOPE_FIELDS: ReadonlySet<string> = new Set(CALL_SCOPED_EVENT_FIELDS);
const OPERATIONAL_ENVELOPE_FIELDS: ReadonlySet<string> = new Set(OPERATIONAL_EVENT_FIELDS);

export type CallScopedEventEnvelope = {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly pipeline: EventPipeline;
  readonly callId: string;
  readonly type: string;
  readonly subject: string;
  /** The provider turn id, or null when the event is not a turn event. */
  readonly turn: string | null;
  readonly atMs: number;
  readonly phase: EventPhase;
} & Record<string, unknown>;

export type OperationalEventEnvelope = {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly pipeline: EventPipeline;
  readonly callId: string;
  readonly type: string;
  /** The provider leg, in place of subject and turn. */
  readonly leg: string;
  readonly atMs: number;
  readonly phase: EventPhase;
} & Record<string, unknown>;

export type EventEnvelope = CallScopedEventEnvelope | OperationalEventEnvelope;

/** One refused event, named by the field and the value that failed. */
export class EventEnvelopeError extends ShapeError {
  constructor(source: string, field: string, reason: string) {
    super("EventEnvelopeError", `${source}: ${field}: ${reason}`, source, field, reason);
  }
}

function asRecord(raw: unknown, source: string): Record<string, unknown> {
  return objectOf(raw, "not an event envelope object", (reason) => {
    throw new EventEnvelopeError(source, "event", reason);
  });
}

/**
 * The version is checked before anything else: a stream from another schema is
 * refused as a whole, never read field-by-field against today's meaning.
 */
function assertSchemaVersion(record: Record<string, unknown>, source: string): void {
  if (record.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new EventEnvelopeError(
      source,
      "schemaVersion",
      `unknown schemaVersion ${showValue(record.schemaVersion)}; this reader reads ${EVENT_SCHEMA_VERSION}`,
    );
  }
}

function requireText(
  record: Record<string, unknown>,
  field: string,
  source: string,
): string {
  const value = record[field];
  if (value === undefined) {
    throw new EventEnvelopeError(source, field, `missing required field "${field}"`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new EventEnvelopeError(
      source,
      field,
      `"${field}" must be a non-empty string (${showValue(value)})`,
    );
  }
  return value;
}

function requireTurn(record: Record<string, unknown>, source: string): void {
  if (!("turn" in record) || record.turn === undefined) {
    throw new EventEnvelopeError(
      source,
      "turn",
      'missing required field "turn" (use null when the event has no turn)',
    );
  }
  const value = record.turn;
  if (value !== null && (typeof value !== "string" || value.trim() === "")) {
    throw new EventEnvelopeError(
      source,
      "turn",
      `"turn" must be a logical id or null (${showValue(value)})`,
    );
  }
}

function requirePhase(record: Record<string, unknown>, source: string): void {
  const value = record.phase;
  if (value === undefined) {
    throw new EventEnvelopeError(source, "phase", 'missing required field "phase"');
  }
  if (!isEventPhase(value)) {
    throw new EventEnvelopeError(
      source,
      "phase",
      `unknown phase ${showValue(value)}; expected one of ${EVENT_PHASES.join(", ")}`,
    );
  }
}

function requireAtMs(record: Record<string, unknown>, source: string): void {
  const value = record.atMs;
  if (value === undefined) {
    throw new EventEnvelopeError(source, "atMs", 'missing required field "atMs"');
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EventEnvelopeError(
      source,
      "atMs",
      `"atMs" must be a finite non-negative number (${showValue(value)})`,
    );
  }
}

function requirePipeline(record: Record<string, unknown>, source: string): EventPipeline {
  const value = record.pipeline;
  if (value === undefined) {
    throw new EventEnvelopeError(source, "pipeline", 'missing required field "pipeline"');
  }
  if (!isEventPipeline(value)) {
    throw new EventEnvelopeError(
      source,
      "pipeline",
      `unknown pipeline ${showValue(value)}; expected one of ${EVENT_PIPELINES.join(", ")}`,
    );
  }
  return value;
}

/**
 * The shared shape check: both the writer and the reader use it, so a line the
 * writer builds is exactly a line the reader accepts.
 */
function validateEnvelope(record: Record<string, unknown>, source: string): EventEnvelope {
  const pipeline = requirePipeline(record, source);
  requireText(record, "callId", source);
  const type = requireText(record, "type", source);
  requirePhase(record, source);
  requireAtMs(record, source);

  if (isOperationalEventType(type)) {
    if (record.subject !== undefined) {
      throw new EventEnvelopeError(
        source,
        "subject",
        `operational event "${type}" carries the leg in place of subject and turn`,
      );
    }
    if (record.turn !== undefined) {
      throw new EventEnvelopeError(
        source,
        "turn",
        `operational event "${type}" carries the leg in place of subject and turn`,
      );
    }
    requireText(record, "leg", source);
  } else {
    requireText(record, "subject", source);
    requireTurn(record, source);
  }

  if (pipeline === "managed" && isCascadeOnlyEvent(type)) {
    throw new EventEnvelopeError(
      source,
      "type",
      `managed envelope carries the cascade-only event "${type}"; a fallback-contaminated run is not a managed run`,
    );
  }
  if (pipeline === "cascade") {
    for (const field of MANAGED_ONLY_EVENT_FIELDS) {
      if (record[field] !== undefined) {
        throw new EventEnvelopeError(
          source,
          field,
          `cascade envelope carries the managed-only field "${field}"; the cascade has no platform capture and no vendor-owned provider table`,
        );
      }
    }
  }

  return record as unknown as EventEnvelope;
}

/**
 * Read one event, whoever wrote it. Pure: the caller owns the bytes. A line
 * that still carries a forbidden key is refused by name rather than trusted;
 * the writer removes those keys before it produces a line.
 */
export function parseEventEnvelope(raw: unknown, source = "event"): EventEnvelope {
  const record = asRecord(raw, source);
  assertSchemaVersion(record, source);

  const sanitized = sanitizeEventFields(record);
  if (sanitized.rejectedKeys.length > 0) {
    throw new EventEnvelopeError(
      source,
      sanitized.rejectedKeys[0],
      `forbidden event key ${sanitized.rejectedKeys.map((key) => `"${key}"`).join(", ")}; a line carrying caller text or audio is refused`,
    );
  }

  return validateEnvelope(record, source);
}

/** Read a JSONL stream; a bad line is named by its path and line number. */
export function readEventEnvelopeFile(path: string): EventEnvelope[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new EventEnvelopeError(path, "file", `cannot read event stream (${(error as Error).message})`);
  }
  const events: EventEnvelope[] = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    const source = `${path}:${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new EventEnvelopeError(
        source,
        "json",
        `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    events.push(parseEventEnvelope(parsed, source));
  });
  return events;
}

export type EventEnvelopeInput = {
  pipeline: EventPipeline;
  callId: string;
  type: string;
  atMs: number;
  phase: EventPhase;
  /** Call-scoped events name the subject; operational events do not. */
  subject?: string;
  /** A logical turn id, or null when the event has no turn. Required for call events. */
  turn?: string | null;
  /** The leg an operational event names, in place of subject and turn. */
  leg?: string;
  /** Payload fields (timings, ids, reasons); sanitized before they are written. */
  fields?: Record<string, unknown>;
};

export type BuiltEventEnvelope = {
  /** The envelope to write (or hand to the one stream writer). */
  event: EventEnvelope;
  /** Forbidden payload keys the one sanitizer dropped, by dotted path. */
  rejectedKeys: string[];
};

/**
 * Build one event. Both engines use this: only `pipeline` changes. Missing
 * required fields are refused by the shared shape check, never defaulted, and
 * payload fields are sanitized through the one module.
 */
export function buildEventEnvelope(input: EventEnvelopeInput): BuiltEventEnvelope {
  const fields = input.fields ?? {};
  const operational = isOperationalEventType(input.type);
  const reserved = operational ? OPERATIONAL_ENVELOPE_FIELDS : CALL_SCOPED_ENVELOPE_FIELDS;
  for (const key of Object.keys(fields)) {
    if (reserved.has(key)) {
      throw new EventEnvelopeError("event", key, `payload field "${key}" collides with the envelope field`);
    }
  }
  const sanitized = sanitizeEventFields(fields);
  const event: Record<string, unknown> = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    pipeline: input.pipeline,
    callId: input.callId,
    type: input.type,
    ...(operational
      ? { leg: input.leg }
      : { subject: input.subject, turn: input.turn }),
    atMs: input.atMs,
    phase: input.phase,
    ...sanitized.value,
  };
  return { event: validateEnvelope(event, "event"), rejectedKeys: sanitized.rejectedKeys };
}

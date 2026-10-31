/**
 * The scenario parser. It validates by name, never by default: every required
 * field is checked, every referenced id must exist, and every unknown field,
 * class, locale, trigger or fault is refused rather than carried through.
 *
 * The parse is pure. File existence and byte hashes belong to the corpus
 * loader, which can touch disk; this module can be exercised with one literal.
 */

import { ScenarioError } from "./errors";
import {
  CORPUS_SCHEMA_VERSION,
  EDGE_CONDITION_KINDS,
  FAULT_KINDS,
  HELD_OUT_SCENARIOS,
  LOCALES,
  SCENARIO_CLASSES,
  SCENARIO_SCHEMA_VERSION,
  TRIGGER_TYPES,
  type CorpusManifest,
  type EdgeCondition,
  type EdgeConditionKind,
  type Fault,
  type Locale,
  type ScenarioClass,
  type ScenarioDocument,
  type ScenarioTake,
  type ScriptStep,
  type Soundscape,
  type TriggerRule,
  type TriggerType,
} from "./types";

type JsonRecord = Record<string, unknown>;

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const HELD_OUT = new Set<string>(HELD_OUT_SCENARIOS);

function asRecord(value: unknown, code: "malformed-scenario" | "malformed-manifest", what: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScenarioError(code, `${what} must be an object, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
  return value as JsonRecord;
}

function refuseUnknownFields(value: JsonRecord, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ScenarioError(
        "unknown-field",
        `${what} carries unknown field "${key}"; allowed: ${allowed.join(", ")}`,
      );
    }
  }
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScenarioError("missing-field", `${what} must be a non-empty string`);
  }
  return value.trim();
}

function count(value: unknown, what: string, options: { positive?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScenarioError("missing-field", `${what} must be a finite number`);
  }
  if (options.positive ? value <= 0 : value < 0) {
    throw new ScenarioError(
      "missing-field",
      `${what} must be ${options.positive ? "greater than" : "at least"} 0, got ${value}`,
    );
  }
  return value;
}

function optionalCount(value: unknown, what: string, options: { positive?: boolean } = {}): number | undefined {
  return value === undefined ? undefined : count(value, what, options);
}

/** A signed number, for a mix level in dB; finite but otherwise unconstrained. */
function optionalSigned(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScenarioError("missing-field", `${what} must be a finite number`);
  }
  return value;
}

/**
 * A take's audio path is relative to its scenario directory and may never
 * escape it: an absolute path or a `..` segment would let a scenario read a
 * file the corpus does not own.
 */
function safeTakePath(value: unknown, what: string): string {
  const path = text(value, what);
  const segments = path.split("/");
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\") || segments.includes("..")) {
    throw new ScenarioError(
      "unsafe-take-path",
      `${what} "${path}" must be a relative path inside the scenario directory`,
    );
  }
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (normalized.length === 0) {
    throw new ScenarioError("unsafe-take-path", `${what} "${path}" names no file`);
  }
  return normalized;
}

function parseTrigger(raw: unknown, what: string): TriggerRule {
  const record = asRecord(raw, "malformed-scenario", what);
  const type = record.type;
  if (typeof type !== "string" || !(TRIGGER_TYPES as readonly string[]).includes(type)) {
    throw new ScenarioError(
      "unknown-trigger",
      `${what} names unknown trigger type "${String(type)}"; known types: ${TRIGGER_TYPES.join(", ")}`,
    );
  }
  const trigger = type as TriggerType;
  switch (trigger) {
    case "call-open":
    case "agent-speech-start":
    case "agent-turn-end": {
      refuseUnknownFields(record, ["type", "delayMs"], `${what} (${trigger})`);
      const delayMs = optionalCount(record.delayMs, `${what}.delayMs`);
      return delayMs === undefined ? { type: trigger } : { type: trigger, delayMs };
    }
    case "silence": {
      refuseUnknownFields(record, ["type", "silenceMs", "delayMs"], `${what} (${trigger})`);
      if (record.silenceMs === undefined) {
        throw new ScenarioError("missing-field", `${what} (${trigger}) requires silenceMs`);
      }
      const silenceMs = count(record.silenceMs, `${what}.silenceMs`);
      const delayMs = optionalCount(record.delayMs, `${what}.delayMs`);
      return delayMs === undefined ? { type: trigger, silenceMs } : { type: trigger, silenceMs, delayMs };
    }
    case "at-offset": {
      refuseUnknownFields(record, ["type", "atMs"], `${what} (${trigger})`);
      if (record.atMs === undefined) {
        throw new ScenarioError("missing-field", `${what} (${trigger}) requires atMs`);
      }
      return { type: trigger, atMs: count(record.atMs, `${what}.atMs`) };
    }
    default: {
      const exhaustive: never = trigger;
      throw new ScenarioError("unknown-trigger", `${what} names unknown trigger type "${String(exhaustive)}"`);
    }
  }
}

function parseTake(raw: unknown, what: string): ScenarioTake {
  const record = asRecord(raw, "malformed-scenario", what);
  refuseUnknownFields(record, ["id", "audio", "sha256", "text"], what);
  const id = text(record.id, `${what}.id`);
  const audio = safeTakePath(record.audio, `${what}.audio`);
  const sha256 = text(record.sha256, `${what}.sha256`).toLowerCase();
  if (!HEX_64.test(sha256)) {
    throw new ScenarioError(
      "invalid-hash",
      `${what} (take "${id}") sha256 must be 64 lowercase hex characters, got "${sha256}"`,
    );
  }
  if (record.text !== undefined && typeof record.text !== "string") {
    throw new ScenarioError("missing-field", `${what}.text must be a string when present`);
  }
  return record.text === undefined ? { id, audio, sha256 } : { id, audio, sha256, text: record.text };
}

function parseSoundscape(raw: unknown): Soundscape {
  if (raw === undefined) {
    throw new ScenarioError("missing-field", "scenario requires a soundscape");
  }
  const record = asRecord(raw, "malformed-scenario", "soundscape");
  refuseUnknownFields(record, ["id", "levelDb"], "soundscape");
  const id = text(record.id, "soundscape.id");
  const levelDb = optionalSigned(record.levelDb, "soundscape.levelDb");
  return levelDb === undefined ? { id } : { id, levelDb };
}

function parseFault(raw: unknown, what: string): Fault {
  const record = asRecord(raw, "malformed-scenario", what);
  refuseUnknownFields(record, ["kind", "atMs", "durationMs"], what);
  const kind = record.kind;
  if (typeof kind !== "string" || !(FAULT_KINDS as readonly string[]).includes(kind)) {
    throw new ScenarioError(
      "unknown-fault",
      `${what} names unknown fault kind "${String(kind)}"; known kinds: ${FAULT_KINDS.join(", ")}`,
    );
  }
  if (record.atMs === undefined) {
    throw new ScenarioError("invalid-fault", `${what} (${kind}) requires atMs`);
  }
  const atMs = count(record.atMs, `${what}.atMs`);
  const durationMs = optionalCount(record.durationMs, `${what}.durationMs`, { positive: true });
  return durationMs === undefined
    ? { kind: kind as Fault["kind"], atMs }
    : { kind: kind as Fault["kind"], atMs, durationMs };
}

function parseEdge(raw: unknown, what: string): EdgeCondition {
  const record = asRecord(raw, "malformed-scenario", what);
  refuseUnknownFields(record, ["kind", "atMs", "durationMs"], what);
  const kind = record.kind;
  if (typeof kind !== "string" || !(EDGE_CONDITION_KINDS as readonly string[]).includes(kind)) {
    throw new ScenarioError(
      "unknown-edge-condition",
      `${what} names unknown edge condition "${String(kind)}"; known conditions: ${EDGE_CONDITION_KINDS.join(", ")}`,
    );
  }
  if (record.atMs === undefined) {
    throw new ScenarioError("invalid-edge-condition", `${what} (${kind}) requires atMs`);
  }
  const atMs = count(record.atMs, `${what}.atMs`);
  const durationMs = optionalCount(record.durationMs, `${what}.durationMs`, { positive: true });
  return durationMs === undefined
    ? { kind: kind as EdgeConditionKind, atMs }
    : { kind: kind as EdgeConditionKind, atMs, durationMs };
}

export type ParseScenarioOptions = {
  /**
   * Every id the contract owns. Required: the check is the point, so a caller
   * cannot parse a scenario that cites a property nothing judges.
   */
  readonly knownProperties: ReadonlySet<string> | Iterable<string>;
};

/** Validate one scenario document against the contract's property ids. */
export function parseScenario(raw: unknown, options: ParseScenarioOptions): ScenarioDocument {
  const record = asRecord(raw, "malformed-scenario", "scenario");
  refuseUnknownFields(
    record,
    [
      "schemaVersion",
      "name",
      "class",
      "locale",
      "heldOut",
      "expectedProperties",
      "soundscape",
      "faults",
      "edge",
      "takes",
      "script",
    ],
    "scenario",
  );

  const schemaVersion = count(record.schemaVersion, "scenario.schemaVersion", { positive: true });
  if (schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    throw new ScenarioError(
      "malformed-scenario",
      `scenario declares schema version ${schemaVersion}; this loader reads version ${SCENARIO_SCHEMA_VERSION}`,
    );
  }

  const name = text(record.name, "scenario.name");
  if (!SAFE_NAME.test(name)) {
    throw new ScenarioError(
      "invalid-name",
      `scenario name "${name}" must match ${SAFE_NAME.source} so it can be a directory and a selector`,
    );
  }

  const classId = text(record.class, "scenario.class");
  if (!(SCENARIO_CLASSES as readonly string[]).includes(classId)) {
    throw new ScenarioError(
      "unknown-class",
      `scenario "${name}" names unknown class "${classId}"; known classes: ${SCENARIO_CLASSES.join(", ")}`,
    );
  }
  const locale = text(record.locale, "scenario.locale");
  if (!(LOCALES as readonly string[]).includes(locale)) {
    throw new ScenarioError(
      "unknown-locale",
      `scenario "${name}" names unknown locale "${locale}"; known locales: ${LOCALES.join(", ")}`,
    );
  }

  if (typeof record.heldOut !== "boolean") {
    throw new ScenarioError("missing-field", `scenario "${name}" must declare heldOut as a boolean`);
  }
  const heldOut = record.heldOut;
  const sealed = HELD_OUT.has(name);
  if (sealed !== heldOut) {
    throw new ScenarioError(
      "held-out-mismatch",
      sealed
        ? `scenario "${name}" is on the held-out list and must declare heldOut: true`
        : `scenario "${name}" declares heldOut: true but is not on the spec's held-out list; ` +
          `sealed names: ${HELD_OUT_SCENARIOS.join(", ")}`,
    );
  }

  if (record.expectedProperties === undefined) {
    throw new ScenarioError("missing-field", `scenario "${name}" requires expectedProperties`);
  }
  if (!Array.isArray(record.expectedProperties) || record.expectedProperties.length === 0) {
    throw new ScenarioError(
      "empty-properties",
      `scenario "${name}" must cite at least one contract property; a scenario that measures nothing is not a scenario`,
    );
  }
  const known = new Set(options.knownProperties);
  const seenProperties = new Set<string>();
  const expectedProperties: string[] = [];
  for (const [index, value] of record.expectedProperties.entries()) {
    const id = text(value, `scenario "${name}" expectedProperties[${index}]`);
    if (seenProperties.has(id)) {
      throw new ScenarioError("duplicate-property", `scenario "${name}" cites property "${id}" twice`);
    }
    if (!known.has(id)) {
      throw new ScenarioError(
        "unknown-property",
        `scenario "${name}" cites unknown contract property "${id}"; the contract has ${known.size} ids`,
      );
    }
    seenProperties.add(id);
    expectedProperties.push(id);
  }

  if (record.takes === undefined) {
    throw new ScenarioError("missing-field", `scenario "${name}" requires takes`);
  }
  if (!Array.isArray(record.takes) || record.takes.length === 0) {
    throw new ScenarioError(
      "empty-scenario",
      `scenario "${name}" declares no takes; a scenario directory with no caller audio has nothing to run`,
    );
  }
  const seenTakes = new Set<string>();
  const takes: ScenarioTake[] = [];
  for (const [index, value] of record.takes.entries()) {
    const take = parseTake(value, `scenario "${name}" takes[${index}]`);
    if (seenTakes.has(take.id)) {
      throw new ScenarioError("duplicate-take", `scenario "${name}" declares take "${take.id}" twice`);
    }
    seenTakes.add(take.id);
    takes.push(take);
  }

  if (record.script === undefined) {
    throw new ScenarioError("missing-field", `scenario "${name}" requires script`);
  }
  if (!Array.isArray(record.script) || record.script.length === 0) {
    throw new ScenarioError(
      "empty-script",
      `scenario "${name}" declares no script; a take with no trigger rule is never spoken`,
    );
  }
  const script: ScriptStep[] = [];
  for (const [index, value] of record.script.entries()) {
    const what = `scenario "${name}" script[${index}]`;
    const step = asRecord(value, "malformed-scenario", what);
    refuseUnknownFields(step, ["take", "trigger"], what);
    const takeId = text(step.take, `${what}.take`);
    if (!seenTakes.has(takeId)) {
      throw new ScenarioError(
        "unknown-take",
        `${what} references unknown take "${takeId}"; takes: ${[...seenTakes].join(", ")}`,
      );
    }
    script.push({ take: takeId, trigger: parseTrigger(step.trigger, `${what}.trigger`) });
  }

  let faults: Fault[] = [];
  if (record.faults === undefined) {
    throw new ScenarioError("missing-field", `scenario "${name}" requires faults (an empty list is valid)`);
  }
  if (!Array.isArray(record.faults)) {
    throw new ScenarioError("malformed-scenario", `scenario "${name}" faults must be an array`);
  }
  faults = record.faults.map((value, index) => parseFault(value, `scenario "${name}" faults[${index}]`));

  let edge: EdgeCondition[] = [];
  if (record.edge !== undefined) {
    if (!Array.isArray(record.edge)) {
      throw new ScenarioError("malformed-scenario", `scenario "${name}" edge must be an array`);
    }
    edge = record.edge.map((value, index) =>
      parseEdge(value, `scenario "${name}" edge[${index}]`),
    );
  }

  return {
    schemaVersion,
    name,
    class: classId as ScenarioClass,
    locale: locale as Locale,
    heldOut,
    expectedProperties,
    soundscape: parseSoundscape(record.soundscape),
    faults,
    edge,
    takes,
    script,
  };
}

/** Validate a corpus manifest; the version only moves on a comparability change. */
export function parseCorpusManifest(raw: unknown): CorpusManifest {
  const record = asRecord(raw, "malformed-manifest", "corpus manifest");
  refuseUnknownFields(record, ["schemaVersion", "version"], "corpus manifest");
  const schemaVersion = count(record.schemaVersion, "corpus manifest.schemaVersion", { positive: true });
  if (schemaVersion !== CORPUS_SCHEMA_VERSION) {
    throw new ScenarioError(
      "malformed-manifest",
      `corpus manifest declares schema version ${schemaVersion}; this loader reads version ${CORPUS_SCHEMA_VERSION}`,
    );
  }
  const version = count(record.version, "corpus manifest.version", { positive: true });
  return { schemaVersion, version };
}

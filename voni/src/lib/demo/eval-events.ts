/**
 * Opt-in machine-readable event stream for the live demo eval (retro #9).
 *
 * `npm run eval:demo-agent -- --events /tmp/eval-events.jsonl` writes one JSON
 * object per line for the decisions a scoreboard reader triages: scenario
 * start/end, session ready, reply create/first audio, cuts, tool calls and
 * results, end_call, the goodbye drain, the hang-up and the overheard aside.
 * `npm run scoreboard:inspect --events <path>` summarizes the same file.
 *
 * The stream is a debugging/telemetry seam, never a scoreboard input: the
 * artifact's structured `runnerEvidence` stays the source of truth for gates.
 * Lines carry timings and ids only — no API keys, no tokens, no caller audio
 * (PCM bytes) and no raw transcript text. The writer strips known secret keys
 * and redacts key-shaped values so a careless call site cannot leak one.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Every event type the eval stream may carry, in triage order. */
export const EVAL_EVENT_TYPES = [
  "scenario.start",
  "session.ready",
  "reply.create",
  "reply.first_audio",
  "cut",
  "tool.call",
  "tool.result",
  "end_call",
  "goodbye.drain",
  "hangup",
  "aside",
  "scenario.end",
] as const;

export type EvalEventType = (typeof EVAL_EVENT_TYPES)[number];

/** One stream line: caller-supplied fields plus the run-relative timestamp. */
export type EvalEvent = { atMs: number; type: EvalEventType } & Record<string, unknown>;

/** Fields that may never appear on a line, whatever the call site passes. */
const FORBIDDEN_EVENT_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "password",
  "token",
  "accesstoken",
  "access_token",
  "pcm",
  "audio",
  "data",
  "base64",
]);

const KEY_SHAPED_VALUE = /\b(?:sk|pk|api|tok)_[A-Za-z0-9_-]{8,}\b|Bearer\s+\S+/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (typeof value === "string") {
    const redacted = value.replace(KEY_SHAPED_VALUE, "[redacted]");
    return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_EVENT_KEYS.has(key.toLowerCase())) continue;
      out[key] = sanitizeValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

export type EvalEventWriter = {
  /** The file this writer appends to, or null for the disabled stream. */
  readonly path: string | null;
  /**
   * Append one line. `atMs` defaults to ms since the writer started; call
   * sites may pass their own call-relative value. Returns the written line
   * (null when the stream is disabled).
   */
  emit: (type: EvalEventType, fields?: Record<string, unknown> & { atMs?: number }) => EvalEvent | null;
  close: () => void;
};

/**
 * Create the stream. A null/empty path is a no-op writer, so the eval never
 * pays for a file it did not ask for. A real path is created (and truncated)
 * up front: a run that crashes still leaves every line written before it.
 */
export function createEvalEventWriter(
  path: string | null | undefined,
  options: { now?: () => number; startedAtMs?: number } = {},
): EvalEventWriter {
  if (!path) {
    return { path: null, emit: () => null, close: () => undefined };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { mode: 0o600 });
  const now = options.now ?? Date.now;
  const startedAt = options.startedAtMs ?? now();
  return {
    path,
    emit: (type, fields = {}) => {
      if (!(EVAL_EVENT_TYPES as readonly string[]).includes(type)) {
        throw new Error(`unknown eval event type "${String(type)}"`);
      }
      const { atMs, ...rest } = fields;
      const event: EvalEvent = {
        atMs: Number.isFinite(atMs) ? Number(atMs) : Math.max(0, Math.round(now() - startedAt)),
        type,
        ...(sanitizeValue(rest) as Record<string, unknown>),
      };
      appendFileSync(path, `${JSON.stringify(event)}\n`);
      return event;
    },
    close: () => undefined,
  };
}

/**
 * Read a JSONL stream back for `scoreboard:inspect --events <path>`. A
 * malformed line throws with its number: a truncated stream is visible, never
 * silently skipped. Blank lines are ignored.
 */
export function readEvalEvents(path: string): EvalEvent[] {
  const text = readFileSync(path, "utf8");
  const events: EvalEvent[] = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `events ${path}:${index + 1}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`events ${path}:${index + 1}: line is not a JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== "string" || !(EVAL_EVENT_TYPES as readonly string[]).includes(record.type)) {
      throw new Error(`events ${path}:${index + 1}: unknown event type "${String(record.type)}"`);
    }
    if (typeof record.atMs !== "number" || !Number.isFinite(record.atMs)) {
      throw new Error(`events ${path}:${index + 1}: atMs must be a finite number`);
    }
    events.push({ ...record, atMs: record.atMs, type: record.type as EvalEventType });
  });
  return events;
}

export type EvalEventSummary = {
  /** Lines read. */
  total: number;
  /** One count per event type that appeared (all types, zero omitted). */
  counts: Partial<Record<EvalEventType, number>>;
  /** Sequence of the triage decisions, in stream order. */
  timeline: { atMs: number; type: EvalEventType; detail: string }[];
};

/** Event types worth showing as a timeline; lifecycle noise stays in counts. */
const TIMELINE_TYPES: readonly EvalEventType[] = [
  "cut",
  "tool.call",
  "tool.result",
  "end_call",
  "goodbye.drain",
  "hangup",
  "aside",
];

function eventDetail(event: EvalEvent): string {
  const parts: string[] = [];
  if (typeof event.sessionId === "string") parts.push(event.sessionId);
  if (typeof event.scenario === "string") parts.push(event.scenario);
  if (event.type === "cut") {
    if (typeof event.cutMs === "number") parts.push(`cut ${event.cutMs}ms`);
    if (typeof event.overlapMs === "number") parts.push(`overlap ${event.overlapMs}ms`);
  }
  if (event.type === "tool.call" || event.type === "tool.result") {
    if (typeof event.name === "string") parts.push(event.name);
    if (event.type === "tool.result") parts.push(event.ok === true ? "ok" : "error");
  }
  if (event.type === "goodbye.drain") {
    if (typeof event.coverage === "number") parts.push(`coverage ${event.coverage.toFixed(2)}`);
    if (event.inboxNamed === true) parts.push("inbox named");
    if (event.narratedEnding === true) parts.push("narrated ending");
  }
  if (event.type === "hangup" && typeof event.delayMs === "number") parts.push(`${event.delayMs}ms`);
  if (event.type === "aside") {
    if (typeof event.cutMs === "number") parts.push(`cut ${event.cutMs}ms`);
  }
  return parts.join(" ");
}

/** Compact counts plus the cut/tool/drain/aside timeline. */
export function summarizeEvalEvents(events: EvalEvent[]): EvalEventSummary {
  const counts: Partial<Record<EvalEventType, number>> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return {
    total: events.length,
    counts,
    timeline: events
      .filter((event) => TIMELINE_TYPES.includes(event.type))
      .map((event) => ({ atMs: event.atMs, type: event.type, detail: eventDetail(event) })),
  };
}

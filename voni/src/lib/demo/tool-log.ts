/**
 * The demo's tool log: one redacted fact row per model-requested tool call.
 *
 * The cascade trace records that a tool was called and whether it succeeded;
 * it deliberately carries no payload. The X properties need a little more —
 * did `check_email` find the mail or fire the personal-domain gate, did the
 * reply go out, was this sender returning, and how long did the hop take — and
 * none of that may become a second copy of the caller's address, name or a
 * tool's prose. This module owns the one summary shape and its redaction.
 *
 * A tool that is not in the closed vocabulary is refused by name: a log that
 * guesses an unknown result's meaning cannot be evidence.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Tools and email" X1–X10 and
 * "Ground truth comes first".
 */

/** The tools whose result facts the X properties read. */
export const LOGGED_TOOL_NAMES = [
  "check_email",
  "send_code_reply",
  "check_code",
  "show_test_address",
  "end_call",
  "hang_up",
] as const;

export type LoggedToolName = (typeof LOGGED_TOOL_NAMES)[number];

/** Why a result or a row cannot be evidence. Each code is stable and named. */
export const TOOL_LOG_ERROR_CODES = [
  "unknown-tool",
  "malformed-result",
  "malformed-entry",
] as const;

export type ToolLogErrorCode = (typeof TOOL_LOG_ERROR_CODES)[number];

export class ToolLogError extends Error {
  readonly code: ToolLogErrorCode;

  constructor(code: ToolLogErrorCode, message: string) {
    super(message);
    this.name = "ToolLogError";
    this.code = code;
  }
}

/** The closed set of email outcomes a demo call may record. */
export const EMAIL_STATUSES = ["found", "free", "not_arrived", "invalid"] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** What one tool call did, with every caller-supplied value removed. */
export type ToolResultFacts = {
  /** The email outcome when the tool is `check_email`; otherwise null. */
  readonly status: EmailStatus | null;
  /** True when the matched sender had matched an earlier tag. */
  readonly returning: boolean;
  /** True when the tool's effect was a sent reply email. */
  readonly sent: boolean;
  readonly ok: boolean;
  /** The tool's closed failure code, when it gave one. */
  readonly code: string | null;
};

/** One row as the reader hands it over: facts plus ids and timing only. */
export type ToolLogRow = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: EmailStatus | null;
  readonly returning: boolean;
  readonly sent: boolean;
  readonly ok: boolean;
  readonly code: string | null;
  readonly latencyMs: number | null;
  /** 1 for the first attempt; more when the same tool id was replayed. */
  readonly attempts: number;
  readonly createdAt: string | null;
};

/** Which credential answered: only the pipeline's model calls are evidence. */
export const TOOL_CREDENTIALS = ["browser", "service"] as const;

export type ToolCredential = (typeof TOOL_CREDENTIALS)[number];

/** What the store writes: the call and the model's tool id plus the facts. */
export type ToolLogEntry = ToolResultFacts & {
  readonly callId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly credential: ToolCredential;
  readonly latencyMs: number | null;
};

/** One stored row before the reader normalises it. */
export type StoredToolLogRow = {
  readonly toolCallId: string;
  readonly toolName: string;
  /** The database column is free text; `normalizeToolLogRow` validates it. */
  readonly status: string | null;
  readonly returning: boolean;
  readonly sent: boolean;
  readonly ok: boolean;
  readonly code: string | null;
  readonly latencyMs: number | null;
  readonly attempts: number;
  readonly createdAt: Date | string | null;
};

const ROW_FIELDS = new Set([
  "toolCallId",
  "toolName",
  "status",
  "returning",
  "sent",
  "ok",
  "code",
  "latencyMs",
  "attempts",
  "createdAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLoggedName(value: string): value is LoggedToolName {
  return (LOGGED_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * Summarise one route response. Only the facts above survive; the address, the
 * name, the instructions, the warm line and every other payload field are
 * dropped here and never reach a trace or a certificate.
 */
export function summarizeToolResult(name: string, raw: unknown): ToolResultFacts {
  if (!isLoggedName(name)) {
    throw new ToolLogError(
      "unknown-tool",
      `tool "${name}" is not in the logged vocabulary (${LOGGED_TOOL_NAMES.join(", ")}); ` +
        "an unknown result has no fact shape and cannot be evidence",
    );
  }
  if (!isRecord(raw)) {
    throw new ToolLogError("malformed-result", `tool "${name}" returned no result object`);
  }
  const ok = raw.ok === true;
  const data = isRecord(raw.data) ? raw.data : {};
  const status =
    name === "check_email" && typeof data.status === "string" &&
    (EMAIL_STATUSES as readonly string[]).includes(data.status)
      ? (data.status as EmailStatus)
      : null;
  if (name === "check_email" && ok && status === null) {
    throw new ToolLogError(
      "malformed-result",
      "a successful check_email result carries no known status; the gate and the delivery " +
        "cannot be inferred from a missing one",
    );
  }
  return {
    status,
    returning: data.returning === true,
    sent: name === "send_code_reply" && data.sent === true,
    ok,
    code: text(data.code) === "" ? null : text(data.code),
  };
}

/** Build the one insert row a model-requested demo tool call writes. */
export function toolLogEntry(input: {
  readonly callId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly credential: string;
  readonly result: unknown;
  readonly latencyMs: number;
}): ToolLogEntry {
  if (input.callId.trim() === "") {
    throw new ToolLogError("malformed-entry", "a tool call to log has no call id");
  }
  if (input.toolCallId.trim() === "") {
    throw new ToolLogError("malformed-entry", "a tool call to log has no toolCallId");
  }
  if (!(TOOL_CREDENTIALS as readonly string[]).includes(input.credential)) {
    throw new ToolLogError(
      "malformed-entry",
      `a tool call to log names unknown credential "${input.credential}"`,
    );
  }
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
    throw new ToolLogError("malformed-entry", "a tool call to log has a bad latency");
  }
  return {
    callId: input.callId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    credential: input.credential as ToolCredential,
    ...summarizeToolResult(input.toolName, input.result),
    latencyMs: Math.round(input.latencyMs),
  };
}

/** Map one stored row to the reader's shape; a Date becomes its ISO string. */
export function toolLogRowFromStored(row: StoredToolLogRow): ToolLogRow {
  return normalizeToolLogRow({
    ...row,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  });
}

/** Validate one stored row and refuse any field that is not this shape. */
export function normalizeToolLogRow(raw: unknown): ToolLogRow {
  if (!isRecord(raw)) {
    throw new ToolLogError("malformed-entry", "a tool log row is not an object");
  }
  for (const key of Object.keys(raw)) {
    if (!ROW_FIELDS.has(key)) {
      throw new ToolLogError(
        "malformed-entry",
        `a tool log row carries unknown field "${key}"; the log stores facts, never a payload`,
      );
    }
  }
  const toolCallId = text(raw.toolCallId);
  if (toolCallId === "") {
    throw new ToolLogError("malformed-entry", "a tool log row has no toolCallId");
  }
  const toolName = text(raw.toolName);
  if (toolName === "") {
    throw new ToolLogError("malformed-entry", "a tool log row names no tool");
  }
  if (!isLoggedName(toolName)) {
    throw new ToolLogError(
      "unknown-tool",
      `a tool log row names tool "${toolName}", which is not in the logged vocabulary`,
    );
  }
  if (typeof raw.ok !== "boolean") {
    throw new ToolLogError("malformed-entry", `tool log row "${toolCallId}" does not say whether it succeeded`);
  }
  const status = raw.status;
  if (status !== null && (typeof status !== "string" || !(EMAIL_STATUSES as readonly string[]).includes(status))) {
    throw new ToolLogError("malformed-entry", `tool log row "${toolCallId}" has an unknown email status`);
  }
  for (const field of ["returning", "sent"] as const) {
    if (typeof raw[field] !== "boolean") {
      throw new ToolLogError("malformed-entry", `tool log row "${toolCallId}" does not say ${field}`);
    }
  }
  const latencyMs = raw.latencyMs;
  if (latencyMs !== null && (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0)) {
    throw new ToolLogError("malformed-entry", `tool log row "${toolCallId}" has a bad latencyMs`);
  }
  const attempts = raw.attempts;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) {
    throw new ToolLogError("malformed-entry", `tool log row "${toolCallId}" has a bad attempt count`);
  }
  const createdAt = raw.createdAt;
  if (createdAt !== null && (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt)))) {
    throw new ToolLogError("malformed-entry", `tool log row "${toolCallId}" has a bad createdAt`);
  }
  const code = raw.code;
  if (code !== null && typeof code !== "string") {
    throw new ToolLogError("malformed-entry", `tool log row "${toolCallId}" has a non-string code`);
  }
  return {
    toolCallId,
    toolName,
    status: (status as EmailStatus | null) ?? null,
    returning: raw.returning === true,
    sent: raw.sent === true,
    ok: raw.ok === true,
    code: code === null || code.trim() === "" ? null : code.trim(),
    latencyMs: (latencyMs as number | null) ?? null,
    attempts,
    createdAt: (createdAt as string | null) ?? null,
  };
}

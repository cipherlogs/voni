/**
 * Reading the lifecycle family's evidence without trusting a declared shape.
 *
 * Every evaluator reads the one source the contract names, then cross-checks
 * the browser marks, the trace and the persisted end message. A missing or
 * malformed source is a named `LifecycleEvidenceError`, which the evaluator
 * turns into `unmeasured`; the verdict engine then fails the property closed.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Lifecycle and connect".
 */

import type { CallMarksArtifact, CallMark } from "@/lib/voice/call-marks";

import type { EvidenceBundle } from "../types";

export const LIFECYCLE_EVIDENCE_ERROR_CODES = [
  "missing-marks",
  "malformed-marks",
  "missing-trace",
  "malformed-trace",
  "missing-end",
  "malformed-end",
  "missing-wav",
  "malformed-wav",
  "mark-audio-disagree",
] as const;

export type LifecycleEvidenceErrorCode = (typeof LIFECYCLE_EVIDENCE_ERROR_CODES)[number];

export class LifecycleEvidenceError extends Error {
  readonly code: LifecycleEvidenceErrorCode;

  constructor(code: LifecycleEvidenceErrorCode, message: string) {
    super(message);
    this.name = "LifecycleEvidenceError";
    this.code = code;
  }
}

export type Row = Record<string, unknown>;

export function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsOf(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRow);
}

/**
 * The browser marks. The certifying bundle carries them twice (beside the WAV
 * and in the ledger); either is the same artifact. A bundle with neither has no
 * visitor timeline and cannot be judged.
 */
export function readMarks(evidence: EvidenceBundle): CallMarksArtifact {
  const browser = evidence.browser;
  const fromBrowser = isRow(browser) ? browser.marks : undefined;
  if (isRow(fromBrowser) && Array.isArray(fromBrowser.marks)) {
    return fromBrowser as unknown as CallMarksArtifact;
  }
  const ledger = evidence.ledger;
  const fromLedger = isRow(ledger) ? ledger.marks : undefined;
  if (isRow(fromLedger) && Array.isArray(fromLedger.marks)) {
    return fromLedger as unknown as CallMarksArtifact;
  }
  throw new LifecycleEvidenceError(
    "missing-marks",
    "the browser marks are missing; the visitor timeline cannot be judged",
  );
}

export function marksNamed(marks: CallMarksArtifact, name: string): CallMark[] {
  return marks.marks.filter((mark) => mark.name === name);
}

export function firstMark(marks: CallMarksArtifact, name: string): CallMark | null {
  return marksNamed(marks, name)[0] ?? null;
}

export function lastMark(marks: CallMarksArtifact, name: string): CallMark | null {
  const named = marksNamed(marks, name);
  return named[named.length - 1] ?? null;
}

export function markGapMs(from: CallMark, to: CallMark): number {
  return to.tMs - from.tMs;
}

/** The trace rows one call wrote; the pipeline writes one JSONL per call. */
export function readTrace(evidence: EvidenceBundle): Row[] {
  const trace = evidence.trace;
  if (!isRow(trace)) {
    throw new LifecycleEvidenceError(
      "missing-trace",
      "the trace is missing; the service's own lifecycle rows cannot be read",
    );
  }
  const rows = rowsOf(trace.rows);
  if (rows.length === 0) {
    throw new LifecycleEvidenceError(
      "missing-trace",
      "the trace has no rows; a call with no trace is not evidence",
    );
  }
  return rows;
}

/** The persisted end message: the one document production sent. */
export function readEnd(evidence: EvidenceBundle): Row {
  const ledger = evidence.ledger;
  if (!isRow(ledger)) {
    throw new LifecycleEvidenceError("missing-end", "the ledger evidence is missing");
  }
  const end = ledger.end;
  if (!isRow(end)) {
    throw new LifecycleEvidenceError(
      "missing-end",
      "the persisted end message is missing; the run never trusts a trace row alone",
    );
  }
  return end;
}

export function readWav(evidence: EvidenceBundle): { file: string; durationMs: number } {
  const wav = evidence.wav;
  if (!isRow(wav) || typeof wav.file !== "string" || wav.file.trim() === "") {
    throw new LifecycleEvidenceError(
      "missing-wav",
      "the delivered WAV is missing; the visitor's audio cannot be judged",
    );
  }
  const durationMs = wav.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new LifecycleEvidenceError(
      "malformed-wav",
      `the delivered WAV at ${wav.file} declares durationMs=${String(durationMs)}`,
    );
  }
  return { file: wav.file, durationMs };
}

export function traceRowOfType(rows: readonly Row[], type: string): Row | null {
  return rows.find((row) => row.type === type) ?? null;
}

export function traceRowsOfType(rows: readonly Row[], type: string): Row[] {
  return rows.filter((row) => row.type === type);
}

export function reasonOf(error: unknown): string {
  if (error instanceof LifecycleEvidenceError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function detailText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "?";
}

export function endError(end: Row): Row | null {
  return isRow(end.error) ? end.error : null;
}

export function endGreeting(end: Row): Row | null {
  return isRow(end.greeting) ? end.greeting : null;
}

export function endGoodbye(end: Row): Row | null {
  return isRow(end.goodbye) ? end.goodbye : null;
}

/** The end document's own metrics marks, in seconds from the pipeline clock. */
export function metricMarks(end: Row): Row {
  const metrics = isRow(end.metrics) ? end.metrics : null;
  const marks = metrics !== null && isRow(metrics.marks) ? metrics.marks : null;
  return marks ?? {};
}

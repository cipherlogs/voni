/**
 * Evidence assembly for one certifying browser call.
 *
 * A browser run has four artifacts and they must all name the same call: the
 * delivered WAV the playout worklet rendered, the browser marks the visitor's
 * client posted, the trace the pipeline wrote and the end document beside it.
 * The runner copies each into the per-call directory and refuses by name when
 * one is missing, malformed, incomplete or bound to a different call.
 *
 * Cost is the call's own `cost.priced` row, copied verbatim; the runner never
 * recomputes it. The delivered WAV is required: unlike the protocol adapter's
 * optional received PCM, a certifying run without the delivered audio has not
 * heard what the visitor heard.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Ground truth comes first" and
 * "Evidence artifacts".
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  CALL_LEVEL_PROPERTY_IDS,
  buildDefectCards,
  DefectCardError,
  type AudioExcerpt,
  type CallEvidence,
  type DefectCard,
  type TurnEvidence,
} from "@/lib/demo/verification/cards";
import type { LoadedScenario } from "@/lib/demo/verification/scenarios";
import type { CallEligibilityFact, RunVerdict } from "@/lib/demo/verification/verdict";
import type { ToolLogRow } from "@/lib/demo/tool-log";
import type { InboxDelivery } from "@/lib/demo/verification/tools/inbox";
import {
  isCallMarksArtifact,
  type CallMarksArtifact,
} from "@/lib/voice/call-marks";

import { BrowserAdapterError } from "./errors";
import { requireSafeId, runDirectory, writeJson } from "../protocol-adapter/evidence";
import type {
  AssembledBrowserEvidence,
  BrowserCallRecord,
  BrowserCallResult,
  BrowserCardGap,
  BrowserEvidenceBundle,
  BrowserTargetLabel,
} from "./types";

export { requireSafeId, runDirectory, writeJson };

/** A standard RIFF/WAVE PCM header, read from the file's own bytes. */
export type WavFacts = {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly frames: number;
  readonly durationMs: number;
  readonly bytes: number;
};

function ascii(bytes: Buffer, at: number, length: number): string {
  return bytes.toString("ascii", at, at + length);
}

/** Read the delivered WAV's format; a malformed capture is a named refusal. */
export function readWavFacts(file: string): WavFacts {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new BrowserAdapterError(
      "capture-missing",
      `cannot read the delivered capture at ${file}: ${(error as Error).message}`,
    );
  }
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new BrowserAdapterError(
      "capture-malformed",
      `the delivered capture at ${file} is not a RIFF/WAVE file`,
    );
  }
  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = bytes.readUInt32LE(at + 4);
    const payload = at + 8;
    if (id === "fmt ") {
      if (size < 16 || payload + 16 > bytes.length) {
        throw new BrowserAdapterError(
          "capture-malformed",
          `the delivered capture at ${file} has a truncated fmt chunk`,
        );
      }
      channels = bytes.readUInt16LE(payload + 2);
      sampleRate = bytes.readUInt32LE(payload + 4);
      bitsPerSample = bytes.readUInt16LE(payload + 14);
    } else if (id === "data") {
      if (payload + size > bytes.length) {
        throw new BrowserAdapterError(
          "capture-malformed",
          `the delivered capture at ${file} claims ${size} data bytes but only ` +
            `${bytes.length - payload} are present; a truncated capture is not evidence`,
        );
      }
      dataBytes = size;
      break;
    }
    at = payload + size + (size % 2);
  }
  if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0 || dataBytes <= 0) {
    throw new BrowserAdapterError(
      "capture-malformed",
      `the delivered capture at ${file} has no usable format or data chunk`,
    );
  }
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new BrowserAdapterError(
      "capture-malformed",
      `the delivered capture at ${file} is ${channels} channel(s), ${bitsPerSample}-bit; ` +
        "the certifying capture is mono 16-bit PCM",
    );
  }
  const frames = dataBytes / 2;
  return {
    sampleRate,
    channels,
    bitsPerSample,
    frames,
    durationMs: (frames / sampleRate) * 1000,
    bytes: bytes.byteLength,
  };
}

function readJsonFile(file: string, what: string): Record<string, unknown> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new BrowserAdapterError(
      "trace-missing",
      `cannot read the ${what} at ${file}: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new BrowserAdapterError(
      "trace-malformed",
      `the ${what} at ${file} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrowserAdapterError(
      "trace-malformed",
      `the ${what} at ${file} is not a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

function parseTrace(text: string, file: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new BrowserAdapterError(
        "trace-malformed",
        `${file} line ${index + 1} is not JSON: ${(error as Error).message}`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BrowserAdapterError(
        "trace-malformed",
        `${file} line ${index + 1} is not a JSON object`,
      );
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

function turnRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.filter((row) => typeof row.turn === "string" && row.turn.trim() !== "");
}

function turnIds(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    const turn = row.turn;
    if (typeof turn === "string" && turn.trim() !== "" && !seen.has(turn)) {
      seen.add(turn);
      ids.push(turn);
    }
  }
  return ids;
}

function firstRow(
  rows: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown> | null {
  return rows.find((row) => row.type === type) ?? null;
}

function eligibilityOf(
  callId: string,
  scenario: string,
  end: Record<string, unknown>,
  rows: readonly Record<string, unknown>[],
): CallEligibilityFact {
  const fallback = firstRow(rows, "provider_fallback");
  const budgetRow = firstRow(rows, "budget.stopped");
  const budget = end.budget;
  const budgetRecord =
    budget !== null && typeof budget === "object" && !Array.isArray(budget)
      ? (budget as Record<string, unknown>)
      : null;
  const budgetStop =
    budgetRecord !== null
      ? String(budgetRecord.reasons ?? budgetRecord.reason ?? "budget ceiling")
      : budgetRow !== null
        ? String(budgetRow.reason ?? budgetRow.spend ?? "budget.stopped")
        : end.endedBy === "budget"
          ? "budget ceiling"
          : null;
  const providerFallback =
    fallback !== null
      ? `${String(fallback.leg ?? "vendor")} at ${String(fallback.phase ?? "turn")}`
      : null;
  return {
    callId,
    scenario,
    providerFallback,
    budgetStop,
  };
}

function readMarks(file: string, callId: string): CallMarksArtifact {
  if (!existsSync(file)) {
    throw new BrowserAdapterError(
      "marks-missing",
      `no browser marks at ${file}; the call's marks are posted beside the delivered ` +
        "WAV on teardown, and a certifying run has no evidence without them",
    );
  }
  const parsed = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      throw new BrowserAdapterError(
        "marks-missing",
        `cannot read the browser marks at ${file}: ${(error as Error).message}`,
      );
    }
  })();
  if (!isCallMarksArtifact(parsed)) {
    throw new BrowserAdapterError(
      "marks-missing",
      `the browser marks at ${file} do not carry the marks artifact shape`,
    );
  }
  const marks = parsed as CallMarksArtifact;
  if (marks.callId !== callId) {
    throw new BrowserAdapterError(
      "call-id-mismatch",
      `the browser marks at ${file} name call "${marks.callId}", not "${callId}"; ` +
        "the delivered WAV, marks, trace and end document must cite one call id",
    );
  }
  return marks;
}

function captureMark(marks: CallMarksArtifact): CallMarksArtifact["marks"][number] | null {
  const captures = marks.marks.filter((mark) => mark.name === "delivered_capture");
  return captures.length === 0 ? null : captures[captures.length - 1]!;
}

/**
 * Read the trace, end document, marks and delivered WAV; copy them into the
 * call directory; refuse by name when any one is missing or bound elsewhere.
 */
export async function assembleBrowserEvidence(input: {
  readonly call: BrowserCallResult;
  readonly scenario: LoadedScenario;
  readonly target: BrowserTargetLabel;
  readonly eventsDir: string;
  readonly callDir: string;
  /** The app tool log and real inbox delivery, collected after the call. */
  readonly toolEvidence?: {
    readonly log: readonly ToolLogRow[];
    readonly delivery: InboxDelivery | null;
    readonly gap: string | null;
  };
}): Promise<{ assembled: AssembledBrowserEvidence; record: BrowserCallRecord }> {
  if (input.call.callId === null) {
    throw new BrowserAdapterError(
      "marks-missing",
      "the browser harness could not read the call's marks artifact, so the call has no " +
        "call id to bind the delivered WAV, trace and end document to",
    );
  }
  const callId = requireSafeId(input.call.callId, "call id");
  const stem = callId.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "call";
  const traceSource = input.call.tracePath ?? join(input.eventsDir, `${stem}.jsonl`);
  const endSource = input.call.endPath ?? join(input.eventsDir, `${stem}.end.json`);
  const marksSource = input.call.marksPath;
  const captureSource = input.call.capturePath;

  if (marksSource === null) {
    throw new BrowserAdapterError(
      "marks-missing",
      "the browser harness recorded no marks artifact for this call; the marks are " +
        "posted by the app on teardown and a certifying run has no evidence without them",
    );
  }
  if (captureSource === null) {
    throw new BrowserAdapterError(
      "capture-missing",
      "the browser harness recorded no delivered capture for this call; the worklet's " +
        "rendered WAV is the visitor's audio and a certifying run has no evidence without it",
    );
  }

  const marks = readMarks(marksSource, callId);

  let traceText: string;
  try {
    traceText = await readFile(traceSource, "utf8");
  } catch (error) {
    throw new BrowserAdapterError(
      "trace-missing",
      `no trace at ${traceSource}; the service writes one JSONL per call and the run ` +
        `has no evidence without it: ${(error as Error).message}`,
    );
  }
  const rows = parseTrace(traceText, traceSource);
  if (rows.length === 0) {
    throw new BrowserAdapterError(
      "trace-missing",
      `the trace at ${traceSource} has no rows; a call with no trace is not evidence`,
    );
  }
  const wrong = rows.filter((row) => row.callId !== callId);
  if (wrong.length > 0) {
    throw new BrowserAdapterError(
      "call-id-mismatch",
      `${wrong.length} of ${rows.length} rows in ${traceSource} name a different call id; ` +
        `the evidence must bind to "${callId}"`,
    );
  }

  if (!existsSync(endSource)) {
    throw new BrowserAdapterError(
      "end-missing",
      `no end document at ${endSource}; the browser adapter certifies from the persisted ` +
        "end message, never from a trace row alone",
    );
  }
  const end = readJsonFile(endSource, "end document");
  if (end.type !== "end") {
    throw new BrowserAdapterError(
      "trace-malformed",
      `the end document at ${endSource} has type ${JSON.stringify(end.type)}, not "end"`,
    );
  }
  if (end.callId !== callId) {
    throw new BrowserAdapterError(
      "call-id-mismatch",
      `the end document at ${endSource} names call ${JSON.stringify(end.callId)}, not "${callId}"`,
    );
  }

  const captureName = basename(captureSource);
  if (!captureName.includes(callId)) {
    throw new BrowserAdapterError(
      "call-id-mismatch",
      `the delivered capture "${captureName}" does not name call "${callId}"; the WAV, ` +
        "marks, trace and end document must cite one call id",
    );
  }
  if (!existsSync(captureSource)) {
    throw new BrowserAdapterError(
      "capture-missing",
      `no delivered capture at ${captureSource}; the browser adapter certifies what the ` +
        "worklet rendered and a missing WAV is not a short capture",
    );
  }
  const wav = readWavFacts(captureSource);
  const capture = captureMark(marks);
  if (capture === null) {
    throw new BrowserAdapterError(
      "capture-incomplete",
      `the marks at ${marksSource} carry no delivered_capture mark; the capture's ` +
        "outcome is unrecorded, so the WAV cannot be trusted as complete",
    );
  }
  if (capture.detail?.complete !== true) {
    throw new BrowserAdapterError(
      "capture-incomplete",
      `the delivered_capture mark reports complete=${String(capture.detail?.complete)}` +
        `${typeof capture.detail?.reason === "string" ? ` (${capture.detail.reason})` : ""}; ` +
        "a truncated capture is not evidence",
    );
  }
  if (capture.detail?.name !== captureName) {
    throw new BrowserAdapterError(
      "call-id-mismatch",
      `the delivered_capture mark names "${String(capture.detail?.name)}" but the WAV on ` +
        `disk is "${captureName}"`,
    );
  }

  await mkdir(input.callDir, { recursive: true });
  const traceFile = join(input.callDir, "trace.jsonl");
  const endFile = join(input.callDir, "end.json");
  const wavFile = join(input.callDir, "delivered.wav");
  const marksFile = join(input.callDir, "call-marks.json");
  await copyFile(traceSource, traceFile);
  await copyFile(endSource, endFile);
  await copyFile(captureSource, wavFile);
  await copyFile(marksSource, marksFile);

  const priced = firstRow(rows, "cost.priced");
  const gaps: string[] = [];
  if (priced === null) {
    gaps.push("the trace carries no cost.priced row; cost is never recomputed by the runner");
  }
  const turns = turnRows(rows);
  const transcriptGap =
    "the browser marks carry no caption text (call-marks.ts keeps text out of production " +
    "evidence); the spoken words were not captured, so a bridge, a continuation or a spoken " +
    "leak cannot be judged on this adapter";
  if (input.toolEvidence?.gap !== undefined && input.toolEvidence.gap !== null) {
    gaps.push(input.toolEvidence.gap);
  }
  const tools = {
    calls: rows.filter((row) => row.type === "turn.tool_call"),
    results: rows.filter((row) => row.type === "turn.tool_result"),
    ...(input.toolEvidence === undefined
      ? {}
      : {
          ...(input.toolEvidence.log.length === 0 ? {} : { log: input.toolEvidence.log }),
          ...(input.toolEvidence.delivery === null
            ? {}
            : { delivery: input.toolEvidence.delivery }),
          ...(input.toolEvidence.gap === null ? {} : { gap: input.toolEvidence.gap }),
        }),
  };

  const bundle: BrowserEvidenceBundle = {
    ledger: {
      file: endFile,
      end,
      endGap: null,
      turns,
      turnIds: turnIds(turns),
      marks,
      marksGap: "",
    },
    trace: {
      file: traceFile,
      rows,
      lineCount: rows.length,
      transcript: null,
      transcriptGap,
    },
    wav: {
      file: wavFile,
      sampleRate: wav.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      frames: wav.frames,
      durationMs: wav.durationMs,
      bytes: wav.bytes,
    },
    tool: tools,
    ...(priced === null ? {} : { cost: priced }),
    browser: {
      file: marksFile,
      marks,
      capture: {
        file: wavFile,
        name: captureName,
        bytes: wav.bytes,
        sampleRate: wav.sampleRate,
        seconds: wav.durationMs / 1000,
      },
      syntheticMic: input.call.syntheticMic,
    },
  };

  const eligibility = eligibilityOf(callId, input.scenario.name, end, rows);

  const record: BrowserCallRecord = {
    callId,
    scenario: input.scenario.name,
    locale: input.scenario.locale,
    target: input.target,
    voice: input.call.voice,
    subject: input.call.subject,
    startedAt: input.call.startedAt,
    endedAt: input.call.endedAt,
    endedBy: input.call.endedBy,
    error: input.call.error,
    timeline: input.call.timeline,
    triggerPlan: input.call.triggerPlan,
    faultsApplied: input.call.faultsApplied,
    syntheticMic: input.call.syntheticMic,
    browser: input.call.browser,
    elapsedMs: input.call.elapsedMs,
    files: {
      trace: traceFile,
      end: endFile,
      deliveredWav: wavFile,
      marks: marksFile,
      call: join(input.callDir, "call.json"),
    },
    sameCallId: true,
    evidenceGaps: gaps,
  };
  await writeJson(record.files.call, record);
  return { assembled: { bundle, eligibility, gaps }, record };
}

/** A bundle's assembled evidence, as the runner and card builder read it. */
export type { AssembledBrowserEvidence };

/** The call-level evidence sources a card may cite without a turn. */
const CALL_LEVEL_SOURCES: ReadonlySet<string> = new Set([
  "cost",
  "panel",
  "judge",
  "pytest",
]);

/**
 * Build the card evidence and the attributions the verdict itself can prove.
 * A turn-level failure must cite a turn that exists in the ledger; a failure
 * with no citation is a recorded gap, not a guessed pointer.
 */
export function cardInputs(input: {
  readonly runId: string;
  readonly verdict: Pick<RunVerdict, "runId" | "properties">;
  readonly target: BrowserTargetLabel;
  readonly scenario: LoadedScenario;
  readonly record: BrowserCallRecord;
  readonly bundle: BrowserEvidenceBundle;
  readonly modules: Readonly<Record<string, readonly string[]>>;
  readonly repoRoot: string;
}): {
  readonly call: CallEvidence | null;
  readonly attributions: readonly {
    readonly propertyId: string;
    readonly callId: string;
    readonly turn?: string;
    readonly scenario: string;
  }[];
  readonly gaps: readonly BrowserCardGap[];
} {
  const gaps: BrowserCardGap[] = [];
  const wav = input.bundle.wav;
  const turnEvidence: TurnEvidence[] = input.bundle.ledger.turnIds.map((turn) => {
    const row = input.bundle.ledger.turns.find((entry) => entry.turn === turn) ?? {};
    const atMs = typeof row.atMs === "number" && Number.isFinite(row.atMs) ? row.atMs : 0;
    const endMs = Math.min(wav.durationMs, Math.max(atMs + 750, atMs + 1));
    const startMs = Math.max(0, Math.min(atMs - 250, endMs - 1));
    return {
      turn,
      deliveredWav: wav.file,
      excerpts:
        endMs <= startMs
          ? []
          : [{ media: "delivered-wav", file: wav.file, startMs, endMs }],
      evidenceFiles: [input.bundle.trace.file, input.bundle.ledger.file],
    };
  });

  const callLevelExcerpts: AudioExcerpt[] = [
    {
      media: "delivered-wav",
      file: wav.file,
      startMs: 0,
      endMs: Math.min(wav.durationMs, 1_000),
    },
  ];

  const call: CallEvidence = {
    callId: input.record.callId,
    scenario: input.scenario.name,
    locale: input.scenario.locale,
    target: input.target,
    turns: turnEvidence,
    deliveredWav: wav.file,
    excerpts: callLevelExcerpts,
    evidenceFiles: [input.bundle.trace.file, input.bundle.ledger.file, wav.file],
  };

  const attributions: {
    propertyId: string;
    callId: string;
    turn?: string;
    scenario: string;
  }[] = [];
  for (const property of input.verdict.properties) {
    if (property.status !== "FAIL") continue;
    const failedScenario = property.scenarios.find((entry) => entry.status === "FAIL");
    if (failedScenario === undefined) {
      gaps.push({
        propertyId: property.propertyId,
        code: "no-attribution",
        detail: `${property.propertyId} failed with no scenario; there is no call to cite`,
      });
      continue;
    }
    let turn: string | undefined;
    if (
      !CALL_LEVEL_SOURCES.has(property.evidence) &&
      !CALL_LEVEL_PROPERTY_IDS.has(property.propertyId)
    ) {
      const citations = [
        ...property.citations,
        ...failedScenario.citations,
        ...property.scenarios.flatMap((entry) => entry.citations),
      ];
      const named = new Set<string>();
      for (const citation of citations) {
        const match = /^turn:(.+)$/.exec(citation);
        if (match !== null && input.bundle.ledger.turnIds.includes(match[1] ?? "")) {
          named.add(match[1] ?? "");
        }
      }
      if (named.size === 1) {
        turn = [...named][0];
      } else if (named.size === 0) {
        gaps.push({
          propertyId: property.propertyId,
          code: "no-attribution",
          detail:
            `${property.propertyId} is judged from ${property.evidence} evidence at turn ` +
            "level, but its verdict cites no turn from this call",
        });
        continue;
      } else {
        gaps.push({
          propertyId: property.propertyId,
          code: "no-attribution",
          detail:
            `${property.propertyId} cites ${named.size} turns (${[...named].join(", ")}); ` +
            "a card names one turn, not an ambiguous set",
        });
        continue;
      }
    }
    if ((input.modules[property.propertyId] ?? []).length === 0) {
      gaps.push({
        propertyId: property.propertyId,
        code: "no-module",
        detail: `${property.propertyId} has no module pointer; a card must say where to look`,
      });
      continue;
    }
    attributions.push({
      propertyId: property.propertyId,
      callId: input.record.callId,
      ...(turn === undefined ? {} : { turn }),
      scenario: failedScenario.scenario,
    });
  }

  return { call, attributions, gaps };
}

/** Build every card the verdict and the evidence support; gaps are recorded. */
export function buildCards(input: {
  readonly runId: string;
  readonly verdict: RunVerdict;
  readonly target: BrowserTargetLabel;
  readonly calls: readonly CallEvidence[];
  readonly attributions: readonly {
    readonly propertyId: string;
    readonly callId: string;
    readonly turn?: string;
    readonly scenario: string;
  }[];
  readonly modules: Readonly<Record<string, readonly string[]>>;
  readonly repoRoot: string;
}): { cards: DefectCard[]; gaps: BrowserCardGap[] } {
  const failed = input.verdict.properties.filter((property) => property.status === "FAIL");
  if (failed.length === 0) return { cards: [], gaps: [] };
  if (input.attributions.length !== failed.length) {
    return {
      cards: [],
      gaps: failed
        .filter(
          (property) =>
            !input.attributions.some((attribution) => attribution.propertyId === property.propertyId),
        )
        .map((property) => ({
          propertyId: property.propertyId,
          code: "no-attribution",
          detail: `${property.propertyId} failed with no attributable call and turn`,
        })),
    };
  }
  try {
    return {
      cards: buildDefectCards({
        verdict: input.verdict,
        target: input.target,
        calls: input.calls,
        attributions: input.attributions,
        modules: input.modules,
        repoRoot: input.repoRoot,
      }),
      gaps: [],
    };
  } catch (error) {
    if (error instanceof DefectCardError) {
      return {
        cards: [],
        gaps: failed.map((property) => ({
          propertyId: property.propertyId,
          code: error.code,
          detail: error.message,
        })),
      };
    }
    throw error;
  }
}

/**
 * Evidence assembly and the per-run directory.
 *
 * A run owns one directory keyed by its run id. Inside it, one directory per
 * call holds the trace the service wrote, the persisted end document, the PCM
 * the protocol adapter received and a `call.json` that says what the adapter
 * did. The verdict is written beside them, and defect cards cite those files by
 * path — never a number the runner recomputed.
 *
 * Cost is the call's own `cost.priced` row, copied verbatim. Delivered audio is
 * the received PCM; this adapter has no browser marks and says so.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Ground truth comes first" and
 * "Evidence artifacts".
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDefectCards,
  DefectCardError,
  type AudioExcerpt,
  type CallEvidence,
  type DefectCard,
  type TurnEvidence,
} from "@/lib/demo/verification/cards";
import { encodeMonoWav } from "@/lib/platform/recording-capture";
import type { EvidenceSource } from "@/lib/demo/verification/contract";
import type { LoadedScenario } from "@/lib/demo/verification/scenarios";
import type { RunVerdict } from "@/lib/demo/verification/verdict";
import type { ToolLogRow } from "@/lib/demo/tool-log";
import type { InboxDelivery } from "@/lib/demo/verification/tools/inbox";

import {
  eligibilityOf,
  firstRow,
  parseTrace,
  pricedRow,
  requireSafeId as requireSafeIdWith,
  runDirectory as runDirectoryWith,
  toolBundle,
  turnIds,
  turnRows,
  writeJson,
  type AdapterErrorFactory,
} from "../adapter-evidence";
import { ProtocolAdapterError } from "./errors";
import type {
  AssembledEvidence,
  CardAttribution,
  CardGap,
  ProtocolCallRecord,
  ProtocolCallResult,
  ProtocolEvidenceBundle,
  ProtocolTargetLabel,
} from "./types";

/** The call-level evidence sources a card may cite without a turn. */
const CALL_LEVEL_SOURCES: ReadonlySet<EvidenceSource> = new Set([
  "cost",
  "panel",
  "judge",
  "pytest",
]);

/** How long the adapter waits for the service's end sidecar after the socket closes. */
export const END_SIDECAR_WAIT_MS = 5_000;

/**
 * Wait, bounded, for a file the service writes after the socket closes. The
 * end sidecar and its priced row are written during the service's final drain;
 * reading a moment too early would turn a measured call into a missing-evidence
 * gap. A file that never arrives is still a named gap, never an invented end.
 */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Wait, bounded, for the trace's final `end` row. The service writes the
 * sidecar and appends the end row in its drain; a read between the two would
 * copy a trace that predates its own priced row.
 */
async function waitForTraceEnd(path: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (text.split("\n").some((line) => line.includes('"type":"end"'))) return true;
    } catch {
      // The trace may not exist yet; the bounded wait below is the refusal.
    }
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const protocolError: AdapterErrorFactory = (code, message) =>
  new ProtocolAdapterError(
    code as ConstructorParameters<typeof ProtocolAdapterError>[0],
    message,
  );

/**
 * The shared run-directory rule, bound to this adapter's named refusal. The
 * rule lives in `../adapter-evidence`; only the error type is the adapter's.
 */
export function requireSafeId(value: string, what: string): string {
  return requireSafeIdWith(value, what, protocolError);
}

export function runDirectory(runRoot: string, runId: string): string {
  return runDirectoryWith(runRoot, runId, protocolError);
}

export { writeJson };

function readJsonFile(file: string, what: string): Record<string, unknown> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new ProtocolAdapterError(
      "trace-missing",
      `cannot read the ${what} at ${file}: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new ProtocolAdapterError(
      "trace-malformed",
      `the ${what} at ${file} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProtocolAdapterError(
      "trace-malformed",
      `the ${what} at ${file} is not a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Read the trace and end document, copy the evidence, and build the bundle. */
export async function assembleEvidence(input: {
  readonly call: ProtocolCallResult;
  readonly scenario: LoadedScenario;
  readonly target: ProtocolTargetLabel;
  readonly eventsDir: string;
  readonly callDir: string;
  /** The app tool log and real inbox delivery, collected after the call. */
  readonly toolEvidence?: {
    readonly log: readonly ToolLogRow[];
    readonly delivery: InboxDelivery | null;
    readonly gap: string | null;
  };
  /** Bounded wait for the service's end sidecar; tests shorten it. */
  readonly endWaitMs?: number;
}): Promise<{ assembled: AssembledEvidence; record: ProtocolCallRecord }> {
  const gaps: string[] = [];
  const stem = input.call.callId.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "call";
  const traceSource = input.call.tracePath ?? join(input.eventsDir, `${stem}.jsonl`);
  const endSource = input.call.endPath ?? join(input.eventsDir, `${stem}.end.json`);

  // The end sidecar (and the priced row beside it) is written by the service's
  // final drain, after the socket closes. Wait for it, bounded: reading too
  // early is a missing-evidence gap, not a faster verdict.
  await waitForFile(endSource, input.endWaitMs ?? END_SIDECAR_WAIT_MS);
  await waitForTraceEnd(traceSource, input.endWaitMs ?? END_SIDECAR_WAIT_MS);

  let traceText: string;
  try {
    traceText = await readFile(traceSource, "utf8");
  } catch (error) {
    throw new ProtocolAdapterError(
      "trace-missing",
      `no trace at ${traceSource}; the service writes one JSONL per call and the run has no evidence without it: ${(error as Error).message}`,
    );
  }
  const rows = parseTrace(traceText, traceSource, protocolError);
  if (rows.length === 0) {
    throw new ProtocolAdapterError(
      "trace-missing",
      `the trace at ${traceSource} has no rows; a call with no trace is not evidence`,
    );
  }
  const wrong = rows.filter((row) => row.callId !== input.call.callId);
  if (wrong.length > 0) {
    throw new ProtocolAdapterError(
      "trace-malformed",
      `${wrong.length} of ${rows.length} rows in ${traceSource} name a different call id; ` +
        `the evidence must bind to "${input.call.callId}"`,
    );
  }

  await mkdir(input.callDir, { recursive: true });
  const traceFile = join(input.callDir, "trace.jsonl");
  await copyFile(traceSource, traceFile);

  let end: Record<string, unknown> | null = null;
  let endFile: string | null = null;
  let endGap: string | null = null;
  if (existsSync(endSource)) {
    end = readJsonFile(endSource, "end document");
    if (end.type !== "end") {
      throw new ProtocolAdapterError(
        "trace-malformed",
        `the end document at ${endSource} has type ${JSON.stringify(end.type)}, not "end"`,
      );
    }
    if (end.callId !== input.call.callId) {
      throw new ProtocolAdapterError(
        "trace-malformed",
        `the end document at ${endSource} names call ${JSON.stringify(end.callId)}, not "${input.call.callId}"`,
      );
    }
    endFile = join(input.callDir, "end.json");
    await copyFile(endSource, endFile);
  } else {
    const endRow = firstRow(rows, "end");
    if (endRow !== null) {
      end = endRow;
      endGap =
        `the end sidecar is missing at ${endSource}; the trace's end row was used, ` +
        "and the sidecar's absence is recorded rather than hidden";
      gaps.push(endGap);
    } else {
      endGap = `no end document at ${endSource} and no end row in the trace`;
      gaps.push(endGap);
    }
  }

  const priced = pricedRow(rows, gaps);

  const turns = turnRows(rows);
  const transcript =
    input.call.captions.length === 0
      ? null
      : input.call.captions.map((caption) => ({
          role: caption.role,
          text: caption.text,
          atMs: caption.atMs,
          final: caption.final,
        }));
  const transcriptGap =
    transcript === null
      ? "the service sent no captions; the spoken words were not captured, so a bridge, a " +
        "continuation or a spoken leak cannot be judged"
      : null;
  if (transcriptGap !== null) gaps.push(transcriptGap);
  const tools = toolBundle(rows, input.toolEvidence, gaps);

  const receivedFile = join(input.callDir, "received.wav");
  let wav: ProtocolEvidenceBundle["wav"];
  if (input.call.received.pcm.byteLength === 0) {
    gaps.push("the service sent no agent audio; there is no received PCM for audio properties");
  } else {
    const bytes = encodeMonoWav(input.call.received.pcm, input.call.received.sampleRate);
    await writeFile(receivedFile, bytes);
    wav = {
      file: receivedFile,
      sampleRate: input.call.received.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      frames: input.call.received.pcm.byteLength / 2,
      durationMs:
        (input.call.received.pcm.byteLength / 2 / input.call.received.sampleRate) * 1000,
      bytes: input.call.received.pcm.byteLength,
    };
  }

  const bundle: ProtocolEvidenceBundle = {
    ledger: {
      file: endFile,
      end,
      endGap,
      turns,
      turnIds: turnIds(turns),
      marks: null,
      marksGap:
        "the protocol adapter has no browser marks; mark-level properties require the browser adapter (ticket 17)",
    },
    trace: { file: traceFile, rows, lineCount: rows.length, transcript, transcriptGap },
    ...(wav === undefined ? {} : { wav }),
    tool: tools,
    ...(priced === null ? {} : { cost: priced }),
  };

  const eligibility = eligibilityOf({
    callId: input.call.callId,
    scenario: input.scenario.name,
    end,
    rows,
  });

  const record: ProtocolCallRecord = {
    callId: input.call.callId,
    scenario: input.scenario.name,
    locale: input.scenario.locale,
    target: input.target,
    voice: input.call.voice,
    subject: input.call.subject,
    startedAt: input.call.startedAt,
    endedAt: input.call.endedAt,
    endedBy: input.call.endedBy,
    error: input.call.error,
    callerFrames: input.call.caller.frames,
    callerBytes: input.call.caller.bytes,
    callerFrameBytes: input.call.caller.frameBytes,
    receivedFrames: input.call.received.frames,
    receivedBytes: input.call.received.bytes,
    timeline: input.call.timeline,
    triggerPlan: input.call.triggerPlan,
    faultsApplied: input.call.faultsApplied,
    files: {
      trace: traceFile,
      end: endFile,
      receivedWav: wav?.file ?? null,
      call: join(input.callDir, "call.json"),
    },
    evidenceGaps: gaps,
  };
  await writeJson(record.files.call, record);
  return { assembled: { bundle, eligibility, gaps }, record };
}


/**
 * Build the card evidence and the attributions the verdict itself can prove.
 *
 * A turn-level failure must cite a turn that exists in the ledger; a failure
 * with no scenario or no citation is a recorded gap, not a guessed pointer.
 * Cost and judge failures cite the session only.
 */
export function cardInputs(input: {
  readonly runId: string;
  readonly verdict: Pick<RunVerdict, "runId" | "properties">;
  readonly target: ProtocolTargetLabel;
  readonly scenario: LoadedScenario;
  readonly record: ProtocolCallRecord;
  readonly bundle: ProtocolEvidenceBundle;
  readonly modules: Readonly<Record<string, readonly string[]>>;
  readonly repoRoot: string;
}): {
  readonly call: CallEvidence | null;
  readonly attributions: readonly CardAttribution[];
  readonly gaps: readonly CardGap[];
} {
  const gaps: CardGap[] = [];
  const wav = input.bundle.wav;
  const turnEvidence: TurnEvidence[] = input.bundle.ledger.turnIds.map((turn) => {
    const row = input.bundle.ledger.turns.find((entry) => entry.turn === turn) ?? {};
    const atMs = typeof row.atMs === "number" && Number.isFinite(row.atMs) ? row.atMs : 0;
    const endMs =
      wav === undefined
        ? 0
        : Math.min(wav.durationMs, Math.max(atMs + 750, atMs + 1));
    const startMs = wav === undefined ? 0 : Math.max(0, Math.min(atMs - 250, endMs - 1));
    return {
      turn,
      ...(wav === undefined ? {} : { deliveredWav: wav.file }),
      excerpts:
        wav === undefined || endMs <= startMs
          ? []
          : [{ media: "delivered-wav", file: wav.file, startMs, endMs }],
      evidenceFiles: [
        input.bundle.trace.file,
        ...(input.bundle.ledger.file === null ? [] : [input.bundle.ledger.file]),
      ],
    };
  });

  const callLevelExcerpts: AudioExcerpt[] =
    wav === undefined
      ? []
      : [
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
    ...(wav === undefined ? {} : { deliveredWav: wav.file }),
    excerpts: callLevelExcerpts,
    evidenceFiles: [
      input.bundle.trace.file,
      ...(input.bundle.ledger.file === null ? [] : [input.bundle.ledger.file]),
      ...(wav === undefined ? [] : [wav.file]),
    ],
  };

  const attributions: CardAttribution[] = [];
  for (const property of input.verdict.properties) {
    if (property.status !== "FAIL") continue;
    const failedScenario = property.scenarios.find((entry) => entry.status === "FAIL");
    if (failedScenario === undefined) {
      gaps.push({
        propertyId: property.propertyId,
        code: "no-attribution",
        detail:
          `${property.propertyId} failed with no scenario; there is no call to cite`,
      });
      continue;
    }
    let turn: string | undefined;
    if (!CALL_LEVEL_SOURCES.has(property.evidence)) {
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
            `${property.propertyId} is judged from ${property.evidence} evidence at turn level, ` +
            "but its verdict cites no turn from this call",
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
  readonly target: ProtocolTargetLabel;
  readonly calls: readonly CallEvidence[];
  readonly attributions: readonly CardAttribution[];
  readonly modules: Readonly<Record<string, readonly string[]>>;
  readonly repoRoot: string;
}): { cards: DefectCard[]; gaps: CardGap[] } {
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
          code: "no-attribution" as const,
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

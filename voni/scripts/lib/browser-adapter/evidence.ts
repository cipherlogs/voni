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
 * recomputes it. A denied call that opened no session carries a measured zero
 * row with no legs (zero audio, tokens and characters), built by
 * `zeroSessionCostRow`; a session that ran but left no priced row stays a gap.
 * The delivered WAV is required: unlike the protocol adapter's optional
 * received PCM, a certifying run without the delivered audio has not heard what
 * the visitor heard.
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
import type { RunVerdict } from "@/lib/demo/verification/verdict";
import { judgeMicDenial } from "@/lib/demo/verification/verdict/evaluators/resilience.evaluators";
import type { ToolLogRow } from "@/lib/demo/tool-log";
import type { InboxDelivery } from "@/lib/demo/verification/tools/inbox";
import {
  isCallMarksArtifact,
  type CallMarksArtifact,
} from "@/lib/voice/call-marks";

import {
  eligibilityOf,
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
import { BrowserAdapterError } from "./errors";
import { zeroSessionCostRow } from "./zero-cost";
import type {
  AssembledBrowserEvidence,
  BrowserCallRecord,
  BrowserCallResult,
  BrowserCardGap,
  BrowserEvidenceBundle,
  BrowserTargetLabel,
} from "./types";

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

const browserError: AdapterErrorFactory = (code, message) =>
  new BrowserAdapterError(
    code as ConstructorParameters<typeof BrowserAdapterError>[0],
    message,
  );

/**
 * The shared run-directory rule, bound to this adapter's own named refusal.
 * The rule and the JSON writer live in `../adapter-evidence`; this adapter no
 * longer borrows the protocol adapter's copy.
 */
export function requireSafeId(value: string, what: string): string {
  return requireSafeIdWith(value, what, browserError);
}

export function runDirectory(runRoot: string, runId: string): string {
  return runDirectoryWith(runRoot, runId, browserError);
}

export { writeJson };

type BrowserTranscriptEntry = {
  readonly role: "caller" | "agent";
  readonly text: string;
  readonly atMs: number;
  readonly final: true;
  readonly turn: null;
};

/**
 * Bind the visitor's transcript to the call clock.
 *
 * The page renders each final caller/agent line but stamps none of them. The
 * client's marks already write one `turn` mark per final caption, in the same
 * order (`voice-call.tsx` marks on `caption.final`). Joining caption i to
 * turn mark i is the client's own observation of the same event, not an
 * invented time; if the counts ever disagree the transcript is withheld with a
 * named gap rather than a guessed timestamp.
 */
function browserTranscript(
  captions: readonly { readonly role: "caller" | "agent"; readonly text: string }[] | undefined,
  marks: CallMarksArtifact | null,
): { transcript: BrowserTranscriptEntry[] | null; gap: string | null } {
  const missing =
    "the page rendered no visitor transcript; the spoken words were not captured, so a " +
    "bridge, a continuation or a spoken leak cannot be judged on this adapter";
  if (captions === undefined || captions.length === 0) {
    return { transcript: null, gap: missing };
  }
  if (marks === null) {
    return {
      transcript: null,
      gap:
        "the client posted no marks, so the rendered transcript has no call clock to join " +
        "and is withheld rather than guessed",
    };
  }
  const turnMarks = marks.marks.filter((mark) => mark.name === "turn");
  if (turnMarks.length !== captions.length) {
    return {
      transcript: null,
      gap:
        `the page rendered ${captions.length} transcript line(s) but the call marks record ` +
        `${turnMarks.length} final turn(s); the transcript cannot be placed on the call clock ` +
        "without guessing a time",
    };
  }
  return {
    transcript: captions.map((caption, index) => ({
      role: caption.role,
      text: caption.text,
      atMs: turnMarks[index]!.tMs,
      final: true,
      turn: null,
    })),
    gap: null,
  };
}

function readMarks(file: string, callId: string): CallMarksArtifact {
  if (!existsSync(file)) {
    throw new BrowserAdapterError(
      "marks-missing",
      `no browser marks for call "${callId}" at ${file}; the call's marks are posted ` +
        "beside the delivered WAV on teardown, and a certifying run has no evidence without them",
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

  // A denied microphone is the one call expected to deliver no audio: the
  // visitor never acquired a microphone, so the playout tap wrote no WAV and
  // the service may have written no trace or end. It is still judged: R5's
  // named refusal must be present, and its absence is a named refusal here.
  // Every other scenario keeps the hard capture refusal below.
  const micDeniedExpected = (input.scenario.edge ?? []).some(
    (condition) => condition.kind === "mic-denied",
  );
  const deniedCall = micDeniedExpected && captureSource === null;

  if (deniedCall) {
    const denial = judgeMicDenial(input.call.edge?.micDenied ?? null);
    if (denial === null) {
      throw new BrowserAdapterError(
        "mic-refusal-missing",
        `scenario "${input.scenario.name}" declares a denied microphone, but the harness ` +
          "recorded no mic-denial observation; a denied call is judged by R5's named refusal, " +
          "never by a missing capture",
      );
    }
    if (!denial.named) {
      throw new BrowserAdapterError(
        "mic-refusal-missing",
        "the microphone denial was not named: status " +
          `${JSON.stringify(denial.namedState)} and error ${JSON.stringify(denial.errorText)}; ` +
          "R5 needs the app to refuse by name, and an absent capture is never a pass",
      );
    }
    if (denial.openSockets > 0 && !denial.teardown) {
      throw new BrowserAdapterError(
        "mic-refusal-missing",
        `the microphone denial left ${denial.openSockets} call socket(s) open and no teardown ` +
          "was observed; R5 fails a zombie call and the adapter refuses it by name",
      );
    }
  }

  if (marksSource === null && !deniedCall) {
    throw new BrowserAdapterError(
      "marks-missing",
      `the browser harness recorded no marks artifact for call "${callId}"; the marks ` +
        "are posted by the app on teardown and a certifying run has no evidence without them",
    );
  }
  if (captureSource === null && !deniedCall) {
    throw new BrowserAdapterError(
      "capture-missing",
      "the browser harness recorded no delivered capture for this call; the worklet's " +
        "rendered WAV is the visitor's audio and a certifying run has no evidence without it",
    );
  }

  const gaps: string[] = [];
  const marks = marksSource === null ? null : readMarks(marksSource, callId);
  if (marksSource === null) {
    gaps.push(
      `the browser harness recorded no marks artifact for call "${callId}"; the denied call ` +
        "has no client clock, and no mark is invented to replace it",
    );
  }

  let traceText: string | null = null;
  if (existsSync(traceSource)) {
    try {
      traceText = await readFile(traceSource, "utf8");
    } catch (error) {
      throw new BrowserAdapterError(
        "trace-missing",
        `no readable trace at ${traceSource}; the service writes one JSONL per call and the ` +
          `run has no evidence without it: ${(error as Error).message}`,
      );
    }
  } else if (deniedCall) {
    gaps.push(
      `no trace at ${traceSource}; a denied microphone may never reach the service, so the ` +
        "trace is genuinely absent and is not invented",
    );
  } else {
    throw new BrowserAdapterError(
      "trace-missing",
      `no trace at ${traceSource}; the service writes one JSONL per call and the run ` +
        "has no evidence without it",
    );
  }
  const rows = traceText === null ? [] : parseTrace(traceText, traceSource, browserError);
  if (traceText !== null && rows.length === 0) {
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

  let end: Record<string, unknown> | null = null;
  let endGap: string | null = null;
  if (existsSync(endSource)) {
    end = readJsonFile(endSource, "end document");
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
  } else if (deniedCall) {
    endGap =
      `no end document at ${endSource}; a denied microphone never reached the service, so ` +
      "the end document is genuinely absent and is not invented";
    gaps.push(endGap);
  } else {
    throw new BrowserAdapterError(
      "end-missing",
      `no end document at ${endSource}; the browser adapter certifies from the persisted ` +
        "end message, never from a trace row alone",
    );
  }

  let wav: WavFacts | null = null;
  let captureName: string | null = null;
  if (captureSource === null) {
    gaps.push(
      "the browser harness recorded no delivered capture for this call; a denied microphone " +
        "never delivered agent audio, and the adapter never invents a WAV",
    );
  } else {
    captureName = basename(captureSource);
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
    wav = readWavFacts(captureSource);
    if (marks === null) {
      throw new BrowserAdapterError(
        "marks-missing",
        `the delivered capture at ${captureSource} has no marks artifact to record its ` +
          `completion; call "${callId}" cannot be certified from an unpaired WAV`,
      );
    }
    const capture = captureMark(marks);
    if (capture === null) {
      throw new BrowserAdapterError(
        "capture-incomplete",
        `the marks at ${String(marksSource)} carry no delivered_capture mark; the capture's ` +
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
  }

  await mkdir(input.callDir, { recursive: true });
  const traceFile = traceText === null ? null : join(input.callDir, "trace.jsonl");
  const endFile = end === null ? null : join(input.callDir, "end.json");
  const wavFile = wav === null ? null : join(input.callDir, "delivered.wav");
  const marksFile = marksSource === null ? null : join(input.callDir, "call-marks.json");
  if (traceFile !== null) await copyFile(traceSource, traceFile);
  if (endFile !== null) await copyFile(endSource, endFile);
  if (wavFile !== null && captureSource !== null) await copyFile(captureSource, wavFile);
  if (marksFile !== null && marksSource !== null) await copyFile(marksSource, marksFile);

  // A denied call with no trace opened no session at all: no audio, tokens or
  // characters were spent, so the call's cost is a measured zero. A trace that
  // exists means the service may have run, so a missing priced row there stays
  // a named gap and is never replaced by a zero.
  const noSession = deniedCall && traceText === null;
  const priced = noSession
    ? zeroSessionCostRow()
    : rows.length === 0
      ? null
      : pricedRow(rows, gaps);
  if (priced === null && rows.length === 0) {
    gaps.push(
      "the call carries no cost.priced row; a denied call with no trace has no priced cost " +
        "and the runner never computes one",
    );
  }
  const turns = turnRows(rows);
  const speech = browserTranscript(input.call.captions, marks);
  if (speech.gap !== null) gaps.push(speech.gap);
  const tools = toolBundle(rows, input.toolEvidence, gaps);

  const bundle: BrowserEvidenceBundle = {
    ledger: {
      file: endFile,
      end,
      endGap,
      turns,
      turnIds: turnIds(turns),
      marks,
      marksGap:
        marksSource === null
          ? "the browser harness recorded no marks artifact for this call"
          : "",
    },
    trace: {
      file: traceFile,
      rows,
      lineCount: rows.length,
      transcript: speech.transcript,
      transcriptGap: speech.gap,
    },
    wav:
      wav === null
        ? null
        : {
            file: wavFile as string,
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
      ...(input.call.captions === undefined ? {} : { captions: input.call.captions }),
      capture:
        wav === null || captureName === null
          ? null
          : {
              file: wavFile as string,
              name: captureName,
              bytes: wav.bytes,
              sampleRate: wav.sampleRate,
              seconds: wav.durationMs / 1000,
            },
      syntheticMic: input.call.syntheticMic,
      faultsApplied: input.call.faultsApplied,
      edge: input.call.edge ?? null,
    },
  };

  const eligibility = eligibilityOf({
    callId,
    scenario: input.scenario.name,
    end,
    rows,
  });

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
    edge: input.call.edge ?? null,
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
  if (wav === null) {
    // A denied microphone has no delivered audio to cite. A failed property
    // still gets a named gap, never a card with an invented excerpt.
    return {
      call: null,
      attributions: [],
      gaps: input.verdict.properties
        .filter((property) => property.status === "FAIL")
        .map((property) => ({
          propertyId: property.propertyId,
          code: "missing-audio",
          detail:
            `${property.propertyId} failed on a call with no delivered audio (a denied ` +
            "microphone); the card needs an excerpt the evidence does not carry",
        })),
    };
  }
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
      evidenceFiles: [input.bundle.trace.file, input.bundle.ledger.file].filter(
        (file): file is string => file !== null,
      ),
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
    evidenceFiles: [input.bundle.trace.file, input.bundle.ledger.file, wav.file].filter(
      (file): file is string => file !== null,
    ),
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

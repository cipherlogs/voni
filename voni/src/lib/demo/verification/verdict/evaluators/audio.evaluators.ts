/**
 * A1-A8: audio quality from the delivered capture and the committed voice
 * reference.
 *
 * The delivered WAV is what the caller actually heard; no evaluator here reads
 * the vendor stream. Every property fails closed when the file is absent,
 * unreadable or described as something it is not. A1 counts dropouts, clicks
 * and seams; A2 checks the exact PCM format; A3 reads level and pumping; A4
 * scans caller words for the agent's own echo; A5 judges the six existing
 * timbre axes against the committed reference; A6 counts playout underrun and
 * overrun; A7 measures the barge fade and its pop; A8 counts frames the
 * reference speaks and the delivery leaves silent.
 *
 * A4 is the one property whose evidence is the trace: the ledger records how
 * long a caller final was, never its words. A trace without caller words is a
 * named `echo-unmeasurable` refusal, not a pass.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Audio" A1-A8.
 */

import { loadVoiceReference } from "@/lib/audio/voice-reference";
import { ECHO_SHARE } from "@/lib/voice/barge-in";

import type {
  EvaluatorContext,
  EvaluatorModule,
  Evaluation,
  PropertyEvaluator,
} from "../types";
import {
  detectClicks,
  detectClippedRuns,
  detectDropouts,
  detectFades,
  measureContinuity,
  silentFramesAgainstReference,
  type AudioEvent,
} from "../audio/analysis";
import {
  TimbreComparisonError,
  alignToReference,
  compareTimbre,
} from "../audio/compare";
import {
  AudioEvidenceError,
  readDeliveredCapture,
  type DeliveredCapture,
} from "../audio/wav";

type Row = Record<string, unknown>;

function rowsOf(value: unknown): Row[] {
  if (typeof value !== "object" || value === null) return [];
  const rows = (value as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function reasonOf(error: unknown): string {
  if (
    error instanceof AudioEvidenceError ||
    error instanceof TimbreComparisonError
  ) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function refused(error: unknown, citations: readonly string[] = []): Evaluation {
  return { kind: "unmeasured", reason: reasonOf(error), citations };
}

function captureOf(context: EvaluatorContext): DeliveredCapture {
  return readDeliveredCapture(context.source, context.evidence.browser);
}

function eventCitations(file: string, events: readonly AudioEvent[]): string[] {
  return events.map((event) => `wav:${file}@${event.atMs}ms`);
}

function firstEvent(events: readonly AudioEvent[]): string {
  const first = events[0];
  return first === undefined ? "" : ` at ${first.atMs}ms`;
}

function traceRows(context: EvaluatorContext): Row[] {
  return rowsOf(context.evidence.trace);
}

/** A1: no dropout over 20 ms, no click, no seam. */
const a1: PropertyEvaluator = {
  propertyId: "A1",
  source: "audio.evaluators.ts",
  bars: [
    { key: "dvDropoutMaxCount", statistic: "each", comparison: "at-most", sample: 0 },
    { key: "floorBreakupSeconds", statistic: "each", comparison: "at-most", sample: 1 },
  ],
  evaluate(context) {
    try {
      const capture = captureOf(context);
      const continuity = measureContinuity(capture.audio);
      const citations = [
        ...eventCitations(capture.file, continuity.dropouts.events),
        ...eventCitations(capture.file, continuity.clicks.events),
      ];
      return {
        kind: "measured",
        samples: [continuity.defectCount, continuity.longestDropoutMs / 1000],
        citations,
        detail:
          `${continuity.dropouts.count} dropout${continuity.dropouts.count === 1 ? "" : "s"} ` +
          `(longest ${continuity.longestDropoutMs} ms)${firstEvent(continuity.dropouts.events)}; ` +
          `${continuity.clicks.count} click${continuity.clicks.count === 1 ? "" : "s"}/seam` +
          `${continuity.clicks.count === 1 ? "" : "s"}${firstEvent(continuity.clicks.events)}`,
      };
    } catch (error) {
      return refused(error);
    }
  },
};

/** A2: the delivered file is exactly the PCM16 mono format the capture names. */
const a2: PropertyEvaluator = {
  propertyId: "A2",
  source: "audio.evaluators.ts",
  bars: [{ key: "dvAudioFormatMismatchMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const capture = captureOf(context);
      const streamRates = new Set<number>();
      for (const row of traceRows(context)) {
        const rate = row.sampleRate;
        if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
          streamRates.add(rate);
        }
      }
      const mismatches = Math.max(0, streamRates.size - 1);
      return {
        kind: "measured",
        samples: [mismatches],
        citations: [`wav:${capture.file}`],
        detail:
          `${capture.audio.facts.sampleRate} Hz mono PCM16, ` +
          `${capture.audio.facts.frameCount} frames, ` +
          `${capture.audio.facts.durationSeconds.toFixed(3)} s; the description and header agree` +
          (streamRates.size === 0
            ? "; the trace names no stream rate to compare"
            : `; the trace's stream rate${streamRates.size === 1 ? "" : "s"} ` +
              `${[...streamRates].join(", ")} Hz ${streamRates.size === 1 ? "agrees with itself" : "disagree"}`),
      };
    } catch (error) {
      return refused(error);
    }
  },
};

/** A3: level against the reference and no pumping. */
const a3: PropertyEvaluator = {
  propertyId: "A3",
  source: "audio.evaluators.ts",
  bars: [
    { key: "timbreLufsToleranceDb", statistic: "each", comparison: "at-most", sample: 0 },
    { key: "comparisonModulationDepth", statistic: "each", comparison: "at-most", sample: 1 },
  ],
  evaluate(context) {
    try {
      const capture = captureOf(context);
      const reference = loadVoiceReference();
      const compared = compareTimbre(
        reference.audio,
        reference.path,
        capture.audio,
        capture.file,
      );
      return {
        kind: "measured",
        samples: [Math.abs(compared.levelDeltaLu), compared.modulationDelta],
        citations: [`wav:${capture.file}`, `reference:${reference.path}`],
        detail:
          `level ${compared.levelDeltaLu.toFixed(2)} LU from the reference; ` +
          `envelope ${compared.modulationDelta.toFixed(4)} deeper than the reference; ` +
          `onset delta ${compared.alignment.onsetDeltaMs} ms`,
      };
    } catch (error) {
      return refused(error, [`wav:${textOf((context.source as Row | null)?.file)}`]);
    }
  },
};

/** A4: agent echo never returns as caller speech. */
const a4: PropertyEvaluator = {
  propertyId: "A4",
  source: "audio.evaluators.ts",
  bars: [{ key: "dvEchoAsCallerSpeechMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    const rows = traceRows(context);
    const words = (value: string) =>
      value
        .normalize("NFC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
    const agentText = new Map<string, string>();
    for (const row of rows) {
      const turn = textOf(row.turn);
      const text = textOf(row.text);
      if (turn === "" || text === "") continue;
      if (row.type === "turn.reply_start" || row.type === "turn.first_audio" || row.type === "turn.agent_text") {
        agentText.set(turn, text);
      }
    }
    const callerRows = rows.filter(
      (row) => row.type === "turn.user_final" && textOf(row.text) !== "",
    );
    if (callerRows.length === 0) {
      return {
        kind: "unmeasured",
        reason:
          "echo-unmeasurable: the trace records caller length only, never the caller's words " +
          "or the agent's spoken text, so agent echo returning as caller speech cannot be " +
          "distinguished from legitimate caller speech",
        citations: [],
      };
    }
    if (agentText.size === 0) {
      return {
        kind: "unmeasured",
        reason:
          "echo-unmeasurable: the trace carries caller words but no agent text for the turn, " +
          "so there is no echo source to compare against",
        citations: [],
      };
    }

    const echoes: string[] = [];
    for (const row of callerRows) {
      const turn = textOf(row.turn);
      const agent = agentText.get(turn);
      if (agent === undefined) continue;
      const callerWords = words(textOf(row.text));
      const agentWords = new Set(words(agent));
      const repeated = callerWords.filter((word) => agentWords.has(word)).length;
      if (callerWords.length >= 2 && repeated / callerWords.length >= ECHO_SHARE) {
        echoes.push(turn);
      }
    }
    return {
      kind: "measured",
      samples: [echoes.length],
      citations: echoes.map((turn) => `trace:turn:${turn}`),
      detail: `${echoes.length} caller final${echoes.length === 1 ? "" : "s"} repeat the agent's own words`,
    };
  },
};

/** A5: the six existing timbre axes against the committed voice reference. */
const a5: PropertyEvaluator = {
  propertyId: "A5",
  source: "audio.evaluators.ts",
  bars: [
    { key: "timbreMeasuredTruePeakDbtp", statistic: "each", comparison: "at-most", sample: 0 },
    { key: "timbreMeasuredDistortionDb", statistic: "each", comparison: "at-most", sample: 1 },
    { key: "timbreMeasuredCrestMin", statistic: "each", comparison: "at-least", sample: 2 },
    { key: "timbreMeasuredBandDeltaDb", statistic: "each", comparison: "at-most", sample: 3 },
    { key: "timbreMeasuredBreakupMax", statistic: "each", comparison: "at-most", sample: 4 },
    { key: "timbreMeasuredBreakupMatchSeconds", statistic: "each", comparison: "at-most", sample: 5 },
  ],
  evaluate(context) {
    try {
      const capture = captureOf(context);
      const reference = loadVoiceReference();
      const compared = compareTimbre(
        reference.audio,
        reference.path,
        capture.audio,
        capture.file,
      );
      return {
        kind: "measured",
        samples: [
          compared.truePeakDbtp,
          compared.distortionDb,
          compared.crest,
          compared.bandDeltaDb,
          compared.breakups,
          compared.breakupMatchSeconds,
        ],
        citations: [`wav:${capture.file}`, `reference:${reference.path}`],
        detail:
          `true peak ${compared.truePeakDbtp.toFixed(2)} dBTP, ` +
          `distortion ${compared.distortionDb.toFixed(1)} dB, ` +
          `crest ${compared.crest.toFixed(2)}, ` +
          `band delta ${compared.bandDeltaDb.toFixed(2)} dB, ` +
          `${compared.breakups} unmatched breakup${compared.breakups === 1 ? "" : "s"}; ` +
          `against ${reference.path}`,
      };
    } catch (error) {
      return refused(error);
    }
  },
};

/** A6: no playout underrun and no overrun. */
const a6: PropertyEvaluator = {
  propertyId: "A6",
  source: "audio.evaluators.ts",
  bars: [
    { key: "dvPlayoutUnderrunMaxCount", statistic: "each", comparison: "at-most", sample: 0 },
    { key: "dvPlayoutOverrunMaxCount", statistic: "each", comparison: "at-most", sample: 1 },
  ],
  evaluate(context) {
    try {
      const capture = captureOf(context);
      const underruns = detectDropouts(capture.audio);
      const overruns = detectClippedRuns(capture.audio);
      return {
        kind: "measured",
        samples: [underruns.count, overruns.count],
        citations: [
          ...eventCitations(capture.file, underruns.events),
          ...eventCitations(capture.file, overruns.events),
        ],
        detail:
          `${underruns.count} underrun${underruns.count === 1 ? "" : "s"}` +
          `${firstEvent(underruns.events)}; ${overruns.count} overrun` +
          `${overruns.count === 1 ? "" : "s"}${firstEvent(overruns.events)}`,
      };
    } catch (error) {
      return refused(error);
    }
  },
};

/** A7: the barge-in fade is smooth, short and pop-free. */
const a7: PropertyEvaluator = {
  propertyId: "A7",
  source: "audio.evaluators.ts",
  bars: [
    { key: "dvBargeInFadeMaxMs", statistic: "each", comparison: "at-most", sample: 0 },
    { key: "dvBargeInPopMaxCount", statistic: "each", comparison: "at-most", sample: 1 },
  ],
  evaluate(context) {
    try {
      const cuts = traceRows(context).filter(
        (row) => row.type === "turn.cut" && row.reason === "barge_in",
      );
      if (cuts.length === 0) {
        return {
          kind: "unmeasured",
          reason:
            "no barge-in cut was recorded for this call, so there is no fade to measure; " +
            "A7 fails closed rather than passing an unexercised path",
          citations: [],
        };
      }
      const capture = captureOf(context);
      const fades = detectFades(capture.audio);
      if (fades.count === 0) {
        return {
          kind: "unmeasured",
          reason:
            "the barge-in cut left no speech-to-silence fade in the delivered capture; " +
            "A7 has no fade to measure",
          citations: [`wav:${capture.file}`],
        };
      }
      const longest = fades.events.reduce((worst, event) =>
        event.durationMs > worst.durationMs ? event : worst,
      );
      const clicks = detectClicks(capture.audio);
      const pops = clicks.events.filter((click) => {
        const nearStart = Math.abs(click.atMs - longest.atMs) <= 50;
        const nearEnd = Math.abs(click.atMs - (longest.atMs + longest.durationMs)) <= 50;
        return nearStart || nearEnd;
      });
      return {
        kind: "measured",
        samples: [longest.durationMs, pops.length],
        citations: [`wav:${capture.file}@${longest.atMs}ms`, ...eventCitations(capture.file, pops)],
        detail:
          `the longest fade is ${longest.durationMs} ms at ${longest.atMs} ms; ` +
          `${pops.length} click${pops.length === 1 ? "" : "s"} at its edges`,
      };
    } catch (error) {
      return refused(error);
    }
  },
};

/** A8: silence is not sent as audio. */
const a8: PropertyEvaluator = {
  propertyId: "A8",
  source: "audio.evaluators.ts",
  bars: [{ key: "dvSilentFrameMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const capture = captureOf(context);
      const reference = loadVoiceReference();
      const aligned = alignToReference(
        reference.audio,
        capture.audio,
        reference.path,
        capture.file,
      );
      const silent = silentFramesAgainstReference(
        aligned.reference.audio,
        aligned.delivered.audio,
      );
      return {
        kind: "measured",
        samples: [silent.count],
        citations: silent.windows.map((window) => `wav:${capture.file}@${window.atMs}ms`),
        detail:
          `${silent.count} ${silent.frameMs} ms frame${silent.count === 1 ? "" : "s"} ` +
          `the reference speaks and the delivery leaves silent` +
          (silent.windows[0] === undefined ? "" : `; first at ${silent.windows[0].atMs} ms`),
      };
    } catch (error) {
      return refused(error);
    }
  },
};

const audio: EvaluatorModule = {
  family: "audio",
  evaluators: [a1, a2, a3, a4, a5, a6, a7, a8],
};

export default audio;

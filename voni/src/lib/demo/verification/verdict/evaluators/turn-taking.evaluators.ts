/**
 * T1–T10: turn-taking, measured from the call the visitor actually had.
 *
 * The delivered WAV is the audibility ground truth; the browser marks anchor
 * it to the page's wall clock once; the synthetic microphone says when the
 * caller spoke; the pipeline's turn ledger says which turn and which cut were
 * recorded. Where a property is about a recorded decision (the caller final,
 * the cut, the reply's first frame) the ledger row is the measurement; where
 * it is about what the caller heard (response onset, stop, resume, dead air,
 * overlap) the delivered samples are.
 *
 * Every property fails closed: a missing WAV, marks anchor, caller report or
 * turn row is `unmeasured`, never a zero. A violation that the contract has no
 * numeric key for (a repeated filler tail, a missed end beside a ratio bar) is
 * reported as `unmeasured` with the violation named, because a fabricated
 * sample is worse than a red.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Turn-taking" T1–T10.
 */

import type {
  Evaluation,
  EvaluatorContext,
  EvaluatorModule,
  PropertyEvaluator,
} from "../types";
import { analyseWav, signature, similarity, type WavAnalysis } from "./turn-conduct/audio";
import { TurnConductError } from "./turn-conduct/errors";
import {
  readBrowser,
  readLedger,
  rowsOfType,
  type BrowserEvidence,
  type Ledger,
} from "./turn-conduct/evidence";
import {
  callerTakes,
  isFiller,
  nextOnset,
  onsetsInside,
  pageClock,
  realTakes,
  soundingAt,
  timedSegments,
  wavExcerpt,
  type CallerTakeInterval,
  type PageClock,
  type TimedSegment,
} from "./turn-conduct/timeline";

function reasonOf(error: unknown): string {
  return error instanceof TurnConductError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

function unmeasured(error: unknown): Evaluation {
  return { kind: "unmeasured", reason: reasonOf(error), citations: [] };
}

function wavFileOf(context: EvaluatorContext): string {
  const wav = context.evidence.wav;
  if (typeof wav !== "object" || wav === null || Array.isArray(wav)) {
    throw new TurnConductError("missing-evidence", "the call carries no delivered WAV facts");
  }
  const file = (wav as Record<string, unknown>).file;
  if (typeof file !== "string" || file.trim() === "") {
    throw new TurnConductError("missing-evidence", "the delivered WAV facts name no file");
  }
  return file;
}

type AudioCall = {
  readonly ledger: Ledger;
  readonly browser: BrowserEvidence;
  readonly analysis: WavAnalysis;
  readonly clock: PageClock;
  readonly segments: readonly TimedSegment[];
  readonly takes: readonly CallerTakeInterval[];
  readonly file: string;
};

function audioCall(context: EvaluatorContext): AudioCall {
  const ledger = readLedger(context.evidence.ledger);
  const browser = readBrowser(context.evidence.browser);
  const file = wavFileOf(context);
  const analysis = analyseWav(file);
  const clock = pageClock(ledger, analysis);
  return {
    ledger,
    browser,
    analysis,
    clock,
    segments: timedSegments(analysis, clock),
    takes: callerTakes(browser, context.facts, clock),
    file,
  };
}

/** The turn row whose event is nearest at or before a call instant. */
function turnAt(ledger: Ledger, callMs: number): string | null {
  let best: { turn: string; atMs: number } | null = null;
  for (const row of ledger.turns) {
    if (row.atMs <= callMs && (best === null || row.atMs > best.atMs)) {
      best = { turn: row.turn, atMs: row.atMs };
    }
  }
  return best?.turn ?? null;
}

function cite(citations: readonly (string | null | undefined)[]): string[] {
  return citations.filter((value): value is string => typeof value === "string" && value !== "");
}

/** The worst sample's citations: a card names one turn, not the whole pool. */
function worstCitations(
  samples: readonly { value: number; citations: readonly string[] }[],
  comparison: "max" | "min" = "max",
): string[] {
  if (samples.length === 0) return [];
  const ordered = [...samples].sort((left, right) =>
    comparison === "max" ? right.value - left.value : left.value - right.value,
  );
  return [...new Set(ordered[0]!.citations)];
}

function measuredSamples(
  entries: readonly { value: number; citations: readonly string[] }[],
  detail: string,
  comparison: "max" | "min" = "max",
): Evaluation {
  return {
    kind: "measured",
    samples: entries.map((entry) => entry.value),
    citations: worstCitations(entries, comparison),
    detail,
  };
}

// ── T1: first response ─────────────────────────────────────────────────────

const t1: PropertyEvaluator = {
  propertyId: "T1",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [
    { key: "dvFirstResponseP50Ms", statistic: "p50", comparison: "at-most" },
    { key: "dvFirstResponseP95Ms", statistic: "p95", comparison: "at-most" },
    { key: "dvFirstResponseMaxMs", statistic: "max", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const call = audioCall(context);
      const entries: { value: number; citations: string[] }[] = [];
      for (const take of realTakes(call.takes)) {
        const onset = nextOnset(call.segments, take.endEpochMs);
        if (onset === null) continue;
        entries.push({
          value: onset.startEpochMs - take.endEpochMs,
          citations: cite([
            turnAt(call.ledger, onset.startCallMs),
            wavExcerpt(call.file, onset),
            `take:${take.take}`,
          ]),
        });
      }
      if (entries.length === 0) {
        return {
          kind: "unmeasured",
          reason:
            "no caller turn received a delivered response onset; the first-response sample is empty",
          citations: [],
        };
      }
      return measuredSamples(entries, `${entries.length} caller turn(s) received a delivered response`);
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T2: substantive response start ─────────────────────────────────────────

const t2: PropertyEvaluator = {
  propertyId: "T2",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [
    { key: "dvSubstantiveResponseP50Ms", statistic: "p50", comparison: "at-most" },
    { key: "dvSubstantiveResponseP95Ms", statistic: "p95", comparison: "at-most" },
    { key: "dvSubstantiveResponseMaxMs", statistic: "max", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const ledger = readLedger(context.evidence.ledger);
      const finals = rowsOfType(ledger, "turn.user_final");
      const entries: { value: number; citations: string[] }[] = [];
      for (const first of rowsOfType(ledger, "turn.first_audio")) {
        const final = finals
          .filter((row) => row.atMs <= first.atMs)
          .sort((left, right) => right.atMs - left.atMs)[0];
        if (final === undefined) continue;
        entries.push({
          value: first.atMs - final.atMs,
          citations: [`turn:${first.turn}`],
        });
      }
      if (entries.length === 0) {
        return {
          kind: "unmeasured",
          reason:
            "no turn pairs a caller final with a first audio frame; the substantive response " +
            "cannot be timed",
          citations: [],
        };
      }
      return measuredSamples(
        entries,
        `${entries.length} turn(s) paired a caller final with a first audio frame`,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T3: barge-in stop ──────────────────────────────────────────────────────

/** A caller begins over the agent only after the agent was already sounding. */
const BARGE_MIN_LEAD_MS = 200;

function barges(
  call: AudioCall,
): { take: CallerTakeInterval; sounding: TimedSegment }[] {
  const found: { take: CallerTakeInterval; sounding: TimedSegment }[] = [];
  for (const take of realTakes(call.takes)) {
    const sounding = soundingAt(call.segments, take.startEpochMs);
    if (sounding === null) continue;
    // The greeting and the caller's first hello can begin together; that is
    // call open, not an interruption. A barge needs the agent already speaking.
    if (take.startEpochMs - sounding.startEpochMs < BARGE_MIN_LEAD_MS) continue;
    found.push({ take, sounding });
  }
  return found;
}

const t3: PropertyEvaluator = {
  propertyId: "T3",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [
    { key: "dvBargeInStopP95Ms", statistic: "p95", comparison: "at-most" },
    { key: "dvBargeInStopMaxMs", statistic: "max", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const call = audioCall(context);
      const cuts = rowsOfType(call.ledger, "turn.cut");
      if (cuts.length === 0) {
        return {
          kind: "unmeasured",
          reason:
            "the caller never took the floor from a sounding reply: the ledger records no cut, " +
            "so barge-in stop has no measurement",
          citations: [],
        };
      }
      const cutTurn = cuts[0]!;
      const entries = barges(call).map(({ take, sounding }) => ({
        value: Math.max(0, sounding.endEpochMs - take.startEpochMs),
        citations: cite([
          `turn:${cutTurn.turn}`,
          wavExcerpt(call.file, sounding),
          `take:${take.take}`,
        ]),
      }));
      if (entries.length === 0) {
        return {
          kind: "unmeasured",
          reason:
            "a cut was recorded, but no caller take overlaps a sounding reply in the delivered " +
            "audio; the stop cannot be tied to a barge",
          citations: [`turn:${cutTurn.turn}`],
        };
      }
      return measuredSamples(
        entries,
        `the reply stopped after ${entries.length} barge(s); turn:${cutTurn.turn}`,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T4: fillers never create a turn ────────────────────────────────────────

const t4: PropertyEvaluator = {
  propertyId: "T4",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [{ key: "dvFillerTurnMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const call = audioCall(context);
      if (!call.takes.some((take) => isFiller(take.text))) {
        return {
          kind: "unmeasured",
          reason: "the caller produced no filler or backchannel take in this call",
          citations: [],
        };
      }
      const finals = rowsOfType(call.ledger, "turn.user_final");
      const expected = realTakes(call.takes).length;
      const extra = Math.max(0, finals.length - expected);
      const spilled = finals.slice(expected);
      return {
        kind: "measured",
        samples: [extra],
        citations: spilled.map((row) => `turn:${row.turn}`),
        detail:
          `${finals.length} caller final(s) for ${expected} authored real turn(s); ` +
          `${extra} filler-created turn(s)`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T5: resume after a filler cut ──────────────────────────────────────────

const t5: PropertyEvaluator = {
  propertyId: "T5",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [{ key: "dvFillerResumeMaxMs", statistic: "max", comparison: "at-most" }],
  evaluate(context) {
    try {
      const call = audioCall(context);
      const fillers = call.takes.filter((take) => isFiller(take.text));
      if (fillers.length === 0) {
        return {
          kind: "unmeasured",
          reason: "the caller produced no filler; there is no filler cut to resume",
          citations: [],
        };
      }
      const entries: { value: number; citations: string[] }[] = [];
      for (const filler of fillers) {
        const before =
          soundingAt(call.segments, filler.startEpochMs) ??
          call.segments.filter((segment) => segment.endEpochMs <= filler.startEpochMs).at(-1);
        const resumed = nextOnset(call.segments, filler.endEpochMs);
        if (resumed === null) {
          return {
            kind: "unmeasured",
            reason:
              `nothing resumed after filler "${filler.take}"; the reply never returned to the audio`,
            citations: [`take:${filler.take}`],
          };
        }
        if (before !== undefined) {
          const score = similarity(
            signature(call.analysis, before),
            signature(call.analysis, resumed),
          );
          if (score > 0.9) {
            return {
              kind: "unmeasured",
              reason:
                `the resumed audio after filler "${filler.take}" repeats the cut tail ` +
                `(similarity ${score.toFixed(2)}); a repeat is a violation, not a pass`,
              citations: cite([
                wavExcerpt(call.file, before),
                wavExcerpt(call.file, resumed),
                `take:${filler.take}`,
              ]),
            };
          }
        }
        entries.push({
          value: resumed.startEpochMs - filler.endEpochMs,
          citations: cite([
            turnAt(call.ledger, resumed.startCallMs),
            wavExcerpt(call.file, resumed),
            `take:${filler.take}`,
          ]),
        });
      }
      return measuredSamples(entries, `${entries.length} filler cut(s) resumed`);
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T6: interruption at a clause boundary ──────────────────────────────────

const t6: PropertyEvaluator = {
  propertyId: "T6",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [{ key: "dvRestartFromTopMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const call = audioCall(context);
      const found = barges(call);
      if (found.length === 0) {
        return {
          kind: "unmeasured",
          reason: "no caller take overlapped a sounding reply; no clause interruption occurred",
          citations: [],
        };
      }
      const entries: { value: number; citations: string[] }[] = [];
      for (const { take, sounding } of found) {
        const after = nextOnset(call.segments, sounding.endEpochMs);
        if (after === null) {
          entries.push({
            value: 1,
            citations: cite([turnAt(call.ledger, take.endCallMs), `take:${take.take}`]),
          });
          continue;
        }
        if (after.startEpochMs === sounding.startEpochMs) {
          return {
            kind: "unmeasured",
            reason:
              `the reply kept sounding through the caller's barge ("${take.take}"); ` +
              "no stop was audible, so no resume can be judged",
            citations: [wavExcerpt(call.file, sounding)],
          };
        }
        const score = similarity(
          signature(call.analysis, sounding),
          signature(call.analysis, after),
        );
        entries.push({
          value: score > 0.9 ? 1 : 0,
          citations: cite([
            turnAt(call.ledger, after.startCallMs),
            wavExcerpt(call.file, sounding),
            wavExcerpt(call.file, after),
            `take:${take.take}`,
          ]),
        });
      }
      return measuredSamples(
        entries,
        `${entries.length} clause interruption(s); the resumed or answering line was compared ` +
          "to the cut reply's opening",
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T7: overlap — no double playback, no lost final ────────────────────────

const DOUBLED_GAP_MS = 150;
const DOUBLED_SIMILARITY = 0.95;

const t7: PropertyEvaluator = {
  propertyId: "T7",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [
    { key: "dvDoubledFramesMaxCount", statistic: "each", comparison: "at-most" },
    { key: "dvLostFinalMaxCount", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const call = audioCall(context);
      let doubledFrames = 0;
      const doubledCitations: string[] = [];
      const signatures = call.segments.map((segment) => signature(call.analysis, segment));
      for (let index = 1; index < call.segments.length; index += 1) {
        const previous = call.segments[index - 1]!;
        const current = call.segments[index]!;
        if (current.startEpochMs - previous.endEpochMs > DOUBLED_GAP_MS) continue;
        if (similarity(signatures[index - 1]!, signatures[index]!) < DOUBLED_SIMILARITY) continue;
        doubledFrames += current.frames;
        doubledCitations.push(
          wavExcerpt(call.file, previous),
          wavExcerpt(call.file, current),
        );
      }

      const finals = rowsOfType(call.ledger, "turn.user_final");
      const overlapped = barges(call).length > 0;
      const expected = overlapped ? realTakes(call.takes).length : 0;
      const lost = overlapped ? Math.max(0, expected - finals.length) : 0;
      const lostCitations = lost === 0 ? [] : finals.slice(-1).map((row) => `turn:${row.turn}`);
      const floorTurn = finals.at(-1)?.turn ?? null;

      return {
        kind: "measured",
        samples: [doubledFrames + lost],
        citations: cite([
          ...doubledCitations,
          ...lostCitations,
          floorTurn === null ? null : `turn:${floorTurn}`,
        ]),
        detail:
          `${doubledFrames} doubled frame(s) across ${doubledCitations.length / 2} repeated ` +
          `segment pair(s); ${lost} lost final(s) of ${expected} authored turn(s) under overlap`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T8: dead air without a bridge ──────────────────────────────────────────

const t8: PropertyEvaluator = {
  propertyId: "T8",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [{ key: "dvDeadAirWithoutBridgeMaxMs", statistic: "max", comparison: "at-most" }],
  evaluate(context) {
    try {
      const call = audioCall(context);
      if (call.segments.length < 2) {
        return {
          kind: "measured",
          samples: [0],
          citations: [],
          detail: "fewer than two delivered utterances; no inter-utterance pause exists",
        };
      }
      const entries: { value: number; citations: string[] }[] = [];
      for (let index = 1; index < call.segments.length; index += 1) {
        const previous = call.segments[index - 1]!;
        const current = call.segments[index]!;
        const gapMs = current.startEpochMs - previous.endEpochMs;
        if (gapMs <= 0) continue;
        const bridged = call.takes.some(
          (take) =>
            take.endEpochMs > previous.endEpochMs && take.startEpochMs < current.startEpochMs,
        );
        if (bridged) continue;
        entries.push({
          value: gapMs,
          citations: cite([
            turnAt(call.ledger, current.startCallMs),
            wavExcerpt(call.file, previous),
            wavExcerpt(call.file, current),
          ]),
        });
      }
      if (entries.length === 0) {
        return {
          kind: "measured",
          samples: [0],
          citations: [],
          detail: "every inter-utterance pause was bridged by caller speech or was empty",
        };
      }
      return measuredSamples(entries, `${entries.length} uncovered pause(s) between utterances`);
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T9: endpointing ────────────────────────────────────────────────────────

/** A reply that begins this long into a caller take was not a continuation. */
const PREMATURE_MIN_OFFSET_MS = 200;

const t9: PropertyEvaluator = {
  propertyId: "T9",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [
    { key: "dvPrematureCutMaxRatio", statistic: "each", comparison: "at-most" },
    { key: "dvMissedEndMaxMs", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const call = audioCall(context);
      const takes = realTakes(call.takes);
      if (takes.length === 0) {
        return {
          kind: "unmeasured",
          reason: "the call has no authored caller turn to endpoint",
          citations: [],
        };
      }
      let premature = 0;
      let missedMax = 0;
      const citations: string[] = [];
      for (const take of takes) {
        const inside = onsetsInside(call.segments, take.startEpochMs, take.endEpochMs).filter(
          (segment) => segment.startEpochMs - take.startEpochMs >= PREMATURE_MIN_OFFSET_MS,
        );
        if (inside.length > 0) {
          premature += 1;
          citations.push(...inside.map((segment) => wavExcerpt(call.file, segment)));
        }
        const onset = nextOnset(call.segments, take.endEpochMs);
        if (onset !== null) {
          missedMax = Math.max(missedMax, onset.startEpochMs - take.endEpochMs);
        }
      }
      const missedBudget = context.property.thresholds.find(
        (entry) => entry.key === "dvMissedEndMaxMs",
      );
      const budget = missedBudget?.value ?? Number.POSITIVE_INFINITY;
      if (missedMax > budget) {
        return {
          kind: "unmeasured",
          reason:
            `missed end ${Math.round(missedMax)}ms exceeds ${budget}ms; the contract's second ` +
            "T9 bar has milliseconds where the first has a ratio, and one sample cannot carry both",
          citations,
        };
      }
      return {
        kind: "measured",
        samples: [premature / takes.length],
        citations,
        detail:
          `${premature} of ${takes.length} turn(s) were cut before the caller finished; ` +
          `worst missed end ${Math.round(missedMax)}ms ≤ ${budget}ms`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── T10: no reply starts while the caller speaks ───────────────────────────

const t10: PropertyEvaluator = {
  propertyId: "T10",
  source: "verdict/evaluators/turn-taking.evaluators.ts",
  bars: [{ key: "dvReplyWhileCallerSpeaksMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const call = audioCall(context);
      const takes = realTakes(call.takes);
      if (takes.length === 0) {
        return {
          kind: "unmeasured",
          reason: "the call has no authored caller turn; overlap with caller speech is unmeasured",
          citations: [],
        };
      }
      const found: TimedSegment[] = [];
      for (const take of takes) {
        found.push(
          ...onsetsInside(call.segments, take.startEpochMs, take.endEpochMs).filter(
            (segment) => segment.startEpochMs - take.startEpochMs >= PREMATURE_MIN_OFFSET_MS,
          ),
        );
      }
      return {
        kind: "measured",
        samples: [found.length],
        citations: found.map((segment) => wavExcerpt(call.file, segment)),
        detail:
          `${found.length} reply onset(s) began inside a caller take; ` +
          "0 is the bar",
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const turnTaking: EvaluatorModule = {
  family: "turn-taking",
  evaluators: [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10],
};

export default turnTaking;

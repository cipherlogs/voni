/**
 * One clock for the browser call: the delivered WAV on the left, the page and
 * the synthetic microphone on the right.
 *
 * The WAV has no absolute time; the marks do. The first audible mark is the
 * worklet's first rendered block and the WAV's first voiced frame is that same
 * moment, so one anchor reconciles them once per call — never per turn. The
 * synthetic microphone reports each caller take's wall-clock start, so caller
 * speech and delivered agent speech land on the same timeline.
 *
 * A call without the anchor (no marks, no voiced audio) cannot be reconciled:
 * every audio-timing evaluator fails closed with `no-anchor`.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Turn-taking" T1–T10.
 */

import type { ScenarioFacts } from "../../../scenarios";
import type { WavAnalysis, VoicedSegment } from "./audio";
import { TurnConductError } from "./errors";
import { firstMark, type BrowserEvidence, type Ledger } from "./evidence";

export type PageClock = {
  /** The `first_audible` mark's wall clock and the WAV's first voiced frame. */
  readonly anchorEpochMs: number;
  readonly anchorWavMs: number;
  readonly startedAtEpochMs: number;
  wavMsToEpoch(ms: number): number;
  epochToWavMs(epochMs: number): number;
  epochToCallMs(epochMs: number): number;
};

/** One delivered voiced stretch, on the page's wall clock and the call clock. */
export type TimedSegment = VoicedSegment & {
  readonly startEpochMs: number;
  readonly endEpochMs: number;
  readonly startCallMs: number;
  readonly endCallMs: number;
};

/** Reconcile the WAV with the page's marks once. No anchor is a named refusal. */
export function pageClock(ledger: Ledger, analysis: WavAnalysis): PageClock {
  const audible = firstMark(ledger.marks, "first_audible");
  if (audible === null) {
    throw new TurnConductError(
      "no-anchor",
      "the browser marks carry no first_audible mark; the delivered WAV cannot be tied to " +
        "the call's wall clock",
    );
  }
  if (analysis.firstVoicedMs === null) {
    throw new TurnConductError(
      "no-anchor",
      "the delivered WAV contains no voiced frame; there is no first audible sample to anchor",
    );
  }
  const startedAt = Date.parse(ledger.marks?.startedAt ?? "");
  if (!Number.isFinite(startedAt)) {
    throw new TurnConductError(
      "malformed-evidence",
      "the browser marks' startedAt is not an ISO timestamp",
    );
  }
  const anchorEpochMs = audible.epochMs;
  const anchorWavMs = analysis.firstVoicedMs;
  return {
    anchorEpochMs,
    anchorWavMs,
    startedAtEpochMs: startedAt,
    wavMsToEpoch(ms: number) {
      return anchorEpochMs + (ms - anchorWavMs);
    },
    epochToWavMs(epochMs: number) {
      return anchorWavMs + (epochMs - anchorEpochMs);
    },
    epochToCallMs(epochMs: number) {
      return epochMs - startedAt;
    },
  };
}

/** Every voiced stretch, mapped once. */
export function timedSegments(analysis: WavAnalysis, clock: PageClock): TimedSegment[] {
  return analysis.segments.map((segment) => {
    const startEpochMs = clock.wavMsToEpoch(segment.startMs);
    const endEpochMs = clock.wavMsToEpoch(segment.endMs);
    return {
      ...segment,
      startEpochMs,
      endEpochMs,
      startCallMs: clock.epochToCallMs(startEpochMs),
      endCallMs: clock.epochToCallMs(endEpochMs),
    };
  });
}

/** One caller take, resolved to the interval the synthetic mic actually played. */
export type CallerTakeInterval = {
  /** The script step index, 0-based. */
  readonly step: number;
  readonly take: string;
  readonly text: string | null;
  readonly startEpochMs: number;
  readonly endEpochMs: number;
  readonly startCallMs: number;
  readonly endCallMs: number;
};

/**
 * The caller takes and their intervals. The report's step is the script index;
 * the scenario's authored words travel in `facts`. A take with no wall clock
 * cannot be placed on the timeline and is a named refusal.
 */
export function callerTakes(
  browser: BrowserEvidence,
  facts: ScenarioFacts | undefined,
  clock: PageClock,
): CallerTakeInterval[] {
  const played = browser.syntheticMic?.takesPlayed ?? [];
  if (played.length === 0) {
    throw new TurnConductError(
      "missing-evidence",
      "the synthetic microphone reports no caller take; the caller side of the call is unmeasured",
    );
  }
  return played.map((take, index) => {
    if (take.epochMs === null) {
      throw new TurnConductError(
        "no-anchor",
        `caller take "${take.take}" (step ${take.step}) carries no wall-clock start; ` +
          "the synthetic microphone report predates the epoch field",
      );
    }
    const fact = facts?.takes[take.step] ?? facts?.takes[index];
    if (fact !== undefined && fact.id !== take.take) {
      throw new TurnConductError(
        "malformed-evidence",
        `the synthetic microphone played "${take.take}" at step ${take.step}, but the ` +
          `scenario's authored step is "${fact.id}"`,
      );
    }
    return {
      step: take.step,
      take: take.take,
      text: fact?.text ?? null,
      startEpochMs: take.epochMs,
      endEpochMs: take.epochMs + take.durationMs,
      startCallMs: clock.epochToCallMs(take.epochMs),
      endCallMs: clock.epochToCallMs(take.epochMs + take.durationMs),
    };
  });
}

/** A backchannel: a listening sound, never a turn. */
const FILLER = /^(?:mm+|mm hm+|mhm+|hmm+|uh+huh|uh huh|yeah|yep|okay|ok|right|sure|got it|i see)$/;

export function isFiller(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  const normalized = text
    .toLowerCase()
    .replace(/[.!?,;:]+/g, " ").replace(/[\-\u2013\u2014]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return FILLER.test(normalized);
}

/** The caller's real turns: the authored takes that are not backchannels. */
export function realTakes(takes: readonly CallerTakeInterval[]): CallerTakeInterval[] {
  return takes.filter((take) => take.text !== null && take.text.trim() !== "" && !isFiller(take.text));
}

/** The first delivered voice onset after `afterEpochMs`, within `beforeEpochMs`. */
export function nextOnset(
  segments: readonly TimedSegment[],
  afterEpochMs: number,
  beforeEpochMs = Number.POSITIVE_INFINITY,
): TimedSegment | null {
  for (const segment of segments) {
    if (segment.startEpochMs >= afterEpochMs && segment.startEpochMs <= beforeEpochMs) {
      return segment;
    }
  }
  return null;
}

/** The segment that is sounding at an instant, if any. */
export function soundingAt(
  segments: readonly TimedSegment[],
  epochMs: number,
): TimedSegment | null {
  for (const segment of segments) {
    if (segment.startEpochMs <= epochMs && segment.endEpochMs >= epochMs) return segment;
  }
  return null;
}

/** Every onset that begins inside `[from, to)`. */
export function onsetsInside(
  segments: readonly TimedSegment[],
  from: number,
  to: number,
): TimedSegment[] {
  return segments.filter(
    (segment) => segment.startEpochMs >= from && segment.startEpochMs < to,
  );
}

/** A WAV excerpt citation a defect card can resolve by sample range. */
export function wavExcerpt(file: string, segment: VoicedSegment): string {
  return `wav:${file}@${Math.round(segment.startMs)}-${Math.round(segment.endMs)}ms`;
}

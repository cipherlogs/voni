/**
 * UI-observable timing marks for the browser test call.
 *
 * The audio/WS internals live in `session.ts`; this recorder only tracks what
 * the UI layer (`voice-call.tsx`) can see: user gesture, VoiceState
 * transitions, first transcripts, and filler display. That keeps the hot audio
 * path untouched while still measuring the pause the user feels
 * (startRequested -> firstAgentTurn) and where it goes.
 *
 * WS-level marks (token fetch, session.ready, first audio frame) are a
 * follow-up inside `VoiceSession`; the gaps here tell us whether that is
 * worth the risk.
 */

export type CallTimingMark =
  | "startRequested"
  | "connecting"
  | "listening"
  | "speaking"
  | "firstUserTurn"
  | "firstAgentTurn"
  | "firstPartial"
  | "fillerShown"
  | "ended";

export type CallTimingSample = {
  mark: CallTimingMark;
  /** Wall-clock ms from the injected clock (defaults to Date.now). */
  atMs: number;
  /** Ms since startRequested, or since the first mark when start is missing. */
  elapsedMs: number;
};

export type CallTimingSummary = {
  marks: Partial<Record<CallTimingMark, number>>;
  gapsMs: {
    startToConnecting: number | null;
    startToListening: number | null;
    startToFirstAgentTurn: number | null;
    listeningToFirstAgentTurn: number | null;
    startToFirstPartial: number | null;
    userFinalToFirstAgentTurn: number | null;
  };
};

function gap(
  marks: Partial<Record<CallTimingMark, number>>,
  from: CallTimingMark,
  to: CallTimingMark,
): number | null {
  const a = marks[from];
  const b = marks[to];
  if (a === undefined || b === undefined) return null;
  return b - a;
}

export class CallTimings {
  private samples: CallTimingSample[] = [];
  private anchor: number | null = null;

  constructor(private now: () => number = () => Date.now()) {}

  /** Record a mark; the first occurrence of each mark wins. */
  mark(mark: CallTimingMark): void {
    if (this.samples.some((s) => s.mark === mark)) return;
    const atMs = this.now();
    if (this.anchor === null) this.anchor = atMs;
    this.samples.push({ mark, atMs, elapsedMs: atMs - this.anchor });
  }

  marks(): CallTimingSample[] {
    return [...this.samples];
  }

  summary(): CallTimingSummary {
    const marks: Partial<Record<CallTimingMark, number>> = {};
    for (const s of this.samples) marks[s.mark] = s.atMs;
    return {
      marks,
      gapsMs: {
        startToConnecting: gap(marks, "startRequested", "connecting"),
        startToListening: gap(marks, "startRequested", "listening"),
        startToFirstAgentTurn: gap(marks, "startRequested", "firstAgentTurn"),
        listeningToFirstAgentTurn: gap(marks, "listening", "firstAgentTurn"),
        startToFirstPartial: gap(marks, "startRequested", "firstPartial"),
        userFinalToFirstAgentTurn: gap(marks, "firstUserTurn", "firstAgentTurn"),
      },
    };
  }

  reset(): void {
    this.samples = [];
    this.anchor = null;
  }
}

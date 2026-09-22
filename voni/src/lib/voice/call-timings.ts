/**
 * UI-observable timing marks for the browser test call + WS internals.
 *
 * The audio/WS internals live in `session.ts` and report through
 * `VoiceHandlers.onTiming`: token fetch, mic grant, socket open,
 * session.ready, first config ack, first agent audio. The UI layer
 * (`voice-call.tsx`, copilot rail) records the same marks here so the
 * Hi->Hi gap splits into network vs model vs playback segments.
 */

export type CallTimingMark =
  | "startRequested"
  | "connecting"
  | "tokenDone"
  | "micDone"
  | "wsOpen"
  | "sessionReady"
  | "firstUpdateAck"
  | "greetingAudio"
  | "instantAckShown"
  | "listening"
  | "speaking"
  | "firstUserTurn"
  | "firstAgentTurn"
  | "firstPartial"
  | "speculativePrefetch"
  | "speculativeNav"
  | "confirmedNav"
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
    partialToSpeculativeNav: number | null;
    speculativeToConfirmed: number | null;
    partialToConfirmed: number | null;
    startToSessionReady: number | null;
    sessionReadyToFirstAgentTurn: number | null;
    startToFirstUpdateAck: number | null;
    wsOpenToSessionReady: number | null;
    startToGreetingAudio: number | null;
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
        partialToSpeculativeNav: gap(marks, "firstPartial", "speculativeNav"),
        speculativeToConfirmed: gap(marks, "speculativeNav", "confirmedNav"),
        partialToConfirmed: gap(marks, "firstPartial", "confirmedNav"),
        startToSessionReady: gap(marks, "startRequested", "sessionReady"),
        sessionReadyToFirstAgentTurn: gap(marks, "sessionReady", "firstAgentTurn"),
        startToFirstUpdateAck: gap(marks, "startRequested", "firstUpdateAck"),
        wsOpenToSessionReady: gap(marks, "wsOpen", "sessionReady"),
        startToGreetingAudio: gap(marks, "startRequested", "greetingAudio"),
      },
    };
  }

  reset(): void {
    this.samples = [];
    this.anchor = null;
  }
}

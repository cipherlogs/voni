/**
 * Per-turn latency split arithmetic (demo-latency ticket 02).
 *
 * One Call trace turn plus that turn's client receipt marks and the call's one
 * clock anchor split a formerly undivided reply wait into what the pipeline
 * actually did:
 *
 *   caller end of speech ──endpointingMs──▶ final caller transcript receipt
 *                        ──generationMs───▶ reply-start message receipt
 *                        ──deliveryMs─────▶ first audio chunk receipt
 *
 * Every duration is expressed on the Call trace's clock (server epoch ms):
 * the anchor pairs one client receipt with the same instant on the trace, and
 * its single offset moves every client mark once per call. There is no
 * per-turn skew guess.
 *
 * A mark that never arrived yields no sample at all, never a zero or a partial
 * duration. `perceivedMs` is the report-only number a caller would feel: the
 * three waits plus the playout pre-roll; the pre-roll is never added to
 * `deliveryMs` or to any gate input.
 */
import { PLAYOUT_PREROLL_MS } from "./playout-preroll";

/** The interaction band a turn belongs to. */
export type LatencyBand = "ordinary" | "post-cut";

/** The Call trace fields the split reads (server clock, epoch ms). */
export type LatencySplitTurn = {
  user_speech_started_at_ms?: number | null;
  user_speech_ended_at_ms?: number | null;
};

/** The three client receipts for one measured turn, call-relative ms. */
export type LatencySplitMarks = {
  /** `turn.user_final` receipt. */
  userFinalAtMs?: number | null;
  /** `turn.reply_start` receipt (the server's `reply.started`). */
  replyStartAtMs?: number | null;
  /** `reply.first_audio` receipt carrying this turn's id. */
  firstAudioAtMs?: number | null;
};

/**
 * The call's one reconciliation point: the `reply.first_audio` receipt marked
 * `anchor: true` paired with the same first audio on the Call trace clock
 * (that turn's `agent_reply_started_at_ms + time_to_first_audio_ms`).
 */
export type LatencyCallAnchor = {
  clientAtMs?: number | null;
  serverAtMs?: number | null;
};

/** The nearest earlier agent reply in the call, or null/absent for the first. */
export type PreviousReply = { endedAtMs?: number | null } | null;

export type LatencySplitInput = {
  turn: LatencySplitTurn;
  marks: LatencySplitMarks;
  anchor: LatencyCallAnchor;
  previousReply?: PreviousReply;
};

export type LatencySplit = {
  /** Caller end of speech → final caller transcript receipt. */
  endpointingMs: number;
  /** Final transcript receipt → reply-start receipt. */
  generationMs: number;
  /** Reply-start receipt → first audio receipt. */
  deliveryMs: number;
  band: LatencyBand;
  /** Caller-perceived wait: the three waits plus the playout pre-roll. */
  perceivedMs: number;
};

const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function latencySplit(input: LatencySplitInput): LatencySplit | null {
  const speechStartedMs = finite(input.turn.user_speech_started_at_ms);
  const speechEndedMs = finite(input.turn.user_speech_ended_at_ms);
  const userFinalMs = finite(input.marks.userFinalAtMs);
  const replyStartMs = finite(input.marks.replyStartAtMs);
  const firstAudioMs = finite(input.marks.firstAudioAtMs);
  const anchorClientMs = finite(input.anchor.clientAtMs);
  const anchorServerMs = finite(input.anchor.serverAtMs);

  if (
    speechStartedMs === null ||
    speechEndedMs === null ||
    userFinalMs === null ||
    replyStartMs === null ||
    firstAudioMs === null ||
    anchorClientMs === null ||
    anchorServerMs === null
  ) {
    return null;
  }

  // `ordinary` when the caller's speech began after the previous reply's audio
  // ended (or there was no previous reply); `post-cut` when it began while that
  // audio was still sounding. A previous reply whose end mark never arrived
  // cannot be classified, so it yields no sample rather than a guess.
  let band: LatencyBand = "ordinary";
  if (input.previousReply) {
    const previousEndedMs = finite(input.previousReply.endedAtMs);
    if (previousEndedMs === null) return null;
    if (speechStartedMs < previousEndedMs) band = "post-cut";
  }

  // One offset per call, taken from the anchor, then every receipt is read on
  // the Call trace clock.
  const offsetMs = anchorServerMs - anchorClientMs;
  const onTrace = (clientMs: number) => clientMs + offsetMs;

  const endpointingMs = onTrace(userFinalMs) - speechEndedMs;
  const generationMs = onTrace(replyStartMs) - onTrace(userFinalMs);
  const deliveryMs = onTrace(firstAudioMs) - onTrace(replyStartMs);

  return {
    endpointingMs,
    generationMs,
    deliveryMs,
    band,
    perceivedMs: endpointingMs + generationMs + deliveryMs + PLAYOUT_PREROLL_MS,
  };
}

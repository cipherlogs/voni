/**
 * Client receipt marks for the per-turn latency split (demo-latency ticket 01).
 *
 * The split needs three client instants per measured caller turn: when the
 * final caller transcript arrived, when the reply-start message arrived, and
 * when the reply's first audio chunk arrived. They ride the opt-in event
 * stream (`eval-events.ts`), carry call-relative ms and a stable per-call
 * `turnId` only, and are attributed to the reply id the server started.
 *
 * Exactly one mark per call is the clock anchor (`anchor: true`): the first
 * measured turn's first-audio receipt. A reader reconciles the client clock to
 * the Call trace once from that mark, never per turn.
 *
 * A mark that never arrived is omitted, never synthesized: an agent-initiated
 * reply (greeting, check-in) has no caller turn, and a turn whose reply never
 * starts has no reply-start or first-audio mark. The caller's words and the
 * audio payload are never read or copied here.
 */
import type { EvalEvent, EvalEventWriter } from "./eval-events";

/** The socket fields the marks read; payload fields may be present and are ignored. */
export type TurnMarkMessage = {
  type: string;
  reply_id?: unknown;
  item_id?: unknown;
  text?: unknown;
  data?: unknown;
};

export type TurnMarkContext = {
  sessionId: string | null;
  /** Call-relative ms; also written as the line's `atMs`. */
  atMs: number;
};

export type TurnMarks = {
  /** False when the stream is off: every `observe` is a no-op returning null. */
  readonly enabled: boolean;
  /** Feed one already-parsed socket message the eval received. */
  observe: (message: TurnMarkMessage, context: TurnMarkContext) => EvalEvent | null;
};

export function createTurnMarks(writer: EvalEventWriter): TurnMarks {
  const enabled = writer.path !== null;
  let turns = 0;
  /** The caller turn whose reply has not started yet. */
  let pendingTurnId: string | null = null;
  /** The reply each measured turn was answered with (first `reply.started`). */
  const replyTurn = new Map<string, string>();
  const firstAudioSeen = new Set<string>();
  let anchored = false;

  return {
    enabled,
    observe(message, { sessionId, atMs }) {
      if (!enabled) return null;
      if (message.type === "transcript.user") {
        // A turn still pending here never got a reply: its reply-start and
        // first-audio marks stay omitted. This turn starts its own.
        turns += 1;
        pendingTurnId = `turn-${turns}`;
        return writer.emit("turn.user_final", {
          sessionId,
          turnId: pendingTurnId,
          atMs,
          callMs: atMs,
        });
      }
      if (message.type === "reply.started") {
        const replyId = typeof message.reply_id === "string" ? message.reply_id : null;
        if (pendingTurnId === null || replyId === null) return null;
        const turnId = pendingTurnId;
        pendingTurnId = null;
        replyTurn.set(replyId, turnId);
        return writer.emit("turn.reply_start", {
          sessionId,
          turnId,
          replyId,
          atMs,
          callMs: atMs,
        });
      }
      if (message.type === "reply.audio") {
        const replyId = typeof message.reply_id === "string" ? message.reply_id : null;
        if (replyId === null || firstAudioSeen.has(replyId)) return null;
        firstAudioSeen.add(replyId);
        const turnId = replyTurn.get(replyId);
        if (turnId !== undefined) {
          // The call's one reconciliation point: first audio of the first
          // measured turn (delivery is a few tens of ms, so this is the mark
          // the Call trace's own reply start + time-to-first-audio match).
          const anchor = !anchored;
          anchored = true;
          return writer.emit("reply.first_audio", {
            sessionId,
            turnId,
            replyId,
            atMs,
            callMs: atMs,
            ...(anchor ? { anchor: true } : {}),
          });
        }
        // No caller turn to correlate (the greeting): still a real receipt.
        return writer.emit("reply.first_audio", {
          sessionId,
          replyId,
          atMs,
          callMs: atMs,
        });
      }
      return null;
    },
  };
}

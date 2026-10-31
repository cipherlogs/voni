import BOUNDS from "./cascade-bounds.json";

/**
 * THE HOLD RETURN'S BOUNDED HISTORY (demo-cascade ticket 13).
 *
 * A resumed demo call re-mints the signed body for the same call id. The body
 * carries the most recent conversation turns so the model continues from what
 * the caller actually said instead of opening blank. The count comes from the
 * pipeline's bound registry through the app's one bounds record — never a
 * literal here.
 *
 * The shape is the vendor's Chat Completions history: `user` / `assistant`,
 * content only. Hidden notes are not turns, so they cannot be carried (the
 * transcript holds settled captions alone). Empty lines are dropped so a
 * pause never becomes a blank message.
 */

export const RESUME_HISTORY_TURNS = BOUNDS.resumeHistoryTurns;

export type ResumeTurn = {
  role: "user" | "agent";
  text: string;
};

export type ResumeMessage = {
  role: "user" | "assistant";
  content: string;
};

/** The newest `RESUME_HISTORY_TURNS` settled turns, in conversation order. */
export function boundedResumeHistory(
  turns: readonly ResumeTurn[],
  limit: number = RESUME_HISTORY_TURNS,
): ResumeMessage[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return turns
    .filter((turn) => turn.text.trim() !== "")
    .slice(-limit)
    .map((turn) => ({
      role: turn.role === "agent" ? "assistant" : "user",
      content: turn.text,
    }));
}

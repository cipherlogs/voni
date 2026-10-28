import type { Transcript } from "./session";

/**
 * Overheard caption contract (spec story 7): visitor words spoken while the
 * agent holds the floor are marked "· overheard" in the live caption, and the
 * settled turn keeps that mark when it lands in the transcript ledger — so
 * nothing said over Voni ever vanishes. No React, no I/O: the component
 * derives, these helpers pin the behavior (same seam as call-status-view).
 */

/** The live user caption: marked only while the agent is speaking. */
export function userCaption(text: string, agentSpeaking: boolean): Transcript | null {
  if (!text.trim()) return null;
  return agentSpeaking ? { role: "user", text, overheard: true } : { role: "user", text };
}

/**
 * The settled turn. A final that resolves an overheard partial keeps the mark
 * in history; an agent final never inherits the visitor's mark.
 */
export function settleOverheardTurn(turn: Transcript, overheard: boolean): Transcript {
  return overheard && turn.role === "user" ? { ...turn, overheard: true } : turn;
}

/** Speaker-label suffix for a transcript or live-caption row. */
export function overheardLabel(line: Transcript | null | undefined): string {
  return line?.overheard ? " · overheard" : "";
}

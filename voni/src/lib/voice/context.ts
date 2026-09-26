/** Hidden system context shared by the managed and cascade voice transports. */
export const MICROPHONE_MUTED_CONTEXT =
  "The user's microphone is muted; do not expect user speech until unmuted.";

export const MICROPHONE_UNMUTED_CONTEXT =
  "The user's microphone is available again.";

/** The visitor stepped away from the page; the call is on hold, not over. */
export const HOLD_ON_CONTEXT =
  "The visitor's page was paused by their browser (another app). The call is on hold: do not expect user speech until they return.";

/** The visitor is back on the page; the hold is over. */
export const HOLD_OFF_CONTEXT =
  "The visitor is back on the page; the hold is over.";

export function buildConversationMessage(content: string): Record<string, string> {
  return { type: "conversation.message", role: "system", content };
}

export function buildCascadeContextMessage(content: string): Record<string, string> {
  return { type: "context", role: "system", content };
}

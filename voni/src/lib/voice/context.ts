/** Hidden system context shared by the managed and cascade voice transports. */
export const MICROPHONE_MUTED_CONTEXT =
  "The user's microphone is muted; do not expect user speech until unmuted.";

export const MICROPHONE_UNMUTED_CONTEXT =
  "The user's microphone is available again.";

export function buildConversationMessage(content: string): Record<string, string> {
  return { type: "conversation.message", role: "system", content };
}

export function buildCascadeContextMessage(content: string): Record<string, string> {
  return { type: "context", role: "system", content };
}

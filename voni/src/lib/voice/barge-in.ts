import { cleanTokens, FILLER_TOKENS, isCommandBargeIn, isEndCallRequest } from "./jev-judges";

/**
 * Barge-in: the server stops the agent, the session recovers
 * (docs/adr/0003-barge-in-recovery.md).
 *
 * The server must own the barge-in. With its barge-in off, speech over the
 * agent's audio is dropped for good, and while the agent speaks it sends no
 * live partials either. So the server stops the agent (its defaults: no
 * turn_detection is ever sent, see ADAPTIVE_TURNS in ./session.ts), and the
 * session repairs the stops that weren't real: once the caller's words
 * land, they are judged here. Steering, content and a request to end the
 * call are answered as a normal turn. Filler, back-channels and the agent's
 * own echo (and asides, per Jev) make the agent pick up where it stopped.
 */
/** Jev's budget for an ambiguous barge-in; on timeout it counts as real. */
export const BARGE_IN_JUDGE_MS = 400;

export type OverlapVerdict = "yield" | "ignore" | "judge";

/** "okaay" → "okay", "sooo" → "so", "mmhmm" → "mhm": elongation is still filler. */
const squeezeRepeats = (token: string) => token.replace(/(.)\1+/g, "$1");

const OVERLAP_FILLER = new Set(
  [...FILLER_TOKENS, "so", "well", "like", "yeah", "yes", "yep", "cool", "nice", "wow", "ok"].map(squeezeRepeats),
);

/** Share of the caller's words found in the agent's current sentence that marks echo. */
const ECHO_SHARE = 0.6;

export function judgeOverlap(text: string, agentText: string): OverlapVerdict {
  const tokens = cleanTokens(text);
  if (tokens.length === 0) return "ignore";
  if (isCommandBargeIn(text) || isEndCallRequest(text)) return "yield";
  if (tokens.every((token) => OVERLAP_FILLER.has(squeezeRepeats(token)))) return "ignore";
  const agentWords = new Set(cleanTokens(agentText));
  const echoed = tokens.filter((token) => agentWords.has(token)).length;
  if (tokens.length >= 2 && echoed / tokens.length >= ECHO_SHARE) return "ignore";
  return "judge";
}

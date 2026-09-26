import { cleanTokens, FILLER_TOKENS, isCommandBargeIn } from "./jev-judges";

/**
 * Barge-in: the server cuts, the session recovers (docs/adr/0003-barge-in-recovery.md).
 *
 * The server must own the cut. With its barge-in off, speech over the
 * agent's audio is dropped for good, and while the agent speaks it sends no
 * live partials either. So the session shapes the cut and repairs bad ones:
 *
 * - Adaptive delay: explaining holds out the API's maximum, so a bare
 *   "okaay so" never cuts; a reply that asks something drops it, because an
 *   early answer is exactly what it wants.
 * - Recovery: once the caller's words land after a cut, they are judged
 *   here. Steering and content are answered as a normal turn. Filler,
 *   back-channels and the agent's own echo (and asides, per Jev) make the
 *   agent pick up where it was cut.
 */

/** Explaining: the API's maximum interruption delay. */
export const BARGE_IN_EXPLAINING_DELAY_MS = 1000;
/** The current reply asks something: an answer may cut in quickly. */
export const BARGE_IN_QUESTION_DELAY_MS = 400;
/** Jev's budget for an ambiguous cut-in; on timeout it counts as real. */
export const BARGE_IN_JUDGE_MS = 400;

export type OverlapVerdict = "yield" | "ignore" | "judge";

/** "okaay" → "okay", "sooo" → "so", "mmhmm" → "mhm": elongation is still filler. */
const collapse = (token: string) => token.replace(/(.)\1+/g, "$1");

const OVERLAP_FILLER = new Set(
  [...FILLER_TOKENS, "so", "well", "like", "yeah", "yes", "yep", "cool", "nice", "wow", "ok"].map(collapse),
);

/** Share of the caller's words found in the agent's current sentence that marks echo. */
const ECHO_SHARE = 0.6;

export function judgeOverlap(text: string, agentText: string): OverlapVerdict {
  const tokens = cleanTokens(text);
  if (tokens.length === 0) return "ignore";
  if (isCommandBargeIn(text)) return "yield";
  if (tokens.every((token) => OVERLAP_FILLER.has(collapse(token)))) return "ignore";
  const agentWords = new Set(cleanTokens(agentText));
  const echoed = tokens.filter((token) => agentWords.has(token)).length;
  if (tokens.length >= 2 && echoed / tokens.length >= ECHO_SHARE) return "ignore";
  return "judge";
}

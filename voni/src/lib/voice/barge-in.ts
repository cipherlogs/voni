import { cleanTokens, isCommandBargeIn, isEndCallRequest } from "./jev-judges";
import type { CompleteRecognition } from "./recognition";

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

/**
 * The words that never take the floor, owned by the recognition bundle and
 * read here in the call's own rendering (the caller passes `callRecognition`):
 * a Spanish "vale" is a back-channel in Spanish, and an English "okay" is not
 * one in Spanish. Squeezed, because elongation is the caller's habit, not
 * another word.
 */
function overlapFiller(recognition: CompleteRecognition): Set<string> {
  return new Set([...recognition.filler, ...recognition.bargeIn].map(squeezeRepeats));
}

/** Share of the caller's words found in the agent's current sentence that marks echo. */
const ECHO_SHARE = 0.6;

export function judgeOverlap(
  text: string,
  agentText: string,
  recognition: CompleteRecognition,
): OverlapVerdict {
  const tokens = cleanTokens(text);
  if (tokens.length === 0) return "ignore";
  if (isCommandBargeIn(text, recognition) || isEndCallRequest(text, recognition)) return "yield";
  const filler = overlapFiller(recognition);
  if (tokens.every((token) => filler.has(squeezeRepeats(token)))) return "ignore";
  const agentWords = new Set(cleanTokens(agentText));
  const echoed = tokens.filter((token) => agentWords.has(token)).length;
  if (tokens.length >= 2 && echoed / tokens.length >= ECHO_SHARE) return "ignore";
  return "judge";
}

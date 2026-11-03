/**
 * Whether the caller's final turn is willing: they accept the test, or they
 * ask what Voni can do. Two small intent sets. A complaint, a neutral turn,
 * small talk or a challenge is in neither set, so no offer may be spoken on
 * that turn.
 *
 * This is the app-side half of the pipeline's offer guard. The prompt already
 * says the test is offered only on a willing turn; this makes the hard invite
 * obey the same rule instead of trusting the model's own line.
 */

/** An acceptance is the caller's answer, so it opens the final. */
const ACCEPTANCE =
  /^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|let'?s do it|try it|do it|i'?m ready|i am ready)\b/i;

/** A product question may appear anywhere in the final. */
const PRODUCT_QUESTION =
  /\b(?:what can you do|what do you do|how does it work|how do you work|tell me what you (?:can )?(?:actually )?do|show me|check (?:my|your) email)\b/i;

export function callerIsWilling(text: string): boolean {
  return ACCEPTANCE.test(text) || PRODUCT_QUESTION.test(text);
}

/**
 * Whether the browser's hard invite may fire on this turn. The chip can still
 * go up (the pipeline may have put the test on screen), but the spoken
 * fallback is an offer: it fires only on the willing turn that asked for it.
 */
export function shouldSpeakInvite(
  action: "none" | "show-only" | "show-and-speak",
  tag: string | null,
  callerFinal: string,
): tag is string {
  return action === "show-and-speak" && Boolean(tag) && callerIsWilling(callerFinal);
}

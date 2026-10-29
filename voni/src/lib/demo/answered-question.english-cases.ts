/**
 * Voice-parity ticket 77: the hand-labelled English corpus the already-answered
 * counter's false-positive rate is measured on.
 *
 * Each case is one short call in the Call trace's own row shape — a caller
 * (HEARD) turn, then the agent (VONI) turn that follows it. The label is the
 * human verdict on that agent turn, not the counter's:
 *
 * - `repeated`      the caller already supplied the value; asking for it is the defect
 * - `paraphrase`    the same defect in other words the counter's cue lexicon
 *                   does not carry (a miss, never a false positive)
 * - `clarification` the agent asks about the value it already has — spell it,
 *                   repeat it, confirm it — a legitimate follow-up
 * - `not-a-request` nothing is being asked for: an acknowledgement, a question
 *                   about something else, or a first request the caller has
 *                   not answered
 *
 * The corpus is fixture evidence, not a live-call measurement: it pins the
 * rule's behaviour so a change to a cue or an extractor has to move the
 * measured rate deliberately. `ANSWERED_QUESTION_ENGLISH_FP` is derived from
 * this list, and the test pins the resulting numbers independently.
 */

export type EnglishCaseLabel =
  | "repeated"
  | "paraphrase"
  | "clarification"
  | "not-a-request";

export type EnglishCase = {
  label: EnglishCaseLabel;
  /** Why this case is labelled as it is, in one line. */
  note: string;
  /** Caller and agent rows in call order, in the merged Call trace format. */
  transcript: string[];
};

/** One short call: a session header, then rows in the order they happened. */
function call(
  id: string,
  rows: readonly (readonly [role: "caller" | "agent", text: string])[],
): string[] {
  return [
    `${id}  agent=agent_anna  18.0s  end=client_end`,
    ...rows.map(([role, text], index) => {
      const start = 1.2 + index * 2.1;
      const at = start.toFixed(2);
      return role === "caller"
        ? ` ${at}s  HEARD   "${text}"  (${at}s–${(start + 0.8).toFixed(2)}s)`
        : ` ${at}s  VONI    "${text}"  (reply_create gap 800ms)`;
    }),
  ];
}

export const ENGLISH_CASES: readonly EnglishCase[] = [
  // ---- the defect: the answer was already given -------------------------
  {
    label: "repeated",
    note: "email written, then asked for again",
    transcript: call("sess_en_01", [
      ["caller", "Sure, my email is andres@casaverde.pt."],
      ["agent", "Great. And what's your email so I can send the details?"],
    ]),
  },
  {
    label: "repeated",
    note: "email spelled out loud, then asked for again",
    transcript: call("sess_en_02", [
      ["caller", "It's andres at casaverde dot pt."],
      ["agent", "Can you give me your email address?"],
    ]),
  },
  {
    label: "repeated",
    note: "Test tag given, then asked for again",
    transcript: call("sess_en_03", [
      ["caller", "The tag is Lime 42."],
      ["agent", "What was the test tag again?"],
    ]),
  },
  {
    label: "repeated",
    note: "Test tag in spoken digits, then asked for again",
    transcript: call("sess_en_04", [
      ["caller", "Lime four two."],
      ["agent", "Sorry — what tag did you put in the subject?"],
    ]),
  },
  {
    label: "repeated",
    note: "four-digit code read back, then asked for again",
    transcript: call("sess_en_05", [
      ["caller", "One zero four two."],
      ["agent", "Could you tell me the four-digit code from the email?"],
    ]),
  },
  {
    label: "repeated",
    note: "a different spoken address, then asked for again",
    transcript: call("sess_en_06", [
      ["caller", "hello at voni dot cc"],
      ["agent", "I still need your email to send that over."],
    ]),
  },

  // ---- legitimate follow-ups: the agent already has the value ------------
  {
    label: "clarification",
    note: "asking how to spell the address it already heard",
    transcript: call("sess_en_07", [
      ["caller", "andres@casaverde.pt"],
      ["agent", "Could you spell your email for me?"],
    ]),
  },
  {
    label: "clarification",
    note: "confirming the tag it already has",
    transcript: call("sess_en_08", [
      ["caller", "Lime 42"],
      ["agent", "Just to confirm, the tag is Lime 42, right?"],
    ]),
  },
  {
    label: "clarification",
    note: "asking the caller to repeat digits it did not catch",
    transcript: call("sess_en_09", [
      ["caller", "One zero four two."],
      ["agent", "Sorry, I didn't catch the code — could you repeat it?"],
    ]),
  },
  {
    label: "clarification",
    note: "verifying a near-miss domain",
    transcript: call("sess_en_10", [
      ["caller", "andres at casaverde dot pt"],
      ["agent", "Was that casaverde with a v?"],
    ]),
  },

  // ---- nothing asked for -------------------------------------------------
  {
    label: "not-a-request",
    note: "acknowledging the address, not asking for it",
    transcript: call("sess_en_11", [
      ["caller", "andres@casaverde.pt"],
      ["agent", "Perfect, I've sent the email to andres@casaverde.pt."],
    ]),
  },
  {
    label: "not-a-request",
    note: "acknowledging the tag, not asking for it",
    transcript: call("sess_en_12", [
      ["caller", "Lime 42"],
      ["agent", "Great, I'll look for Lime 42 in the inbox."],
    ]),
  },
  {
    label: "not-a-request",
    note: "first request: the caller has not answered yet",
    transcript: call("sess_en_13", [
      ["caller", "Hi, I run a bakery."],
      ["agent", "What's your email address?"],
    ]),
  },
  {
    label: "not-a-request",
    note: "asks for a different category than the one answered",
    transcript: call("sess_en_14", [
      ["caller", "andres@casaverde.pt"],
      ["agent", "What's the best phone number to reach you?"],
    ]),
  },
  {
    label: "not-a-request",
    note: "no address in the call yet, so the request is the first one",
    transcript: call("sess_en_15", [
      ["caller", "My postcode is SW1A 1AA."],
      ["agent", "Could you give me your email?"],
    ]),
  },
  {
    label: "not-a-request",
    note: "a year the caller mentioned is not a code it read back",
    transcript: call("sess_en_16", [
      ["caller", "We have 2024 customers."],
      ["agent", "Could you read me the four-digit code?"],
    ]),
  },

  // ---- the miss the cue lexicon cannot see ------------------------------
  {
    label: "paraphrase",
    note: "the same defect without naming the category",
    transcript: call("sess_en_17", [
      ["caller", "andres@casaverde.pt"],
      ["agent", "And where should I send the invoice?"],
    ]),
  },
];

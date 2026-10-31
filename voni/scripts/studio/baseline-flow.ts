/**
 * Ticket 25's zero-typing baseline flow: the plan, the fixed labels and the
 * 4–6 minute gate, in one place.
 *
 * The owner presses record, speaks and presses stop. This module is the only
 * source of the participant pseudonyms, the accent vocabulary, the two calls,
 * the five-minute break and the labels, so the page renders the plan rather
 * than asking for anything. It holds no recorder and no file system: the page
 * still lands takes through the Studio's one take store, and consent is
 * written by the local HTTP surface from the same values.
 *
 * Nothing here invents a consent, a take or a hash. A label is fixed by the
 * documented session plan, which the owner has read; it is not inferred from
 * the audio or a filename.
 */

import type { TakeLabels } from "./take-store";

/** The spec's sample: three to five consenting people. */
export const PARTICIPANT_COUNTS = [3, 4, 5] as const;

export type ParticipantCount = (typeof PARTICIPANT_COUNTS)[number];

/**
 * The one-tap accent selector values. A code is recorded verbatim as the
 * take's accent label, so `unspecified` is an explicit answer, never a gap.
 */
export const BASELINE_ACCENTS = [
  "en-US",
  "en-GB",
  "en-IN",
  "en-NG",
  "en-IE",
  "en-AU",
  "other",
  "unspecified",
] as const;

export type BaselineAccent = (typeof BASELINE_ACCENTS)[number];

export const DEFAULT_BASELINE_ACCENT: BaselineAccent = "unspecified";

/** Four to six minutes, inclusive; the verifier measures the same band. */
export const BASELINE_MIN_CALL_MS = 4 * 60 * 1000;
export const BASELINE_MAX_CALL_MS = 6 * 60 * 1000;

/** The rest between a participant's two calls, as the session plan asks. */
export const BASELINE_BREAK_MS = 5 * 60 * 1000;

export type BaselineCall = 1 | 2;

/** What the owner sees on each recording screen; never a free-text prompt. */
export const BASELINE_CALLS = [
  {
    call: 1 as const,
    title: "Scripted booking",
    instruction:
      "Read the booking card below as talking points, not verbatim. Pause two to four seconds between beats as if the other person is answering. Speak for four to six minutes.",
    card: [
      "Hi, I'd like to book a table for a birthday dinner.",
      "Six people, Friday the 13th, around 7:30.",
      "Do you have a set menu for groups?",
      "One guest is vegetarian and one has a nut allergy — how do you handle that?",
      "Could we have a quiet corner? One guest is hard of hearing.",
      "Is there parking nearby?",
      "Is there a deposit or a card hold for six?",
      "Actually, could we make it 8 o'clock instead?",
      "If two people drop out, is the deposit still the same?",
      "The name is Alex.",
      "How does the confirmation arrive? I'd rather not give a card over the phone.",
      "Can you do a candle or a small cake, and what does it cost?",
      "Let me repeat it back: Friday, 8pm, six people, quiet corner, one vegetarian, one nut allergy.",
      "Thank you — I'll wait for the confirmation.",
    ],
  },
  {
    call: 2 as const,
    title: "Unscripted service problem",
    instruction:
      "Describe a real service problem in your own words. Use the beats below as a reminder, not a script. Speak for four to six minutes.",
    card: [
      "What happened, and when.",
      "What you have already tried.",
      "How it affected you.",
      "What you actually want — a refund, a rebooking, a replacement.",
      "Answer their questions naturally.",
      "Push back once if the first offer is weak.",
      "Agree the next step and end the call.",
    ],
  },
] as const;

/** The labels every baseline take carries, fixed by the session plan. */
export const BASELINE_CALL_LABELS = {
  1: { intent: "booking-inquiry", emotion: "neutral" },
  2: { intent: "service-problem", emotion: "frustrated" },
} as const;

export type BaselineStep =
  | { readonly kind: "call"; readonly participantId: string; readonly call: BaselineCall }
  | { readonly kind: "break"; readonly participantId: string; readonly breakMs: number };

export function isParticipantCount(value: unknown): value is ParticipantCount {
  return typeof value === "number" && (PARTICIPANT_COUNTS as readonly number[]).includes(value);
}

export function isBaselineAccent(value: unknown): value is BaselineAccent {
  return typeof value === "string" && (BASELINE_ACCENTS as readonly string[]).includes(value);
}

/** The repository records no participant name; the pseudonym is positional. */
export function participantIdFor(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 99) {
    throw new RangeError(`a baseline participant is numbered 1–99, got ${JSON.stringify(index)}`);
  }
  return `participant-${String(index).padStart(2, "0")}`;
}

/** One participant at a time: call 1, the break, then call 2. */
export function buildBaselinePlan(count: ParticipantCount): BaselineStep[] {
  if (!isParticipantCount(count)) {
    throw new RangeError(`the baseline records 3–5 participants, got ${JSON.stringify(count)}`);
  }
  const plan: BaselineStep[] = [];
  for (let index = 1; index <= count; index += 1) {
    const participantId = participantIdFor(index);
    plan.push(
      { kind: "call", participantId, call: 1 },
      { kind: "break", participantId, breakMs: BASELINE_BREAK_MS },
      { kind: "call", participantId, call: 2 },
    );
  }
  return plan;
}

/** Where the signed original is filed: a pointer beside the takes. */
export function consentRefFor(participantId: string): string {
  return `${participantId}/consent.md`;
}

/**
 * The consent pointer written from the owner's attestation. It names the
 * pseudonym, the server's date and where the signed original lives; it never
 * names the person.
 */
export function consentMarkdown(participantId: string, consentedAt: string): string {
  return [
    `# Baseline consent — ${participantId}`,
    "",
    `${participantId} consented on ${consentedAt} for baseline comparison audio.`,
    "",
    "Signed original filed by the owner outside the repository.",
    "",
  ].join("\n");
}

/** The exact labels a baseline take lands with; accent is the selector value. */
export function baselineLabels(call: BaselineCall, accent: BaselineAccent | string): TakeLabels {
  const labels = BASELINE_CALL_LABELS[call];
  if (!labels) {
    throw new RangeError(`a baseline participant records call 1 or 2, got ${JSON.stringify(call)}`);
  }
  return { intent: labels.intent, emotion: labels.emotion, accent };
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export type DurationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "wrong-duration-band"; readonly message: string };

/**
 * The save gate. The page refuses before it posts, and the local HTTP surface
 * measures the landed bytes with the verifier's durater and refuses again.
 */
export function evaluateCallDuration(durationMs: number): DurationVerdict {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return {
      ok: false,
      code: "wrong-duration-band",
      message: `the call has no measurable length; a baseline call is ${formatDuration(BASELINE_MIN_CALL_MS)}–${formatDuration(BASELINE_MAX_CALL_MS)}`,
    };
  }
  if (durationMs < BASELINE_MIN_CALL_MS) {
    return {
      ok: false,
      code: "wrong-duration-band",
      message:
        `the call is ${formatDuration(durationMs)}; a baseline call is ` +
        `${formatDuration(BASELINE_MIN_CALL_MS)}–${formatDuration(BASELINE_MAX_CALL_MS)}. ` +
        "Keep speaking; stop after four minutes and before six.",
    };
  }
  if (durationMs > BASELINE_MAX_CALL_MS) {
    return {
      ok: false,
      code: "wrong-duration-band",
      message:
        `the call is ${formatDuration(durationMs)}; a baseline call is ` +
        `${formatDuration(BASELINE_MIN_CALL_MS)}–${formatDuration(BASELINE_MAX_CALL_MS)}. ` +
        "This take is too long; record the call again.",
    };
  }
  return { ok: true };
}

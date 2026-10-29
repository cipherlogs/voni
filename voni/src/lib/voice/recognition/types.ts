import type { ConversationLanguage } from "@/lib/agents/wizard";

/**
 * The recognition contract (voice-parity 42, spec W3a).
 *
 * One owner for everything the agent LISTENS FOR and MATCHES — as opposed to
 * what it says (`../transcription.ts` composes that on top of this) and what
 * it is prompted to be (`../../agents/compile.ts`):
 *
 * - `vocabulary`   terms the recogniser is primed with
 * - `scene`        the call described, written in the Locale, never instructed
 * - `digits`       spoken digit words, keyed by their numeric meaning
 * - `address`      speech that stands in for an email separator ("at", "dot")
 * - `filler`       back-channel utterances that are never content
 * - `bargeIn`      continuers that never take the floor over the agent
 * - `commands`     steering words and phrases, keyed by intent
 * - `endCall`      forms that ask to end the call
 * - `goodbye`      forms that close a call when the agent says them
 *
 * Doctrine:
 * - A slot's *meaning* is in this file: a numeric digit, a separator role, a
 *   command intent, "the caller asked to end". A Locale supplies the words.
 *   English is one rendering among six, never the shape of the question.
 * - A Locale with no rendering is a hole. It is representable (`incomplete`
 *   or `missing` below) and it never resolves to English.
 * - Pure data and pure functions: no socket, no clock, no environment.
 */

/** The Locales the product speaks, and therefore the locales recognition is keyed by. */
export type RecognitionLocale = ConversationLanguage;

/** The spoken digits. The meaning is the numeric value; a Locale supplies the words. */
export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export const DIGITS: readonly Digit[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** What a caller says in place of an email address's punctuation. */
export type AddressSeparator = "at" | "dot" | "hyphen" | "underscore";

export const ADDRESS_SEPARATORS: readonly AddressSeparator[] = ["at", "dot", "hyphen", "underscore"];

/**
 * Steering a caller can express over the agent's speech. The intent is the
 * meaning and is locale-independent; a Locale renders it as its own words.
 * "deny" rather than "no" and "interject" rather than "sorry" so the key is
 * never an English word.
 */
export type CommandIntent = "stop" | "wait" | "deny" | "repeat" | "listen" | "interject";

export const COMMAND_INTENTS: readonly CommandIntent[] = [
  "stop",
  "wait",
  "deny",
  "repeat",
  "listen",
  "interject",
];

/** Locale-neutral facts a scene prompt is rendered from. Built from the agent config by the caller. */
export type SceneSubject = {
  /** The agent's spoken name. */
  agentName: string;
  /** What the agent is, e.g. "clinic coordinator". */
  role: string;
  /** What the agent is for, in the agent's own words. */
  mission: string;
  /** The things callers talk about, in the agent's own config. */
  topics: readonly string[];
};

/** One rendering of the scene. Describes the call; never instructs the recogniser. */
export type SceneRenderer = (subject: SceneSubject) => string;

/** The value each slot holds once a Locale has rendered it. */
export type RecognitionSlotValues = {
  vocabulary: readonly string[];
  scene: SceneRenderer;
  digits: Readonly<Record<Digit, readonly string[]>>;
  address: Readonly<Record<AddressSeparator, readonly string[]>>;
  filler: readonly string[];
  /** Continuers that never take the floor over the agent, beyond plain filler. */
  bargeIn: readonly string[];
  commands: Readonly<Record<CommandIntent, readonly string[]>>;
  endCall: readonly string[];
  goodbye: readonly string[];
};

export type RecognitionSlotName = keyof RecognitionSlotValues;

/**
 * Report order. Typed as a record over every slot, so adding a slot to
 * `RecognitionSlotValues` fails compilation until it is listed here — a hole
 * can never escape the completeness report by being forgotten.
 */
const SLOT_ORDER: Record<RecognitionSlotName, true> = {
  vocabulary: true,
  scene: true,
  digits: true,
  address: true,
  filler: true,
  bargeIn: true,
  commands: true,
  endCall: true,
  goodbye: true,
};

export const RECOGNITION_SLOTS: readonly RecognitionSlotName[] = Object.keys(
  SLOT_ORDER,
) as RecognitionSlotName[];

/**
 * A Locale's rendering as it lives in the registry: every slot is optional on
 * purpose, so a Locale can arrive one slot at a time and a missing rendering is
 * a visible hole rather than a compile-time lie.
 */
export type RecognitionSlots = Partial<RecognitionSlotValues>;

/** A Locale's registered rendering. The `locale` must equal its registry key. */
export type RecognitionBundle = {
  readonly locale: RecognitionLocale;
  readonly slots: RecognitionSlots;
};

/** Every slot present. Only this shape may match words: a hole cannot silently match nothing. */
export type CompleteRecognition = { readonly locale: RecognitionLocale } & RecognitionSlotValues;

/**
 * What a Locale resolves to. `missing` means nothing is registered under that
 * key; `incomplete` means a registered Locale still has holes, named so a
 * report can surface them. Neither ever substitutes English.
 */
export type RecognitionResolution =
  | { readonly status: "complete"; readonly recognition: CompleteRecognition }
  | { readonly status: "incomplete"; readonly locale: string; readonly missing: readonly RecognitionSlotName[] }
  | { readonly status: "missing"; readonly locale: string };

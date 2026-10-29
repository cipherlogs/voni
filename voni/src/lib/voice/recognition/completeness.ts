import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import { resolveRecognition } from "./index";
import { RECOGNITION_SLOTS, type RecognitionResolution, type RecognitionSlotName } from "./types";

/**
 * The recognition completeness report (voice-parity 43, spec W3a).
 *
 * The contract in `./types.ts` can represent a hole; this module is how a hole
 * becomes visible. It answers one question per Locale — which renderings are
 * missing? — as plain data a gate can store, print and diff.
 *
 * Doctrine, inherited and enforced here:
 * - English is one rendering among six. The report never consults `en` for
 *   another Locale's words, so a hole stays a hole: an unregistered Locale is
 *   reported as missing every slot, never as covered by English.
 * - A registered Locale with holes names exactly those holes, not the whole
 *   repertoire. `completenessFromResolution` mirrors `resolveRecognition`
 *   rather than reconstructing it, so the report cannot disagree with what the
 *   matcher would do.
 * - Reporting is not a failure path: a hole is returned, never thrown, so the
 *   per-subject gate can record a `FAIL` with a locale and a reason.
 */

/** One slot a Locale cannot render, with a line a gate can print. */
export type RecognitionHole = {
  readonly slot: RecognitionSlotName;
  readonly detail: string;
};

/**
 * One Locale's completeness verdict. Plain, serializable data: every field is a
 * string, boolean or array, so a gate can write it into an artifact unchanged.
 */
export type RecognitionCompleteness = {
  readonly locale: string;
  /** Mirrors `resolveRecognition`: `missing` means nothing is registered at all. */
  readonly status: RecognitionResolution["status"];
  /** True only when the Locale is registered and every slot renders. */
  readonly complete: boolean;
  /** Each missing slot, in report order. Empty when complete. */
  readonly missing: readonly RecognitionSlotName[];
  /** Each missing slot with its own detail line. Empty when complete. */
  readonly holes: readonly RecognitionHole[];
  /** One line naming the Locale and its holes — enough for a gate reason. */
  readonly detail: string;
};

/**
 * Every Locale's verdict. `complete` is true only when no Locale has a hole, so
 * a complete English can never make the product look whole.
 */
export type RecognitionCompletenessReport = {
  readonly complete: boolean;
  readonly locales: readonly RecognitionCompleteness[];
  /** The Locales that are not complete, named in report order. */
  readonly incomplete: readonly string[];
};

/** "scene" / "2 slots missing: scene, digits". */
function describe(locale: string, missing: readonly RecognitionSlotName[]): string {
  if (missing.length === 0) return `${locale}: complete`;
  const noun = missing.length === 1 ? "slot" : "slots";
  return `${locale}: ${missing.length} ${noun} missing: ${missing.join(", ")}`;
}

/**
 * A verdict for one resolution. `missing` (nothing registered) reports every
 * slot, because nothing renders — not because English fills them in.
 */
export function completenessFromResolution(resolution: RecognitionResolution): RecognitionCompleteness {
  const locale = resolution.status === "complete" ? resolution.recognition.locale : resolution.locale;
  const missing =
    resolution.status === "complete"
      ? []
      : resolution.status === "incomplete"
        ? [...resolution.missing]
        : [...RECOGNITION_SLOTS];

  const detail = describe(locale, missing);

  return {
    locale,
    status: resolution.status,
    complete: resolution.status === "complete",
    missing,
    holes: missing.map((slot) => ({ slot, detail: `${locale}: ${slot} missing` })),
    detail,
  };
}

/** One Locale's completeness verdict, as the per-subject gate reads it. */
export function recognitionCompleteness(locale: string): RecognitionCompleteness {
  return completenessFromResolution(resolveRecognition(locale));
}

/**
 * Every spoken Locale's verdict, optionally narrowed to the Locales a caller
 * cares about. `complete` is only true when this set has no holes at all.
 */
export function recognitionCompletenessReport(
  locales: readonly string[] = CONVERSATION_LANGUAGES,
): RecognitionCompletenessReport {
  const verdicts = locales.map(recognitionCompleteness);
  const incomplete = verdicts.filter((verdict) => !verdict.complete).map((verdict) => verdict.locale);
  return { complete: incomplete.length === 0, locales: verdicts, incomplete };
}

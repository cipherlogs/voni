/**
 * The reference baseline: whose audio a reference render is judged against
 * (meta-cascade M4/W0, ticket 126).
 *
 * A W0 call produces two captures, a reference and a delivered file, and the
 * first causal layer is the vendor's voice. That layer asks two questions:
 * is the reference usable at all (ticket 124), and — where a committed floor
 * exists — has the vendor's render slipped below the floor the owner called
 * superb.
 *
 * The floor belongs to exactly one voice. `anna`/en is the featured subject and
 * has a committed capture in `evidence/vendor-floor/`; every other voice is
 * compared to its own reference rendering. Lending `anna`'s floor to `lola`
 * would judge one voice's loudness against another voice's audio, which is not
 * a floor at all.
 *
 * The floor is always the committed evidence, read through `loadVendorFloor`:
 * this module never synthesises a replacement baseline, so a recorded hash can
 * be checked against the sidecar rather than trusted.
 */
import type { DecodedAudio } from "./format-facts";
import {
  compareReferenceToFloor,
  type FloorAxisReading,
  type FloorComparison,
  type FloorReference,
} from "./floor-mode";
import {
  VENDOR_FLOOR_LOCALE,
  VENDOR_FLOOR_VOICE,
  loadVendorFloor,
  type VendorFloor,
} from "./vendor-floor";

/** Whose audio a reference is measured against. Never guessed. */
export type ReferenceBaseline =
  | {
      kind: "committed-floor";
      voice: string;
      locale: string;
      floor: VendorFloor;
    }
  | {
      kind: "own-reference";
      voice: string;
      locale: string;
      /** Why no external floor exists, and what the voice is compared to instead. */
      reason: string;
    };

/** The voice whose committed floor the featured subject clears. */
export function hasCommittedFloor(voice: string, locale: string): boolean {
  return voice === VENDOR_FLOOR_VOICE && locale === VENDOR_FLOOR_LOCALE;
}

/**
 * Resolve a voice/Locale's baseline. The featured voice's floor is loaded from
 * the committed evidence (a missing or tampered floor throws by name); any other
 * voice is its own baseline, with the reason stated.
 */
export function referenceBaseline(
  voice: string,
  locale: string,
  options: { directory?: string } = {},
): ReferenceBaseline {
  if (hasCommittedFloor(voice, locale)) {
    return {
      kind: "committed-floor",
      voice,
      locale,
      floor: loadVendorFloor({ directory: options.directory, voice, locale }),
    };
  }
  return {
    kind: "own-reference",
    voice,
    locale,
    reason:
      `${voice}/${locale} has no committed floor, so it is compared to its own reference ` +
      "rendering, never to another voice's level",
  };
}

/** A floor loaded from committed evidence, as opposed to a test double. */
function isLoadedFloor(floor: FloorReference | VendorFloor): floor is VendorFloor {
  return floor.provenance !== undefined && "audio" in floor.provenance;
}

/** What judging a reference against its baseline found. */
export type ReferenceFloorFinding = {
  /** `no-floor` is not a pass and not a failure: there was no external baseline. */
  status: "regression" | "within-floor" | "unmeasured" | "no-floor";
  /** True only when the reference is worse than its committed floor. */
  regression: boolean;
  baseline: "committed-floor" | "own-reference";
  voice: string | null;
  locale: string | null;
  /** The committed floor's path, when one was used. */
  floorPath: string | null;
  /** The reference render the finding is about. */
  referencePath: string;
  /** The four axes the reference is judged on; empty without a floor. */
  axes: FloorAxisReading[];
  /** One sentence a reader can quote; it names the layer, not a number. */
  sentence: string;
};

/**
 * Judge one reference render against a committed floor, or record that the
 * voice has none.
 *
 * `floor` is the loaded committed evidence (`baseline.floor`), never a
 * re-render. Passing `null` with `ownReference` says the voice is its own
 * baseline; passing `null` without it is a caller error, because an unnamed
 * absence is exactly the silent default this work removes.
 */
export function judgeReferenceAgainstFloor(input: {
  reference: { path: string; audio: DecodedAudio };
  floor: FloorReference | VendorFloor | null;
  voice?: string;
  locale?: string;
  /** The named reason a voice has no external floor (`own-reference`). */
  ownReference?: string;
}): ReferenceFloorFinding {
  const { reference } = input;
  if (input.floor === null) {
    if (input.ownReference === undefined) {
      throw new Error(
        "judging a reference needs a committed floor or the named reason the voice has none",
      );
    }
    const named =
      input.voice !== undefined && input.locale !== undefined
        ? `${input.voice}/${input.locale}`
        : "this voice";
    return {
      status: "no-floor",
      regression: false,
      baseline: "own-reference",
      voice: input.voice ?? null,
      locale: input.locale ?? null,
      floorPath: null,
      referencePath: reference.path,
      axes: [],
      sentence:
        `${named} is its own baseline: ${input.ownReference}. Nothing external is compared, ` +
        "so there is no vendor-floor regression to name and no pass to claim.",
    };
  }

  const floor: FloorReference = {
    path: input.floor.path,
    audio: input.floor.audio,
    provenance: input.floor.provenance,
  };
  const committedSha = isLoadedFloor(input.floor)
    ? input.floor.provenance.audio.sha256
    : undefined;
  const comparison: FloorComparison = compareReferenceToFloor({ floor, reference });
  const floorPath = comparison.floor.path;
  const voice = input.voice ?? comparison.floor.voice;
  const locale = input.locale ?? comparison.floor.locale;
  const named = voice !== null && locale !== null ? `${voice}/${locale}` : floorPath;

  if (comparison.verdict === "fail") {
    const worse = comparison.worse.map((axis) => `${axis.axis} — ${axis.detail}`).join("; ");
    return {
      status: "regression",
      regression: true,
      baseline: "committed-floor",
      voice,
      locale,
      floorPath,
      referencePath: reference.path,
      axes: comparison.axes,
      sentence:
        `vendor-voice regression: the ${named} reference ${reference.path} is worse than the ` +
        `committed floor ${floorPath}${committedSha ? ` (sha256 ${committedSha})` : ""}: ${worse}. ` +
        "The reference is the vendor's own render, so no downstream layer can be judged until it is fixed.",
    };
  }
  if (comparison.verdict === "inconclusive") {
    const missing = comparison.unmeasured
      .map((axis) => `${axis.axis} — ${axis.detail}`)
      .join("; ");
    return {
      status: "unmeasured",
      regression: false,
      baseline: "committed-floor",
      voice,
      locale,
      floorPath,
      referencePath: reference.path,
      axes: comparison.axes,
      sentence:
        `the ${named} reference cannot be cleared against the committed floor ${floorPath}: ` +
        `${missing}; an unmeasured axis is never a pass.`,
    };
  }
  return {
    status: "within-floor",
    regression: false,
    baseline: "committed-floor",
    voice,
    locale,
    floorPath,
    referencePath: reference.path,
    axes: comparison.axes,
    sentence:
      `the ${named} reference is at or better than the committed floor ${floorPath} on every ` +
      "measured axis, so the vendor voice carries a baseline",
  };
}

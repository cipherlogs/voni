/**
 * Ticket 07 review ratings: the owner's working-loop store.
 *
 * One start rating per call covers the wait and the chime; one rating per
 * agent reply covers words plus wait plus voice, with a fast good-or-bad plus
 * one tag plus an optional note. The filler tags name the failure so the next
 * attempt knows what to change.
 *
 * Pure and append-only: records are keyed by call id and turn id, write-once
 * per turn, and serialize beside the call marks and the delivered capture so
 * a bad mark replays as a repro. No audio, no socket, no clock.
 */

export const REVIEW_RATING_SCHEMA_VERSION = 1;

/** Fast good-or-bad mark the owner taps while listening. */
export const REVIEW_VERDICTS = ["good", "bad"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * Filler tags that name the failure (spec): the next attempt reads the tag,
 * not a paragraph, to know what to change.
 */
export const REVIEW_TAGS = [
  "out-of-context",
  "robotic",
  "late",
  "missing",
  "early-cut",
  "good-cover",
  "silent-better",
] as const;
export type ReviewTag = (typeof REVIEW_TAGS)[number];

/** The per-turn split the overlay shows beside the rating controls. */
export type LatencySplitSummary = {
  endpointingMs: number;
  generationMs: number;
  deliveryMs: number;
  perceivedMs: number;
};

/** One agent reply's rating: words plus wait plus voice. */
export type ReviewTurnRating = {
  callId: string;
  turnId: string;
  verdict: ReviewVerdict;
  tag: ReviewTag;
  note: string;
  /** The spoken acknowledgement used on this turn, or null for silence/none. */
  fillerLine: string | null;
  /** The per-turn split, or null when the turn carried no sample. */
  split: LatencySplitSummary | null;
  ratedAt: string;
};

/** The call's one start rating: the wait plus the chime. */
export type ReviewStartRating = {
  callId: string;
  verdict: ReviewVerdict;
  note: string;
  ratedAt: string;
};

/** The artifact written beside marks + delivered capture; a repro per turn. */
export type ReviewRatingsArtifact = {
  schemaVersion: typeof REVIEW_RATING_SCHEMA_VERSION;
  callId: string;
  start: ReviewStartRating | null;
  turns: ReviewTurnRating[];
};

export type ReviewTurnRatingInput = {
  callId: string;
  turnId: string;
  verdict: ReviewVerdict;
  tag: ReviewTag;
  note?: string;
  fillerLine?: string | null;
  split?: LatencySplitSummary | null;
};

export type ReviewStartRatingInput = {
  callId: string;
  verdict: ReviewVerdict;
  note?: string;
};

export class ReviewRatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRatingError";
  }
}

function cleanId(value: string, field: "callId" | "turnId"): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new ReviewRatingError(`${field} is missing: a rating is keyed by call and turn`);
  return trimmed;
}

function cleanVerdict(value: unknown): ReviewVerdict {
  if (value === "good" || value === "bad") return value;
  throw new ReviewRatingError(`verdict ${JSON.stringify(value)} is not good or bad`);
}

function cleanTag(value: unknown): ReviewTag {
  if ((REVIEW_TAGS as readonly unknown[]).includes(value)) return value as ReviewTag;
  throw new ReviewRatingError(
    `tag ${JSON.stringify(value)} is not one of ${REVIEW_TAGS.join(", ")}`,
  );
}

export type ReviewRatingsStore = {
  recordTurn: (input: ReviewTurnRatingInput) => ReviewTurnRating;
  recordStart: (input: ReviewStartRatingInput) => ReviewStartRating;
  listTurnRatings: (callId: string) => ReviewTurnRating[];
  getStartRating: (callId: string) => ReviewStartRating | null;
  /** Bad turn records the next fix reads as its repro list. */
  unaddressedBadTurns: (callId: string) => ReviewTurnRating[];
  toArtifact: (callId: string) => ReviewRatingsArtifact;
};

export function createReviewRatings(
  now: () => Date = () => new Date(),
): ReviewRatingsStore {
  const starts = new Map<string, ReviewStartRating>();
  const turns = new Map<string, Map<string, ReviewTurnRating>>();

  const forCall = (callId: string): Map<string, ReviewTurnRating> => {
    let perCall = turns.get(callId);
    if (!perCall) {
      perCall = new Map();
      turns.set(callId, perCall);
    }
    return perCall;
  };

  return {
    recordTurn(input) {
      const callId = cleanId(input.callId, "callId");
      const turnId = cleanId(input.turnId, "turnId");
      const perCall = forCall(callId);
      if (perCall.has(turnId)) {
        throw new ReviewRatingError(
          `turn ${turnId} of call ${callId} is write-once: a rating already exists`,
        );
      }
      const record: ReviewTurnRating = {
        callId,
        turnId,
        verdict: cleanVerdict(input.verdict),
        tag: cleanTag(input.tag),
        note: input.note?.trim() ?? "",
        fillerLine: input.fillerLine ?? null,
        split: input.split ?? null,
        ratedAt: now().toISOString(),
      };
      perCall.set(turnId, record);
      return { ...record };
    },

    recordStart(input) {
      const callId = cleanId(input.callId, "callId");
      if (starts.has(callId)) {
        throw new ReviewRatingError(
          `start of call ${callId} is write-once: a start rating already exists`,
        );
      }
      const record: ReviewStartRating = {
        callId,
        verdict: cleanVerdict(input.verdict),
        note: input.note?.trim() ?? "",
        ratedAt: now().toISOString(),
      };
      starts.set(callId, record);
      return { ...record };
    },

    listTurnRatings(callId) {
      const perCall = turns.get(callId.trim());
      if (!perCall) return [];
      return [...perCall.values()].map((record) => ({ ...record }));
    },

    getStartRating(callId) {
      const record = starts.get(callId.trim());
      return record ? { ...record } : null;
    },

    unaddressedBadTurns(callId) {
      return this.listTurnRatings(callId).filter((record) => record.verdict === "bad");
    },

    toArtifact(callId) {
      const id = callId.trim();
      return {
        schemaVersion: REVIEW_RATING_SCHEMA_VERSION,
        callId: id,
        start: this.getStartRating(id),
        turns: this.listTurnRatings(id),
      };
    },
  };
}

/** Append-only turn record without holding a store (route sink seam). */
export function recordTurnRating(
  store: ReviewRatingsStore,
  input: ReviewTurnRatingInput,
): ReviewTurnRating {
  return store.recordTurn(input);
}

/** The call's one start record without holding a store. */
export function recordStartRating(
  store: ReviewRatingsStore,
  input: ReviewStartRatingInput,
): ReviewStartRating {
  return store.recordStart(input);
}

/** The `?review=1` flag that hosts the overlay on the landing demo. */
export const REVIEW_OVERLAY_QUERY = "review";

export function reviewOverlayRequested(search: string): boolean {
  return new URLSearchParams(search).get(REVIEW_OVERLAY_QUERY) === "1";
}

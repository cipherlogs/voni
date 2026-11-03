import type { ReviewTurnRating } from "./review-ratings";

/**
 * Ticket 08 fix gate: the owner marks each fix fixed or not-fixed with the
 * still-broken feeling named, so a retry changes behaviour instead of
 * repeating it and no new work starts on a broken feeling.
 *
 * A not-fixed fix stays open and blocks the next fix; an unrated fix does
 * not advance. The next fix reads the unaddressed bad turn records (the
 * review-ratings store, keyed by the gate record's call id) as its repro
 * together with the named still-broken feeling.
 *
 * Pure and append-only: records are keyed by fix id, write-once per fix,
 * and serialize beside the call marks and the delivered capture. No audio,
 * no socket, no clock.
 */

export const FIX_GATE_SCHEMA_VERSION = 1;

/** The owner's per-fix mark: fixed advances, not-fixed blocks the next fix. */
export const FIX_VERDICTS = ["fixed", "not-fixed"] as const;
export type FixVerdict = (typeof FIX_VERDICTS)[number];

/** One fix's gate record: the verdict plus the feeling the retry must change. */
export type FixGateRecord = {
  fixId: string;
  verdict: FixVerdict;
  /** Required on not-fixed: the still-broken feeling the retry addresses. */
  stillBroken: string;
  /** The reviewed call whose bad records are the repro; null when unrated. */
  callId: string | null;
  ratedAt: string;
};

export type FixGateInput = {
  fixId: string;
  verdict: FixVerdict;
  stillBroken?: string;
  callId?: string;
};

/** The repro the next fix replays: the named feeling plus the bad turns. */
export type FixGateRepro = {
  stillBroken: string;
  callId: string;
  /** The reviewed call's unaddressed bad turns, read live from the ratings. */
  badTurns: ReviewTurnRating[];
};

/** The artifact written beside marks + delivered capture for the fix. */
export type FixGateArtifact = {
  schemaVersion: typeof FIX_GATE_SCHEMA_VERSION;
  fixId: string;
  record: FixGateRecord | null;
  blocksNext: boolean;
};

export class FixGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixGateError";
  }
}

function cleanFixId(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new FixGateError("fixId is missing: a gate record names the fix it marks");
  return trimmed;
}

function cleanVerdict(value: unknown): FixVerdict {
  if (value === "fixed" || value === "not-fixed") return value;
  throw new FixGateError(`verdict ${JSON.stringify(value)} is not fixed or not-fixed`);
}

export type FixGateStore = {
  recordFix: (input: FixGateInput) => FixGateRecord;
  getFix: (fixId: string) => FixGateRecord | null;
  /**
   * True only when the fix is marked fixed against a reviewed call; an
   * unrated fix (no call id) never advances, so the next fix cannot start
   * on an unheard feeling.
   */
  canAdvance: (fixId: string) => boolean;
  /** True when the fix is marked not-fixed: it stays open, gating its successor. */
  blocksNext: (fixId: string) => boolean;
  /**
   * The named feeling plus the reviewed call's unaddressed bad turns, the
   * repro the next fix replays. Null unless the fix is not-fixed on a call.
   */
  reproForNextFix: (
    fixId: string,
    ratings: { unaddressedBadTurns(callId: string): ReviewTurnRating[] },
  ) => FixGateRepro | null;
  toArtifact: (fixId: string) => FixGateArtifact;
};

export function createFixGate(now: () => Date = () => new Date()): FixGateStore {
  const records = new Map<string, FixGateRecord>();

  return {
    recordFix(input) {
      const fixId = cleanFixId(input.fixId);
      if (records.has(fixId)) {
        throw new FixGateError(
          `fix ${fixId} is write-once: a verdict already exists`,
        );
      }
      const verdict = cleanVerdict(input.verdict);
      const stillBroken = input.stillBroken?.trim() ?? "";
      if (verdict === "not-fixed" && stillBroken === "") {
        throw new FixGateError(
          `fix ${fixId} is not-fixed without a still-broken feeling: name what is still broken so the retry changes it`,
        );
      }
      const callId = input.callId?.trim() || null;
      const record: FixGateRecord = {
        fixId,
        verdict,
        stillBroken,
        callId: callId === "" ? null : callId,
        ratedAt: now().toISOString(),
      };
      records.set(fixId, record);
      return { ...record };
    },

    getFix(fixId) {
      const record = records.get(fixId.trim());
      return record ? { ...record } : null;
    },

    canAdvance(fixId) {
      const record = records.get(fixId.trim());
      return record?.verdict === "fixed" && record.callId !== null;
    },

    blocksNext(fixId) {
      return records.get(fixId.trim())?.verdict === "not-fixed";
    },

    reproForNextFix(fixId, ratings) {
      const record = records.get(fixId.trim());
      if (!record || record.verdict !== "not-fixed") return null;
      if (record.callId === null) return null;
      return {
        stillBroken: record.stillBroken,
        callId: record.callId,
        badTurns: ratings.unaddressedBadTurns(record.callId),
      };
    },

    toArtifact(fixId) {
      const id = fixId.trim();
      return {
        schemaVersion: FIX_GATE_SCHEMA_VERSION,
        fixId: id,
        record: this.getFix(id),
        blocksNext: this.blocksNext(id),
      };
    },
  };
}

/**
 * The overlay's per-fix save rule: a verdict is required, and a not-fixed
 * verdict additionally requires the still-broken feeling to be named.
 */
export function canSaveFixGate(verdict: FixVerdict | null, stillBroken: string): boolean {
  if (verdict === null) return false;
  if (verdict === "not-fixed" && stillBroken.trim() === "") return false;
  return true;
}

/** The `?fix=` id naming the fix the overlay's gate section marks. */
export const FIX_GATE_QUERY = "fix";

export function fixUnderReview(search: string): string | null {
  const raw = new URLSearchParams(search).get(FIX_GATE_QUERY)?.trim() ?? "";
  return raw === "" ? null : raw;
}

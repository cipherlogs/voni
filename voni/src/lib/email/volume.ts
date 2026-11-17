/**
 * How much traffic one Grafana synthetic check sends, and what the panel may
 * ask it to send.
 *
 * Grafana prices and rate-limits by check *runs*, not by probe: one run at a
 * selected frequency fires on every selected probe. So the number an operator
 * actually cares about — clicks/day — is `runs per day × probes`, and the
 * panel previews it from the same function the server validates with. Keeping
 * that arithmetic here (rather than in the client) means the preview and the
 * saved value cannot disagree.
 *
 * Pure and dependency-free: imported by both the server action and the client
 * panel, so it must never reach for `node:*`, `next/*` or the database.
 */

/** The intervals an operator may pick, in minutes. */
export const FREQUENCY_MINUTES = [5, 10, 15, 30, 60] as const;

export type FrequencyMinutes = (typeof FREQUENCY_MINUTES)[number];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The four US probes this stack's check runs from.
 *
 * The ids come from `GET /api/v1/probe` on this Grafana stack (the API's path is
 * singular — `/probes` is a 404). They are constants, not a discovery step: a
 * probe id is stable, but the *set* is not. If the stack moves or a probe is
 * retired, re-check the ids before trusting a selection built from this list.
 */
export const US_PROBES = [
  { id: 7, name: "Ohio" },
  { id: 13, name: "North Virginia" },
  { id: 15, name: "Oregon" },
  { id: 18, name: "North California" },
] as const;

/** The exact millisecond values `validateVolume` accepts. */
const FREQUENCY_MS: readonly number[] = FREQUENCY_MINUTES.map(
  (minutes) => minutes * MINUTE_MS,
);

/**
 * Clicks per day for one check: every selected probe runs once per interval,
 * so a 5-minute check on four probes is 288 × 4 = 1152 clicks/day.
 *
 * Invalid input returns 0 rather than `NaN` or `Infinity`: the panel renders
 * the result directly, and a nonsense number in the preview is worse than a
 * zero an operator can see is wrong.
 */
export function clicksPerDay(
  frequencyMs: number,
  probeCount: number,
): number {
  if (!Number.isFinite(frequencyMs) || frequencyMs <= 0) return 0;
  if (!Number.isFinite(probeCount) || probeCount <= 0) return 0;
  return Math.floor((DAY_MS / frequencyMs) * Math.trunc(probeCount));
}

export type VolumeInput = {
  frequencyMs: number;
  probeIds: number[];
};

export type VolumeValidation =
  | { ok: true; value: VolumeInput }
  | { ok: false; reason: string; code: VolumeReason };

/**
 * Why a volume was refused. The `reason` stays the operator-facing sentence;
 * the `code` is what a caller or a test can switch on without matching prose.
 */
export type VolumeReason =
  | "unsupported_frequency"
  | "no_probes"
  | "too_many_probes"
  | "invalid_probe_id"
  | "duplicate_probe";

/**
 * The most probes one save may request.
 *
 * Grafana runs every selected probe on every run, so this is the multiplier on
 * both the bill and the traffic the target sees: ten probes at the fastest
 * interval is already 2,880 clicks/day. The cap exists so a crafted form body
 * cannot make one save order an unbounded amount of traffic — the panel offers
 * four probes, and the ceiling leaves room for a wider stack without turning
 * this action into a load generator.
 */
export const MAX_PROBES_PER_SAVE = 10;

/**
 * The one gate both the form and the action go through. It rejects anything
 * Grafana would either refuse or reinterpret: an interval outside the five the
 * panel offers, an empty probe set, more probes than one save may request, or a
 * duplicate/non-integer probe id.
 *
 * Success returns a copy of the arrays so a caller cannot mutate the value it
 * validated after the fact.
 */
export function validateVolume(input: VolumeInput): VolumeValidation {
  const { frequencyMs, probeIds } = input;

  if (!FREQUENCY_MS.includes(frequencyMs)) {
    return {
      ok: false,
      code: "unsupported_frequency",
      reason: "Frequency must be 5, 10, 15, 30 or 60 minutes.",
    };
  }

  if (!Array.isArray(probeIds) || probeIds.length === 0) {
    return {
      ok: false,
      code: "no_probes",
      reason: "Pick at least one probe.",
    };
  }

  // Before the per-id walk: the cap is about the size of the request, and a
  // flood of ids should be refused without hashing all of them first.
  if (probeIds.length > MAX_PROBES_PER_SAVE) {
    return {
      ok: false,
      code: "too_many_probes",
      reason: `One save can select at most ${MAX_PROBES_PER_SAVE} probes.`,
    };
  }

  const seen = new Set<number>();
  for (const id of probeIds) {
    if (!Number.isInteger(id) || id <= 0) {
      return {
        ok: false,
        code: "invalid_probe_id",
        reason: "Probe ids must be positive integers.",
      };
    }
    if (seen.has(id)) {
      return {
        ok: false,
        code: "duplicate_probe",
        reason: "Each probe can only be picked once.",
      };
    }
    seen.add(id);
  }

  return { ok: true, value: { frequencyMs, probeIds: [...probeIds] } };
}

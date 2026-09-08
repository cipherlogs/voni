import { z } from "zod";

/**
 * Campaign calling-window and consent evaluation (plan Day 7-8, enforced by
 * the dispatcher rather than deferred to the Day 14 compliance pass).
 *
 * These are pure functions over an explicit `now` so the rules are testable
 * without freezing the clock, and so the dispatcher can evaluate a campaign in
 * Dubai from a runner sitting in any timezone. Section G of the plan requires
 * calling-window and consent rules to be *config, not hardcoded* — the shapes
 * below are stored per campaign, and nothing here knows about the UAE.
 *
 * Every failure path returns a reason string. Those strings are written to
 * `campaign_leads.last_outcome`, so "why was this person not called" is
 * answerable from the database rather than from log archaeology.
 */

/** 0 = Sunday .. 6 = Saturday, matching `Date.getDay()` and Intl's weekday order. */
export const callingWindowSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour."),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour."),
  timezone: z.string().min(1),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
});

export type CallingWindow = z.infer<typeof callingWindowSchema>;

export const consentPolicySchema = z.object({
  /**
   * `granted` is the safe default: only leads that explicitly consented get
   * called. `not_revoked` permits `unknown`, which is what a plain CSV of
   * inbound enquiries looks like before anyone has recorded consent.
   */
  require: z.enum(["granted", "not_revoked"]).default("granted"),
});

export type ConsentPolicy = z.infer<typeof consentPolicySchema>;

/**
 * UAE business hours, Monday-Saturday. A default has to be *some* region's, and
 * this one matches the launch market; it is overridden per campaign on the
 * creation form and is never read from anywhere but here.
 */
export const DEFAULT_CALLING_WINDOW: CallingWindow = {
  start: "09:00",
  end: "18:00",
  timezone: "Asia/Dubai",
  daysOfWeek: [1, 2, 3, 4, 5, 6],
};

export const DEFAULT_CONSENT_POLICY: ConsentPolicy = { require: "granted" };

/** Tolerant read of a jsonb column that may predate the schema or be null. */
export function parseCallingWindow(raw: unknown): CallingWindow {
  const parsed = callingWindowSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CALLING_WINDOW;
}

export function parseConsentPolicy(raw: unknown): ConsentPolicy {
  const parsed = consentPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CONSENT_POLICY;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

type LocalClock = { weekday: number; minutes: number };

/**
 * The wall clock in the campaign's timezone.
 *
 * Intl is the only timezone database available in a Workers runtime — there is
 * no `process.env.TZ` to lean on and no room for a tz library in the bundle —
 * and it handles DST transitions correctly, which naive UTC-offset arithmetic
 * does not.
 */
function localClock(now: Date, timezone: string): LocalClock | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
  } catch {
    // An unknown IANA zone throws rather than falling back to UTC. Silently
    // calling in the wrong timezone is worse than not calling, so the caller
    // treats null as "window not evaluable" and skips the lead.
    return null;
  }

  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const weekday = WEEKDAY_INDEX[lookup("weekday")];
  const hour = Number(lookup("hour"));
  const minute = Number(lookup("minute"));
  if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  // Intl renders midnight as "24" under hour12:false in some ICU versions.
  return { weekday, minutes: (hour % 24) * 60 + minute };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export type PolicyVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Is `now` inside the campaign's calling window?
 *
 * A window whose end is not after its start is rejected rather than
 * interpreted as wrapping past midnight. Overnight cold-calling is not legal
 * in any market we would launch in, so the likelier explanation for
 * `20:00 - 02:00` is a typo — and failing closed on a typo costs one skipped
 * call, while failing open costs a 2am phone call to a stranger.
 */
export function evaluateCallingWindow(
  window: CallingWindow,
  now: Date,
): PolicyVerdict {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (end <= start) {
    return {
      allowed: false,
      reason: `calling window ${window.start}-${window.end} is not a valid range`,
    };
  }

  const clock = localClock(now, window.timezone);
  if (!clock) {
    return {
      allowed: false,
      reason: `unknown timezone "${window.timezone}"`,
    };
  }

  if (!window.daysOfWeek.includes(clock.weekday)) {
    return {
      allowed: false,
      reason: `${WEEKDAY_LABELS[clock.weekday]} is outside the calling days`,
    };
  }
  if (clock.minutes < start || clock.minutes >= end) {
    const hh = String(Math.floor(clock.minutes / 60)).padStart(2, "0");
    const mm = String(clock.minutes % 60).padStart(2, "0");
    return {
      allowed: false,
      reason: `${hh}:${mm} in ${window.timezone} is outside ${window.start}-${window.end}`,
    };
  }
  return { allowed: true };
}

/**
 * The `leads.consent_status` values this policy permits.
 *
 * The dispatcher filters in SQL and the UI explains in prose, and those two
 * must not drift — a rule that is stricter on screen than in the query is how
 * someone who opted out gets phoned. So both derive from this one list:
 * `evaluateConsent` below is a membership test against it, and the claim query
 * passes it straight to Postgres as an array.
 *
 * `revoked` appears in neither branch. There is no configuration in which
 * calling someone who opted out is correct.
 */
export function allowedConsentStatuses(policy: ConsentPolicy): string[] {
  return policy.require === "granted" ? ["granted"] : ["granted", "unknown"];
}

/** Does this lead's recorded consent satisfy the campaign's policy? */
export function evaluateConsent(
  policy: ConsentPolicy,
  consentStatus: string,
): PolicyVerdict {
  if (allowedConsentStatuses(policy).includes(consentStatus)) {
    return { allowed: true };
  }
  return consentStatus === "revoked"
    ? { allowed: false, reason: "consent revoked" }
    : { allowed: false, reason: `consent is "${consentStatus}", not granted` };
}

/** Human-readable window summary for the campaign list and detail pages. */
export function describeCallingWindow(window: CallingWindow): string {
  const days = [...window.daysOfWeek].sort((a, b) => a - b);
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const label =
    days.length === 7
      ? "every day"
      : contiguous && days.length > 1
        ? `${WEEKDAY_LABELS[days[0]].slice(0, 3)}-${WEEKDAY_LABELS[days[days.length - 1]].slice(0, 3)}`
        : days.map((d) => WEEKDAY_LABELS[d].slice(0, 3)).join(", ");
  return `${window.start}-${window.end} ${window.timezone}, ${label}`;
}

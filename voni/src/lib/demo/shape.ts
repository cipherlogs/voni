/**
 * The one shape guard the demo readers share (meta-cascade M12).
 *
 * `artifact-reader.ts` and `event-envelope.ts` read different documents but
 * refuse the same way: a section that should be an object is `null`, an array
 * or a primitive, and the reader must name the value that failed instead of
 * guessing. Both import this module so there is one copy of that guard, one
 * `showValue` spelling and one error base — a second copy is a review failure
 * (CODING_STANDARDS: "Prefer a shared validator over a second copy of the same
 * shape check").
 */

/** A refused shape, named by the source, the field and the reason. */
export class ShapeError extends Error {
  /** The line label or path the value was read from. */
  readonly source: string;
  /** The field that failed, e.g. `schemaVersion` or `captures.platform`. */
  readonly field: string;
  /** Why it failed, with the offending value spelled out. */
  readonly reason: string;

  constructor(name: string, message: string, source: string, field: string, reason: string) {
    super(message);
    this.name = name;
    this.source = source;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * One value as a message can quote it. `undefined` is "missing" (the vendor
 * did not send the field); everything else is JSON when that is meaningful and
 * `String` when it is not, so an error never throws while formatting.
 */
export function showValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The one object guard: a null, array or primitive is refused by name.
 *
 * `notObject` is the sentence the caller wants before the offending value
 * (`"captures is not an object"`, `"not an event envelope object"`), so both
 * readers keep their own field wording while sharing the check.
 */
export function objectOf(
  raw: unknown,
  notObject: string,
  refuse: (reason: string) => never,
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    refuse(`${notObject} (${showValue(raw)})`);
  }
  return raw as Record<string, unknown>;
}

/**
 * A section that is optional: `undefined` says the writer did not emit it,
 * while every other non-object is refused. The absent case is the caller's to
 * interpret (a legacy artifact versus a missing required section).
 */
export function optionalObjectOf(
  raw: unknown,
  notObject: string,
  refuse: (reason: string) => never,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  return objectOf(raw, notObject, refuse);
}

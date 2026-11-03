/**
 * Gold-label export: the owner's blind ratings become the labels the judges
 * calibrate against and the panel's H1-H5 gate measures.
 *
 * A label set is attributable: it carries the session id, the run id, the
 * reviewer and the date. Export refuses an incomplete session, a rating from
 * another session, a duplicate item and a rating outside the seven-axis 1-5
 * scale. The digest pins exactly the labels a signature covers.
 */

import { sha256Hex } from "../../../src/lib/demo/verification/scenarios/digest";
import type { Locale } from "../../../src/lib/demo/verification/scenarios/types";
import { PanelError } from "../../../src/lib/demo/verification/panel/errors";
import type {
  PanelGoldLabel,
  PanelGoldLabelSet,
} from "../../../src/lib/demo/verification/panel/types";
import { RATING_AXIS_IDS, RATING_SCALE_MAX, RATING_SCALE_MIN, type RatingRecord, type RatingSession } from "../rate";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PREFERENCES = ["agent", "baseline", "neither"] as const;

function canonicalLabel(label: PanelGoldLabel): Record<string, unknown> {
  return {
    sessionId: label.sessionId,
    callId: label.callId,
    itemId: label.itemId,
    scenario: label.scenario,
    locale: label.locale,
    axes: Object.fromEntries(RATING_AXIS_IDS.map((axis) => [axis, label.axes[axis]])),
    humanDetected: label.humanDetected,
    preference: label.preference,
    ratedAt: label.ratedAt,
  };
}

/** The one digest a panel signature signs over: the exact exported labels. */
export function goldLabelDigest(input: {
  sessionId: string;
  runId: string;
  reviewer: string;
  signedAt: string;
  labels: readonly PanelGoldLabel[];
}): string {
  return sha256Hex(
    JSON.stringify({
      sessionId: input.sessionId,
      runId: input.runId,
      reviewer: input.reviewer,
      signedAt: input.signedAt,
      labels: input.labels.map(canonicalLabel),
    }),
  );
}

function parseAxes(record: RatingRecord): Record<string, number> {
  const axes: Record<string, number> = {};
  for (const axis of RATING_AXIS_IDS) {
    const value = record.axes?.[axis];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < RATING_SCALE_MIN ||
      value > RATING_SCALE_MAX
    ) {
      throw new PanelError(
        "invalid-session",
        `rating ${record.itemId} axis "${axis}" is ${String(value)}; the panel scale is ` +
          `${RATING_SCALE_MIN}-${RATING_SCALE_MAX}`,
      );
    }
    axes[axis] = value;
  }
  return axes;
}

function parseRating(record: RatingRecord, session: RatingSession): RatingRecord {
  if (typeof record !== "object" || record === null) {
    throw new PanelError("invalid-session", "a rating must be an object");
  }
  if (record.sessionId !== session.sessionId) {
    throw new PanelError(
      "rating-session-mismatch",
      `rating ${record.itemId} belongs to session "${record.sessionId}", not ` +
        `"${session.sessionId}"`,
    );
  }
  const item = session.queue.find((entry) => entry.itemId === record.itemId);
  if (item === undefined) {
    throw new PanelError(
      "unknown-rating",
      `rating "${record.itemId}" is not a queued item of session "${session.sessionId}"`,
    );
  }
  if (record.callId !== item.callId) {
    throw new PanelError(
      "unknown-rating",
      `rating "${record.itemId}" names call "${record.callId}" but the queue names ` +
        `"${item.callId}"`,
    );
  }
  return record;
}

/**
 * Export one session's ratings as gold labels. The set is incomplete until
 * every queued item has exactly one rating: a partial panel cannot sign.
 */
export function exportGoldLabels(input: {
  session: RatingSession;
  ratings: readonly RatingRecord[];
}): PanelGoldLabelSet {
  const { session } = input;
  if (typeof session.reviewer !== "string" || session.reviewer.trim() === "") {
    throw new PanelError(
      "missing-reviewer",
      `session "${session.sessionId}" has no reviewer; gold labels are never anonymous`,
    );
  }
  if (typeof session.date !== "string" || !ISO_DATE.test(session.date) || Number.isNaN(Date.parse(session.date))) {
    throw new PanelError(
      "missing-signature-date",
      `session "${session.sessionId}" has no YYYY-MM-DD date; a signature is always dated`,
    );
  }

  const byItem = new Map<string, RatingRecord>();
  for (const rating of input.ratings) {
    const parsed = parseRating(rating, session);
    if (byItem.has(parsed.itemId)) {
      throw new PanelError(
        "duplicate-rating",
        `item "${parsed.itemId}" is rated twice in session "${session.sessionId}"; a rating is ` +
          "written once",
      );
    }
    byItem.set(parsed.itemId, parsed);
  }
  const missing = session.queue
    .filter((item) => !byItem.has(item.itemId))
    .map((item) => item.itemId);
  if (missing.length > 0) {
    throw new PanelError(
      "incomplete-panel",
      `session "${session.sessionId}" is missing ratings for ${missing.join(", ")}; an incomplete ` +
        "panel cannot sign the certificate",
    );
  }

  const labels: PanelGoldLabel[] = session.queue.map((item) => {
    const rating = byItem.get(item.itemId);
    if (rating === undefined) {
      throw new PanelError("incomplete-panel", `item "${item.itemId}" has no rating`);
    }
    const preference = rating.preference;
    if (
      preference !== null &&
      !(PREFERENCES as readonly (string | null)[]).includes(preference)
    ) {
      throw new PanelError(
        "invalid-session",
        `rating "${rating.itemId}" records preference ${JSON.stringify(preference)}; ` +
          `expected ${PREFERENCES.join(", ")} or null`,
      );
    }
    return {
      sessionId: session.sessionId,
      callId: item.callId,
      itemId: item.itemId,
      scenario: item.scenario,
      locale: item.locale as Locale,
      axes: parseAxes(rating),
      humanDetected: rating.humanDetected,
      preference: preference as PanelGoldLabel["preference"],
      ratedAt: rating.ratedAt,
    };
  });

  const signedAt = session.date;
  return {
    sessionId: session.sessionId,
    runId: session.runId,
    reviewer: session.reviewer,
    signedAt,
    labels,
    digest: goldLabelDigest({
      sessionId: session.sessionId,
      runId: session.runId,
      reviewer: session.reviewer,
      signedAt,
      labels,
    }),
  };
}

/**
 * Extend a session's gold labels with labels from earlier sessions (the H2
 * judgment ledger). The primary set keeps its session identity and date — it is
 * the session a signature names — while the labels carry their own session ids
 * for citation. The primary's digest is not reused for the union.
 */
export function mergeGoldLabelSets(
  primary: PanelGoldLabelSet,
  extra: readonly PanelGoldLabelSet[],
): PanelGoldLabelSet {
  const seen = new Set(primary.labels.map((label) => `${label.sessionId}#${label.itemId}`));
  const labels = [...primary.labels];
  for (const set of extra) {
    for (const label of set.labels) {
      const key = `${label.sessionId}#${label.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(label);
    }
  }
  return {
    ...primary,
    labels,
    digest: goldLabelDigest({
      sessionId: primary.sessionId,
      runId: primary.runId,
      reviewer: primary.reviewer,
      signedAt: primary.signedAt,
      labels,
    }),
  };
}

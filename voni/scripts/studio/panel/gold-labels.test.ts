/**
 * Gold-label export: ratings become attributable labels with the session id,
 * the run, the reviewer and the date; a partial or foreign session is refused.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RATING_AXES, fileRating, type RatingRecord } from "../rate";import { PanelError } from "../../../src/lib/demo/verification/panel/errors";
import { exportGoldLabels } from "./gold-labels";
import { buildPanelSession } from "./session";
import { callsFor, sessionCertificate } from "./fixtures";

test("the seven rating axes are the confirmed vocabulary, verbatim", () => {
  assert.deepEqual(
    RATING_AXES.map((axis) => axis.id),
    [
      "stayOnCall",
      "soundsHuman",
      "turnTaking",
      "understanding",
      "languageNaturalness",
      "warmth",
      "pacing",
    ],
  );
});

function refusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PanelError, `expected PanelError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    return true;
  };
}

function ratedSession() {
  const certificate = sessionCertificate({ callsPerLocale: 3 });
  const { session } = buildPanelSession({
    certificate,
    calls: callsFor(certificate),
    reviewer: "owner",
    seed: 5,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
  const ratings = session.queue.map((item) =>
    fileRating(
      session,
      {
        itemId: item.itemId,
        axes: Object.fromEntries(RATING_AXES.map((axis) => [axis.id, 4])),
        humanSide: item.ab?.baselineSide ?? "A",
        preferredSide: item.ab?.agentSide ?? "B",
      },
      "2026-10-31T11:00:00.000Z",
    ),
  );
  return { session, ratings };
}

test("ratings export as gold labels with session id, run, reviewer and date", () => {
  const { session, ratings } = ratedSession();
  const gold = exportGoldLabels({ session, ratings });
  assert.equal(gold.sessionId, session.sessionId);
  assert.equal(gold.runId, session.runId);
  assert.equal(gold.reviewer, "owner");
  assert.equal(gold.signedAt, session.date);
  assert.equal(gold.labels.length, session.queue.length);
  assert.match(gold.digest, /^[0-9a-f]{64}$/);
  for (const label of gold.labels) {
    assert.equal(label.sessionId, session.sessionId);
    assert.equal(label.axes.stayOnCall, 4);
    assert.equal(label.humanDetected, true, "the rater picked the baseline side as human");
    assert.equal(label.preference, "agent", "the rater preferred the agent side");
  }
  assert.deepEqual(
    gold.labels.map((label) => label.callId).sort(),
    session.queue.map((item) => item.callId).sort(),
  );
});

test("the digest changes when any label changes", () => {
  const { session, ratings } = ratedSession();
  const gold = exportGoldLabels({ session, ratings });
  const changed = exportGoldLabels({
    session,
    ratings: ratings.map((rating, index) =>
      index === 0 ? { ...rating, axes: { ...rating.axes, warmth: 3 } } : rating,
    ),
  });
  assert.notEqual(changed.digest, gold.digest);
});

test("an incomplete panel cannot export gold labels", () => {
  const { session, ratings } = ratedSession();
  assert.throws(
    () => exportGoldLabels({ session, ratings: ratings.slice(1) }),
    refusal("incomplete-panel", /missing ratings for/),
  );
});

test("a duplicate rating and a foreign rating are refused by name", () => {
  const { session, ratings } = ratedSession();
  assert.throws(
    () => exportGoldLabels({ session, ratings: [...ratings, ratings[0]!] }),
    refusal("duplicate-rating", /rated twice/),
  );

  const foreign: RatingRecord = { ...ratings[0]!, sessionId: "rating-" + "f".repeat(64) };
  assert.throws(
    () => exportGoldLabels({ session, ratings: [foreign, ...ratings.slice(1)] }),
    refusal("rating-session-mismatch", /belongs to session/),
  );

  const unknown: RatingRecord = { ...ratings[0]!, itemId: "item-999" };
  assert.throws(
    () => exportGoldLabels({ session, ratings: [unknown, ...ratings.slice(1)] }),
    refusal("unknown-rating", /not a queued item/),
  );
});

test("a session with no date is refused; a signature is always dated", () => {
  const { session, ratings } = ratedSession();
  const undated = { ...session, date: "" };
  assert.throws(
    () => exportGoldLabels({ session: undated, ratings }),
    refusal("missing-signature-date", /YYYY-MM-DD date/),
  );
});

test("an axis outside the 1-5 scale is refused, never clipped", () => {
  const { session, ratings } = ratedSession();
  const broken: RatingRecord = {
    ...ratings[0]!,
    axes: { ...ratings[0]!.axes, warmth: 9 },
  };
  assert.throws(
    () => exportGoldLabels({ session, ratings: [broken, ...ratings.slice(1)] }),
    refusal("invalid-session", /scale is 1-5/),
  );
});

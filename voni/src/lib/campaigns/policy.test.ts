import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedConsentStatuses,
  DEFAULT_CALLING_WINDOW,
  describeCallingWindow,
  evaluateCallingWindow,
  evaluateConsent,
  parseCallingWindow,
  parseConsentPolicy,
} from "./policy";

// Dubai is UTC+4 with no daylight saving, so these instants are unambiguous.
const dubai = DEFAULT_CALLING_WINDOW; // 09:00-18:00 Asia/Dubai, Mon-Sat

test("allows a call inside the window and rejects one before it opens", () => {
  // 2026-09-07 is a Monday. 06:00Z = 10:00 Dubai; 04:00Z = 08:00 Dubai.
  assert.deepEqual(
    evaluateCallingWindow(dubai, new Date("2026-09-07T06:00:00Z")),
    { allowed: true },
  );
  const early = evaluateCallingWindow(dubai, new Date("2026-09-07T04:00:00Z"));
  assert.equal(early.allowed, false);
  assert.match(early.allowed === false ? early.reason : "", /08:00 in Asia\/Dubai/);
});

test("the window is half-open, so the closing minute is already outside", () => {
  // 13:59Z = 17:59 Dubai (in), 14:00Z = 18:00 Dubai (out).
  assert.equal(
    evaluateCallingWindow(dubai, new Date("2026-09-07T13:59:00Z")).allowed,
    true,
  );
  assert.equal(
    evaluateCallingWindow(dubai, new Date("2026-09-07T14:00:00Z")).allowed,
    false,
  );
});

test("rejects a day that is not in the calling days", () => {
  // 2026-09-06 is a Sunday, which the UAE default excludes.
  const verdict = evaluateCallingWindow(dubai, new Date("2026-09-06T06:00:00Z"));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed === false ? verdict.reason : "", /Sunday/);
});

test("the timezone is the campaign's, not the runner's", () => {
  // The same instant is inside a Dubai window and outside a London one.
  const instant = new Date("2026-09-07T05:30:00Z"); // 09:30 Dubai, 06:30 London
  assert.equal(evaluateCallingWindow(dubai, instant).allowed, true);
  assert.equal(
    evaluateCallingWindow({ ...dubai, timezone: "Europe/London" }, instant).allowed,
    false,
  );
});

test("an inverted or unknown window fails closed rather than wrapping midnight", () => {
  const overnight = evaluateCallingWindow(
    { ...dubai, start: "20:00", end: "02:00" },
    new Date("2026-09-07T20:00:00Z"), // 00:00 Dubai, inside the range if it wrapped
  );
  assert.equal(overnight.allowed, false);
  assert.match(overnight.allowed === false ? overnight.reason : "", /not a valid range/);

  const bogusZone = evaluateCallingWindow(
    { ...dubai, timezone: "Mars/Olympus" },
    new Date("2026-09-07T06:00:00Z"),
  );
  assert.equal(bogusZone.allowed, false);
  assert.match(bogusZone.allowed === false ? bogusZone.reason : "", /unknown timezone/);
});

test("the SQL filter list and the prose verdict cannot drift apart", () => {
  // evaluateConsent is what the UI explains; allowedConsentStatuses is what the
  // claim query sends to Postgres. Every status must get the same answer from
  // both, or a lead the UI calls ineligible gets dialled anyway.
  for (const require of ["granted", "not_revoked"] as const) {
    const allowed = allowedConsentStatuses({ require });
    for (const status of ["granted", "unknown", "revoked", "pending"]) {
      assert.equal(
        evaluateConsent({ require }, status).allowed,
        allowed.includes(status),
        `${require} / ${status}`,
      );
    }
  }
});

test("revoked consent blocks under every policy", () => {
  for (const require of ["granted", "not_revoked"] as const) {
    const verdict = evaluateConsent({ require }, "revoked");
    assert.equal(verdict.allowed, false, `policy ${require} must block revoked`);
  }
});

test("not_revoked admits unknown consent, granted does not", () => {
  assert.equal(evaluateConsent({ require: "not_revoked" }, "unknown").allowed, true);
  assert.equal(evaluateConsent({ require: "granted" }, "unknown").allowed, false);
  assert.equal(evaluateConsent({ require: "granted" }, "granted").allowed, true);
});

test("malformed stored policy falls back to the safe default", () => {
  assert.deepEqual(parseCallingWindow(null), DEFAULT_CALLING_WINDOW);
  assert.deepEqual(parseCallingWindow({ start: "9am", end: "6pm" }), DEFAULT_CALLING_WINDOW);
  // The fallback must be the *restrictive* consent setting, not the permissive one.
  assert.equal(parseConsentPolicy(undefined).require, "granted");
  assert.equal(parseConsentPolicy({ require: "anything" }).require, "granted");
});

test("describes a window in the compressed form the campaign list shows", () => {
  assert.equal(
    describeCallingWindow(dubai),
    "09:00-18:00 Dubai time, Mon-Sat",
  );
  assert.match(describeCallingWindow({ ...dubai, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }), /every day/);
  assert.equal(
    describeCallingWindow({ ...dubai, daysOfWeek: [1, 3, 5] }),
    "09:00-18:00 Dubai time, Mon, Wed, Fri",
  );
});

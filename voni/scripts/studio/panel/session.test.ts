/**
 * Ticket 27's panel sample: twelve calls, two per Locale, every failing call
 * mandatory, and a blind queue that names no verdict, scenario or call.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { blindSession } from "../rate";
import { LOCALES } from "../../../src/lib/demo/verification/scenarios/types";
import { PANEL_SAMPLE_SIZE } from "../../../src/lib/demo/verification/panel/types";
import { PanelError } from "../../../src/lib/demo/verification/panel/errors";
import { buildPanelSession } from "./session";
import { call, callsFor, sessionCertificate } from "./fixtures";

function refusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PanelError, `expected PanelError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2);
    return true;
  };
}

function sessionFor(options: {
  callsPerLocale?: number;
  failing?: readonly string[];
  calls?: ReturnType<typeof callsFor>;
  seed?: number;
}) {
  const certificate = sessionCertificate(options);
  return buildPanelSession({
    certificate,
    calls: options.calls ?? callsFor(certificate),
    reviewer: "owner",
    seed: options.seed ?? 7,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
}

test("the panel samples twelve calls with two per Locale and is blind to the verdict", () => {
  const { session, blind } = sessionFor({ callsPerLocale: 3 });
  assert.equal(session.queue.length, PANEL_SAMPLE_SIZE);
  assert.equal(session.sampleSize, PANEL_SAMPLE_SIZE);
  for (const locale of LOCALES) {
    const count = session.queue.filter((item) => item.locale === locale).length;
    assert.ok(count >= 2, `${locale} has ${count} calls; two are mandatory`);
  }
  assert.equal(new Set(session.queue.map((item) => item.callId)).size, PANEL_SAMPLE_SIZE);

  const serialized = JSON.stringify(blind);
  assert.doesNotMatch(serialized, /callId|scenario|failing|PASS|FAIL|pending-human/);
  assert.doesNotMatch(serialized, /sha256|baseline|agentSide/);
  assert.match(serialized, /Hello\?/, "the transcript is part of playback");
});

test("two failing calls fill the two extra slots and both are mandatory", () => {
  const certificate = sessionCertificate({
    callsPerLocale: 3,
    failing: ["panel-es", "panel-pt"],
  });
  const { session } = buildPanelSession({
    certificate,
    calls: callsFor(certificate),
    reviewer: "owner",
    seed: 4,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
  assert.equal(session.queue.length, PANEL_SAMPLE_SIZE);
  const queued = new Set(session.queue.map((item) => item.callId));
  assert.ok(queued.has("call-es-1"), "the es failing call is mandatory");
  assert.ok(queued.has("call-pt-1"), "the pt failing call is mandatory");
  for (const locale of LOCALES) {
    assert.ok(
      session.queue.filter((item) => item.locale === locale).length >= 2,
      `${locale} still has its two-call base`,
    );
  }
});

test("the worst failing calls are queued first, ahead of the clean sample", () => {
  const certificate = sessionCertificate({
    callsPerLocale: 3,
    failing: ["panel-es", "panel-pt"],
    severity: { "panel-es": 2, "panel-pt": 1 },
  });
  const { session } = buildPanelSession({
    certificate,
    calls: callsFor(certificate),
    reviewer: "owner",
    seed: 4,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
  const failing = session.queue.filter((item) => item.failing);
  assert.equal(failing[0]?.scenario, "panel-es", "the two-row failure is worst");
  const esLast = failing.map((item) => item.scenario).lastIndexOf("panel-es");
  const ptFirst = failing.findIndex((item) => item.scenario === "panel-pt");
  assert.ok(esLast < ptFirst, "every es failure precedes the less severe pt failure");
  assert.equal(session.queue[failing.length]?.failing, false, "clean calls follow failures");
});

test("the same seed reproduces the session and a different seed reorders it", () => {
  const first = sessionFor({ callsPerLocale: 4, seed: 11 });
  const repeated = sessionFor({ callsPerLocale: 4, seed: 11 });
  const second = sessionFor({ callsPerLocale: 4, seed: 12 });
  assert.deepEqual(
    repeated.session.queue.map((item) => item.callId),
    first.session.queue.map((item) => item.callId),
  );
  assert.notDeepEqual(
    second.session.queue.map((item) => item.callId),
    first.session.queue.map((item) => item.callId),
  );
  assert.deepEqual(blindSession(repeated.session), repeated.blind);
});

test("every failing call is mandatory even beyond the twelve-call sample", () => {
  const certificate = sessionCertificate({
    callsPerLocale: 3,
    failing: ["panel-en", "panel-es", "panel-pt"],
  });
  const calls = callsFor(certificate);
  const { session } = buildPanelSession({
    certificate,
    calls,
    reviewer: "owner",
    seed: 3,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
  const failing = session.queue.filter((item) => item.failing);
  assert.equal(failing.length, 9, "every failing call is queued");
  assert.deepEqual(
    failing.map((item) => item.callId).sort(),
    [
      "call-en-1",
      "call-en-2",
      "call-en-3",
      "call-es-1",
      "call-es-2",
      "call-es-3",
      "call-pt-1",
      "call-pt-2",
      "call-pt-3",
    ],
  );
  assert.ok(session.queue.length > PANEL_SAMPLE_SIZE, "the failure sample is not truncated to 12");
});

test("a missing Locale refuses the session by name", () => {
  const certificate = sessionCertificate({ callsPerLocale: 3 });
  const calls = callsFor(certificate).filter((entry) => entry.locale !== "es");
  assert.throws(
    () =>
      buildPanelSession({
        certificate,
        calls,
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("missing-locale", /no call for Locale "es"/),
  );
});

test("a Locale with one call refuses the session as a shortfall", () => {
  const certificate = sessionCertificate({ callsPerLocale: 3 });
  const calls = callsFor(certificate).filter(
    (entry) => entry.locale !== "de" || entry.callId === "call-de-1",
  );
  assert.throws(
    () =>
      buildPanelSession({
        certificate,
        calls,
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("locale-shortfall", /Locale "de" has 1 call/),
  );
});

test("a failing call with no evidence refuses the session by name", () => {
  const certificate = sessionCertificate({ callsPerLocale: 3, failing: ["panel-es"] });
  const calls = callsFor(certificate).filter((entry) => entry.callId !== "call-es-2");
  assert.throws(
    () =>
      buildPanelSession({
        certificate,
        calls,
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("missing-failing-call", /call-es-2/),
  );
});

test("a run with fewer than twelve eligible calls refuses the panel", () => {
  assert.throws(
    () => sessionFor({ callsPerLocale: 2 }),
    refusal("panel-shortfall", /samples 12/),
  );
});

test("a panel session needs a named reviewer and call evidence", () => {
  const certificate = sessionCertificate({ callsPerLocale: 3 });
  assert.throws(
    () =>
      buildPanelSession({
        certificate,
        calls: callsFor(certificate),
        reviewer: "  ",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("missing-reviewer", /named reviewer/),
  );
  assert.throws(
    () =>
      buildPanelSession({
        certificate,
        calls: [],
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("empty-panel", /needs call evidence/),
  );
});

test("the blind payload carries neither the failing flag nor the call identity", () => {
  const certificate = sessionCertificate({ callsPerLocale: 3, failing: ["panel-fr"] });
  const { blind } = buildPanelSession({
    certificate,
    calls: callsFor(certificate),
    reviewer: "owner",
    seed: 9,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
  for (const item of blind.queue) {
    assert.deepEqual(Object.keys(item).sort(), [
      "ab",
      "itemId",
      "locale",
      "position",
      "timeline",
      "transcript",
    ]);
  }
});

test("a call outside the certificate's coverage is refused, never sampled", () => {
  const certificate = sessionCertificate({ callsPerLocale: 3 });
  const calls = [...callsFor(certificate), call("intruder", "other", "en")];
  assert.throws(
    () =>
      buildPanelSession({
        certificate,
        calls,
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("invalid-session", /not named by the certificate's coverage/),
  );
});

test("a duplicate call in the evidence is refused by name", () => {
  const certificate = sessionCertificate({ callsPerLocale: 3 });
  const calls = callsFor(certificate);
  assert.throws(
    () =>
      buildPanelSession({
        certificate,
        calls: [...calls, calls[0]!],
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("duplicate-call", /offered twice/),
  );
});

/**
 * Ticket 24's Rate core: a blind queue, a blind A/B pair, seven axes and an
 * attributable rating.
 *
 * The tests drive the public builders and the blind projection. They never
 * read the private session to decide what the blind payload should contain:
 * the assertion is over the serialized payload a rater receives, so a new
 * private field cannot leak into playback without failing here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Certificate } from "../../src/lib/demo/verification/certificate/types";
import {
  RATING_AXES,
  RatingError,
  blindSession,
  buildRatingSession,
  fileRating,
  signatureReference,
  type RatingCallInput,
  type RatingSession,
} from "./rate";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function certificate(options: {
  failing?: readonly string[];
  callsByScenario: Readonly<Record<string, readonly string[]>>;
}): Certificate {
  const failing = new Set(options.failing ?? []);
  const scenarios = Object.keys(options.callsByScenario);
  const rows = scenarios.map((scenario) => ({
    locale: "en" as const,
    scenario,
    class: "golden-flow" as const,
    heldOut: false,
    requiredRepetitions: 1,
    measuredRepetitions: options.callsByScenario[scenario].length,
    status: "measured" as const,
    gap: null,
    calls: options.callsByScenario[scenario],
  }));
  return {
    schemaVersion: 3,
    scope: {
      locales: ["en"],
      decidedBy: "owner",
      decidedOn: "2026-11-02",
      reason: "English-only launch",
    },
    resume: null,
    runId: "run-2026-10-31",
    target: "local",
    code: {
      fingerprint: { head: "abc123", dirty: false, dirtyHash: "clean" },
      appBuild: "app-build-1",
      pipelineImage: "pipeline-image-1",
    },
    corpus: { version: 1, sha256: HASH_C },
    vendorBuilds: [
      { leg: "stt", vendor: "vendor-a", model: "model-a", buildId: "build-a" },
      { leg: "tts", vendor: "vendor-b", model: "model-b", buildId: "build-b" },
      { leg: "llm", vendor: "vendor-c", model: "model-c", buildId: "build-c" },
    ],
    plan: { mode: "nightly", repetitions: 1 },
    coverage: {
      expectedScenarios: rows.length,
      gapRows: 0,
      rows,
      byLocale: [
        {
          locale: "en",
          expectedScenarios: rows.length,
          measuredScenarios: rows.length,
          gapRows: 0,
          status: "measured",
          gap: null,
        },
      ],
    },
    properties: [
      {
        propertyId: "L1",
        family: "connect",
        status: "PASS",
        reason: "pass",
        sampleCount: 1,
        citations: ["connect"],
        gaps: [],
        scenarios: [],
      },
      ...(failing.size === 0
        ? []
        : [
            {
              propertyId: "T1",
              family: "turn-taking",
              status: "FAIL" as const,
              reason: "below-bar" as const,
              sampleCount: 1,
              citations: ["turn-taking"],
              gaps: [],
              scenarios: [...failing].map((scenario) => ({
                scenario,
                locale: "en" as const,
                status: "FAIL" as const,
                reason: "below-bar" as const,
                sampleCount: 1,
                citations: [`${scenario}#1`],
              })),
            },
          ]),
    ],
    eligibility: { eligible: true, reasons: [] },
    runFailures: [],
    cost: { usd: 0.42, callCount: Object.values(options.callsByScenario).flat().length },
    residualRiskIds: ["RR-01"],
    panel: null,
    verdict: failing.size > 0 ? "not-demo-ready" : "pending-human",
    pass: false,
  };
}

function call(
  callId: string,
  scenario: string,
  options: { locale?: RatingCallInput["locale"]; baseline?: boolean; hash?: string; text?: string } = {},
): RatingCallInput {
  return {
    callId,
    scenario,
    locale: options.locale ?? "en",
    transcript: [
      { speaker: "caller", text: "Hi, is this Voni?", atMs: 0 },
      { speaker: "agent", text: options.text ?? "Hello, thanks for calling.", atMs: 500 },
    ],
    timeline: [
      { atMs: 0, type: "call-open" },
      { atMs: 500, type: "agent-speech-start" },
      { atMs: 1400, type: "agent-turn-end" },
      { atMs: 3200, type: "call-end" },
    ],
    audio: { path: `calls/${callId}.wav`, sha256: options.hash ?? HASH_A },
    ...(options.baseline
      ? { baseline: { path: `baseline/${callId}.wav`, sha256: HASH_B } }
      : {}),
  };
}

function session(
  options: {
    failing?: readonly string[];
    calls: readonly RatingCallInput[];
    seed?: number;
    reviewer?: string;
    cleanPerLocale?: number;
  },
): RatingSession {
  return buildRatingSession({
    certificate: certificate({
      ...(options.failing ? { failing: options.failing } : {}),
      callsByScenario: Object.fromEntries(
        options.calls.reduce<[string, string[]][]>((groups, entry) => {
          const group = groups.find(([scenario]) => scenario === entry.scenario);
          if (group) group[1].push(entry.callId);
          else groups.push([entry.scenario, [entry.callId]]);
          return groups;
        }, []),
      ),
    }),
    calls: options.calls,
    reviewer: options.reviewer ?? "owner",
    seed: options.seed ?? 7,
    cleanPerLocale: options.cleanPerLocale ?? 2,
    createdAt: "2026-10-31T10:00:00.000Z",
  });
}

function refusal(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RatingError, `expected RatingError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2);
    return true;
  };
}

// ── Blinding ────────────────────────────────────────────────────────────────

test("the blind payload hides the verdict, the model identity and the call identity", () => {
  const built = session({
    failing: ["sad-caller"],
    calls: [call("call-failing", "sad-caller", { baseline: true, text: "I am upset." }), call("call-clean", "booking")],
  });
  const blind = blindSession(built);
  const serialized = JSON.stringify(blind);

  assert.doesNotMatch(serialized, /\b(PASS|FAIL|certified|not-demo-ready|pending-human|ineligible)\b/);
  assert.doesNotMatch(serialized, /model|vendor|provider|buildId|appBuild|pipelineImage/i);
  assert.doesNotMatch(serialized, /callId|scenario|failing|sha256|baseline|agentSide|preferredSide/);
  assert.match(serialized, /I am upset\./, "the transcript is part of playback");
  assert.match(serialized, /call-open/, "the timeline is part of playback");

  const first = blind.queue[0];
  assert.ok(first);
  assert.deepEqual(Object.keys(first).sort(), ["ab", "itemId", "locale", "position", "timeline", "transcript"]);
  assert.deepEqual(first.ab, [{ label: "A" }, { label: "B" }], "the pair names sides, never sources");
});

test("the transcript and timeline are shown, but a missing one is a named refusal", () => {
  const base = call("call-1", "booking");
  const certificateDocument = certificate({ callsByScenario: { booking: ["call-1"] } });
  const common = {
    certificate: certificateDocument,
    reviewer: "owner",
    seed: 1,
    createdAt: "2026-10-31T10:00:00.000Z",
  };

  assert.throws(
    () => buildRatingSession({ ...common, calls: [{ ...base, transcript: [] }] }),
    refusal("missing-transcript", /transcript/),
  );
  assert.throws(
    () => buildRatingSession({ ...common, calls: [{ ...base, timeline: [] }] }),
    refusal("missing-timeline", /timeline/),
  );
  assert.throws(
    () => buildRatingSession({ ...common, calls: [{ ...base, audio: { path: "calls/1.wav", sha256: "short" } }] }),
    refusal("invalid-hash", /sha256/),
  );
});

// ── Ordering and queue completeness ─────────────────────────────────────────

test("order is randomized per session while every failing call stays ahead of the clean sample", () => {
  const calls = [
    call("fail-1", "sad-caller"),
    call("fail-2", "sad-caller"),
    call("fail-3", "sad-caller"),
    call("clean-1", "booking"),
    call("clean-2", "booking"),
    call("clean-3", "booking"),
  ];
  const first = session({ failing: ["sad-caller"], calls, seed: 11, cleanPerLocale: 3 });
  const second = session({ failing: ["sad-caller"], calls, seed: 12, cleanPerLocale: 3 });
  const repeated = session({ failing: ["sad-caller"], calls, seed: 11, cleanPerLocale: 3 });

  assert.deepEqual(
    repeated.queue.map((item) => item.callId),
    first.queue.map((item) => item.callId),
    "the same seed reproduces the same session order",
  );
  assert.notDeepEqual(
    first.queue.map((item) => item.callId),
    second.queue.map((item) => item.callId),
    "a different session seed changes the order",
  );
  assert.notDeepEqual(
    first.queue.map((item) => item.callId),
    calls.map((entry) => entry.callId),
    "the queue is not simply the evidence order",
  );

  const failing = first.queue.filter((item) => item.failing);
  const clean = first.queue.filter((item) => !item.failing);
  assert.equal(failing.length, 3);
  assert.equal(clean.length, 3);
  assert.deepEqual(
    first.queue.slice(0, failing.length).map((item) => item.callId).sort(),
    ["fail-1", "fail-2", "fail-3"],
    "every failing call is queued",
  );
  assert.deepEqual(
    first.queue.slice(failing.length).map((item) => item.callId).sort(),
    ["clean-1", "clean-2", "clean-3"],
  );
  assert.equal(new Set(first.queue.map((item) => item.callId)).size, calls.length, "no call is queued twice");
});

test("a clean sample is drawn per Locale, and every failing call is still included", () => {
  const calls = [
    call("en-fail", "sad-caller", { locale: "en" }),
    call("en-clean-1", "booking", { locale: "en" }),
    call("en-clean-2", "booking", { locale: "en" }),
    call("en-clean-3", "booking", { locale: "en" }),
    call("es-clean-1", "saludo", { locale: "es" }),
    call("es-clean-2", "saludo", { locale: "es" }),
  ];
  const built = session({ failing: ["sad-caller"], calls, seed: 3, cleanPerLocale: 2 });

  assert.equal(built.queue.length, 5, "one failing call plus two clean calls per Locale");
  const clean = built.queue.filter((item) => !item.failing);
  assert.equal(clean.filter((item) => item.locale === "en").length, 2);
  assert.equal(clean.filter((item) => item.locale === "es").length, 2);
  assert.ok(built.queue.find((item) => item.callId === "en-fail"));

  const noClean = session({ failing: ["sad-caller"], calls, seed: 3, cleanPerLocale: 0 });
  assert.deepEqual(noClean.queue.map((item) => item.callId), ["en-fail"]);
});

test("a grouped clean base larger than the sample refuses, never over-queues", () => {
  const calls = Array.from({ length: 13 }, (_, index) =>
    call(`group-call-${index + 1}`, `group-scenario-${index + 1}`),
  );
  assert.throws(
    () =>
      buildRatingSession({
        certificate: certificate({
          callsByScenario: Object.fromEntries(
            calls.map((entry) => [entry.scenario, [entry.callId]]),
          ),
        }),
        calls,
        reviewer: "owner",
        seed: 7,
        cleanPerLocale: 1,
        cleanPerGroup: 1,
        cleanGroupOf: Object.fromEntries(
          calls.map((entry, index) => [entry.callId, `class-${index + 1}`]),
        ),
        sampleSize: 12,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("sample-overflow", /13 calls.*samples 12/),
  );
});

test("a certificate failure with no call evidence is refused by name, never queued as clean", () => {
  assert.throws(
    () => session({ failing: ["sad-caller"], calls: [call("clean-1", "booking")] }),
    refusal("missing-failing-evidence", /sad-caller/),
  );
  assert.throws(
    () => session({ calls: [call("clean-1", "booking")], cleanPerLocale: 0 }),
    refusal("empty-queue", /measures nothing/),
  );
  assert.throws(
    () =>
      buildRatingSession({
        certificate: certificate({ callsByScenario: { booking: ["call-1"] } }),
        calls: [call("call-1", "booking"), call("extra", "booking")],
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("unknown-call", /extra/),
  );
  assert.throws(
    () =>
      buildRatingSession({
        certificate: certificate({ callsByScenario: { booking: ["call-1", "call-2"] } }),
        calls: [call("call-1", "booking")],
        reviewer: "owner",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("missing-call-evidence", /call-2/),
  );
});

// ── Blind A/B ───────────────────────────────────────────────────────────────

test("the blind A/B pair never reveals which side is the agent", () => {
  const sides = new Set<string>();
  for (let seed = 1; seed <= 24; seed += 1) {
    const built = session({ calls: [call("call-1", "booking", { baseline: true })], seed });
    const item = built.queue[0];
    assert.ok(item?.ab);
    sides.add(item.ab.agentSide);
    assert.notEqual(item.ab.agentSide, item.ab.baselineSide);
    const serialized = JSON.stringify(blindSession(built));
    assert.doesNotMatch(serialized, new RegExp(item.ab.agentSide === "A" ? "baselineSide" : "agentSide"));
    assert.doesNotMatch(serialized, new RegExp(HASH_B));
  }
  assert.deepEqual([...sides].sort(), ["A", "B"], "the agent side is randomized, not fixed");
});

test("a call without a baseline has no A/B pair, and an A/B answer on it is refused", () => {
  const built = session({ calls: [call("call-1", "booking")] });
  assert.equal(built.queue[0]?.ab, null);
  assert.equal(blindSession(built).queue[0]?.ab, null);

  assert.throws(
    () =>
      fileRating(
        built,
        {
          itemId: built.queue[0]!.itemId,
          axes: Object.fromEntries(RATING_AXES.map((axis) => [axis.id, 4])),
          humanSide: "A",
        },
        "2026-10-31T10:05:00.000Z",
      ),
    refusal("unexpected-ab-answer", /A\/B pair/),
  );
});

// ── Seven axes and attribution ──────────────────────────────────────────────

const ALL_AXES = Object.fromEntries(RATING_AXES.map((axis) => [axis.id, 4]));

test("a rating needs all seven axes, a session and a reviewer", () => {
  const built = session({ calls: [call("call-1", "booking")] });
  const itemId = built.queue[0]!.itemId;

  assert.equal(RATING_AXES.length, 7);
  assert.throws(
    () => fileRating(built, { itemId, axes: Object.fromEntries(RATING_AXES.slice(0, 6).map((axis) => [axis.id, 4])) }, "2026-10-31T10:05:00.000Z"),
    refusal("missing-axis", new RegExp(RATING_AXES[6].id)),
  );
  assert.throws(
    () => fileRating(built, { itemId, axes: { ...ALL_AXES, extra: 4 } }, "2026-10-31T10:05:00.000Z"),
    refusal("unknown-axis", /extra/),
  );
  assert.throws(
    () => fileRating(built, { itemId, axes: { ...ALL_AXES, [RATING_AXES[0].id]: 0 } }, "2026-10-31T10:05:00.000Z"),
    refusal("invalid-axis-score", /1–5|1-5/),
  );

  const rated = fileRating(
    built,
    {
      itemId,
      axes: ALL_AXES,
      freeText: "  The greeting felt rushed.  ",
      defectTags: ["rushed-greeting", "dead-air"],
    },
    "2026-10-31T10:05:00.000Z",
  );
  assert.equal(rated.sessionId, built.sessionId);
  assert.equal(rated.reviewer, "owner");
  assert.equal(rated.ratedAt, "2026-10-31T10:05:00.000Z");
  assert.deepEqual(rated.axes, ALL_AXES);
  assert.equal(rated.freeText, "The greeting felt rushed.");
  assert.deepEqual(rated.defectTags, ["rushed-greeting", "dead-air"]);
  assert.equal(rated.callId, "call-1");

  assert.throws(
    () => fileRating(built, { itemId, axes: ALL_AXES, defectTags: [" "] }, "2026-10-31T10:05:00.000Z"),
    refusal("invalid-defect-tag", /defect tag/),
  );
});

test("an A/B answer is required when a pair exists and becomes a detection and a preference", () => {
  const built = session({ calls: [call("call-1", "booking", { baseline: true })] });
  const item = built.queue[0]!;
  const itemId = item.itemId;

  assert.throws(
    () => fileRating(built, { itemId, axes: ALL_AXES }, "2026-10-31T10:05:00.000Z"),
    refusal("missing-ab-answer", /A\/B/),
  );

  const pickedHuman = item.ab!.baselineSide;
  const rated = fileRating(
    built,
    { itemId, axes: ALL_AXES, humanSide: pickedHuman, preferredSide: item.ab!.agentSide },
    "2026-10-31T10:05:00.000Z",
  );
  assert.equal(rated.humanDetected, true, "picking the baseline side is a correct human detection");
  assert.equal(rated.preference, "agent");
  assert.equal(rated.humanSide, pickedHuman);
});

test("the session carries the evaluator and date the certificate signature needs", () => {
  const built = session({ calls: [call("call-1", "booking")], reviewer: "owner" });
  assert.equal(built.reviewer, "owner");
  assert.equal(built.createdAt, "2026-10-31T10:00:00.000Z");
  assert.equal(built.date, "2026-10-31");
  assert.match(built.sessionId, /^rating-[0-9a-f]{64}$/);
  assert.deepEqual(signatureReference(built), {
    sessionId: built.sessionId,
    reviewer: "owner",
    signedAt: "2026-10-31",
  });
  assert.throws(
    () =>
      buildRatingSession({
        certificate: certificate({ callsByScenario: { booking: ["call-1"] } }),
        calls: [call("call-1", "booking")],
        reviewer: "  ",
        seed: 1,
        createdAt: "2026-10-31T10:00:00.000Z",
      }),
    refusal("missing-reviewer", /reviewer/),
  );
});

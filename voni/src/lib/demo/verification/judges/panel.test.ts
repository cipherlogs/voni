import test from "node:test";
import assert from "node:assert/strict";

import { JudgeError } from "./errors";
import {
  AGENT_VENDOR,
  assertJudgeIndependence,
  createJudgePanel,
  reconcileCall,
  scoreIndependently,
} from "./panel";
import { rubricHash, validateRubric } from "./rubric";
import type {
  GroundedTranscript,
  JudgeIdentity,
  JudgeScore,
  MachineJudge,
  Rubric,
} from "./types";

/**
 * The two-judge panel: transcript grounding, independent scoring, vendor
 * independence and the escalation ladder. Every score below is synthetic;
 * the transcript turns are the only ground truth a judge may cite.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging".
 */

const RUBRIC: Rubric = {
  id: "demo-seven-axes",
  axes: [
    { id: "sounds-human", question: "Does the agent sound human?" },
    { id: "turn-taking", question: "Does turn-taking feel natural?" },
  ],
};

const TRANSCRIPT: GroundedTranscript = {
  callId: "call-1",
  turns: [
    { id: "t1", speaker: "caller", text: "Hi, I'm calling about a flat.", startMs: 0, endMs: 900 },
    { id: "t2", speaker: "agent", text: "Of course — which area?", startMs: 1200, endMs: 2600 },
    { id: "t3", speaker: "caller", text: "Camden.", startMs: 2800, endMs: 3300 },
  ],
};

const FIRST: JudgeIdentity = { id: "judge-a", vendor: "anthropic", model: "model-a" };
const SECOND: JudgeIdentity = { id: "judge-b", vendor: "openai", model: "model-b" };

function score(
  judgeId: string,
  values: Record<string, number>,
  citations: readonly string[] = ["t2"],
  callId = "call-1",
): JudgeScore {
  return { judgeId, callId, scores: values, citations };
}

function fixedJudge(identity: JudgeIdentity, values: Record<string, number>): MachineJudge {
  return { identity, score: () => score(identity.id, values) };
}

test("the agent's vendor is Meta, and a judge on it is refused by name", () => {
  assert.equal(AGENT_VENDOR, "meta");

  assert.throws(
    () =>
      createJudgePanel({
        judges: [
          fixedJudge({ id: "judge-meta", vendor: "Meta", model: "meta-model" }, {}),
          fixedJudge(SECOND, {}),
        ],
      }),
    (error: unknown) =>
      error instanceof JudgeError &&
      error.code === "vendor-collision" &&
      /judge-meta/.test(error.message) &&
      /meta/i.test(error.message),
  );
});

test("a judge with no recorded vendor is refused, never assumed independent", () => {
  assert.throws(
    () => assertJudgeIndependence([{ id: "judge-x", vendor: "  ", model: "m" }]),
    (error: unknown) => error instanceof JudgeError && error.code === "vendor-unknown",
  );
  assert.throws(
    () => assertJudgeIndependence([{ id: "judge-x", vendor: "unknown", model: "m" }]),
    (error: unknown) => error instanceof JudgeError && error.code === "vendor-unknown",
  );
});

test("a panel needs two distinct independent judges", () => {
  assert.throws(
    () => createJudgePanel({ judges: [fixedJudge(FIRST, {})] }),
    (error: unknown) => error instanceof JudgeError && error.code === "panel-incomplete",
  );
  assert.throws(
    () =>
      createJudgePanel({
        judges: [fixedJudge(FIRST, {}), fixedJudge(FIRST, {})],
      }),
    (error: unknown) => error instanceof JudgeError && error.code === "duplicate-judge",
  );
});

test("two judges score the same grounded transcript independently", async () => {
  const seen: { judge: string; callId: string; turns: string[] }[] = [];
  function judge(identity: JudgeIdentity, values: Record<string, number>): MachineJudge {
    return {
      identity,
      score: ({ transcript }) => {
        seen.push({
          judge: identity.id,
          callId: transcript.callId,
          turns: transcript.turns.map((turn) => turn.id),
        });
        return score(identity.id, values);
      },
    };
  }

  const pair = await scoreIndependently({
    transcript: TRANSCRIPT,
    rubric: RUBRIC,
    judges: [
      judge(FIRST, { "sounds-human": 4, "turn-taking": 5 }),
      judge(SECOND, { "sounds-human": 5, "turn-taking": 4 }),
    ],
  });

  assert.deepEqual(pair, {
    callId: "call-1",
    first: score(FIRST.id, { "sounds-human": 4, "turn-taking": 5 }),
    second: score(SECOND.id, { "sounds-human": 5, "turn-taking": 4 }),
  });
  assert.equal(seen.length, 2, "each judge scored exactly once");
  assert.deepEqual(seen.map((entry) => entry.judge), ["judge-a", "judge-b"]);
  assert.ok(seen.every((entry) => entry.callId === "call-1"));
  assert.ok(seen.every((entry) => entry.turns.join(",") === "t1,t2,t3"));
});

test("a judge that does not cite a real turn is refused as ungrounded", async () => {
  await assert.rejects(
    scoreIndependently({
      transcript: TRANSCRIPT,
      rubric: RUBRIC,
      judges: [
        fixedJudge(FIRST, { "sounds-human": 4, "turn-taking": 4 }),
        { identity: SECOND, score: () => score(SECOND.id, { "sounds-human": 4, "turn-taking": 4 }, ["t9"]) },
      ],
    }),
    (error: unknown) =>
      error instanceof JudgeError &&
      error.code === "ungrounded-score" &&
      /judge-b/.test(error.message) &&
      /t9/.test(error.message),
  );

  await assert.rejects(
    scoreIndependently({
      transcript: TRANSCRIPT,
      rubric: RUBRIC,
      judges: [
        fixedJudge(FIRST, { "sounds-human": 4, "turn-taking": 4 }),
        { identity: SECOND, score: () => score(SECOND.id, { "sounds-human": 4, "turn-taking": 4 }, []) },
      ],
    }),
    (error: unknown) => error instanceof JudgeError && error.code === "ungrounded-score",
  );
});

test("a score must cover every axis on the 1-5 scale and belong to its judge", async () => {
  const base = { "sounds-human": 4, "turn-taking": 4 };
  for (const [values, code] of [
    [{ "sounds-human": 4 }, "invalid-score"],
    [{ ...base, extra: 4 }, "invalid-score"],
    [{ ...base, "turn-taking": 6 }, "invalid-score"],
    [{ ...base, "turn-taking": 3.5 }, "invalid-score"],
    [{ ...base, "turn-taking": "4" }, "invalid-score"],
  ] as const) {
    await assert.rejects(
      scoreIndependently({
        transcript: TRANSCRIPT,
        rubric: RUBRIC,
        judges: [
          fixedJudge(FIRST, base),
          { identity: SECOND, score: () => score(SECOND.id, values as unknown as Record<string, number>) },
        ],
      }),
      (error: unknown) => error instanceof JudgeError && error.code === code,
    );
  }

  await assert.rejects(
    scoreIndependently({
      transcript: TRANSCRIPT,
      rubric: RUBRIC,
      judges: [
        fixedJudge(FIRST, base),
        { identity: SECOND, score: () => score("someone-else", base) },
      ],
    }),
    (error: unknown) =>
      error instanceof JudgeError && error.code === "judge-mismatch" && /someone-else/.test(error.message),
  );

  await assert.rejects(
    scoreIndependently({
      transcript: TRANSCRIPT,
      rubric: RUBRIC,
      judges: [
        fixedJudge(FIRST, base),
        { identity: SECOND, score: () => score(SECOND.id, base, ["t2"], "call-2") },
      ],
    }),
    (error: unknown) => error instanceof JudgeError && error.code === "call-mismatch",
  );
});

test("an empty or malformed transcript is refused, never judged", async () => {
  await assert.rejects(
    scoreIndependently({
      transcript: { callId: "call-1", turns: [] },
      rubric: RUBRIC,
      judges: [fixedJudge(FIRST, {}), fixedJudge(SECOND, {})],
    }),
    (error: unknown) => error instanceof JudgeError && error.code === "invalid-transcript",
  );

  await assert.rejects(
    scoreIndependently({
      transcript: {
        callId: "call-1",
        turns: [
          { id: "t1", speaker: "caller", text: "a", startMs: 0, endMs: 10 },
          { id: "t1", speaker: "agent", text: "b", startMs: 20, endMs: 30 },
        ],
      },
      rubric: RUBRIC,
      judges: [fixedJudge(FIRST, {}), fixedJudge(SECOND, {})],
    }),
    (error: unknown) =>
      error instanceof JudgeError && error.code === "invalid-transcript" && /t1/.test(error.message),
  );
});

test("a one-point difference is agreement; the call is not escalated", () => {
  const result = reconcileCall({
    callId: "call-1",
    rubric: RUBRIC,
    first: score(FIRST.id, { "sounds-human": 4, "turn-taking": 5 }),
    second: score(SECOND.id, { "sounds-human": 5, "turn-taking": 4 }),
  });

  assert.equal(result.state, "agreed");
  assert.deepEqual(result.unresolvedAxes, []);
  assert.deepEqual(result.final, { "sounds-human": 4.5, "turn-taking": 4.5 });
});

test("a disagreement above one point escalates to a third judge", () => {
  const result = reconcileCall({
    callId: "call-1",
    rubric: RUBRIC,
    first: score(FIRST.id, { "sounds-human": 5, "turn-taking": 4 }),
    second: score(SECOND.id, { "sounds-human": 3, "turn-taking": 4 }),
    third: score("judge-c", { "sounds-human": 4, "turn-taking": 4 }),
  });

  assert.equal(result.state, "escalated");
  assert.equal(result.unresolvedAxes.length, 0);
  assert.equal(result.final?.["sounds-human"], 4, "the bridging third score resolves the axis");
  assert.equal(result.final?.["turn-taking"], 4);
  const disputed = result.axes.find((axis) => axis.axis === "sounds-human");
  assert.deepEqual(
    { first: disputed?.first, second: disputed?.second, third: disputed?.third, resolved: disputed?.resolved },
    { first: 5, second: 3, third: 4, resolved: true },
  );
});

test("without a third judge the disagreement goes to the panel and has no final score", () => {
  const result = reconcileCall({
    callId: "call-1",
    rubric: RUBRIC,
    first: score(FIRST.id, { "sounds-human": 5, "turn-taking": 4 }),
    second: score(SECOND.id, { "sounds-human": 3, "turn-taking": 4 }),
  });

  assert.equal(result.state, "panel");
  assert.equal(result.final, null, "an unresolved call may never carry a machine score");
  assert.deepEqual(result.unresolvedAxes, ["sounds-human"]);
  assert.match(result.detail, /panel/);
});

test("a third judge that does not bridge both scores still goes to the panel", () => {
  const result = reconcileCall({
    callId: "call-1",
    rubric: RUBRIC,
    first: score(FIRST.id, { "sounds-human": 5, "turn-taking": 4 }),
    second: score(SECOND.id, { "sounds-human": 3, "turn-taking": 4 }),
    third: score("judge-c", { "sounds-human": 5, "turn-taking": 4 }),
  });

  assert.equal(result.state, "panel");
  assert.equal(result.final, null);
  assert.deepEqual(result.unresolvedAxes, ["sounds-human"]);
});

test("one disputed axis blocks the whole call, even when the others agree", () => {
  const result = reconcileCall({
    callId: "call-1",
    rubric: RUBRIC,
    first: score(FIRST.id, { "sounds-human": 5, "turn-taking": 5 }),
    second: score(SECOND.id, { "sounds-human": 3, "turn-taking": 5 }),
    third: score("judge-c", { "sounds-human": 3, "turn-taking": 5 }),
  });

  assert.equal(result.state, "panel");
  assert.equal(result.final, null);
  assert.deepEqual(result.unresolvedAxes, ["sounds-human"]);
});

test("the third judge must be a third judge, not one of the first two", () => {
  assert.throws(
    () =>
      reconcileCall({
        callId: "call-1",
        rubric: RUBRIC,
        first: score(FIRST.id, { "sounds-human": 5, "turn-taking": 4 }),
        second: score(SECOND.id, { "sounds-human": 3, "turn-taking": 4 }),
        third: score(FIRST.id, { "sounds-human": 4, "turn-taking": 4 }),
      }),
    (error: unknown) => error instanceof JudgeError && error.code === "duplicate-judge",
  );
});

test("the rubric hash moves when any axis changes, and a duplicate axis is refused", () => {
  assert.equal(rubricHash(RUBRIC), rubricHash(structuredClone(RUBRIC)));

  const reworded: Rubric = {
    ...RUBRIC,
    axes: [
      { ...RUBRIC.axes[0], question: "Does the agent sound like a person?" },
      RUBRIC.axes[1],
    ],
  };
  assert.notEqual(rubricHash(reworded), rubricHash(RUBRIC), "a rubric change invalidates calibration");

  const added: Rubric = {
    ...RUBRIC,
    axes: [...RUBRIC.axes, { id: "understanding", question: "Did it understand?" }],
  };
  assert.notEqual(rubricHash(added), rubricHash(RUBRIC));

  assert.throws(
    () =>
      validateRubric({
        id: "bad",
        axes: [
          { id: "same", question: "a" },
          { id: "same", question: "b" },
        ],
      }),
    (error: unknown) => error instanceof JudgeError && error.code === "invalid-rubric",
  );
  assert.throws(
    () => validateRubric({ id: "", axes: [] }),
    (error: unknown) => error instanceof JudgeError && error.code === "invalid-rubric",
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { SCOREBOARD_BUDGETS } from "../../scoreboard-budgets";
import { loadContract } from "../contract";
import { evaluateScenarios } from "../verdict/evaluators";
import { judgeProperty, judgeRun } from "../verdict/judge";
import humanEvaluators from "../verdict/evaluators/human.evaluators";
import { calibrate } from "./calibration";
import { rubricHash } from "./rubric";
import type {
  CalibrationItem,
  CalibrationRecord,
  CalibrationTable,
  JudgeIdentity,
  Rubric,
} from "./types";

/**
 * Calibration against panel gold labels. The two known tables below are worked
 * by hand in `kappa.test.ts`: 219/253 is above the 0.65 bar, 11/21 is below it.
 * A below-bar or incomparable judge makes the verdict unverified; the run then
 * fails closed through H6.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging", H6.
 */

const RUBRIC: Rubric = {
  id: "demo-seven-axes",
  axes: [
    { id: "sounds-human", question: "Does the agent sound human?" },
    { id: "turn-taking", question: "Does turn-taking feel natural?" },
  ],
};

const FIRST: JudgeIdentity = { id: "judge-a", vendor: "anthropic", model: "model-a" };
const SECOND: JudgeIdentity = { id: "judge-b", vendor: "openai", model: "model-b" };

/** Above the bar: kappa 219/253 = 0.8656. */
const ABOVE: CalibrationTable = [
  [10, 1, 0],
  [1, 10, 1],
  [0, 1, 10],
];

/** Below the bar: kappa 11/21 = 0.5238. */
const BELOW: CalibrationTable = [
  [2, 1, 0],
  [1, 2, 1],
  [0, 1, 2],
];

const AXES = RUBRIC.axes.map((axis) => axis.id);

/**
 * Expand a counts table into calibration items for every judge and axis. The
 * call ids are shared by the judges: the same call is rated by both.
 */
function itemsFor(
  judges: readonly JudgeIdentity[],
  axes: readonly string[],
  tableFor: (judge: JudgeIdentity, axis: string) => CalibrationTable,
): CalibrationItem[] {
  const items: CalibrationItem[] = [];
  for (const axis of axes) {
    for (const judge of judges) {
      const rows = tableFor(judge, axis);
      const cells: { score: number; gold: number }[] = [];
      rows.forEach((row, scoreIndex) => {
        row.forEach((count, goldIndex) => {
          for (let n = 0; n < count; n += 1) {
            cells.push({ score: scoreIndex + 1, gold: goldIndex + 1 });
          }
        });
      });
      cells.forEach((cell, index) => {
        items.push({
          callId: `${axis}-call-${index}`,
          axis,
          judgeId: judge.id,
          score: cell.score,
          gold: cell.gold,
        });
      });
    }
  }
  return items;
}

function record(
  judges: readonly JudgeIdentity[],
  tableFor: (judge: JudgeIdentity, axis: string) => CalibrationTable,
  rubric: Rubric = RUBRIC,
): CalibrationRecord {
  return {
    rubricHash: rubricHash(rubric),
    judges,
    items: itemsFor(judges, AXES, tableFor),
  };
}

const above = () => ABOVE;
const below = () => BELOW;

test("the kappa bar is the frozen H6 number 0.65, not a local constant", () => {
  assert.equal(SCOREBOARD_BUDGETS.dvJudgeKappaMin.value, 0.65);
  assert.equal(SCOREBOARD_BUDGETS.dvJudgeKappaMin.gate, "contract/H6");

  const verdict = calibrate({
    rubric: RUBRIC,
    record: record([FIRST, SECOND], above),
  });
  assert.equal(verdict.minKappa, 0.65);
});

test("two judges above the bar are verified against gold labels", () => {
  const verdict = calibrate({
    rubric: RUBRIC,
    record: record([FIRST, SECOND], above),
  });

  assert.equal(verdict.status, "verified");
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.kappas.length, 4, "two judges x two axes");
  for (const kappa of verdict.kappas) {
    assert.equal(kappa, 219 / 253);
  }
  assert.equal(verdict.axes.length, 4);
  assert.ok(verdict.axes.every((axis) => !axis.belowBar && axis.kappa === 219 / 253));
  assert.equal(verdict.rubricHash, rubricHash(RUBRIC));
  assert.match(verdict.detail, /verified/);
});

test("a below-bar kappa is unverified and names the bar and the judge", () => {
  const verdict = calibrate({
    rubric: RUBRIC,
    record: record([FIRST, SECOND], below),
  });

  assert.equal(verdict.status, "unverified");
  assert.equal(verdict.kappas.length, 4);
  for (const kappa of verdict.kappas) {
    assert.equal(kappa, 11 / 21);
  }
  const reason = verdict.reasons.join(" ");
  assert.match(reason, /judge-a/);
  assert.match(reason, /sounds-human/);
  assert.match(reason, /0\.5238/);
  assert.match(reason, /0\.65/);
  assert.match(verdict.detail, /unverified/);
});

test("one below-bar judge is enough to refuse the whole panel", () => {
  const verdict = calibrate({
    rubric: RUBRIC,
    record: record([FIRST, SECOND], (judge) => (judge.id === FIRST.id ? above() : below())),
  });

  assert.equal(verdict.status, "unverified");
  assert.ok(verdict.reasons.some((reason) => /judge-b/.test(reason)));
  assert.ok(!verdict.reasons.some((reason) => /judge-a/.test(reason) && /below/.test(reason)));
});

test("a changed rubric invalidates prior calibration, even when kappa is high", () => {
  const changed: Rubric = {
    ...RUBRIC,
    axes: [
      { ...RUBRIC.axes[0], question: "Does the agent sound like a person?" },
      RUBRIC.axes[1],
    ],
  };
  const verdict = calibrate({
    rubric: changed,
    record: record([FIRST, SECOND], above),
  });

  assert.equal(verdict.status, "unverified");
  assert.notEqual(verdict.rubricHash, record([FIRST, SECOND], above).rubricHash);
  assert.match(verdict.reasons.join(" "), /rubric/i);
  assert.deepEqual(verdict.kappas, [], "a stale rubric yields no trustworthy kappa");
});

test("calibration is refused when a judge, axis or pair is missing", () => {
  const complete = record([FIRST, SECOND], above);

  const single = calibrate({
    rubric: RUBRIC,
    record: { ...complete, judges: [FIRST], items: complete.items.filter((item) => item.judgeId === FIRST.id) },
  });
  assert.equal(single.status, "unverified");
  assert.match(single.reasons.join(" "), /two judges/i);

  const missingAxis = calibrate({
    rubric: RUBRIC,
    record: {
      ...complete,
      items: complete.items.filter((item) => !(item.judgeId === SECOND.id && item.axis === "turn-taking")),
    },
  });
  assert.equal(missingAxis.status, "unverified");
  assert.match(missingAxis.reasons.join(" "), /turn-taking/);

  const duplicate = calibrate({
    rubric: RUBRIC,
    record: { ...complete, items: [...complete.items, complete.items[0]] },
  });
  assert.equal(duplicate.status, "unverified");
  assert.match(duplicate.reasons.join(" "), /twice|duplicate/i);
});

test("a judge on the agent's vendor is refused before calibration", () => {
  const metaJudge = { id: "judge-meta", vendor: "Meta", model: "meta-model" };
  const verdict = calibrate({
    rubric: RUBRIC,
    record: record([metaJudge, SECOND], above),
  });

  assert.equal(verdict.status, "unverified");
  assert.match(verdict.reasons.join(" "), /judge-meta/);
  assert.match(verdict.reasons.join(" "), /vendor/i);
});

test("an uninformative sample has no kappa and is unverified", () => {
  const flat: CalibrationTable = [
    [0, 0, 0],
    [0, 5, 0],
    [0, 0, 0],
  ];
  const verdict = calibrate({
    rubric: RUBRIC,
    record: record([FIRST, SECOND], () => flat),
  });

  assert.equal(verdict.status, "unverified");
  assert.match(verdict.reasons.join(" "), /no defined kappa|undefined|uninformative/i);
});

test("H6 passes only above the bar and fails the run below it", async () => {
  const contract = await loadContract();
  const h6 = contract.properties.find((property) => property.id === "H6");
  assert.ok(h6, "H6 is in the contract");
  if (h6 === undefined) throw new Error("H6 is in the contract");
  const h6Entry = h6;
  assert.equal(h6.unresolved, undefined, "ticket 26 owns H6 now; it is resolved");

  async function evidenceFor(table: (judge: JudgeIdentity, axis: string) => CalibrationTable) {
    const calibration = record([FIRST, SECOND], table);
    const attempts = [1, 2, 3].map((repetition) => ({
      scenario: "calibration",
      repetition,
      evidence: { judge: { rubric: RUBRIC, calibration } },
    }));
    return evaluateScenarios({
      contract: { families: [], properties: [h6Entry] },
      evaluators: humanEvaluators.evaluators,
      attempts,
    });
  }

  const good = await evidenceFor(above);
  const goodVerdict = judgeProperty(h6, good[0]);
  assert.equal(goodVerdict.status, "PASS");
  assert.equal(goodVerdict.reason, "pass");
  assert.ok(goodVerdict.sampleCount > 0);

  const run = judgeRun({
    runId: "calibration-run",
    contract: { families: [], properties: [h6Entry] },
    evidence: good,
  });
  assert.equal(run.verdict, "certified");
  assert.equal(run.certifiable, true);

  const bad = await evidenceFor(below);
  const badVerdict = judgeProperty(h6, bad[0]);
  assert.equal(badVerdict.status, "FAIL");
  assert.equal(badVerdict.reason, "unmeasured");
  assert.match(badVerdict.detail, /0\.5238|below|unverified/i);

  const refused = judgeRun({
    runId: "calibration-run",
    contract: { families: [], properties: [h6Entry] },
    evidence: bad,
  });
  assert.equal(refused.verdict, "not-demo-ready");
  assert.equal(refused.certifiable, false);
});

test("the H6 evaluator refuses malformed judge evidence instead of inventing a pass", async () => {
  const contract = await loadContract();
  const h6 = contract.properties.find((property) => property.id === "H6");
  assert.ok(h6);

  for (const source of [
    undefined,
    {},
    { rubric: RUBRIC },
    { rubric: RUBRIC, calibration: { rubricHash: "stale", judges: [FIRST, SECOND], items: [] } },
    { rubric: RUBRIC, calibration: { rubricHash: rubricHash(RUBRIC), judges: [], items: [] } },
  ]) {
    const evidence = await evaluateScenarios({
      contract: { families: [], properties: [h6] },
      evaluators: humanEvaluators.evaluators,
      attempts: [1, 2, 3].map((repetition) => ({
        scenario: "calibration",
        repetition,
        evidence: { judge: source },
      })),
    });
    const verdict = judgeProperty(h6, evidence[0]);
    assert.equal(verdict.status, "FAIL");
    assert.ok(
      verdict.reason === "unmeasured" || verdict.reason === "missing-evidence",
      `unexpected reason ${verdict.reason}`,
    );
  }
});

test("calibration refuses an unknown axis or rating by name", () => {
  const complete = record([FIRST, SECOND], above);
  const unknownAxis = calibrate({
    rubric: RUBRIC,
    record: { ...complete, items: [...complete.items, { ...complete.items[0], callId: "extra", axis: "mood" }] },
  });
  assert.equal(unknownAxis.status, "unverified");
  assert.match(unknownAxis.reasons.join(" "), /mood/);

  const badRating = calibrate({
    rubric: RUBRIC,
    record: { ...complete, items: [{ ...complete.items[0], callId: "bad", score: 6 }] },
  });
  assert.equal(badRating.status, "unverified");
  assert.match(badRating.reasons.join(" "), /score|rating/i);
});

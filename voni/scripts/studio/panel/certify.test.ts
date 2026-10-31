/**
 * Certification refuses a below-bar judge calibration even when the panel has
 * signed a clean human sample. H6 is ticket 26's gate; the panel may not paper
 * over it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../../../src/lib/demo/verification/contract";
import { evaluateScenarios } from "../../../src/lib/demo/verification/verdict/evaluators";
import humanEvaluators from "../../../src/lib/demo/verification/verdict/evaluators/human.evaluators";
import { judgeRun } from "../../../src/lib/demo/verification/verdict";
import { calibrate } from "../../../src/lib/demo/verification/judges/calibration";
import { rubricHash } from "../../../src/lib/demo/verification/judges/rubric";
import type {
  CalibrationItem,
  CalibrationTable,
  JudgeIdentity,
  Rubric,
} from "../../../src/lib/demo/verification/judges/types";
import { applyPanelVerdict, judgePanel } from "../../../src/lib/demo/verification/panel";
import { certificateExitCode } from "../../../src/lib/demo/verification/certificate";
import { LOCALES } from "../../../src/lib/demo/verification/scenarios/types";
import {
  RUN_ID,
  REVIEWER,
  SESSION_DATE,
  buildSigningCertificate,
  goldLabel,
  goldSet,
  loadHumanContract,
} from "./fixtures";

const RUBRIC: Rubric = {
  id: "demo-seven-axes",
  axes: [
    { id: "sounds-human", question: "Does the agent sound human?" },
    { id: "turn-taking", question: "Does turn-taking feel natural?" },
  ],
};

const FIRST: JudgeIdentity = { id: "judge-a", vendor: "anthropic", model: "model-a" };
const SECOND: JudgeIdentity = { id: "judge-b", vendor: "openai", model: "model-b" };

/** Weighted kappa 11/21 = 0.5238, below the 0.65 H6 bar. */
const BELOW: CalibrationTable = [
  [2, 1, 0],
  [1, 2, 1],
  [0, 1, 2],
];

function items(table: CalibrationTable): CalibrationItem[] {
  const items: CalibrationItem[] = [];
  for (const axis of RUBRIC.axes) {
    for (const judge of [FIRST, SECOND]) {
      const cells: { score: number; gold: number }[] = [];
      table.forEach((row, scoreIndex) => {
        row.forEach((count, goldIndex) => {
          for (let n = 0; n < count; n += 1) {
            cells.push({ score: scoreIndex + 1, gold: goldIndex + 1 });
          }
        });
      });
      cells.forEach((cell, index) => {
        items.push({
          callId: `${axis.id}-call-${index}`,
          axis: axis.id,
          judgeId: judge.id,
          score: cell.score,
          gold: cell.gold,
        });
      });
    }
  }
  return items;
}

const SIGNATURE = {
  sessionId: "rating-" + "a".repeat(64),
  reviewer: REVIEWER,
  signedAt: SESSION_DATE,
  signature: "panel-v1:" + "e".repeat(64),
};

function signedPanel(contract: Awaited<ReturnType<typeof loadContract>>) {
  const labels = [];
  for (const locale of LOCALES) {
    for (let index = 0; index < 40; index += 1) {
      labels.push(goldLabel({ locale, humanDetected: index < 20 ? false : true }));
    }
  }
  return judgePanel(contract, { goldLabels: goldSet(labels), signature: SIGNATURE });
}

test("a below-bar judge calibration refuses to certify a signed clean panel", async () => {
  const contract = await loadHumanContract();
  const h6 = contract.properties.find((property) => property.id === "H6");
  assert.ok(h6);

  const calibration = {
    rubricHash: rubricHash(RUBRIC),
    judges: [FIRST, SECOND],
    items: items(BELOW),
  };
  const verdict = calibrate({ rubric: RUBRIC, record: calibration });
  assert.equal(verdict.status, "unverified");
  assert.ok(verdict.kappas.some((kappa) => kappa < 0.65));

  const evidence = await evaluateScenarios({
    contract: { families: [], properties: [h6] },
    evaluators: humanEvaluators.evaluators,
    attempts: [1, 2, 3].map((repetition) => ({
      scenario: "panel-en",
      repetition,
      evidence: { judge: { rubric: RUBRIC, calibration } },
    })),
  });
  const run = judgeRun({ runId: RUN_ID, contract, evidence });
  assert.equal(run.properties.find((property) => property.propertyId === "H6")?.status, "FAIL");

  const merged = applyPanelVerdict(run, signedPanel(contract));
  const certificate = buildSigningCertificate({ run: merged, panel: SIGNATURE });
  assert.equal(certificate.verdict, "not-demo-ready");
  assert.equal(certificate.pass, false);
  assert.equal(certificateExitCode(certificate.verdict), 1);
  const h6Certificate = certificate.properties.find((property) => property.propertyId === "H6");
  assert.equal(h6Certificate?.status, "FAIL");
  assert.equal(h6Certificate?.reason, "unmeasured");
});

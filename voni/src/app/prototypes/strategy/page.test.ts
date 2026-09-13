import assert from "node:assert/strict";
import test from "node:test";

import {
  authoritySteps,
  capabilities,
  commercialModel,
  discoveryQuestions,
  examples,
  platformLayers,
  roadmap,
  sources,
  stopConditions,
  strategicRisks,
  workflows,
} from "./content";

test("the strategy presentation keeps the complete decision structure", () => {
  assert.equal(capabilities.length, 39);
  assert.deepEqual(new Set(capabilities.map((item) => item.classification)), new Set([
    "Native",
    "Customer-built",
    "Not managed",
    "Needs Voni",
  ]));

  assert.equal(workflows.length, 3);
  assert.equal(workflows[0].name, "Proactive application resolution");
  assert.equal(workflows[0].score, 83);
  assert.ok(workflows[0].score > workflows[1].score);
  assert.ok(workflows[0].score > workflows[2].score);

  assert.equal(examples.length, 3);
  assert.deepEqual(examples.map((example) => example.sector), [
    "Banking",
    "Insurance",
    "Government",
  ]);
  assert.ok(examples.every((example) => example.safePath.length >= 4));
  assert.ok(examples.every((example) => example.humanBoundary.length > 40));

  assert.equal(platformLayers.length, 5);
  assert.deepEqual(authoritySteps.map((step) => step.name), [
    "Propose",
    "Read back",
    "Confirm",
    "Authorize",
    "Execute",
    "Record",
    "Reconcile",
  ]);
  assert.equal(roadmap.length, 4);
  assert.ok(stopConditions.length >= 5);
  assert.equal(commercialModel.length, 5);
  assert.equal(strategicRisks.length, 9);
  assert.equal(discoveryQuestions.length, 14);
  assert.ok(sources.length >= 25);
  assert.ok(sources.every((source) => source.href.startsWith("https://")));
});

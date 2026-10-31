import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../../contract";
import { loadEvaluatorModules, loadEvaluators } from "../evaluators";

/**
 * The Locale evaluators are discovered, not registered twice: the family module
 * `locale.evaluators.ts` owns K5 and K6, and the comprehension module leaves
 * them out. A duplicate would be refused by the registry; this test also proves
 * the Locale core's two properties have an owner at all.
 */

test("K5 and K6 are discovered once, from locale.evaluators.ts", async () => {
  const contract = await loadContract();
  const modules = await loadEvaluatorModules();
  const localeModule = modules.find((entry) => entry.path === "locale.evaluators.ts");
  assert.ok(localeModule, "locale.evaluators.ts is not discovered");
  assert.equal(localeModule.module.family, "comprehension");
  assert.deepEqual(
    localeModule.module.evaluators.map((evaluator) => evaluator.propertyId).sort(),
    ["K5", "K6"],
  );

  const evaluators = await loadEvaluators(contract);
  for (const propertyId of ["K5", "K6"]) {
    const owners = evaluators.filter((evaluator) => evaluator.propertyId === propertyId);
    assert.equal(owners.length, 1, `${propertyId} has ${owners.length} owners`);
    assert.equal(owners[0]?.source, "verdict/evaluators/comprehension.evaluators.ts");
  }
});

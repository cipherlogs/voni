import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Contract, ContractPropertyEntry, ResolvedThreshold } from "../contract";
import { judgeProperty } from "./judge";
import {
  buildEvaluatorRegistry,
  evaluateScenarios,
  loadEvaluatorModules,
  type DiscoveredEvaluatorModule,
} from "./evaluators";
import { VerdictError } from "./errors";
import type {
  BarBinding,
  EvaluatorModule,
  PropertyEvaluator,
  ScenarioAttempt,
} from "./types";

/**
 * Discovery and the failure paths. A family ticket adds `*.evaluators.ts` and
 * is picked up; a duplicate or an unknown id is refused by name; a missing
 * source, a thrown evaluator or a retry never becomes a pass.
 */

const P50: ResolvedThreshold = { source: "budget-record", key: "p50", value: 350, unit: "ms" };
const P95: ResolvedThreshold = { source: "budget-record", key: "p95", value: 700, unit: "ms" };
const MAX: ResolvedThreshold = { source: "budget-record", key: "max", value: 1200, unit: "ms" };
const BARS: readonly BarBinding[] = [
  { key: "p50", statistic: "p50", comparison: "at-most" },
  { key: "p95", statistic: "p95", comparison: "at-most" },
  { key: "max", statistic: "max", comparison: "at-most" },
];

const T1: ContractPropertyEntry = {
  id: "T1",
  family: "turn-taking",
  statement: "First response",
  bar: { text: "p50 <= 350 ms, p95 <= 700 ms, max 1.2 s", numeric: true },
  evidence: "ledger",
  kind: "timing",
  repetitions: 3,
  thresholds: [P50, P95, MAX],
};

const C9: ContractPropertyEntry = {
  id: "C9",
  family: "conduct",
  statement: "Are you AI?",
  bar: { text: "pass", numeric: false },
  evidence: "ledger",
  kind: "behaviour",
  repetitions: 3,
  thresholds: [],
};

function probeContract(properties: readonly ContractPropertyEntry[]): Contract {
  return {
    families: [{ id: "turn-taking", title: "probe", propertyCount: 1 }],
    properties,
  };
}

function evaluator(overrides: Partial<PropertyEvaluator> = {}): PropertyEvaluator {
  return {
    propertyId: "T1",
    bars: BARS,
    source: "probe.evaluators.ts",
    evaluate: () => ({ kind: "measured", samples: [100], citations: ["probe"] }),
    ...overrides,
  };
}

function moduleOf(
  family: EvaluatorModule["family"],
  evaluators: readonly PropertyEvaluator[],
  path = "probe.evaluators.ts",
): DiscoveredEvaluatorModule {
  return { path, module: { family, evaluators } };
}

function assertRefusal(run: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof VerdictError, `expected VerdictError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    return true;
  });
}

function attempt(
  scenario: string,
  repetition: number,
  evidence: ScenarioAttempt["evidence"] = { ledger: { rows: [] } },
): ScenarioAttempt {
  return { scenario, repetition, evidence };
}

function moduleSource(propertyId: string): string {
  return `
const evaluators = [{
  propertyId: ${JSON.stringify(propertyId)},
  bars: [
    { key: "p50", statistic: "p50", comparison: "at-most" },
    { key: "p95", statistic: "p95", comparison: "at-most" },
    { key: "max", statistic: "max", comparison: "at-most" },
  ],
  evaluate: () => ({ kind: "measured", samples: [100], citations: ["probe"] }),
}];
export default { family: "turn-taking", evaluators };
`;
}

test("discovery imports every *.evaluators.ts module and ignores other files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dv07-discovery-"));
  writeFileSync(join(dir, "turn-taking.evaluators.ts"), moduleSource("T1"));
  writeFileSync(join(dir, "notes.md"), "not a module");
  writeFileSync(join(dir, "helper.ts"), "export default 1;");

  const modules = await loadEvaluatorModules(dir);
  assert.equal(modules.length, 1);
  assert.match(modules[0].path, /turn-taking\.evaluators\.ts$/);
  assert.equal(modules[0].module.family, "turn-taking");
  assert.equal(modules[0].module.evaluators[0].propertyId, "T1");
});

test("a family module discovered by file is usable by the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dv07-registry-"));
  writeFileSync(join(dir, "turn-taking.evaluators.ts"), moduleSource("T1"));
  const modules = await loadEvaluatorModules(dir);
  const registry = buildEvaluatorRegistry(modules, probeContract([T1]));
  assert.equal(registry.length, 1);
  assert.equal(registry[0].propertyId, "T1");
});

test("two evaluators for one property id are refused by name", () => {
  assertRefusal(
    () =>
      buildEvaluatorRegistry(
        [
          moduleOf("turn-taking", [evaluator()], "one.evaluators.ts"),
          moduleOf("turn-taking", [evaluator({ source: "two.evaluators.ts" })], "two.evaluators.ts"),
        ],
        probeContract([T1]),
      ),
    "duplicate-evaluator",
    /"T1"/,
  );
});

test("an evaluator for an unknown property is refused by name", () => {
  assertRefusal(
    () =>
      buildEvaluatorRegistry(
        [moduleOf("turn-taking", [evaluator({ propertyId: "ZZ9" })])],
        probeContract([T1]),
      ),
    "unknown-property",
    /"ZZ9"/,
  );
});

test("an evaluator that binds a key the contract does not own is refused by name", () => {
  assertRefusal(
    () =>
      buildEvaluatorRegistry(
        [
          moduleOf("turn-taking", [
            evaluator({
              bars: [
                { key: "p50", statistic: "p50", comparison: "at-most" },
                { key: "p95", statistic: "p95", comparison: "at-most" },
                { key: "max", statistic: "max", comparison: "at-most" },
                { key: "made-up", statistic: "max", comparison: "at-most" },
              ],
            }),
          ]),
        ],
        probeContract([T1]),
      ),
    "unknown-bar",
    /"made-up"/,
  );
});

test("a numeric bar left unbound is refused by name", () => {
  assertRefusal(
    () =>
      buildEvaluatorRegistry(
        [
          moduleOf("turn-taking", [
            evaluator({
              bars: [
                { key: "p50", statistic: "p50", comparison: "at-most" },
                { key: "p95", statistic: "p95", comparison: "at-most" },
              ],
            }),
          ]),
        ],
        probeContract([T1]),
      ),
    "missing-bar-binding",
    /"max"/,
  );
});

test("a categorical property may not bind a numeric threshold", () => {
  assertRefusal(
    () =>
      buildEvaluatorRegistry(
        [
          moduleOf(
            "conduct",
            [evaluator({ propertyId: "C9", bars: BARS })],
          ),
        ],
        probeContract([C9]),
      ),
    "bars-on-categorical-property",
    /"C9"/,
  );
});

test("an evaluator filed under the wrong family is refused by name", () => {
  assertRefusal(
    () =>
      buildEvaluatorRegistry(
        [moduleOf("conduct", [evaluator()])],
        probeContract([T1]),
      ),
    "family-mismatch",
    /"T1"/,
  );
});

test("an empty family module is refused, not silently accepted", () => {
  assertRefusal(
    () => buildEvaluatorRegistry([moduleOf("turn-taking", [])], probeContract([T1])),
    "empty-evaluator-module",
    /turn-taking/,
  );
});

test("evaluateScenarios measures every declared repetition from its evidence source", async () => {
  const calls: string[] = [];
  const contract = probeContract([T1]);
  const evidence = await evaluateScenarios({
    contract,
    evaluators: [
      evaluator({
        evaluate: (context) => {
          calls.push(`${context.scenario}#${context.repetition}`);
          return { kind: "measured", samples: [100 + context.repetition], citations: [`${context.scenario}#${context.repetition}`] };
        },
      }),
    ],
    attempts: [attempt("golden-flow", 1), attempt("golden-flow", 2), attempt("golden-flow", 3)],
  });

  assert.deepEqual(calls, ["golden-flow#1", "golden-flow#2", "golden-flow#3"]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].propertyId, "T1");
  assert.equal(evidence[0].measurements.length, 3);
  assert.equal(judgeProperty(T1, evidence[0]).status, "PASS");
});

test("deterministic properties are measured once even when the scenario is repeated", async () => {
  const calls: number[] = [];
  const contract = probeContract([
    { ...C9, kind: "deterministic", repetitions: 1 },
  ]);
  const evidence = await evaluateScenarios({
    contract,
    evaluators: [
      evaluator({
        propertyId: "C9",
        bars: [],
        evaluate: (context) => {
          calls.push(context.repetition);
          return { kind: "measured", passed: true };
        },
      }),
    ],
    attempts: [attempt("meta", 1), attempt("meta", 2), attempt("meta", 3)],
  });

  assert.deepEqual(calls, [1], "only repetition 1 is judged for a deterministic property");
  assert.equal(evidence[0].measurements.length, 1);
});

test("a missing evidence source is a measurement failure, never a skip", async () => {
  const contract = probeContract([T1]);
  const evidence = await evaluateScenarios({
    contract,
    evaluators: [evaluator()],
    attempts: [attempt("golden-flow", 1, {}), attempt("golden-flow", 2, {}), attempt("golden-flow", 3, {})],
  });

  assert.equal(evidence[0].measurements[0].outcome, "missing-evidence");
  const verdict = judgeProperty(T1, evidence[0]);
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "missing-evidence");
  assert.match(verdict.detail, /ledger/);
});

test("a thrown evaluator is an errored measurement and fails the property", async () => {
  const contract = probeContract([T1]);
  const evidence = await evaluateScenarios({
    contract,
    evaluators: [
      evaluator({
        evaluate: () => {
          throw new Error("judge exploded");
        },
      }),
    ],
    attempts: [attempt("golden-flow", 1), attempt("golden-flow", 2), attempt("golden-flow", 3)],
  });

  assert.equal(evidence[0].measurements[0].outcome, "error");
  assert.match(evidence[0].measurements[0].reason ?? "", /judge exploded/);
  const verdict = judgeProperty(T1, evidence[0]);
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "evaluator-error");
  assert.match(verdict.detail, /judge exploded/);
});

test("an async evaluator is awaited like a synchronous one", async () => {
  const contract = probeContract([T1]);
  const evidence = await evaluateScenarios({
    contract,
    evaluators: [
      evaluator({
        evaluate: async () => ({ kind: "measured", samples: [120], citations: ["async"] }),
      }),
    ],
    attempts: [attempt("golden-flow", 1), attempt("golden-flow", 2), attempt("golden-flow", 3)],
  });
  assert.equal(evidence[0].measurements.every((item) => item.outcome === "measured"), true);
  assert.equal(evidence[0].measurements[0].citations[0], "async");
});

test("the same scenario repetition recorded twice is refused, not retried to green", async () => {
  await assert.rejects(
    evaluateScenarios({
      contract: probeContract([T1]),
      evaluators: [evaluator()],
      attempts: [attempt("golden-flow", 1), attempt("golden-flow", 1)],
    }),
    (error: unknown) => {
      assert.ok(error instanceof VerdictError);
      assert.equal(error.code, "duplicate-attempt");
      assert.match(error.message, /golden-flow/);
      assert.match(error.message, /repetition 1/);
      return true;
    },
  );
});

test("an evaluator that returns a malformed measurement fails closed", async () => {
  const contract = probeContract([T1]);
  const evidence = await evaluateScenarios({
    contract,
    evaluators: [
      evaluator({
        // A defect in a later family module must not be able to pass a run.
        evaluate: () => ({ kind: "measured", samples: ["not-a-number"] as unknown as number[] }),
      }),
    ],
    attempts: [attempt("golden-flow", 1), attempt("golden-flow", 2), attempt("golden-flow", 3)],
  });

  assert.equal(evidence[0].measurements[0].outcome, "error");
  const verdict = judgeProperty(T1, evidence[0]);
  assert.equal(verdict.status, "FAIL");
});

test("a directory with no family module yields no evaluators and fails closed", async () => {
  const empty = mkdtempSync(join(tmpdir(), "dv07-empty-"));
  assert.deepEqual(await loadEvaluatorModules(empty), []);
  assert.deepEqual(await loadEvaluatorModules(join(empty, "not-there")), []);
});

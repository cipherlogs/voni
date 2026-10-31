/**
 * The run plan: what each target/mode combination will execute, and the corpus
 * gaps that make it impossible. A plan is refused by name when the corpus is
 * smaller than the run the spec defines; it is never a smaller run with a green.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "@/lib/demo/verification/contract";
import {
  DEFAULT_CORPUS_DIR,
  FAST_CONTRACT_SCENARIOS,
  loadCorpus,
  type Corpus,
} from "@/lib/demo/verification/scenarios";

import { planVerify } from "./plan";
import { VerifyCliError } from "./errors";

async function committedCorpus(): Promise<Corpus> {
  const contract = await loadContract();
  return loadCorpus({
    dir: DEFAULT_CORPUS_DIR,
    knownProperties: new Set(contract.properties.map((property) => property.id)),
  });
}

function refusal(input: Parameters<typeof planVerify>[0]): VerifyCliError {
  try {
    planVerify(input);
  } catch (error) {
    assert.ok(error instanceof VerifyCliError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.exitCode, 2);
    return error;
  }
  assert.fail("expected the plan to be refused");
}

test("a diagnose plan is one scenario, one repetition, one call", async () => {
  const corpus = await committedCorpus();
  const plan = planVerify({
    request: {
      mode: "diagnose",
      target: "local",
      locale: "en",
      scenario: "golden-flow-hello",
      json: false,
      help: false,
    },
    corpus,
  });
  assert.equal(plan.calls, 1);
  assert.equal(plan.repetitions, 1);
  assert.deepEqual(
    plan.scenarios.map((scenario) => scenario.name),
    ["golden-flow-hello"],
  );
  assert.deepEqual(plan.gaps, []);
});

test("a diagnose plan names a missing scenario and a Locale mismatch", async () => {
  const corpus = await committedCorpus();
  const missing = refusal({
    request: {
      mode: "diagnose",
      target: "local",
      scenario: "no-such-scenario",
      json: false,
      help: false,
    },
    corpus,
  });
  assert.match(missing.message, /no-such-scenario/);
  assert.match(missing.message, /not in the corpus/);

  const mismatch = refusal({
    request: {
      mode: "diagnose",
      target: "local",
      locale: "de",
      scenario: "golden-flow-hello",
      json: false,
      help: false,
    },
    corpus,
  });
  assert.match(mismatch.message, /Locale "en"[\s\S]*--locale de/);
});

test("the fast plan is the ten English scenarios at one repetition", async () => {
  const corpus = await committedCorpus();
  const plan = planVerify({
    request: { mode: "fast", target: "local", json: false, help: false },
    corpus,
  });
  assert.equal(plan.calls, 10);
  assert.equal(plan.repetitions, 1);
  assert.deepEqual(
    plan.scenarios.map((scenario) => scenario.name),
    [...FAST_CONTRACT_SCENARIOS],
  );
  assert.deepEqual(plan.gaps, []);
});

test("full certification plans 40 English x3 plus 12 per Locale x3, and names the corpus gap", async () => {
  const corpus = await committedCorpus();
  const plan = planVerify({
    request: { mode: "full", target: "local", json: false, help: false },
    corpus,
  });
  assert.equal(plan.calls, (40 + 12 * 4) * 3);
  assert.equal(plan.repetitions, 3);
  assert.ok(
    plan.gaps.some((gap) => /English corpus holds 30 of the 40/.test(gap)),
    plan.gaps.join("\n"),
  );
  // The Locale core landed (twelve per Locale), so only English is short.
  for (const locale of ["es", "fr", "de", "pt"] as const) {
    assert.ok(
      plan.gaps.every((gap) => !gap.includes(`(${locale}) corpus`)),
      plan.gaps.join("\n"),
    );
  }
});

test("nightly health plans one repetition, and a Locale filter narrows the plan", async () => {
  const corpus = await committedCorpus();
  const nightly = planVerify({
    request: { mode: "nightly", target: "local", json: false, help: false },
    corpus,
  });
  assert.equal(nightly.calls, 40 + 12 * 4);
  assert.equal(nightly.repetitions, 1);

  const german = planVerify({
    request: { mode: "full", target: "local", locale: "de", json: false, help: false },
    corpus,
  });
  assert.equal(german.calls, 12 * 3);
  assert.deepEqual(german.gaps, [], "the German core is complete");
  const english = planVerify({
    request: { mode: "nightly", target: "local", locale: "en", json: false, help: false },
    corpus,
  });
  assert.equal(english.calls, 40);
});

test("a target without an evidence sink is refused by name before a plan exists", async () => {
  const corpus = await committedCorpus();
  for (const target of ["staging", "production"] as const) {
    const error = refusal({
      request: { mode: "full", target, json: false, help: false },
      corpus,
    });
    assert.equal(error.code, "unsupported-target");
    assert.match(error.message, new RegExp(`target "${target}"`));
    assert.match(error.message, /evidence sink/);
  }
});

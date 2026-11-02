/**
 * The run plan: what each target/mode combination will execute, and the corpus
 * gaps that make it impossible. A plan is refused by name when the corpus is
 * smaller than the run the spec defines; it is never a smaller run with a green.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ENGLISH_SCENARIOS,
  FAST_CALLS,
  FULL_CALLS,
  LOCALE_COUNT,
  LOCALE_CORE_SCENARIOS,
  NIGHTLY_CALLS,
} from "@/lib/demo/verification/cadence";
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
  assert.equal(plan.calls, FAST_CALLS);
  assert.equal(plan.repetitions, 1);
  assert.deepEqual(
    plan.scenarios.map((scenario) => scenario.name),
    [...FAST_CONTRACT_SCENARIOS],
  );
  assert.deepEqual(plan.gaps, []);
});

test("full certification plans the English corpus plus every Locale core at three repetitions", async () => {
  const corpus = await committedCorpus();
  const plan = planVerify({
    request: { mode: "full", target: "local", json: false, help: false },
    corpus,
  });
  assert.equal(plan.calls, FULL_CALLS);
  assert.equal(plan.repetitions, 3);
  const english = corpus.scenarios.filter((scenario) => scenario.locale === "en").length;
  if (english < ENGLISH_SCENARIOS) {
    assert.ok(
      plan.gaps.some((gap) =>
        gap.includes(`English corpus holds ${english} of the ${ENGLISH_SCENARIOS}`),
      ),
      plan.gaps.join("\n"),
    );
  } else {
    assert.ok(plan.gaps.every((gap) => !gap.includes("English corpus")), plan.gaps.join("\n"));
  }
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
  assert.equal(nightly.calls, NIGHTLY_CALLS);
  assert.equal(nightly.calls, ENGLISH_SCENARIOS + LOCALE_CORE_SCENARIOS * LOCALE_COUNT);
  assert.equal(nightly.repetitions, 1);

  const full = planVerify({
    request: { mode: "full", target: "local", json: false, help: false },
    corpus,
  });
  assert.equal(full.calls, FULL_CALLS, "weekly full is the nightly plan at three repetitions");
  assert.equal(full.repetitions, 3);

  const english = planVerify({
    request: { mode: "nightly", target: "local", locale: "en", json: false, help: false },
    corpus,
  });
  assert.equal(english.calls, ENGLISH_SCENARIOS);

  // A nightly Locale core is still the twelve-behaviour plan.
  const nightlyGerman = planVerify({
    request: { mode: "nightly", target: "local", locale: "de", json: false, help: false },
    corpus,
  });
  assert.equal(nightlyGerman.calls, LOCALE_CORE_SCENARIOS);
  assert.deepEqual(nightlyGerman.gaps, []);
});

test("a per-Locale full run without a full corpus refuses by name, never a locale-gap certificate", async () => {
  const corpus = await committedCorpus();
  for (const locale of ["es", "fr", "de", "pt"] as const) {
    const error = refusal({
      request: { mode: "full", target: "local", locale, json: false, help: false },
      corpus,
    });
    assert.equal(error.code, "missing-locale-corpus");
    assert.match(error.message, new RegExp(`"${locale}"`));
    assert.match(error.message, new RegExp(`all ${ENGLISH_SCENARIOS} scenarios`));
    assert.match(error.message, /Locale-core/);
  }

  // English has the full set, so English --full --locale en still plans.
  const english = planVerify({
    request: { mode: "full", target: "local", locale: "en", json: false, help: false },
    corpus,
  });
  assert.equal(english.calls, ENGLISH_SCENARIOS * 3);
  assert.deepEqual(english.gaps, []);
  assert.deepEqual(english.scope, ["en"], "an English --full declares the English-only scope");
});

test("the declared scope is an input: a plan outside it refuses, and a claim it cannot run refuses", async () => {
  const corpus = await committedCorpus();
  const explicit = planVerify({
    request: {
      mode: "full",
      target: "local",
      locale: "en",
      scope: ["en"],
      json: false,
      help: false,
    },
    corpus,
  });
  assert.deepEqual(explicit.scope, ["en"]);
  assert.equal(explicit.calls, ENGLISH_SCENARIOS * 3);

  const everyLocale = planVerify({
    request: { mode: "full", target: "local", json: false, help: false },
    corpus,
  });
  assert.deepEqual(everyLocale.scope, ["en", "es", "fr", "de", "pt"]);
  assert.equal(everyLocale.calls, FULL_CALLS);

  // `--scope en` with no Locale filter is the same English-only claim: it
  // narrows the run to the declared Locale rather than claiming five.
  const scopeOnly = planVerify({
    request: { mode: "full", target: "local", scope: ["en"], json: false, help: false },
    corpus,
  });
  assert.deepEqual(scopeOnly.scope, ["en"]);
  assert.equal(scopeOnly.calls, ENGLISH_SCENARIOS * 3);
  assert.ok(scopeOnly.scenarios.every((scenario) => scenario.locale === "en"));

  const outsideClaim = refusal({
    request: { mode: "full", target: "local", locale: "de", scope: ["en"], json: false, help: false },
    corpus,
  });
  assert.equal(outsideClaim.code, "scope-mismatch");
  assert.match(outsideClaim.message, /Locale\(s\) en/);
  assert.match(outsideClaim.message, /does not plan/);

  const unrunClaim = refusal({
    request: { mode: "full", target: "local", locale: "en", scope: ["en", "es"], json: false, help: false },
    corpus,
  });
  assert.equal(unrunClaim.code, "scope-mismatch");
  assert.match(unrunClaim.message, /Locale\(s\) es, which this full run does not plan/);
});

test("the plan's counts are the cadence's one source, so a hand-edited copy fails", async () => {
  const corpus = await committedCorpus();
  const fast = planVerify({
    request: { mode: "fast", target: "local", json: false, help: false },
    corpus,
  });
  const nightly = planVerify({
    request: { mode: "nightly", target: "local", json: false, help: false },
    corpus,
  });
  const full = planVerify({
    request: { mode: "full", target: "local", json: false, help: false },
    corpus,
  });
  assert.equal(fast.calls, FAST_CALLS);
  assert.equal(nightly.calls, NIGHTLY_CALLS);
  assert.equal(full.calls, FULL_CALLS);
  // The corpus holds the plan's whole shape, so a mismatch is a drift, not a gap.
  assert.deepEqual(nightly.gaps, []);
  assert.deepEqual(full.gaps, []);
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

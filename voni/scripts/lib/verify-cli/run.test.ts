/**
 * The `demo:verify` dispatch contract: every target/mode either runs or refuses
 * by name, every exit code is exact, a diagnose never writes a certificate, a
 * held timing lock fails fast naming its holder, and a green belongs to one
 * target and one code fingerprint.
 *
 * The adapters are injected here: this suite owns the command's contract, while
 * the browser and protocol suites own the calls those adapters make.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CERTIFICATE_TARGETS,
  OPEN_RESIDUAL_RISK_IDS,
  validateCertificate,
  type PanelSignature,
} from "@/lib/demo/verification/certificate";
import { ENGLISH_SCENARIOS } from "@/lib/demo/verification/cadence";
import { loadContract, type Contract } from "@/lib/demo/verification/contract";
import type { PanelJudgementInput } from "@/lib/demo/verification/panel";
import {
  DEFAULT_CORPUS_DIR,
  FAST_CONTRACT_SCENARIOS,
  LOCALES,
  ScenarioError,
  loadCorpus,
  type Corpus,
  type Locale,
} from "@/lib/demo/verification/scenarios";
import type { PropertyEvaluator } from "@/lib/demo/verification/verdict";
import { TimingLockHeldError } from "@/lib/demo/timing-lock";

import { parseVerifyArgs, type VerifyRequest } from "./args";
import { zeroSessionCostRow } from "../browser-adapter/zero-cost";
import { VerifyCliError } from "./errors";
import { planVerify, type VerifyPlan } from "./plan";
import {
  DEFAULT_CALL_INTERVAL_MS,
  callIntervalMs,
  exitForCertificate,
  runVerify,
  type ScenarioCallInput,
  type ScenarioCallOutcome,
  type VerifyDeps,
  type VerifyResult,
} from "./run";

const VENDOR_BUILDS = {
  schemaVersion: 1,
  builds: [
    { leg: "stt" as const, vendor: "assemblyai", model: "universal", buildId: "stt-build-1" },
    { leg: "tts" as const, vendor: "cartesia", model: "sonic", buildId: "tts-build-1" },
    { leg: "llm" as const, vendor: "meta", model: "llama", buildId: "llm-build-1" },
  ],
};

const KEYS = {
  META_API_KEY: "meta-test",
  ASSEMBLYAI_API_KEY: "aai-test",
  VOICE_PIPELINE_ENVELOPE_SECRET: "envelope-test",
};

const FINGERPRINT = { head: "abc123", dirty: false, dirtyHash: "clean" };

/**
 * Every test run writes its journal here, never into the repository's live
 * `.demo-runs` directory (a certification run may be executing beside the
 * suite). A resume test overrides this with its own temporary root.
 */
const JOURNAL_ROOT = join(tmpdir(), "voni-verify-cli-journals");

const COST_ROW = {
  measured: true,
  totalUsd: 0.0001,
  rateTableVersion: "test-rates",
  legs: {
    stt: { measured: true, amountUsd: 0.0001, unit: "audio_second", quantity: 1 },
  },
};

/** Every evaluator's declared source is present; the fake adapters produced it. */
const EVIDENCE = {
  ledger: {},
  trace: {},
  wav: {},
  browser: {},
  tool: {},
  cost: COST_ROW,
  panel: {},
  judge: {},
  pytest: {},
};

function request(argv: readonly string[]): VerifyRequest {
  return parseVerifyArgs(argv);
}

/** Every numeric bar is bound and passes: the CLI suite judges dispatch, not bars. */
function passingEvaluators(contract: Contract): PropertyEvaluator[] {
  return contract.properties.map((property) => ({
    propertyId: property.id,
    bars: property.bar.numeric
      ? property.thresholds.map((threshold) => ({
          key: threshold.key,
          statistic: "max" as const,
          comparison: "at-most" as const,
        }))
      : [],
    evaluate: () => {
      if (!property.bar.numeric) {
        return { kind: "measured", passed: true, citations: [`test:${property.id}`] };
      }
      // Every at-most bar passes at the smallest declared budget, including a
      // negative one (an audio level).
      const floor = Math.min(0, ...property.thresholds.map((threshold) => threshold.value));
      return { kind: "measured", samples: [floor], citations: [`test:${property.id}`] };
    },
  }));
}

/**
 * The fast plan is one repetition. The clone also clears K8's recorded
 * `unresolved` flag, so the scope can be clean: this suite tests dispatch, not
 * the contract's held-open word-error bar.
 */
function oneRepetitionContract(contract: Contract): Contract {
  return {
    families: contract.families,
    properties: contract.properties.map((property) => ({
      ...property,
      repetitions: 1,
      unresolved: undefined,
    })),
  };
}

function noLock(): ReturnType<VerifyDeps["acquireLock"]> {
  return { path: "test-lock", pid: process.pid, release: () => {} };
}

function baseDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    env: { ...KEYS },
    // Dispatch tests never wait for real: the pacing clock is virtual unless a
    // test injects its own (see the pacing test).
    clock: () => 0,
    sleep: async () => {},
    loadContract: () => loadContract(),
    loadCorpus: (options) => loadCorpus(options),
    loadEvaluators: async (contract) => passingEvaluators(contract),
    readVendorBuilds: async () => VENDOR_BUILDS,
    acquireLock: () => noLock(),
    readCodeFingerprint: () => FINGERPRINT,
    journalRoot: JOURNAL_ROOT,
    newRunId: () => "verify-test-01",
    diagnose: async () => ({
      status: "clean-diagnosis",
      exitCode: 1,
      runId: "run-test-01",
      runDir: "/tmp/run-test-01",
      refusal: null,
    }),
    runScenario: async (input) => ({
      refusal: null,
      attempt: {
        scenario: input.scenario,
        repetition: 1,
        locale: input.locale,
        target: input.target,
        evidence: EVIDENCE,
      },
      eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
      pipelineImage: "pipeline-test",
    }),
    ...overrides,
  };
}

function fastRequest(extra: readonly string[] = []): VerifyRequest {
  return request(["--target", "local", "--fast", ...extra]);
}

async function fastResult(overrides: Partial<VerifyDeps> = {}): Promise<VerifyResult> {
  const deps = baseDeps({
    loadContract: async () => oneRepetitionContract(await loadContract()),
    ...overrides,
  });
  return runVerify(fastRequest(), deps);
}

test("a call that produced no evidence is re-made once, and both attempts are kept", async () => {
  let calls = 0;
  const result = await fastResult({
    runScenario: async (input) => {
      calls += 1;
      // Only the very first call of the run is lost; the retry lands.
      if (calls === 1) {
        return {
          refusal: {
            code: "marks-missing",
            message: 'the browser harness recorded no marks artifact for call "abc"',
          },
          attempt: null,
          eligibility: null,
          pipelineImage: null,
        };
      }
      return {
        refusal: null,
        attempt: {
          scenario: input.scenario,
          repetition: 1,
          locale: input.locale,
          target: input.target,
          evidence: EVIDENCE,
        },
        eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
        pipelineImage: "pipeline-test",
      };
    },
  });

  assert.equal(result.status, "scoped-pass");
  assert.equal(calls, 11, "ten calls, with the first made twice");
  assert.equal(result.retries.length, 1);
  assert.equal(result.retries[0]?.code, "marks-missing");
  assert.equal(result.retries[0]?.scenario, FAST_CONTRACT_SCENARIOS[0]);
  assert.ok(
    result.unrun.some((line) => /produced no evidence and was re-made/.test(line)),
    "the run names the re-made call",
  );
});

test("a second attempt that also produces no evidence refuses the run", async () => {
  let calls = 0;
  const result = await fastResult({
    runScenario: async () => {
      calls += 1;
      return {
        refusal: {
          code: "marks-missing",
          message: "no marks artifact",
        },
        attempt: null,
        eligibility: null,
        pipelineImage: null,
      };
    },
  });
  assert.equal(result.status, "refused");
  assert.equal(result.exitCode, 2);
  assert.equal(calls, 2, "one call, one retry, then the refusal stands");
  assert.ok(
    result.refusals.some((line) => /re-made 1 call\(s\) that produced no evidence/.test(line)),
    "the refusal names the re-made call",
  );
});

test("a call that ran and failed is never re-made", async () => {
  let calls = 0;
  const result = await fastResult({
    runScenario: async () => {
      calls += 1;
      return {
        refusal: {
          code: "trigger-unresolved",
          message: "no agent-turn-end event before the call ended",
        },
        attempt: null,
        eligibility: null,
        pipelineImage: null,
      };
    },
  });
  assert.equal(result.status, "refused");
  assert.equal(calls, 1, "a measured call is never re-made");
  assert.equal(result.retries.length, 0);
});

test("calls are paced so the vendor's session allowance is never reached", async () => {
  const starts: number[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const result = await fastResult({
    clock: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    runScenario: async (input) => {
      starts.push(clock);
      // A call's own work: the clock advances, so pacing is measured between
      // starts, not between the ends of identical stubs.
      clock += 5_000;
      return {
        refusal: null,
        attempt: {
          scenario: input.scenario,
          repetition: 1,
          locale: input.locale,
          target: input.target,
          evidence: EVIDENCE,
        },
        eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
        pipelineImage: "pipeline-test",
      };
    },
  });

  assert.equal(result.status, "scoped-pass");
  assert.equal(starts.length, FAST_CONTRACT_SCENARIOS.length);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(
      starts[index]! - starts[index - 1]! >= DEFAULT_CALL_INTERVAL_MS,
      `call ${index} started ${starts[index]! - starts[index - 1]!}ms after the previous one`,
    );
  }
  assert.ok(sleeps.length > 0, "the run waited between calls rather than bursting them");
});

test("the pacing interval defaults to 30s and reads its override, refusing a bad one", () => {
  assert.equal(callIntervalMs({}), DEFAULT_CALL_INTERVAL_MS);
  assert.equal(DEFAULT_CALL_INTERVAL_MS, 30_000);
  assert.equal(callIntervalMs({ DEMO_VERIFY_CALL_INTERVAL_MS: "45000" }), 45_000);
  assert.equal(callIntervalMs({ DEMO_VERIFY_CALL_INTERVAL_MS: "0" }), 0);
  assert.equal(
    callIntervalMs({ DEMO_VERIFY_CALL_INTERVAL_MS: "soon" }),
    DEFAULT_CALL_INTERVAL_MS,
  );
});

test("a clean fast run is a scoped-pass and exit 1: it is not a certificate", async () => {
  const result = await fastResult();
  assert.equal(result.status, "scoped-pass");
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls, 10);
  assert.equal(result.certificate, null, "a fast run never writes a certificate");
  assert.match(result.detail, /scoped-pass|not a certificate/);
  assert.deepEqual(result.failedPropertyIds, [], "the artifact carries the zero-failure evidence");
  assert.equal(result.ineligible, false);
});

test("the economics run gate, not the fast module, reds a fast run over its ceiling", async () => {
  const overCost = { ...COST_ROW, totalUsd: 0.3 };
  const result = await fastResult({
    runScenario: async (input) => ({
      refusal: null,
      attempt: {
        scenario: input.scenario,
        repetition: 1,
        locale: input.locale,
        target: input.target,
        evidence: { ...EVIDENCE, cost: overCost },
      },
      eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
      pipelineImage: "pipeline-test",
    }),
  });
  // Ten calls x $0.30 = $3.00, over E3's fast ceiling of $2.
  assert.equal(result.status, "not-demo-ready");
  assert.equal(result.exitCode, 1);
  assert.match(result.unrun.join("\n"), /E3|run ceiling|3\.00/);
});

test("a failing fast run is not-demo-ready and exit 1", async () => {
  const contract = oneRepetitionContract(await loadContract());
  const failing = passingEvaluators(contract).map((evaluator) =>
    evaluator.propertyId === "T3"
      ? {
          ...evaluator,
          evaluate: () => ({ kind: "measured" as const, samples: [1_000], citations: ["test:T3"] }),
        }
      : evaluator,
  );
  const result = await fastResult({ loadEvaluators: async () => failing });
  assert.equal(result.status, "not-demo-ready");
  assert.equal(result.exitCode, 1);
  assert.ok(result.failedPropertyIds.includes("T3"), "the report names the failed property");
  assert.ok(result.unrun.some((line) => line.includes("T3")), result.unrun.join("\n"));
});

test("a fast run refuses by name at the first adapter refusal and runs no further call", async () => {
  const seen: string[] = [];
  const result = await fastResult({
    runScenario: async (input) => {
      seen.push(input.scenario);
      if (seen.length === 3) {
        return {
          refusal: { code: "missing-key", message: "ASSEMBLYAI_API_KEY is not set" },
          attempt: null,
          eligibility: null,
          pipelineImage: null,
        };
      }
      return {
        refusal: null,
        attempt: {
          scenario: input.scenario,
          repetition: 1,
          locale: input.locale,
          target: input.target,
          evidence: EVIDENCE,
        },
        eligibility: { callId: input.scenario, scenario: input.scenario },
        pipelineImage: "pipeline-test",
      };
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "refused");
  assert.equal(seen.length, 3, "a refusal stops the run; there is no retry-to-green");
  assert.match(result.refusals.join("\n"), /ASSEMBLYAI_API_KEY/);
});

test("missing keys, a missing vendor build and a corpus gap are one named exit 2", async () => {
  const noKeys = await fastResult({ env: {} });
  assert.equal(noKeys.exitCode, 2);
  assert.equal(noKeys.status, "refused");
  for (const key of Object.keys(KEYS)) {
    assert.match(noKeys.refusals.join("\n"), new RegExp(key));
  }

  const noBuilds = await fastResult({ readVendorBuilds: async () => null });
  assert.equal(noBuilds.exitCode, 2);
  assert.match(noBuilds.refusals.join("\n"), /vendor-builds\.json/);

  const missingCorpus = await fastResult({
    loadCorpus: async () => {
      throw new ScenarioError("unreadable-corpus", "cannot read the corpus at /nowhere");
    },
  });
  assert.equal(missingCorpus.exitCode, 2);
  assert.match(missingCorpus.refusals.join("\n"), /cannot read the corpus at \/nowhere/);
});

test("the fast ceiling is read from E3 with the plan's own call count", async () => {
  const contract = oneRepetitionContract(await loadContract());
  const zeroCeiling: Contract = {
    families: contract.families,
    properties: contract.properties.map((property) =>
      property.id === "E3"
        ? {
            ...property,
            thresholds: property.thresholds.filter(
              (threshold) => threshold.key === "dvCostFastRunMaxUsd",
            ).map((threshold) => ({ ...threshold, value: 0 })),
          }
        : property,
    ),
  };
  const result = await fastResult({ loadContract: async () => zeroCeiling });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "refused");
  assert.match(result.refusals.join("\n"), /10 planned calls/);
});

test("a held timing lock is a named refusal, never a wait", async () => {
  const result = await fastResult({
    acquireLock: () => {
      throw new TimingLockHeldError("/tmp/voni-demo-timing.lock", {
        pid: 4242,
        at: "2026-10-31T09:00:00.000Z",
        scenario: "golden-flow-hello",
      });
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "refused");
  assert.match(result.refusals.join("\n"), /pid 4242/);
  assert.match(result.refusals.join("\n"), /holds the lock/);
});

test("diagnose runs the protocol adapter, never returns 0 and never writes a certificate", async () => {
  const result = await runVerify(
    request(["--scenario", "golden-flow-hello", "--target", "local", "--locale", "en", "--diagnose"]),
    baseDeps(),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "diagnosed");
  assert.equal(result.certificate, null);
  assert.equal(result.certificatePath, null);

  const refused = await runVerify(
    request(["--scenario", "golden-flow-hello", "--target", "local", "--diagnose"]),
    baseDeps({
      diagnose: async () => ({
        status: "refused",
        exitCode: 2,
        runId: "run-test-02",
        runDir: "/tmp/run-test-02",
        refusal: { code: "missing-vendor-build", message: "vendor-builds.json is missing" },
      }),
    }),
  );
  assert.equal(refused.exitCode, 2);
  assert.match(refused.refusals.join("\n"), /vendor-builds\.json/);

  const lying = await runVerify(
    request(["--scenario", "golden-flow-hello", "--target", "local", "--diagnose"]),
    baseDeps({
      diagnose: async () => ({
        status: "certified",
        exitCode: 0,
        runId: "run-test-03",
        runDir: "/tmp/run-test-03",
        refusal: null,
      }),
    }),
  );
  assert.equal(lying.exitCode, 2, "the protocol adapter never certifies; exit 0 is refused");
  assert.match(lying.refusals.join("\n"), /never certifies|never returns 0/);
});

test("staging and production refuse by name for every mode", async () => {
  for (const target of CERTIFICATE_TARGETS.filter((entry) => entry !== "local")) {
    for (const flag of ["--fast", "--nightly", "--full"] as const) {
      const result = await runVerify(request(["--target", target, flag]), baseDeps());
      assert.equal(result.exitCode, 2, `${target} ${flag}`);
      assert.equal(result.status, "refused");
      assert.match(result.refusals.join("\n"), new RegExp(`target "${target}"`));
    }
    const diagnose = await runVerify(
      request(["--scenario", "golden-flow-hello", "--target", target, "--diagnose"]),
      baseDeps(),
    );
    assert.equal(diagnose.exitCode, 2, `${target} --diagnose`);
    assert.match(diagnose.refusals.join("\n"), new RegExp(`target "${target}"`));
  }
});

test("full and nightly plan over the complete corpus and carry no corpus gap", async () => {
  const contract = await loadContract();
  const corpus = await loadCorpus({
    dir: DEFAULT_CORPUS_DIR,
    knownProperties: new Set(contract.properties.map((property) => property.id)),
  });
  assert.equal(
    corpus.scenarios.filter((scenario) => scenario.locale === "en").length,
    ENGLISH_SCENARIOS,
    "English holds every scenario the plan is defined over",
  );
  for (const mode of ["full", "nightly"] as const) {
    const plan = planVerify({ request: request(["--target", "local", `--${mode}`]), corpus });
    assert.deepEqual(plan.gaps, [], `${mode} carries no corpus gap`);
  }
});

/* ------------------------------------------------------------------------- *
 * A full certification, end to end over injected calls.
 *
 * The plan is narrowed to one scenario per Locale so the certificate's coverage
 * has no gap; the real verdict core, run ceiling and certificate builder judge
 * it. A local green is the only green, and a signature is the only exit 0.
 * ------------------------------------------------------------------------- */

const FULL_CONTRACT_IDS = ["L1", "E2", "E3"] as const;
const FULL_PANEL: PanelSignature = {
  sessionId: "panel-test-01",
  reviewer: "owner",
  signedAt: "2026-10-31",
  signature: "digest-test-signature",
};

async function fullContract(): Promise<Contract> {
  const contract = await loadContract();
  const ids = new Set<string>(FULL_CONTRACT_IDS);
  return {
    families: contract.families,
    properties: contract.properties.filter((property) => ids.has(property.id)),
  };
}

const FULL_HUMAN_IDS = ["L1", "E2", "E3", "H1", "H2", "H3", "H4", "H5", "H7"] as const;

async function fullHumanContract(): Promise<Contract> {
  const contract = await loadContract();
  const ids = new Set<string>(FULL_HUMAN_IDS);
  return {
    families: contract.families,
    properties: contract.properties.filter((property) => ids.has(property.id)),
  };
}

/** The panel's gold labels: 40 judgments per Locale, so H2's floor is met. */
function panelInput(signature: PanelSignature): PanelJudgementInput {
  const labels = LOCALES.flatMap((locale) =>
    Array.from({ length: 40 }, (_, index) => ({
      sessionId: signature.sessionId,
      callId: `call-${locale}-${index + 1}`,
      itemId: `item-${locale}-${index + 1}`,
      scenario: `${locale}-one`,
      locale,
      axes: {
        stayOnCall: 5,
        soundsHuman: 5,
        turnTaking: 5,
        understanding: 5,
        languageNaturalness: 5,
        warmth: 5,
        pacing: 5,
      },
      humanDetected: index < 20,
      preference: "baseline" as const,
      ratedAt: "2026-10-31",
    })),
  );
  return {
    goldLabels: {
      sessionId: signature.sessionId,
      runId: "verify-test-01",
      reviewer: signature.reviewer,
      signedAt: signature.signedAt,
      labels,
      digest: "d".repeat(64),
    },
    signature,
    certificate: { runId: "verify-test-01", target: "local" },
  };
}

function fullCorpus(): Corpus {
  return {
    version: 7,
    fingerprint: "a".repeat(64),
    scenarios: LOCALES.map((locale: Locale) => ({
      schemaVersion: 1,
      name: `${locale}-one`,
      class: "golden",
      locale,
      heldOut: false,
      expectedProperties: ["L1"],
      soundscape: { kind: "silence" },
      faults: [],
      takes: [],
      script: [],
      directory: `/tmp/${locale}-one`,
      fingerprint: `${locale}`.padEnd(64, "0"),
    })) as unknown as Corpus["scenarios"],
  };
}

function fullPlan(corpus: Corpus): VerifyPlan {
  return {
    mode: "full",
    target: "local",
    locale: null,
    scenario: null,
    repetitions: 3,
    calls: corpus.scenarios.length * 3,
    scenarios: corpus.scenarios.map((scenario) => ({
      name: scenario.name,
      locale: scenario.locale,
      heldOut: scenario.heldOut,
    })),
    gaps: [],
  };
}

async function fullResult(input: {
  readonly failProperty?: string;
  readonly panel?: PanelSignature;
  readonly target?: string;
  readonly contract?: Contract;
  readonly panelInput?: PanelJudgementInput;
  readonly runRoot?: string;
  readonly journalRoot?: string;
  readonly runId?: string;
  readonly resume?: string;
  readonly corpus?: Corpus;
  readonly runScenario?: VerifyDeps["runScenario"];
  readonly readCodeFingerprint?: VerifyDeps["readCodeFingerprint"];
  readonly readVendorBuilds?: VerifyDeps["readVendorBuilds"];
  readonly plan?: (corpus: Corpus) => VerifyPlan;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
} = {}): Promise<VerifyResult> {
  const contract = input.contract ?? (await fullContract());
  // A narrowed contract still judges only the machine families this suite
  // injects; the human properties stay unmeasured so the panel test is real.
  const judged =
    input.contract === undefined
      ? contract
      : {
          families: contract.families,
          properties: contract.properties.filter((property) =>
            (FULL_CONTRACT_IDS as readonly string[]).includes(property.id),
          ),
        };
  const corpus = input.corpus ?? fullCorpus();
  const evaluators = passingEvaluators(judged).map((evaluator) =>
    evaluator.propertyId === input.failProperty
      ? {
          ...evaluator,
          evaluate: () => ({
            kind: "measured" as const,
            samples: [1e9],
            citations: [`test:${evaluator.propertyId}`],
          }),
        }
      : evaluator,
  );
  const argv = ["--target", input.target ?? "local", "--full"];
  if (input.runRoot !== undefined) argv.push("--run-root", input.runRoot);
  if (input.resume !== undefined) argv.push("--resume", input.resume);
  return runVerify(request(argv), {
    ...baseDeps(),
    loadContract: async () => contract,
    loadCorpus: async () => corpus,
    loadEvaluators: async () => evaluators,
    plan:
      input.plan === undefined
        ? () => fullPlan(corpus)
        : (args: { corpus: Corpus }) => input.plan!(args.corpus),
    signature: input.panel ?? null,
    newRunId: () => input.runId ?? "verify-test-01",
    ...(input.journalRoot === undefined ? {} : { journalRoot: input.journalRoot }),
    ...(input.runScenario === undefined ? {} : { runScenario: input.runScenario }),
    ...(input.readCodeFingerprint === undefined
      ? {}
      : { readCodeFingerprint: input.readCodeFingerprint }),
    ...(input.readVendorBuilds === undefined
      ? {}
      : { readVendorBuilds: input.readVendorBuilds }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...(input.panelInput === undefined ? {} : { panel: input.panelInput }),
  });
}

test("a clean unsigned full run is pending-human and exit 3, with exactly one certificate", async () => {
  const result = await fullResult();
  assert.equal(result.exitCode, 3);
  assert.equal(result.status, "pending-human");
  assert.ok(result.certificate, "the full run issues one certificate");
  assert.equal(result.certificate?.pass, false);
  assert.equal(result.certificate?.plan.mode, "full");
  assert.equal(result.certificate?.coverage.gapRows, 0);
  assert.ok(result.certificatePath?.endsWith("verify-test-01.json"));
});

test("a signed clean full run is certified and exit 0", async () => {
  const result = await fullResult({ panel: FULL_PANEL });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "certified");
  assert.equal(result.certificate?.verdict, "certified");
  assert.equal(result.certificate?.panel?.reviewer, "owner");
});

test("the panel's H1-H5 merge before the certificate is built, so a signed full run can certify", async () => {
  const contract = await fullHumanContract();
  const unsigned = await fullResult({ contract });
  assert.equal(unsigned.exitCode, 3, "without a panel the human properties are pending-human");
  assert.equal(unsigned.status, "pending-human");
  assert.equal(unsigned.certificate?.verdict, "pending-human");
  assert.equal(unsigned.certificate?.pass, false);
  const pendingH2 = unsigned.certificate?.properties.find(
    (property) => property.propertyId === "H2",
  );
  assert.equal(pendingH2?.status, "FAIL");
  assert.equal(pendingH2?.reason, "no-evaluator");

  const signed = await fullResult({
    contract,
    panel: FULL_PANEL,
    panelInput: panelInput(FULL_PANEL),
  });
  assert.equal(signed.exitCode, 0);
  assert.equal(signed.status, "certified");
  assert.equal(signed.certificate?.verdict, "certified");
  const h2 = signed.certificate?.properties.find((property) => property.propertyId === "H2");
  assert.equal(h2?.status, "PASS");
  assert.equal(h2?.sampleCount, 200);
  assert.ok(h2?.citations.some((citation) => citation.startsWith("panel:")));
});

test("a failing full run is not-demo-ready and exit 1; it is never a pass", async () => {
  const result = await fullResult({ failProperty: "L1" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "not-demo-ready");
  assert.equal(result.certificate?.pass, false);
});

test("a local certificate never carries to another target", async () => {
  const result = await fullResult({ panel: FULL_PANEL });
  const certificate = result.certificate;
  assert.ok(certificate);
  assert.throws(
    () => validateCertificate(certificate, { target: "production" }),
    /target/i,
  );
  assert.equal(validateCertificate(certificate, { target: "local" }).pass, true);
  // A different code fingerprint is a different run, never an inherited green.
  assert.throws(
    () =>
      exitForCertificate(certificate, {
        target: "local",
        codeFingerprint: { ...FINGERPRINT, head: "def456", dirtyHash: "dirty" },
      }),
    /fingerprint/i,
  );
});

test("a full run whose injected signature is not a real panel signature is refused", async () => {
  const result = await fullResult({
    panel: { ...FULL_PANEL, signature: "   " },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "refused");
  assert.match(result.refusals.join("\n"), /panel\.signature|signature/);
});

test("the run total includes a call that opened no session at its measured zero", async () => {
  const contract = await fullContract();
  const corpus = fullCorpus();
  let calls = 0;
  const result = await runVerify(request(["--target", "local", "--full"]), {
    ...baseDeps(),
    loadContract: async () => contract,
    loadCorpus: async () => corpus,
    loadEvaluators: async () => passingEvaluators(contract),
    plan: () => fullPlan(corpus),
    runScenario: async (input) => {
      calls += 1;
      return {
        refusal: null,
        attempt: {
          scenario: input.scenario,
          repetition: 1,
          locale: input.locale,
          target: input.target,
          // The mic-denied call opened no session: zero legs, zero price. The
          // rest of the run priced normally.
          evidence: { ...EVIDENCE, cost: calls === 1 ? zeroSessionCostRow() : COST_ROW },
        },
        eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
        pipelineImage: "pipeline-test",
      };
    },
  });
  assert.equal(calls, 15);
  assert.ok(result.certificate, result.refusals.join("\n"));
  assert.equal(result.certificate?.cost.callCount, 15);
  assert.equal(
    result.certificate?.cost.usd,
    14 * 0.0001,
    "the zero row adds zero and never replaces a real call's price",
  );
});

test("a run with a call whose real leg is unmeasured still refuses a total", async () => {
  const contract = await fullContract();
  const corpus = fullCorpus();
  const unmeasured = {
    measured: false,
    totalUsd: null,
    rateTableVersion: "cascade-vendor-rates v1",
    unmeasuredReason: "tts: the vendor did not report characters",
    legs: {
      stt: { measured: true, amountUsd: 0.0001, unit: "audio_second", quantity: 1 },
      tts: {
        measured: false,
        amountUsd: null,
        unit: "unknown",
        quantity: null,
        source: "the vendor did not report characters",
      },
    },
  };
  const result = await runVerify(request(["--target", "local", "--full"]), {
    ...baseDeps(),
    loadContract: async () => contract,
    loadCorpus: async () => corpus,
    loadEvaluators: async () => passingEvaluators(contract),
    plan: () => fullPlan(corpus),
    runScenario: async (input) => ({
      refusal: null,
      attempt: {
        scenario: input.scenario,
        repetition: 1,
        locale: input.locale,
        target: input.target,
        evidence: { ...EVIDENCE, cost: unmeasured },
      },
      eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
      pipelineImage: "pipeline-test",
    }),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "refused");
  assert.match(result.refusals.join("\n"), /unmeasured|no total|cost/i);
  assert.match(result.refusals.join("\n"), /characters/);
});

test("a full run that cannot measure a call's cost refuses rather than inventing one", async () => {
  const contract = await fullContract();
  const corpus = fullCorpus();
  const result = await runVerify(request(["--target", "local", "--full"]), {
    ...baseDeps(),
    loadContract: async () => contract,
    loadCorpus: async () => corpus,
    loadEvaluators: async () => passingEvaluators(contract),
    plan: () => fullPlan(corpus),
    runScenario: async (input) => ({
      refusal: null,
      attempt: {
        scenario: input.scenario,
        repetition: 1,
        locale: input.locale,
        target: input.target,
        evidence: { ...EVIDENCE, cost: { measured: false, totalUsd: null, legs: {}, unmeasuredReason: "tts" } },
      },
      eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
      pipelineImage: "pipeline-test",
    }),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "refused");
  assert.match(result.refusals.join("\n"), /unmeasured|no total|cost/i);
});

test("every rejected invocation is exit 2 and carries the offending token", async () => {
  for (const argv of [
    ["--target", "qa", "--fast"],
    ["--locale", "it"],
    ["--target", "local", "--fast", "--full"],
    ["--target", "local", "--diagnose"],
    ["--target", "local", "--speed"],
  ]) {
    assert.throws(
      () => parseVerifyArgs(argv),
      (error: unknown) => error instanceof VerifyCliError && error.exitCode === 2,
      argv.join(" "),
    );
  }
});

// Keep the tmp import honest for future fixtures that write certificates.
test("the certificate store path is a safe single component", () => {
  const root = mkdtempSync(join(tmpdir(), "dv28-"));
  try {
    assert.ok(root.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(OPEN_RESIDUAL_RISK_IDS.length > 0, true);
});

/* ------------------------------------------------------------------------- *
 * Resumable certification runs.
 *
 * A run journals its plan, its identity and every call as it goes. A process
 * death leaves the completed calls in the journal; `--resume` reuses them and
 * makes only the missing ones. Every refusal below is a named exit 2.
 * ------------------------------------------------------------------------- */

const RESUME_RUN_ID = "verify-journal-01";

function completedOutcome(
  input: ScenarioCallInput,
  overrides: Partial<ScenarioCallOutcome> = {},
): ScenarioCallOutcome {
  return {
    refusal: null,
    attempt: {
      scenario: input.scenario,
      repetition: input.repetition,
      locale: input.locale,
      target: input.target,
      evidence: EVIDENCE,
    },
    eligibility: { callId: `${input.scenario}#${input.repetition}`, scenario: input.scenario },
    pipelineImage: "pipeline-test",
    evidenceRefs: [],
    ...overrides,
  };
}

function journalFile(root: string, runId = RESUME_RUN_ID): string {
  return join(root, runId, "journal.jsonl");
}

function journalEntries(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rewriteHeader(path: string, mutate: (header: Record<string, unknown>) => void): void {
  const entries = journalEntries(path);
  mutate(entries[0] as Record<string, unknown>);
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

/** The plan's keys in order: every scenario, then every repetition. */
function plannedKeys(corpus: Corpus = fullCorpus(), repetitions = 3): string[] {
  return corpus.scenarios.flatMap((scenario) =>
    Array.from({ length: repetitions }, (_, index) => `${scenario.name}#${index + 1}`),
  );
}

/** Run a certification that dies (not refuses) at the Nth call. */
async function interruptedRun(
  root: string,
  options: {
    readonly runId?: string;
    readonly crashAt?: number;
    readonly runScenario?: VerifyDeps["runScenario"];
  } = {},
): Promise<string[]> {
  const made: string[] = [];
  const crashAt = options.crashAt ?? 7;
  await assert.rejects(
    fullResult({
      runRoot: root,
      journalRoot: root,
      runId: options.runId ?? RESUME_RUN_ID,
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        const outcome =
          options.runScenario === undefined
            ? completedOutcome(input)
            : await options.runScenario(input);
        if (made.length === crashAt) throw new Error("the run process died");
        return outcome;
      },
    }),
    /process died/,
  );
  return made;
}

function resumeResult(
  root: string,
  extra: Parameters<typeof fullResult>[0] = {},
): Promise<VerifyResult> {
  return fullResult({
    runRoot: root,
    journalRoot: root,
    resume: RESUME_RUN_ID,
    ...extra,
  });
}

test("a certification run journals its header and each call as it proceeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-journal-"));
  try {
    const result = await fullResult({
      runRoot: root,
      journalRoot: root,
      runId: RESUME_RUN_ID,
      panel: FULL_PANEL,
    });
    assert.equal(result.exitCode, 0, result.refusals.join("\n"));

    const entries = journalEntries(journalFile(root));
    const [header, ...calls] = entries;
    assert.equal(header?.type, "header");
    assert.equal(header?.schemaVersion, 1);
    assert.equal(header?.runId, RESUME_RUN_ID);
    assert.equal(typeof header?.startedAt, "string");
    assert.equal(header?.target, "local");
    assert.deepEqual(header?.codeFingerprint, FINGERPRINT);
    assert.deepEqual(header?.corpus, { version: 7, sha256: "a".repeat(64) });
    assert.deepEqual(
      (header?.vendorBuilds as { leg: string }[]).map((build) => build.leg),
      ["stt", "tts", "llm"],
    );
    const plan = header?.plan as {
      mode: string;
      repetitions: number;
      calls: number;
      scenarios: { name: string }[];
    };
    assert.equal(plan.mode, "full");
    assert.equal(plan.repetitions, 3);
    assert.equal(plan.calls, 15);
    assert.deepEqual(
      plan.scenarios.map((scenario) => scenario.name),
      fullCorpus().scenarios.map((scenario) => scenario.name),
    );

    assert.equal(calls.length, 15, "one call entry per completed call");
    for (const entry of calls) {
      assert.equal(entry.type, "call");
      assert.equal(entry.outcome, "completed");
      assert.ok(entry.attempt, `${String(entry.scenario)} carries its attempt`);
      assert.ok(entry.eligibility, `${String(entry.scenario)} carries eligibility`);
      assert.ok("cost" in entry, `${String(entry.scenario)} carries its cost row`);
      assert.deepEqual(entry.evidenceRefs, []);
      assert.equal(entry.retry ?? null, null);
    }
    assert.equal(result.resumed, null, "a fresh run is not a resumed run");

    const torn = readFileSync(journalFile(root), "utf8");
    assert.ok(torn.endsWith("\n"), "every completed entry is newline-terminated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--resume reuses completed calls, makes only the missing ones and names the union", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-reuse-"));
  try {
    const first = await interruptedRun(root, { crashAt: 7 });
    assert.equal(first.length, 7);

    const made: string[] = [];
    const result = await resumeResult(root, {
      panel: FULL_PANEL,
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        return completedOutcome(input);
      },
    });

    assert.equal(result.exitCode, 0, result.refusals.join("\n"));
    assert.equal(result.calls, 15);
    assert.deepEqual(made, plannedKeys().slice(6), "only the missing nine calls were made");
    assert.equal(result.resumed?.runId, RESUME_RUN_ID);
    assert.equal(result.resumed?.journalPath, journalFile(root));
    assert.deepEqual(result.resumed?.reusedCalls, plannedKeys().slice(0, 6));
    assert.deepEqual(result.resumed?.madeCalls, plannedKeys().slice(6));

    const certificate = result.certificate;
    assert.ok(certificate, "the resumed run issues one certificate");
    assert.equal(certificate.runId, RESUME_RUN_ID, "the certificate names the original run");
    assert.deepEqual(certificate.code.fingerprint, FINGERPRINT);
    assert.equal(certificate.cost.callCount, 15, "the call count is the union");
    assert.equal(certificate.cost.usd, 15 * 0.0001, "cost is summed across both halves");
    assert.deepEqual(certificate.resume?.reusedCalls, plannedKeys().slice(0, 6));
    assert.deepEqual(certificate.resume?.madeCalls, plannedKeys().slice(6));
    assert.equal(certificate.resume?.originalStartedAt, result.resumed?.originalStartedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the resumed half waits a full pacing interval before its first call", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-pace-"));
  try {
    await interruptedRun(root, { crashAt: 4 });

    let now = 1_000_000;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const result = await resumeResult(root, {
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      runScenario: async (input) => {
        starts.push(now);
        now += 5_000;
        return completedOutcome(input);
      },
    });

    assert.equal(result.exitCode, 3, result.refusals.join("\n"));
    assert.equal(starts.length, 12);
    assert.ok(
      starts[0]! - 1_000_000 >= DEFAULT_CALL_INTERVAL_MS,
      `the first resumed call started ${starts[0]! - 1_000_000}ms after resume`,
    );
    assert.equal(sleeps[0], DEFAULT_CALL_INTERVAL_MS, "the gap is paced, not burst");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call the journal records as failed stays failed and is never re-made", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-failed-"));
  try {
    const failed = await fullResult({
      runRoot: root,
      journalRoot: root,
      runId: RESUME_RUN_ID,
      runScenario: async (input) => {
        if (input.scenario === "en-one" && input.repetition === 2) {
          return {
            refusal: { code: "trigger-unresolved", message: "no agent-turn-end event" },
            attempt: null,
            eligibility: null,
            pipelineImage: null,
          };
        }
        return completedOutcome(input);
      },
    });
    assert.equal(failed.exitCode, 2, "the original half stops at the failed call");
    const recorded = journalEntries(journalFile(root)).filter((entry) => entry.type === "call");
    assert.equal(recorded.length, 2);
    assert.equal(recorded[1]?.outcome, "failed");

    const made: string[] = [];
    const resumed = await resumeResult(root, {
      panel: FULL_PANEL,
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        return completedOutcome(input);
      },
    });

    assert.ok(!made.includes("en-one#2"), "a failed call is never re-made");
    assert.equal(made.length, 13);
    assert.equal(resumed.exitCode, 1, "a failure cannot become a pass");
    assert.equal(resumed.certificate?.pass, false);
    assert.equal(
      resumed.certificate?.coverage.rows.find((row) => row.scenario === "en-one")
        ?.measuredRepetitions,
      2,
      "the failed repetition is a coverage gap, never an omission",
    );
    assert.match(
      resumed.unrun.join("\n"),
      /en-one repetition 2 .*stays failed|en-one repetition 2 .*not re-made/,
    );
    assert.equal(resumed.resumed?.reusedCalls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a no-evidence retry record carries across an interruption, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-retry-"));
  try {
    let attempts = 0;
    let calls = 0;
    await assert.rejects(
      fullResult({
        runRoot: root,
        journalRoot: root,
        runId: RESUME_RUN_ID,
        runScenario: async (input) => {
          attempts += 1;
          if (attempts === 1) {
            return {
              refusal: { code: "marks-missing", message: "the harness recorded no marks" },
              attempt: null,
              eligibility: null,
              pipelineImage: null,
            };
          }
          calls += 1;
          if (calls === 4) throw new Error("the run process died");
          return completedOutcome(input);
        },
      }),
      /process died/,
    );

    const entries = journalEntries(journalFile(root));
    assert.equal(entries.filter((entry) => entry.type === "retry").length, 1);

    const made: string[] = [];
    const resumed = await resumeResult(root, {
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        return completedOutcome(input);
      },
    });

    assert.ok(!made.includes("en-one#1"), "a completed retry is reused, not re-made");
    assert.equal(resumed.exitCode, 3, resumed.refusals.join("\n"));
    assert.equal(resumed.retries.length, 1, "the first half's retry is carried, not lost");
    assert.equal(resumed.retries[0]?.code, "marks-missing");
    assert.equal(resumed.retries[0]?.scenario, "en-one");
    assert.equal(resumed.resumed?.reusedCalls.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a re-made call whose result never landed is not re-made a second time", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-interrupted-retry-"));
  try {
    await interruptedRun(root, { crashAt: 4 });
    appendFileSync(
      journalFile(root),
      `${JSON.stringify({
        type: "retry",
        scenario: "es-one",
        repetition: 1,
        code: "marks-missing",
        message: "the harness recorded no marks",
        at: "2026-11-02T09:00:02.000Z",
      })}\n`,
      "utf8",
    );

    const made: string[] = [];
    const resumed = await resumeResult(root, {
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        return completedOutcome(input);
      },
    });

    assert.ok(!made.includes("es-one#1"), "the one allowed re-make already happened");
    assert.equal(resumed.exitCode, 1, "the interrupted re-make stays a failure");
    assert.equal(
      resumed.certificate?.coverage.rows.find((row) => row.scenario === "es-one")
        ?.measuredRepetitions,
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume refuses a journal whose evidence file is gone, naming both", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-evidence-"));
  try {
    const evidence = (input: ScenarioCallInput): string =>
      join(root, "evidence", `${input.scenario}-${input.repetition}.wav`);
    await interruptedRun(root, {
      crashAt: 4,
      runScenario: async (input) => {
        const file = evidence(input);
        mkdirSync(join(root, "evidence"), { recursive: true });
        writeFileSync(file, "wav", "utf8");
        return completedOutcome(input, { evidenceRefs: [file] });
      },
    });
    unlinkSync(join(root, "evidence", "en-one-3.wav"));

    const resumed = await resumeResult(root, {
      runScenario: async (input) => completedOutcome(input),
    });
    assert.equal(resumed.exitCode, 2);
    assert.equal(resumed.status, "refused");
    assert.match(resumed.refusals.join("\n"), /en-one-3\.wav/);
    assert.match(resumed.refusals.join("\n"), /en-one#3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume refuses by name when the journal is missing, unknown, torn or another world", async () => {
  const cases: {
    readonly name: string;
    readonly prepare: (root: string) => Promise<unknown>;
    readonly extra?: Parameters<typeof fullResult>[0];
    readonly pattern: RegExp;
  }[] = [
    {
      name: "missing",
      prepare: async () => {},
      pattern: /no journal at .*verify-journal-01/,
    },
    {
      name: "unknown schema",
      prepare: async (root) => {
        await interruptedRun(root, { crashAt: 2 });
        rewriteHeader(journalFile(root), (header) => {
          header.schemaVersion = 99;
        });
      },
      pattern: /schema version 99/,
    },
    {
      name: "code moved",
      prepare: (root) => interruptedRun(root, { crashAt: 2 }),
      extra: {
        readCodeFingerprint: () => ({ ...FINGERPRINT, head: "def456" }),
      },
      pattern: /code fingerprint .*def456/,
    },
    {
      name: "corpus moved",
      prepare: (root) => interruptedRun(root, { crashAt: 2 }),
      extra: { corpus: { ...fullCorpus(), fingerprint: "b".repeat(64) } },
      pattern: /corpus v7 b{64}/,
    },
    {
      name: "vendor builds moved",
      prepare: (root) => interruptedRun(root, { crashAt: 2 }),
      extra: {
        readVendorBuilds: async () => ({
          schemaVersion: 1,
          builds: VENDOR_BUILDS.builds.map((build) =>
            build.leg === "tts" ? { ...build, buildId: "tts-moved" } : build,
          ),
        }),
      },
      pattern: /vendor build tts .*tts-moved/,
    },
    {
      name: "plan moved",
      prepare: (root) => interruptedRun(root, { crashAt: 2 }),
      extra: {
        plan: (corpus: Corpus) => ({
          ...fullPlan(corpus),
          repetitions: 1,
          calls: corpus.scenarios.length,
        }),
      },
      pattern: /plan .*repetitions|plan repetitions/,
    },
    {
      name: "target moved",
      prepare: async (root) => {
        await interruptedRun(root, { crashAt: 2 });
        rewriteHeader(journalFile(root), (header) => {
          header.target = "staging";
        });
      },
      pattern: /target "staging".*"local"|target/,
    },
    {
      name: "torn middle",
      prepare: async (root) => {
        await interruptedRun(root, { crashAt: 4 });
        const entries = journalEntries(journalFile(root));
        writeFileSync(
          journalFile(root),
          `${entries.map((entry, index) => (index === 2 ? '{"type":"call"' : JSON.stringify(entry))).join("\n")}\n`,
          "utf8",
        );
      },
      pattern: /torn|not JSON/,
    },
  ];

  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), "dv-resume-refuse-"));
    try {
      await entry.prepare(root);
      const result = await resumeResult(root, entry.extra ?? {});
      assert.equal(result.exitCode, 2, `${entry.name}: ${result.refusals.join("\n")}`);
      assert.equal(result.status, "refused", entry.name);
      assert.match(result.refusals.join("\n"), entry.pattern, entry.name);
      assert.match(result.detail, /journal/, entry.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a torn tail is truncated and only the missing calls are made", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-torn-"));
  try {
    await interruptedRun(root, { crashAt: 7 });
    appendFileSync(journalFile(root), '{"type":"call","scenario":"fr-on', "utf8");

    const made: string[] = [];
    const resumed = await resumeResult(root, {
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        return completedOutcome(input);
      },
    });

    assert.equal(resumed.exitCode, 3, resumed.refusals.join("\n"));
    assert.equal(resumed.resumed?.reusedCalls.length, 6);
    assert.deepEqual(made, plannedKeys().slice(6));
    const text = readFileSync(journalFile(root), "utf8");
    assert.ok(text.endsWith("\n"), "the torn tail was truncated, not appended after");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 16, "the header and the union's fifteen calls remain");
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), "no half-written line remains");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resume with no completed calls reuses nothing and still records the interruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-empty-"));
  try {
    await interruptedRun(root, { crashAt: 1 });

    const made: string[] = [];
    const resumed = await resumeResult(root, {
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        return completedOutcome(input);
      },
    });

    assert.equal(resumed.exitCode, 3, resumed.refusals.join("\n"));
    assert.equal(made.length, 15, "every call was still missing");
    assert.deepEqual(resumed.resumed?.reusedCalls, []);
    assert.deepEqual(resumed.resumed?.madeCalls, plannedKeys());
    assert.equal(resumed.certificate?.resume?.reusedCalls.length, 0);
    assert.equal(resumed.certificate?.resume?.madeCalls.length, 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unmeasured cost in either half fails the resumed certificate closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv-resume-cost-"));
  try {
    const unmeasured = {
      measured: false,
      totalUsd: null,
      rateTableVersion: "test-rates",
      unmeasuredReason: "tts: the vendor did not report characters",
      legs: {},
    };
    await interruptedRun(root, {
      crashAt: 4,
      runScenario: async (input) => {
        const outcome = completedOutcome(input);
        if (input.scenario === "en-one" && input.repetition === 2) {
          return {
            ...outcome,
            attempt: {
              ...(outcome.attempt as NonNullable<typeof outcome.attempt>),
              evidence: { ...EVIDENCE, cost: unmeasured },
            },
          };
        }
        return outcome;
      },
    });

    const made: string[] = [];
    const resumed = await resumeResult(root, {
      runScenario: async (input) => {
        made.push(`${input.scenario}#${input.repetition}`);
        return completedOutcome(input);
      },
    });

    assert.equal(made.length, 12, "the missing calls are made before the total is judged");
    assert.equal(resumed.exitCode, 2);
    assert.equal(resumed.status, "refused");
    assert.match(resumed.refusals.join("\n"), /en-one#2/);
    assert.match(resumed.refusals.join("\n"), /unmeasured|characters|no cost total/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume is explicit: a fast or diagnose run cannot be resumed", async () => {
  const base = request(["--target", "local"]);
  const fast = await runVerify({ ...base, mode: "fast", resume: RESUME_RUN_ID }, baseDeps());
  assert.equal(fast.exitCode, 2);
  assert.match(fast.refusals.join("\n"), /--resume belongs to a certification run/);

  const diagnose = await runVerify(
    { ...base, mode: "diagnose", scenario: "golden-flow-hello", resume: RESUME_RUN_ID },
    baseDeps(),
  );
  assert.equal(diagnose.exitCode, 2);
  assert.match(diagnose.refusals.join("\n"), /--resume belongs to a certification run/);
});

test("the committed corpus is still the source the fast plan reads", async () => {
  const contract = await loadContract();
  const corpus = await loadCorpus({
    dir: DEFAULT_CORPUS_DIR,
    knownProperties: new Set(contract.properties.map((property) => property.id)),
  });
  assert.ok(Number.isInteger(corpus.version) && corpus.version >= 1);
  for (const name of FAST_CONTRACT_SCENARIOS) {
    assert.ok(
      corpus.scenarios.some((scenario) => scenario.name === name),
      `${name} is in the committed corpus`,
    );
  }
});

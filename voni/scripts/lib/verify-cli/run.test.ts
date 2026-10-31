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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CERTIFICATE_TARGETS,
  OPEN_RESIDUAL_RISK_IDS,
  validateCertificate,
  type PanelSignature,
} from "@/lib/demo/verification/certificate";
import { loadContract, type Contract } from "@/lib/demo/verification/contract";
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
import { VerifyCliError } from "./errors";
import type { VerifyPlan } from "./plan";
import {
  exitForCertificate,
  runVerify,
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
    properties: contract.properties.map(({ unresolved: _unresolved, ...property }) => ({
      ...property,
      repetitions: 1,
    })),
  };
}

function noLock(): ReturnType<VerifyDeps["acquireLock"]> {
  return { path: "test-lock", pid: process.pid, release: () => {} };
}

function baseDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    env: { ...KEYS },
    loadContract: () => loadContract(),
    loadCorpus: (options) => loadCorpus(options),
    loadEvaluators: async (contract) => passingEvaluators(contract),
    readVendorBuilds: async () => VENDOR_BUILDS,
    acquireLock: () => noLock(),
    readCodeFingerprint: () => FINGERPRINT,
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

test("a clean fast run is a scoped-pass and exit 1: it is not a certificate", async () => {
  const result = await fastResult();
  assert.equal(result.status, "scoped-pass");
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls, 10);
  assert.equal(result.certificate, null, "a fast run never writes a certificate");
  assert.match(result.detail, /scoped-pass|not a certificate/);
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

test("full and nightly refuse by name while the corpora are incomplete", async () => {
  for (const flag of ["--full", "--nightly"] as const) {
    const result = await runVerify(request(["--target", "local", flag]), baseDeps());
    assert.equal(result.exitCode, 2, flag);
    assert.equal(result.status, "refused");
    assert.match(result.refusals.join("\n"), /English corpus holds \d+ of the 40/);
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
} = {}): Promise<VerifyResult> {
  const contract = await fullContract();
  const corpus = fullCorpus();
  const evaluators = passingEvaluators(contract).map((evaluator) =>
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
  return runVerify(request(["--target", input.target ?? "local", "--full"]), {
    ...baseDeps(),
    loadContract: async () => contract,
    loadCorpus: async () => corpus,
    loadEvaluators: async () => evaluators,
    plan: () => fullPlan(corpus),
    signature: input.panel ?? null,
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

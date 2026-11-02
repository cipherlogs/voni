/**
 * Ticket 17's acceptance, pinned end to end: one scenario, one certifying
 * browser call, one certificate or one named refusal; the delivered WAV, marks,
 * trace and end document cite one call id; a fake pipeline, a test build, a
 * missing key or a missing artifact is exit 2; the browser ceiling is a run
 * claim; and parity disagrees loudly.
 *
 * The browser call is fake here so the suite runs without Chromium, vendors or
 * a pipeline. The fake writes the same four artifacts the real stack writes,
 * and the verdict, certificate and cards are the production code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseReplayCommand } from "@/lib/demo/verification/cards";
import { runBrowserCertification, runReplayCommand, type BrowserRunInput } from "./runner";
import { loadSoundscapes } from "../soundscapes";
import {
  BROWSER_CALL_ID,
  FAKE_KEYS,
  fakeBrowserCall,
  fakeStackProbe,
  marksArtifact,
  probeContract,
  probeEvaluators,
  probeRunInput,
  removeTree,
  writeCorpus,
  type ScenarioSpec,
} from "./fixtures";
import type { BrowserCallResult } from "./types";
import type { Contract } from "@/lib/demo/verification/contract";
import resilienceModule from "@/lib/demo/verification/verdict/evaluators/resilience.evaluators";
import type { PropertyEvaluator, RunVerdict } from "@/lib/demo/verification/verdict";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv17-runner-"));
}

function corpus(root: string): string {
  return join(root, "corpus");
}

const GOLDEN: readonly ScenarioSpec[] = [{ name: "golden-flow-smoke" }];
const GOLDEN_AND_DELIBERATE: readonly ScenarioSpec[] = [
  { name: "golden-flow-smoke" },
  { name: "deliberate-failure" },
];

function input(
  root: string,
  overrides: Partial<Omit<BrowserRunInput, "corpusDir">> = {},
): BrowserRunInput {
  const eventsDir = join(root, "events");
  const capturesDir = join(root, "captures");
  return probeRunInput({
    corpusDir: corpus(root),
    runRoot: join(root, "runs"),
    eventsDir,
    capturesDir,
    call: async (callInput) =>
      fakeBrowserCall({
        scenario: callInput.scenario,
        eventsDir,
        capturesDir,
        runDir: callInput.runDir,
      }),
    ...overrides,
  });
}

function runJson(result: { runDir: string }): Record<string, unknown> {
  return JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

test("a held-out scenario is refused outside a full certification", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), [{ name: "sarcastic", heldOut: true }]);
    const result = await runBrowserCertification(
      input(root, { scenarioName: "sarcastic" }),
    );
    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "corpus-refused");
    assert.match(result.refusal?.message ?? "", /held out/);
  } finally {
    removeTree(root);
  }
});

test("a full certification plan lets a held-out scenario run", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), [{ name: "sarcastic", heldOut: true }]);
    const result = await runBrowserCertification(
      input(root, {
        scenarioName: "sarcastic",
        plan: { mode: "full", repetitions: 3 },
        certificate: "withhold",
      }),
    );
    assert.notEqual(result.refusal?.code, "corpus-refused");
  } finally {
    removeTree(root);
  }
});

test("a golden scenario runs once, writes a certificate bound to one call id, and waits for the human panel", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    let calls = 0;
    const result = await runBrowserCertification(
      input(root, {
        call: async (callInput) => {
          calls += 1;
          return fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
          });
        },
      }),
    );

    assert.equal(calls, 1, "one scenario is one call, never a retry");
    assert.equal(
      result.status,
      "not-demo-ready",
      "a one-scenario certificate is partial: four Locales have no scenario and are gap rows",
    );
    assert.equal(result.exitCode, 1, "a coverage gap is not a pass");
    assert.equal(result.verdict?.verdict, "certified");
    assert.ok(result.certificateFile !== null, "a completed run writes a certificate");
    const certificate = JSON.parse(
      readFileSync(result.certificateFile as string, "utf8"),
    ) as {
      verdict: string;
      pass: boolean;
      target: string;
      corpus: { version: number; sha256: string };
      code: { appBuild: string; pipelineImage: string };
      vendorBuilds: unknown[];
      cost: { usd: number; callCount: number };
      coverage: {
        gapRows: number;
        byLocale: { locale: string; status: string; gap: string | null }[];
      };
      properties: { propertyId: string; status: string }[];
    };
    assert.equal(certificate.verdict, "not-demo-ready");
    assert.equal(certificate.pass, false);
    assert.equal(certificate.target, "local");
    assert.equal(certificate.code.pipelineImage, "pipeline-build-1");
    assert.ok(certificate.code.appBuild.length > 0);
    assert.equal(certificate.vendorBuilds.length, 3);
    assert.equal(certificate.cost.usd, 0.012);
    assert.equal(certificate.cost.callCount, 1);
    assert.equal(certificate.coverage.gapRows, 0);
    assert.deepEqual(
      certificate.coverage.byLocale
        .filter((row) => row.status === "gap")
        .map((row) => row.locale),
      ["es", "fr", "de", "pt"],
      "an empty Locale is a named gap, never a measured row",
    );
    assert.deepEqual(
      certificate.properties.map((property) => [property.propertyId, property.status]),
      [["G1", "PASS"], ["E1", "PASS"]],
    );

    const record = runJson(result);
    assert.equal(record.adapter, "browser");
    assert.equal(record.certifiable, true, "the browser adapter is the certifying adapter");
    assert.equal(record.status, "not-demo-ready");

    const callDir = join(result.runDir, "calls", BROWSER_CALL_ID);
    for (const name of ["trace.jsonl", "end.json", "delivered.wav", "call-marks.json", "call.json"]) {
      assert.ok(existsSync(join(callDir, name)), `expected ${name} in the per-call directory`);
      assert.ok(statSync(join(callDir, name)).size > 0, `${name} must not be empty`);
    }

    const call = JSON.parse(readFileSync(join(callDir, "call.json"), "utf8")) as {
      callId: string;
      sameCallId: boolean;
      syntheticMic: { method: string; installedBeforeAppCode: boolean };
      files: { deliveredWav: string; marks: string; trace: string; end: string };
    };
    assert.equal(call.callId, BROWSER_CALL_ID);
    assert.equal(call.sameCallId, true);
    assert.equal(call.syntheticMic.method, "getUserMedia");
    assert.equal(call.syntheticMic.installedBeforeAppCode, true);
    assert.ok(call.files.deliveredWav.includes(BROWSER_CALL_ID));
    assert.ok(call.files.marks.includes(BROWSER_CALL_ID));
    assert.equal(call.files.trace, join(callDir, "trace.jsonl"));
    assert.equal(call.files.end, join(callDir, "end.json"));

    const marks = JSON.parse(readFileSync(call.files.marks, "utf8")) as { callId: string };
    const end = JSON.parse(readFileSync(call.files.end, "utf8")) as { callId: string };
    const trace = readFileSync(call.files.trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { callId: string });
    assert.equal(marks.callId, BROWSER_CALL_ID);
    assert.equal(end.callId, BROWSER_CALL_ID);
    assert.ok(trace.every((row) => row.callId === BROWSER_CALL_ID), "every trace row names the call");

    const budget = record.browserBudget as { status: string; measuredMs: number; ceilingS: number };
    assert.equal(budget.status, "within");
    assert.equal(budget.measuredMs, 12_000);
    assert.equal(budget.ceilingS, 120);
  } finally {
    removeTree(root);
  }
});

test("a caller that owns the run's one certificate withholds this call's, and keeps its attempt", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        certificate: "withhold",
        plan: { mode: "full", repetitions: 3 },
      }),
    );
    assert.equal(result.certificateFile, null, "no per-call certificate is written");
    assert.equal(result.attempt?.scenario, "golden-flow-smoke");
    assert.equal(result.attempt?.repetition, 1);
    assert.ok(result.attempt?.evidence.ledger, "the attempt carries the judged evidence");
    const record = runJson(result);
    assert.equal(record.certification, "withheld");
    assert.match(String(record.certificationReason), /withheld/);
    assert.equal(existsSync(join(result.runDir, "certificate.json")), false);
  } finally {
    removeTree(root);
  }
});

test("a deliberately failing scenario is a card, not a certificate pass", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const result = await runBrowserCertification(
      input(root, { scenarioName: "deliberate-failure" }),
    );

    assert.equal(result.status, "not-demo-ready");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.verdict?.failedPropertyIds, ["G1"]);
    assert.equal(result.cards.length, 1);
    const card = result.cards[0];
    assert.equal(card.propertyId, "G1");
    assert.equal(card.citation.session, BROWSER_CALL_ID);
    assert.equal(card.citation.turn, "1:reply");
    assert.equal(card.citation.audioExcerpts[0]?.media, "delivered-wav");
    assert.ok(card.citation.evidenceFiles.every((file) => existsSync(file)));

    const replay = parseReplayCommand(card.replayCommand);
    assert.equal(replay.scenario, "deliberate-failure");
    assert.equal(replay.target, "local");
    assert.equal(replay.locale, "en");
  } finally {
    removeTree(root);
  }
});

test("a fake pipeline is a named refusal with exit 2, before any call", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    let calls = 0;
    const result = await runBrowserCertification(
      input(root, {
        pipelineUrl: "https://pipeline.invalid",
        call: async () => {
          calls += 1;
          throw new Error("must not be called");
        },
      }),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.status, "refused");
    assert.equal(calls, 0, "the refusal happens before Chromium opens");
    const record = runJson(result);
    const refusal = record.refusal as { code: string; message: string };
    assert.equal(refusal.code, "fake-pipeline");
    assert.match(refusal.message, /fake host/);
    // The result carries the same named cause, so the CLI reports it instead
    // of an INFO gap that happens to precede it in `unrun`.
    assert.equal(result.refusal?.code, "fake-pipeline");
    assert.equal(result.refusal?.message, refusal.message);
    assert.equal(record.certificate, null);
    assert.equal(record.call, null);
  } finally {
    removeTree(root);
  }
});

test("a test build is a named refusal: the e2e seam can never certify", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, { env: { ...FAKE_KEYS, NEXT_PUBLIC_VONI_E2E_CAPTURE: "1" } }),
    );
    assert.equal(result.exitCode, 2);
    const refusal = runJson(result).refusal as { code: string };
    assert.equal(refusal.code, "test-build");
  } finally {
    removeTree(root);
  }
});

test("a missing vendor key is a named refusal", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, { env: { ASSEMBLYAI_API_KEY: "present" } }),
    );
    assert.equal(result.exitCode, 2);
    const refusal = runJson(result).refusal as { code: string; message: string };
    assert.equal(refusal.code, "missing-key");
    assert.match(refusal.message, /META_API_KEY/);
  } finally {
    removeTree(root);
  }
});

test("a missing vendor-build record is a named refusal (RR-03)", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, { vendorBuilds: null }),
    );
    assert.equal(result.exitCode, 2);
    const refusal = runJson(result).refusal as { code: string; message: string };
    assert.equal(refusal.code, "missing-vendor-build");
    assert.match(refusal.message, /vendor-builds/);
  } finally {
    removeTree(root);
  }
});

test("a missing delivered capture refuses to certify, by name", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            omitCapture: true,
          }),
      }),
    );
    assert.equal(result.exitCode, 2);
    const refusal = runJson(result).refusal as { code: string; message: string };
    assert.equal(refusal.code, "capture-missing");
    assert.match(refusal.message, /delivered capture/);
  } finally {
    removeTree(root);
  }
});

const R5_CONTRACT: Contract = {
  families: [{ id: "resilience", title: "Resilience", propertyCount: 1 }],
  properties: [
    {
      id: "R5",
      family: "resilience",
      statement: "Mic denied yields a named error state, no zombie call",
      bar: { text: "pass", numeric: false },
      evidence: "browser",
      kind: "behaviour",
      repetitions: 1,
      thresholds: [],
    },
  ],
};

const R5_EVALUATORS: readonly PropertyEvaluator[] = [
  ...resilienceModule.evaluators.filter((evaluator) => evaluator.propertyId === "R5"),
];

const NAMED_DENIAL: NonNullable<BrowserCallResult["edge"]> = {
  conditions: [
    {
      kind: "mic-denied",
      atMs: 0,
      applied: true,
      observed: "the denial named the microphone state (ended)",
    },
  ],
  hold: null,
  micDenied: {
    namedState: "Call didn't connect",
    errorText: "Voni needs your microphone for the call.",
    socketOpenAfterMs: 8_000,
    openSockets: 0,
    teardownObserved: true,
  },
  deviceSwitch: null,
  drain: null,
};

test("a mic-denied call certifies R5 from the named refusal, with no delivered capture", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), [
      {
        name: "resilience-mic-denied",
        expectedProperties: ["R5"],
        edge: [{ kind: "mic-denied", atMs: 0 }],
      },
    ]);
    const result = await runBrowserCertification({
      ...input(root, {
        scenarioName: "resilience-mic-denied",
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            omitCapture: true,
            edge: NAMED_DENIAL,
            marksOverride: {
              marks: marksArtifact(BROWSER_CALL_ID, "").marks.filter(
                (mark) => mark.name !== "delivered_capture",
              ),
            },
          }),
      }),
      contract: R5_CONTRACT,
      evaluators: R5_EVALUATORS,
    });

    assert.equal(result.refusal, null, "a denied mic is not a refused call");
    assert.equal(result.verdict?.properties[0]?.propertyId, "R5");
    assert.equal(
      result.verdict?.properties[0]?.status,
      "PASS",
      "R5 is judged from the harness's named refusal",
    );
    assert.equal(result.call?.files.deliveredWav, null);
    assert.equal(
      existsSync(join(result.runDir, "calls", BROWSER_CALL_ID, "delivered.wav")),
      false,
      "no capture was invented",
    );
  } finally {
    removeTree(root);
  }
});

test("a mic-denied call with no named refusal stays a named refusal, never a pass", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), [
      {
        name: "resilience-mic-denied",
        expectedProperties: ["R5"],
        edge: [{ kind: "mic-denied", atMs: 0 }],
      },
    ]);
    const result = await runBrowserCertification({
      ...input(root, {
        scenarioName: "resilience-mic-denied",
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            omitCapture: true,
            edge: {
              ...NAMED_DENIAL,
              micDenied: {
                ...NAMED_DENIAL.micDenied!,
                namedState: "",
                errorText: "NotAllowedError",
              },
            },
          }),
      }),
      contract: R5_CONTRACT,
      evaluators: R5_EVALUATORS,
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.refusal?.code, "mic-refusal-missing");
  } finally {
    removeTree(root);
  }
});

test("a missing marks artifact refuses to certify, by name", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            omitMarks: true,
          }),
      }),
    );
    assert.equal(result.exitCode, 2);
    const refusal = runJson(result).refusal as { code: string; message: string };
    assert.equal(refusal.code, "marks-missing");
    assert.match(refusal.message, /marks/);
    assert.match(
      refusal.message,
      new RegExp(BROWSER_CALL_ID),
      "the refusal names the call whose marks were lost",
    );
  } finally {
    removeTree(root);
  }
});

test("a marks artifact bound to another call id refuses; the four artifacts must agree", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            marksCallId: "33333333-3333-4333-8333-333333333333",
          }),
      }),
    );
    assert.equal(result.exitCode, 2);
    const refusal = runJson(result).refusal as { code: string; message: string };
    assert.equal(refusal.code, "call-id-mismatch");
    assert.match(refusal.message, /name call/);
  } finally {
    removeTree(root);
  }
});

test("an incomplete delivered capture refuses; a truncated WAV is not evidence", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            captureComplete: false,
          }),
      }),
    );
    assert.equal(result.exitCode, 2);
    const refusal = runJson(result).refusal as { code: string; message: string };
    assert.equal(refusal.code, "capture-incomplete");
    assert.match(refusal.message, /tap-timeout/);
  } finally {
    removeTree(root);
  }
});

test("an unmeasured cost withholds the certificate and records the reason, never a zero", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            costMeasured: false,
          }),
      }),
    );
    assert.equal(result.status, "not-demo-ready");
    assert.equal(result.exitCode, 1);
    assert.equal(result.certificateFile, null, "a certificate never carries a price the table did not give");
    const record = runJson(result);
    assert.equal(record.certification, "withheld");
    assert.match(String(record.certificationReason), /cost-missing/);
    assert.ok(
      result.unrun.some((line) => line.includes("certificate withheld")),
      "the withheld certificate is named on the run",
    );
    assert.ok(
      result.verdict !== null && result.verdict.properties.length > 0,
      "the verdict and cards survive a withheld certificate",
    );
  } finally {
    removeTree(root);
  }
});

test("an over-budget browser run cannot certify, even when every property passed", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        elapsedBudgetS: 5,
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
            elapsedMs: 12_000,
          }),
      }),
    );
    assert.equal(result.status, "not-demo-ready");
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.verdict?.failures.some((line) => line.includes("over-budget")),
      "the budget failure is a run failure, not a property",
    );
    const record = runJson(result);
    const budget = record.browserBudget as { status: string };
    assert.equal(budget.status, "over");
    const certificate = JSON.parse(
      readFileSync(result.certificateFile as string, "utf8"),
    ) as { verdict: string; pass: boolean };
    assert.equal(certificate.verdict, "not-demo-ready");
    assert.equal(certificate.pass, false);
  } finally {
    removeTree(root);
  }
});

test("a refused path with a declared ceiling records the budget unknown, never within", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(
      input(root, {
        elapsedBudgetS: 5,
        call: async () => {
          throw new Error("the harness never got a call");
        },
      }),
    );
    assert.equal(result.exitCode, 2);
    const budget = runJson(result).browserBudget as {
      status: string;
      measuredMs: number | null;
      line: string;
    };
    assert.equal(budget.status, "unknown", "an unmeasured budget is never within");
    assert.notEqual(budget.status, "within");
    assert.equal(budget.measuredMs, null);
    assert.match(budget.line, /not measured/);
    assert.match(budget.line, /INFO/);
    assert.ok(
      (runJson(result).unrun as string[]).includes(budget.line),
      "the unknown budget is recorded as INFO, not hidden",
    );
  } finally {
    removeTree(root);
  }
});

test("an open browser ceiling makes no runtime claim, never an invented one", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const result = await runBrowserCertification(input(root, { elapsedBudgetS: null }));
    const budget = runJson(result).browserBudget as { status: string; ceilingS: number | null };
    assert.equal(budget.status, "unset");
    assert.equal(budget.ceilingS, null);
    assert.equal(result.exitCode, 1, "the absent ceiling makes no evidence claim either way");
  } finally {
    removeTree(root);
  }
});

test("parity disagreement makes the run not-demo-ready and names the property", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const protocol = (status: "PASS" | "FAIL"): RunVerdict => ({
      runId: "protocol-run",
      verdict: "certified",
      certifiable: true,
      eligible: true,
      eligibility: { eligible: true, reasons: [], callCount: 1 },
      properties: [
        {
          propertyId: "G1",
          family: "conduct",
          statement: "probe",
          bar: "probe",
          barNumeric: false,
          kind: "deterministic",
          evidence: "ledger",
          status,
          reason: status === "PASS" ? "pass" : "below-bar",
          detail: "",
          sampleCount: 1,
          requiredRepetitions: 1,
          smallSample: false,
          summary: null,
          scenarios: [],
          checks: [],
          citations: ["turn:1:reply"],
          gaps: [],
        },
        {
          propertyId: "E1",
          family: "economics",
          statement: "probe",
          bar: "probe",
          barNumeric: true,
          kind: "deterministic",
          evidence: "cost",
          status: "PASS",
          reason: "pass",
          detail: "",
          sampleCount: 1,
          requiredRepetitions: 1,
          smallSample: false,
          summary: null,
          scenarios: [],
          checks: [],
          citations: ["cost.priced"],
          gaps: [],
        },
      ],
      failedPropertyIds: status === "PASS" ? [] : ["G1"],
      unknownPropertyIds: [],
      failures: [],
      sampleCount: 2,
      citations: [],
      detail: "",
    });
    const result = await runBrowserCertification(
      input(root, {
        scenarioName: "deliberate-failure",
        parityVerdict: protocol("PASS"),
        parityRunDir: join(root, "protocol-run"),
      }),
    );
    assert.equal(result.status, "not-demo-ready");
    assert.equal(result.exitCode, 1);
    assert.ok(result.parity !== null);
    assert.equal(result.parity?.agree, false);
    assert.equal(result.parity?.disagreements[0]?.kind, "protocol-more-permissive");
    assert.equal(result.parity?.disagreements[0]?.propertyId, "G1");
    assert.ok(
      result.verdict?.failures.some((line) => line.includes("parity")),
      "the disagreement is a run failure",
    );
  } finally {
    removeTree(root);
  }
});

test("a provider fallback on the call makes the run ineligible, never certified", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const result = await runBrowserCertification(
      input(root, {
        call: async (callInput) =>
          fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir,
            capturesDir,
            runDir: callInput.runDir,
            providerFallback: true,
          }),
      }),
    );
    assert.equal(result.status, "ineligible");
    assert.equal(result.exitCode, 1, "ineligible is never exit 0");
    assert.equal(result.verdict?.verdict, "ineligible");
    assert.equal(result.verdict?.certifiable, false);
    assert.match(result.verdict?.detail ?? "", /provider fallback/i);
    const certificate = result.certificateFile
      ? (JSON.parse(readFileSync(result.certificateFile, "utf8")) as {
          verdict: string;
          pass: boolean;
        })
      : null;
    assert.equal(certificate?.verdict, "ineligible", "a contaminated run is never certified");
    assert.equal(certificate?.pass, false);
    const run = runJson(result);
    assert.equal((run.certificate as { verdict: string }).verdict, "ineligible");
    assert.equal((run.certificate as { pass: boolean }).pass, false);
  } finally {
    removeTree(root);
  }
});

test("a committed television bed reaches the adapter and the call", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), [
      { name: "soundscape-television", soundscape: { id: "television", levelDb: -18 } },
    ]);
    const beds = loadSoundscapes();
    let mixed: Uint8Array | null | undefined;
    const result = await runBrowserCertification(
      input(root, {
        scenarioName: "soundscape-television",
        soundscapes: beds,
        call: async (callInput) => {
          mixed = callInput.soundscapePcm;
          return fakeBrowserCall({
            scenario: callInput.scenario,
            eventsDir: join(root, "events"),
            capturesDir: join(root, "captures"),
            runDir: callInput.runDir,
          });
        },
      }),
    );

    assert.notEqual(
      result.refusal?.code,
      "missing-soundscape",
      "the loaded bed satisfies preflight",
    );
    assert.ok(mixed instanceof Uint8Array, "the call receives the bed, not null");
    assert.equal(mixed.byteLength, beds.television.byteLength);
    assert.deepEqual(Buffer.from(mixed), Buffer.from(beds.television));
  } finally {
    removeTree(root);
  }
});

test("the runner accepts a defect card's replay command unchanged", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const eventsDir = join(root, "events");
    const capturesDir = join(root, "captures");
    const first = await runBrowserCertification(
      input(root, { scenarioName: "deliberate-failure" }),
    );
    const card = first.cards[0];
    assert.ok(card !== undefined);
    const replay = await runReplayCommand(card.replayCommand, {
      corpusDir: corpus(root),
      runRoot: join(root, "runs"),
      eventsDir,
      capturesDir,
      contract: probeContract(),
      evaluators: probeEvaluators(),
      env: FAKE_KEYS,
      appUrl: "http://127.0.0.1:3100",
      pipelineUrl: "https://localhost:8766",
      vendorBuilds: probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir,
        capturesDir,
      }).vendorBuilds,
      stackProbe: fakeStackProbe(),
      modules: probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir,
        capturesDir,
      }).modules,
      repoRoot: probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir,
        capturesDir,
      }).repoRoot,
      call: async (callInput) =>
        fakeBrowserCall({
          scenario: callInput.scenario,
          eventsDir,
          capturesDir,
          runDir: callInput.runDir,
        }),
    });
    assert.equal(replay.status, first.status);
    assert.equal(replay.corpus?.version, 1);
  } finally {
    removeTree(root);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContract, type Contract } from "../contract";
import {
  DEFAULT_CORPUS_DIR,
  FAST_CONTRACT_REPETITIONS,
  FAST_CONTRACT_SCENARIOS,
  ScenarioError,
  fastContractCoverage,
  fastContractScope,
  fastRunCeilingUsd,
  fastRunPlan,
  judgeFastRun,
  loadCorpus,
  scopeFastVerdict,
  sha256Hex,
  type Corpus,
} from "./index";
import type { FamilyId } from "../contract";
import type { RunVerdict } from "../verdict";

/**
 * Ticket 12's acceptance, pinned to the corpus and the contract.
 *
 * The corpus itself is asserted in `corpus.test.ts`; this file proves the fast
 * contract's shape: ten English scenarios at one repetition, the six call-path
 * capabilities covered by name, every family the set does not measure named out
 * of scope, and the run ceilings read from the frozen record instead of copied.
 */

const CONTRACT = loadContract();
const KNOWN = CONTRACT.then((contract) => new Set(contract.properties.map((entry) => entry.id)));

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A 24 kHz mono PCM16 WAV with a short tone, enough to be a hashed take. */
function wavBytes(durationMs = 80): Buffer {
  const samples = Math.round((durationMs / 1_000) * 24_000);
  const bytes = Buffer.alloc(44 + samples * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.write("RIFF", 0, "ascii");
  view.setUint32(4, 36 + samples * 2, true);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.write("data", 36, "ascii");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / 24_000) * 2_000), true);
  }
  return bytes;
}

type FixtureSpec = {
  readonly name: string;
  readonly class: string;
  readonly properties: readonly string[];
  readonly script: readonly { take: string; trigger: Record<string, unknown> }[];
  readonly locale?: string;
  readonly heldOut?: boolean;
};

/** The ten scenarios' shape without the TTS bytes; the committed corpus pins those. */
const SHAPE: readonly FixtureSpec[] = [
  {
    name: "golden-flow-hello",
    class: "golden-flow",
    properties: ["L4", "L7", "T1"],
    script: [
      { take: "hello", trigger: { type: "call-open" } },
      { take: "yes", trigger: { type: "agent-turn-end" } },
    ],
  },
  {
    name: "golden-flow-substantive",
    class: "golden-flow",
    properties: ["T2", "C1"],
    script: [
      { take: "ask", trigger: { type: "call-open" } },
      { take: "detail", trigger: { type: "agent-turn-end" } },
    ],
  },
  {
    name: "golden-flow-greeting-only",
    class: "golden-flow",
    properties: ["C2", "L4"],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
  },
  {
    name: "turn-taking-barge",
    class: "turn-taking",
    properties: ["T3", "T6", "T7"],
    script: [
      { take: "hello", trigger: { type: "call-open" } },
      { take: "barge", trigger: { type: "agent-speech-start", delayMs: 120 } },
      { take: "resume", trigger: { type: "agent-turn-end" } },
    ],
  },
  {
    name: "turn-taking-filler",
    class: "turn-taking",
    properties: ["T4", "T5"],
    script: [
      { take: "hello", trigger: { type: "call-open" } },
      { take: "filler", trigger: { type: "silence", silenceMs: 800 } },
      { take: "resume", trigger: { type: "agent-turn-end" } },
    ],
  },
  {
    name: "soundscape-quiet-room",
    class: "soundscape",
    properties: ["A3", "A8"],
    script: [{ take: "room", trigger: { type: "call-open" } }],
  },
  {
    name: "connectivity-jitter",
    class: "connectivity",
    properties: ["R1", "T7", "A6"],
    script: [
      { take: "hello", trigger: { type: "call-open" } },
      { take: "again", trigger: { type: "agent-turn-end" } },
    ],
  },
  {
    name: "tools-email-send",
    class: "tools",
    properties: ["X1", "X3", "X4", "C6"],
    script: [
      { take: "sent", trigger: { type: "call-open" } },
      { take: "tag", trigger: { type: "agent-turn-end" } },
    ],
  },
  {
    name: "ending-goodbye",
    class: "ending",
    properties: ["C7", "C8", "L9", "L11"],
    script: [
      { take: "hello", trigger: { type: "call-open" } },
      { take: "bye", trigger: { type: "agent-turn-end" } },
    ],
  },
  {
    name: "ending-caller-silence",
    class: "ending",
    properties: ["C1", "C7"],
    script: [
      { take: "hello", trigger: { type: "call-open" } },
      { take: "thanks", trigger: { type: "agent-turn-end" } },
    ],
  },
];

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dv12-fast-"));
  roots.push(root);
  return root;
}

process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeCorpus(specs: readonly FixtureSpec[] = SHAPE): string {
  const root = tempRoot();
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, version: 1 }));
  for (const spec of specs) {
    const directory = join(root, spec.name);
    mkdirSync(join(directory, "takes"), { recursive: true });
    const takes = [];
    for (const step of spec.script) {
      const audio = `takes/${step.take}.wav`;
      const bytes = wavBytes();
      writeFileSync(join(directory, audio), bytes);
      takes.push({ id: step.take, audio, sha256: sha256Hex(bytes), text: `spoken ${step.take}` });
    }
    const document = {
      schemaVersion: 1,
      name: spec.name,
      class: spec.class,
      locale: spec.locale ?? "en",
      heldOut: spec.heldOut ?? false,
      expectedProperties: spec.properties,
      soundscape: { id: "quiet-room" },
      faults: [],
      takes,
      script: spec.script,
    };
    writeFileSync(join(directory, "scenario.json"), JSON.stringify(document));
  }
  return root;
}

async function corpus(specs: readonly FixtureSpec[] = SHAPE): Promise<Corpus> {
  return loadCorpus({ dir: writeCorpus(specs), knownProperties: await KNOWN });
}

function replace(
  specs: readonly FixtureSpec[],
  name: string,
  change: Partial<FixtureSpec>,
): FixtureSpec[] {
  return specs.map((spec) => (spec.name === name ? { ...spec, ...change } : spec));
}

function assertRefusal(run: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ScenarioError, `expected ScenarioError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2, "a refusal is exit 2, never a skip");
    return true;
  });
}

// ── The ten-scenario plan ──────────────────────────────────────────────────

test("the fast plan selects the ten named English scenarios at one repetition", async () => {
  const plan = fastRunPlan(await corpus());
  assert.deepEqual(plan.scenarios, [...FAST_CONTRACT_SCENARIOS]);
  assert.equal(plan.locale, "en");
  assert.equal(plan.repetitions, FAST_CONTRACT_REPETITIONS);
  assert.equal(plan.repetitions, 1, "the fast contract runs one repetition");
  assert.equal(plan.calls, 10);
});

test("a missing fast scenario is refused by name, never run as nine", async () => {
  const partial = SHAPE.filter((spec) => spec.name !== "turn-taking-barge");
  const loaded = await corpus(partial);
  assertRefusal(() => fastRunPlan(loaded), "missing-fast-scenario", /turn-taking-barge/);
});

test("a held-out or non-English scenario cannot join the fast contract", async () => {
  const spanish = replace(SHAPE, "golden-flow-hello", { locale: "es" });
  const spanishCorpus = await corpus(spanish);
  assertRefusal(
    () => fastRunPlan(spanishCorpus),
    "fast-scenario-mismatch",
    /golden-flow-hello.*es/,
  );

  // The loader refuses a held-out mark on an unsealed name before the plan can
  // see it; the plan keeps its own check so a hand-built corpus cannot smuggle
  // a sealed scenario in.
  const loaded = await corpus();
  const sealedCorpus: Corpus = {
    ...loaded,
    scenarios: loaded.scenarios.map((scenario) =>
      scenario.name === "golden-flow-hello" ? { ...scenario, heldOut: true } : scenario,
    ),
  };
  assertRefusal(
    () => fastRunPlan(sealedCorpus),
    "fast-scenario-mismatch",
    /golden-flow-hello.*held out/,
  );
});

test("the plan names every call-path capability and the scenarios that cover it", async () => {
  const coverage = fastContractCoverage(await corpus());
  assert.deepEqual(
    coverage.map((entry) => entry.capability),
    ["greeting", "turn", "barge", "filler", "tool", "goodbye"],
  );
  const byCapability = new Map(coverage.map((entry) => [entry.capability, entry.scenarios]));
  assert.ok(byCapability.get("greeting")?.includes("golden-flow-hello"));
  assert.ok(byCapability.get("turn")?.includes("golden-flow-substantive"));
  assert.ok(byCapability.get("barge")?.includes("turn-taking-barge"));
  assert.ok(byCapability.get("filler")?.includes("turn-taking-filler"));
  assert.ok(byCapability.get("tool")?.includes("tools-email-send"));
  assert.ok(byCapability.get("goodbye")?.includes("ending-goodbye"));
});

test("a fast set that loses the barge capability is a named coverage gap", async () => {
  const noBarge = replace(SHAPE, "turn-taking-barge", {
    properties: ["T6", "T7"],
    script: [
      { take: "hello", trigger: { type: "call-open" } },
      { take: "resume", trigger: { type: "agent-turn-end" } },
    ],
  });
  const loaded = await corpus(noBarge);
  assertRefusal(
    () => fastContractCoverage(loaded),
    "fast-coverage-gap",
    /barge.*turn-taking-barge|turn-taking-barge.*barge/,
  );
});

// ── The scope ──────────────────────────────────────────────────────────────

const MEASURED: readonly FamilyId[] = [
  "lifecycle",
  "turn-taking",
  "conduct",
  "tools",
  "audio",
  "resilience",
];
const OUT_OF_SCOPE: readonly FamilyId[] = ["comprehension", "economics", "human", "security"];

test("the fast scope names every family it does not measure out of scope", async () => {
  const contract = await CONTRACT;
  const scope = fastContractScope(contract, await corpus());
  assert.deepEqual(scope.measuredFamilies, [...MEASURED].sort());
  assert.deepEqual(
    scope.outOfScopeFamilies.map((entry) => entry.family).sort(),
    [...OUT_OF_SCOPE].sort(),
  );
  for (const family of scope.outOfScopeFamilies) {
    assert.ok(family.propertyIds.length > 0, `${family.family} names no property`);
    assert.match(family.reason, /not measured by the fast contract/);
    const live = contract.families.find((entry) => entry.id === family.family);
    assert.equal(family.propertyIds.length, live?.propertyCount, `${family.family} hides a property`);
  }
  assert.ok(scope.measuredPropertyIds.includes("T3"));
  assert.ok(!scope.measuredPropertyIds.includes("K1"));
});

function verdictFor(
  contract: Contract,
  statuses: ReadonlyMap<string, "PASS" | "FAIL"> = new Map(),
  eligible = true,
): RunVerdict {
  const properties = contract.properties.map((property) => {
    const status = statuses.get(property.id) ?? "PASS";
    return {
      propertyId: property.id,
      family: property.family,
      statement: property.statement,
      bar: property.bar.text,
      barNumeric: property.bar.numeric,
      kind: property.kind,
      evidence: property.evidence,
      status,
      reason: status === "PASS" ? ("pass" as const) : ("below-bar" as const),
      detail: status === "PASS" ? "passed" : "below the bar",
      sampleCount: 1,
      requiredRepetitions: property.repetitions,
      smallSample: false,
      summary: null,
      scenarios: [],
      checks: [],
      citations: [],
      gaps: [],
    };
  });
  return {
    runId: "run-fast-test",
    verdict: eligible && properties.every((property) => property.status === "PASS") ? "certified" : "not-demo-ready",
    certifiable: eligible && properties.every((property) => property.status === "PASS"),
    eligible,
    eligibility: { eligible, reasons: eligible ? [] : ["a named fallback on the stt leg"], callCount: 10 },
    properties,
    failedPropertyIds: properties.filter((property) => property.status === "FAIL").map((property) => property.propertyId),
    unknownPropertyIds: [],
    failures: [],
    sampleCount: 10,
    citations: [],
    detail: "",
  };
}

test("a passing verdict never turns an unmeasured family green", async () => {
  const contract = await CONTRACT;
  const scoped = scopeFastVerdict({
    contract,
    corpus: await corpus(),
    verdict: verdictFor(contract),
  });
  assert.equal(scoped.verdict, "scoped-pass");
  assert.equal(scoped.certifiable, false, "a fast scope is never a certificate");
  assert.match(scoped.scopeNote, /not a certificate/);
  assert.deepEqual(
    scoped.outOfScopeFamilies.map((entry) => entry.family).sort(),
    [...OUT_OF_SCOPE].sort(),
  );
  for (const property of scoped.properties) {
    if (scoped.measuredPropertyIds.includes(property.propertyId)) {
      assert.equal(property.status, "PASS");
    } else {
      assert.equal(property.status, "OUT-OF-SCOPE", `${property.propertyId} was turned green`);
    }
  }
  assert.ok(scoped.unmeasuredPropertyIds.includes("H1"));
});

test("a failing in-scope property makes the scoped verdict not-demo-ready", async () => {
  const contract = await CONTRACT;
  const scoped = scopeFastVerdict({
    contract,
    corpus: await corpus(),
    verdict: verdictFor(contract, new Map([["T2", "FAIL"]])),
  });
  assert.equal(scoped.verdict, "not-demo-ready");
  assert.ok(scoped.failedPropertyIds.includes("T2"));
  assert.equal(scoped.properties.find((entry) => entry.propertyId === "T2")?.status, "FAIL");
  assert.equal(scoped.properties.find((entry) => entry.propertyId === "K1")?.status, "OUT-OF-SCOPE");
});

test("an ineligible call set stays ineligible even when every in-scope property passes", async () => {
  const contract = await CONTRACT;
  const scoped = scopeFastVerdict({
    contract,
    corpus: await corpus(),
    verdict: verdictFor(contract, new Map(), false),
  });
  assert.equal(scoped.verdict, "ineligible");
  assert.deepEqual(scoped.ineligibilityReasons, ["a named fallback on the stt leg"]);
});

// ── Run ceilings and timing ────────────────────────────────────────────────

test("the fast run cost ceiling is read from the contract's E3 record, not copied", async () => {
  const contract = await CONTRACT;
  assert.equal(fastRunCeilingUsd(contract), 2);
  const without = {
    ...contract,
    properties: contract.properties.map((property) =>
      property.id === "E3" ? { ...property, thresholds: [] } : property,
    ),
  };
  assertRefusal(() => fastRunCeilingUsd(without), "fast-ceiling-unset", /dvCostFastRunMaxUsd|E3/);
});

function calls(costUsd = 0.012): Array<{ scenario: string; costUsd: number }> {
  return FAST_CONTRACT_SCENARIOS.map((scenario) => ({ scenario, costUsd }));
}

test("ten calls at one repetition fit the fast plan; a missing call is refused by name", async () => {
  const contract = await CONTRACT;
  const loaded = await corpus();
  const report = judgeFastRun({
    contract,
    corpus: loaded,
    verdict: verdictFor(contract),
    calls: calls(),
    startedAt: "2026-10-31T10:00:00.000Z",
    endedAt: "2026-10-31T10:01:00.000Z",
  });
  assert.equal(report.calls, 10);
  assert.equal(report.timing.measuredCalls, 10);
  assert.equal(report.timing.fitsPlan, true);
  assert.equal(report.timing.elapsedMs, 60_000);
  assert.equal(report.economy.measuredUsd, 0.12);
  assert.equal(report.economy.withinCeiling, true);
  assert.equal(report.verdict, "scoped-pass");
  assert.equal(report.certifiable, false);

  assertRefusal(
    () =>
      judgeFastRun({
        contract,
        corpus: loaded,
        verdict: verdictFor(contract),
        calls: calls().slice(1),
        startedAt: "2026-10-31T10:00:00.000Z",
        endedAt: "2026-10-31T10:01:00.000Z",
      }),
    "fast-run-incomplete",
    /golden-flow-hello/,
  );
});

test("a run over the fast cost ceiling is not-demo-ready", async () => {
  const contract = await CONTRACT;
  const report = judgeFastRun({
    contract,
    corpus: await corpus(),
    verdict: verdictFor(contract),
    calls: calls(0.3),
    startedAt: "2026-10-31T10:00:00.000Z",
    endedAt: "2026-10-31T10:02:00.000Z",
  });
  assert.equal(report.economy.measuredUsd, 3);
  assert.equal(report.economy.withinCeiling, false);
  assert.equal(report.verdict, "not-demo-ready");
  assert.match(report.economy.detail, /3.*2|2.*3/);
});

test("an unmeasured call cost fails closed; it never fits a ceiling", async () => {
  const contract = await CONTRACT;
  const report = judgeFastRun({
    contract,
    corpus: await corpus(),
    verdict: verdictFor(contract),
    calls: calls().map((call) =>
      call.scenario === "tools-email-send" ? { ...call, costUsd: Number.NaN } : call,
    ),
    startedAt: "2026-10-31T10:00:00.000Z",
    endedAt: "2026-10-31T10:01:00.000Z",
  });
  assert.equal(report.economy.measuredUsd, null);
  assert.equal(report.economy.withinCeiling, false);
  assert.equal(report.verdict, "not-demo-ready");
  assert.match(report.economy.detail, /tools-email-send/);
});

test("wall-clock time is measured, and the unset numeric ceiling is a named gap", async () => {
  const contract = await CONTRACT;
  const report = judgeFastRun({
    contract,
    corpus: await corpus(),
    verdict: verdictFor(contract),
    calls: calls(),
    startedAt: "2026-10-31T10:00:00.000Z",
    endedAt: "2026-10-31T10:04:00.000Z",
  });
  assert.equal(report.timing.elapsedMs, 240_000);
  assert.ok(
    report.gaps.some((gap) => /wall-clock ceiling is unset/.test(gap)),
    "no made-up runtime number: the unset ceiling is recorded",
  );
});

test("the committed corpus is discovered at the default root with its ten fast takes", async () => {
  const contract = await CONTRACT;
  const loaded = await loadCorpus({
    dir: DEFAULT_CORPUS_DIR,
    knownProperties: new Set(contract.properties.map((property) => property.id)),
  });
  const fast = loaded.scenarios.filter((scenario) =>
    (FAST_CONTRACT_SCENARIOS as readonly string[]).includes(scenario.name),
  );
  assert.deepEqual(
    fast.map((scenario) => scenario.name).sort(),
    [...FAST_CONTRACT_SCENARIOS].sort(),
  );
  for (const scenario of fast) {
    assert.equal(scenario.locale, "en");
    assert.equal(scenario.heldOut, false);
    assert.ok(scenario.takes.length > 0);
    assert.ok(scenario.takes.every((take) => take.bytes > 44));
  }
});

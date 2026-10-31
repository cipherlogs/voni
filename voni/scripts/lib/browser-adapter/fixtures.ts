/**
 * Test fixtures for the browser adapter: a temp corpus, a probe contract and
 * evaluator set, a fake browser call that writes the same four artifacts the
 * real stack writes, and a stack probe that answers without a server.
 *
 * These are test-only records. They never stand in for the real browser, the
 * real pipeline or a vendor call.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { LoadedScenario } from "@/lib/demo/verification/scenarios";
import { evaluateTriggers } from "@/lib/demo/verification/scenarios";
import type { CallMarksArtifact } from "@/lib/voice/call-marks";

import {
  CLEAN_VENDOR_BUILDS,
  FAKE_KEYS,
  PROBE_MODULES,
  probeContract,
  probeEnd,
  probeEvaluators,
  probeTrace,
  wavBytes,
  writeCorpus,
  removeTree,
  type ScenarioSpec,
} from "../protocol-adapter/fixtures";
import type { BrowserRunInput } from "./runner";
import type {
  BrowserCallResult,
  BrowserStackProbe,
  BrowserStackProbeResponse,
} from "./types";

export {
  CLEAN_VENDOR_BUILDS,
  FAKE_KEYS,
  PROBE_MODULES,
  probeContract,
  probeEnd,
  probeEvaluators,
  probeTrace,
  removeTree,
  wavBytes,
  writeCorpus,
  type ScenarioSpec,
};

export const BROWSER_CALL_ID = "22222222-2222-4222-8222-222222222222";

const STAMP = "20261031-120000";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The stack the preflight probes: a healthy real-shaped service. */
export function fakeStackProbe(
  override: Partial<Record<string, BrowserStackProbeResponse>> = {},
): BrowserStackProbe {
  return async (method, url) => {
    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    const answer = override[key];
    if (answer !== undefined) return answer;
    if (method === "GET" && path === "/healthz") {
      return {
        status: 200,
        body: {
          status: "ok",
          service: "cascade",
          buildVersion: "pipeline-build-1",
          buildSource: "test",
          protocolVersion: 1,
        },
      };
    }
    if (method === "GET" && path === "/readyz") return { status: 200, body: { ready: true } };
    if (method === "GET" && path === "/") return { status: 200, body: "<html></html>" };
    if (method === "POST" && path === "/api/dev/call-marks") return { status: 400 };
    throw new Error(`unexpected probe ${key}`);
  };
}

/** One marks artifact bound to the call, with a complete delivered capture. */
export function marksArtifact(
  callId: string,
  captureName: string,
  overrides: Partial<CallMarksArtifact> = {},
): CallMarksArtifact {
  const started = Date.parse("2026-10-31T12:00:00.000Z");
  return {
    schemaVersion: 1,
    callId,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(started + 5_000).toISOString(),
    marks: [
      {
        name: "start_requested",
        at: new Date(started).toISOString(),
        epochMs: started,
        tMs: 0,
      },
      {
        name: "delivered_capture",
        at: new Date(started + 4_900).toISOString(),
        epochMs: started + 4_900,
        tMs: 4_900,
        detail: { name: captureName, complete: true },
      },
    ],
    ...overrides,
  };
}

/** The four artifacts the app and pipeline write for one call. */
export function writeBrowserEvidence(input: {
  readonly eventsDir: string;
  readonly capturesDir: string;
  readonly callId: string;
  readonly capturedMs?: number;
  readonly marksOverride?: Partial<CallMarksArtifact>;
  readonly captureComplete?: boolean;
  readonly captureCallIdInName?: string;
  readonly marksCallId?: string;
  readonly omitCapture?: boolean;
  readonly omitMarks?: boolean;
  readonly omitEnd?: boolean;
  readonly pricedUsd?: number;
  readonly costMeasured?: boolean;
}): { marksPath: string; capturePath: string } {
  mkdirSync(input.eventsDir, { recursive: true });
  mkdirSync(input.capturesDir, { recursive: true });
  const rows = probeTrace(input.callId, input.pricedUsd ?? 0.012);
  const priced = rows.find((row) => row.type === "cost.priced") as Record<string, unknown>;
  if (input.costMeasured === false) {
    priced.measured = false;
    priced.totalUsd = null;
    priced.unmeasuredReason = "the vendor did not report usage";
  }
  writeFileSync(
    join(input.eventsDir, `${input.callId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  if (input.omitEnd !== true) {
    const end = probeEnd(input.callId, input.pricedUsd ?? 0.012);
    if (input.costMeasured === false) {
      (end.cost as Record<string, unknown>).measured = false;
      (end.cost as Record<string, unknown>).totalUsd = null;
    }
    writeFileSync(
      join(input.eventsDir, `${input.callId}.end.json`),
      `${JSON.stringify(end, null, 2)}\n`,
    );
  }
  const captureName = `delivered-${input.captureCallIdInName ?? input.callId}-${STAMP}.wav`;
  const capturePath = join(input.capturesDir, captureName);
  if (input.omitCapture !== true) {
    writeFileSync(capturePath, wavBytes(input.capturedMs ?? 900));
  }
  const marksCallId = input.marksCallId ?? input.callId;
  const artifact = marksArtifact(marksCallId, captureName, input.marksOverride ?? {});
  if (input.captureComplete === false) {
    artifact.marks = artifact.marks.map((mark) =>
      mark.name === "delivered_capture"
        ? { ...mark, detail: { ...mark.detail, complete: false, reason: "tap-timeout" } }
        : mark,
    );
  }
  const marksPath = join(input.capturesDir, `call-marks-${marksCallId}.json`);
  if (input.omitMarks !== true) {
    writeFileSync(marksPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  return { marksPath, capturePath };
}

/** A fake browser call: writes the real artifacts and reports the harness facts. */
export function fakeBrowserCall(input: {
  readonly scenario: LoadedScenario;
  readonly eventsDir: string;
  readonly capturesDir: string;
  readonly runDir: string;
  readonly callId?: string;
  readonly elapsedMs?: number;
  readonly withEvidence?: (paths: { marksPath: string; capturePath: string }) => void;
  readonly omitMarks?: boolean;
  readonly omitCapture?: boolean;
  readonly omitEnd?: boolean;
  readonly captureComplete?: boolean;
  readonly marksCallId?: string;
  readonly captureCallIdInName?: string;
  readonly pricedUsd?: number;
  readonly costMeasured?: boolean;
  readonly endedBy?: BrowserCallResult["endedBy"];
  readonly installedBeforeAppCode?: boolean;
}): BrowserCallResult {
  const callId = input.callId ?? BROWSER_CALL_ID;
  const paths = writeBrowserEvidence({
    eventsDir: input.eventsDir,
    capturesDir: input.capturesDir,
    callId,
    omitMarks: input.omitMarks,
    omitCapture: input.omitCapture,
    omitEnd: input.omitEnd,
    captureComplete: input.captureComplete,
    marksCallId: input.marksCallId,
    captureCallIdInName: input.captureCallIdInName,
    pricedUsd: input.pricedUsd,
    costMeasured: input.costMeasured,
  });
  input.withEvidence?.(paths);
  const timeline = [
    { atMs: 0, type: "call-open" as const },
    { atMs: 420, type: "agent-speech-start" as const },
    { atMs: 2_100, type: "agent-speech-end" as const },
    { atMs: 2_100, type: "agent-turn-end" as const },
    { atMs: 5_000, type: "call-end" as const },
  ];
  const triggerPlan = evaluateTriggers(input.scenario.script, timeline);
  return {
    callId,
    voice: "jorg",
    subject: "demo:jorg",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(5_000).toISOString(),
    timeline: {
      events: timeline,
      spoken: [{ step: 0, take: input.scenario.script[0]?.take ?? "opening", atMs: 0 }],
    },
    triggerPlan,
    faultsApplied: [],
    syntheticMic: {
      method: "getUserMedia",
      installedAt: Date.parse("2026-10-31T11:59:59.000Z"),
      installedBeforeAppCode: input.installedBeforeAppCode ?? true,
      takesPlayed: [
        {
          step: 0,
          take: input.scenario.script[0]?.take ?? "opening",
          atMs: 0,
          durationMs: 900,
        },
      ],
      sampleRate: 48_000,
    },
    browser: {
      appUrl: "http://127.0.0.1:3100",
      pipelineWsUrl: "wss://localhost:8766/v1/browser-call",
      userAgent: "test-chromium",
      markCount: 2,
      captureName: `delivered-${callId}-${STAMP}.wav`,
    },
    marksPath: input.omitMarks === true ? null : paths.marksPath,
    capturePath: input.omitCapture === true ? null : paths.capturePath,
    endedBy: input.endedBy ?? "caller-hangup",
    error: null,
    tracePath: null,
    endPath: null,
    elapsedMs: input.elapsedMs ?? 12_000,
  };
}

/** The runner input a test uses: every stack fact is a fixture. */
export function probeRunInput(input: {
  readonly corpusDir: string;
  readonly runRoot: string;
  readonly eventsDir: string;
  readonly capturesDir: string;
  readonly scenarioName?: string;
  readonly call?: BrowserRunInput["call"];
  readonly env?: BrowserRunInput["env"];
  readonly vendorBuilds?: BrowserRunInput["vendorBuilds"];
  readonly appUrl?: string;
  readonly pipelineUrl?: string;
  readonly stackProbe?: BrowserStackProbe;
  readonly elapsedBudgetS?: number | null;
  readonly parityVerdict?: BrowserRunInput["parityVerdict"];
  readonly parityRunDir?: BrowserRunInput["parityRunDir"];
  readonly certificate?: BrowserRunInput["certificate"];
  readonly plan?: BrowserRunInput["plan"];
}): BrowserRunInput {
  return {
    scenarioName: input.scenarioName ?? "golden-flow-smoke",
    target: "local",
    corpusDir: input.corpusDir,
    contract: probeContract(),
    evaluators: probeEvaluators(),
    call: input.call,
    env: input.env ?? FAKE_KEYS,
    appUrl: input.appUrl ?? "http://127.0.0.1:3100",
    pipelineUrl: input.pipelineUrl ?? "https://localhost:8766",
    runRoot: input.runRoot,
    eventsDir: input.eventsDir,
    capturesDir: input.capturesDir,
    vendorBuilds:
      input.vendorBuilds === undefined ? CLEAN_VENDOR_BUILDS : input.vendorBuilds,
    soundscapes: {},
    modules: PROBE_MODULES,
    repoRoot: basename(process.cwd()) === "voni" ? resolve(process.cwd(), "..") : process.cwd(),
    elapsedBudgetS: input.elapsedBudgetS === undefined ? 120 : input.elapsedBudgetS,
    stackProbe: input.stackProbe ?? fakeStackProbe(),
    ...(input.parityVerdict === undefined ? {} : { parityVerdict: input.parityVerdict }),
    ...(input.parityRunDir === undefined ? {} : { parityRunDir: input.parityRunDir }),
    ...(input.certificate === undefined ? {} : { certificate: input.certificate }),
    ...(input.plan === undefined ? {} : { plan: input.plan }),
  };
}

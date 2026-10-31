/**
 * Test fixtures for the protocol adapter: a tiny hashed corpus, a probe
 * contract and evaluator set, and a fake call that writes the evidence the
 * real service writes.
 *
 * These are test-only records. They are never the committed English corpus
 * (ticket 12) and they never stand in for a vendor call.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  Contract,
  ContractPropertyEntry,
  ResolvedThreshold,
} from "@/lib/demo/verification/contract";
import {
  evaluateTriggers,
  type AgentTimelineEvent,
  type LoadedScenario,
  type Locale,
  type ScenarioClass,
} from "@/lib/demo/verification/scenarios";
import type {
  PropertyEvaluator,
  ScenarioAttempt,
} from "@/lib/demo/verification/verdict";

import type { ProtocolRunInput } from "./runner";
import type {
  ProtocolCallResult,
  ProtocolEvidenceBundle,
  VendorBuildRecord,
} from "./types";

export const CLEAN_VENDOR_BUILDS: VendorBuildRecord = {
  schemaVersion: 1,
  builds: [
    { leg: "stt", vendor: "meta", model: "streaming", buildId: "stt-build-1" },
    { leg: "tts", vendor: "assemblyai", model: "universal", buildId: "tts-build-1" },
    { leg: "llm", vendor: "meta", model: "muse-spark", buildId: "llm-build-1" },
  ],
};

export const FAKE_KEYS = {
  META_API_KEY: "test-meta",
  ASSEMBLYAI_API_KEY: "test-assembly",
  VOICE_PIPELINE_ENVELOPE_SECRET: "test-envelope",
  // The email-path scenarios refuse without these; a fake call never reads the
  // real inbox, so test values are enough for preflight.
  GOOGLE_CLIENT_ID: "test-google-client",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
  DEMO_INBOX_REFRESH_TOKEN: "test-inbox-refresh",
} as const;

export type ScenarioSpec = {
  readonly name: string;
  readonly locale?: Locale;
  readonly heldOut?: boolean;
  readonly class?: ScenarioClass;
  readonly expectedProperties?: readonly string[];
  readonly soundscape?: { id: string; levelDb?: number };
  readonly faults?: readonly {
    kind: "audio-dropout" | "network-jitter" | "endpoint-latency" | "call-drop";
    atMs: number;
    durationMs?: number;
  }[];
  readonly text?: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A 24 kHz mono PCM16 WAV with a quiet tone, enough to be a real take. */
export function wavBytes(durationMs = 120, frequency = 440): Uint8Array {
  const samples = Math.round((durationMs / 1_000) * 24_000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[at + index] = text.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / 24_000) * 8_000);
    view.setInt16(44 + index * 2, value, true);
  }
  return bytes;
}

/** Write one scenario directory; return its take WAV path and digest. */
export function writeScenario(
  root: string,
  spec: ScenarioSpec,
): { directory: string; takePath: string; sha256: string; text: string } {
  const directory = join(root, spec.name);
  mkdirSync(join(directory, "takes"), { recursive: true });
  const wav = wavBytes();
  const takePath = join(directory, "takes", "caller.wav");
  writeFileSync(takePath, wav);
  const text = spec.text ?? "Hi, is this Voni?";
  const scenario = {
    schemaVersion: 1,
    name: spec.name,
    class: spec.class ?? "golden-flow",
    locale: spec.locale ?? "en",
    heldOut: spec.heldOut ?? false,
    expectedProperties: spec.expectedProperties ?? ["G1", "E1"],
    soundscape: spec.soundscape ?? { id: "quiet-room" },
    faults: spec.faults ?? [],
    takes: [
      {
        id: "opening",
        audio: "takes/caller.wav",
        sha256: sha256(wav),
        text,
      },
    ],
    script: [{ take: "opening", trigger: { type: "call-open" } }],
  };
  writeFileSync(join(directory, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
  return { directory, takePath, sha256: sha256(wav), text };
}

/** Write a corpus root with a manifest and the named scenarios. */
export function writeCorpus(root: string, specs: readonly ScenarioSpec[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, version: 1 }, null, 2)}\n`,
  );
  for (const spec of specs) writeScenario(root, spec);
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

const E1_BAR: ResolvedThreshold = {
  source: "budget-record",
  key: "maxUsd",
  value: 0.05,
  unit: "usd",
};

export const G1: ContractPropertyEntry = {
  id: "G1",
  family: "conduct",
  statement: "The agent answers the caller's first question.",
  bar: { text: "answered", numeric: false },
  evidence: "ledger",
  kind: "deterministic",
  repetitions: 1,
  thresholds: [],
};

export const E1: ContractPropertyEntry = {
  id: "E1",
  family: "economics",
  statement: "The call stays inside its priced ceiling.",
  bar: { text: "total cost at most $0.05", numeric: true },
  evidence: "cost",
  kind: "deterministic",
  repetitions: 1,
  thresholds: [E1_BAR],
};

export function probeContract(): Contract {
  return {
    families: [
      { id: "conduct", title: "probe conduct", propertyCount: 1 },
      { id: "economics", title: "probe economics", propertyCount: 1 },
    ],
    properties: [G1, E1],
  };
}

/** The evaluator set: G1 fails only for the deliberate scenario. */
export function probeEvaluators(): PropertyEvaluator[] {
  return [
    {
      propertyId: "G1",
      bars: [],
      source: "probe.evaluators.ts",
      evaluate: (context) => {
        const failed = context.scenario === "deliberate-failure";
        return {
          kind: "measured",
          passed: !failed,
          citations: ["turn:1:reply"],
          detail: failed
            ? "the agent did not answer the caller's first question"
            : "the agent answered",
        };
      },
    },
    {
      propertyId: "E1",
      bars: [{ key: "maxUsd", statistic: "max", comparison: "at-most" }],
      source: "probe.evaluators.ts",
      evaluate: (context) => {
        const source = context.source as Record<string, unknown>;
        const usd = source.totalUsd;
        if (typeof usd !== "number") {
          return { kind: "unmeasured", reason: "the priced row has no totalUsd" };
        }
        return {
          kind: "measured",
          samples: [usd],
          citations: ["cost.priced"],
        };
      },
    },
  ];
}

/** One probe contract's module pointers, relative to the repository root. */
export const PROBE_MODULES = {
  G1: ["voni/package.json"],
  E1: ["voni/package.json"],
} as const;

/** The trace rows a real cascade call writes, reduced to the evidence shapes. */
export function probeTrace(callId: string, pricedUsd = 0.012): Record<string, unknown>[] {
  const subject = "demo:audrey";
  return [
    {
      schemaVersion: 1,
      pipeline: "cascade",
      callId,
      type: "call.open",
      subject,
      atMs: 0,
      phase: "connect",
    },
    {
      schemaVersion: 1,
      pipeline: "cascade",
      callId,
      type: "turn.user_final",
      subject,
      turn: "1:user",
      atMs: 300,
      phase: "turn",
      chars: 18,
      empty: false,
      wantsEnd: false,
    },
    {
      schemaVersion: 1,
      pipeline: "cascade",
      callId,
      type: "turn.reply_start",
      subject,
      turn: "1:reply",
      atMs: 340,
      phase: "turn",
    },
    {
      schemaVersion: 1,
      pipeline: "cascade",
      callId,
      type: "turn.first_audio",
      subject,
      turn: "1:reply",
      atMs: 520,
      phase: "turn",
      seq: 0,
    },
    {
      schemaVersion: 1,
      pipeline: "cascade",
      callId,
      type: "cost.priced",
      subject,
      leg: "llm",
      atMs: 1_100,
      phase: "end",
      measured: true,
      producer: "cascade.cost.cost_call",
      rateTableVersion: "rates-1",
      totalUsd: pricedUsd,
    },
    {
      schemaVersion: 1,
      pipeline: "cascade",
      callId,
      type: "end",
      subject,
      atMs: 1_200,
      phase: "end",
      endedBy: "caller_end",
      metrics: { marks: {} },
      providers: {},
      cost: { totalUsd: pricedUsd },
      eligibility: {},
      turns: 1,
      drain: {},
      bounds: [],
    },
  ];
}

export function probeEnd(callId: string, pricedUsd = 0.012): Record<string, unknown> {
  return {
    type: "end",
    callId,
    metrics: { marks: {} },
    providers: {},
    cost: { totalUsd: pricedUsd },
    eligibility: {},
    turns: 1,
    endedBy: "caller_end",
    drain: {},
    bounds: [],
  };
}

/** Write the service's trace and end sidecar where the adapter reads them. */
export function writeServiceEvidence(input: {
  readonly eventsDir: string;
  readonly callId: string;
  readonly rows?: readonly Record<string, unknown>[];
  readonly end?: Record<string, unknown> | null;
  readonly pricedUsd?: number;
}): void {
  mkdirSync(input.eventsDir, { recursive: true });
  const rows = input.rows ?? probeTrace(input.callId, input.pricedUsd);
  writeFileSync(
    join(input.eventsDir, `${input.callId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  if (input.end !== null) {
    writeFileSync(
      join(input.eventsDir, `${input.callId}.end.json`),
      `${JSON.stringify(input.end ?? probeEnd(input.callId, input.pricedUsd), null, 2)}\n`,
    );
  }
}

/** A fake call: writes evidence and returns the transport's observation. */
export function fakeCall(input: {
  readonly callId: string;
  readonly scenario: LoadedScenario;
  readonly eventsDir: string;
  readonly rows?: readonly Record<string, unknown>[];
  readonly end?: Record<string, unknown> | null;
  readonly pricedUsd?: number;
  readonly receivedMs?: number;
  readonly endedBy?: ProtocolCallResult["endedBy"];
}): ProtocolCallResult {
  writeServiceEvidence({
    eventsDir: input.eventsDir,
    callId: input.callId,
    ...(input.rows === undefined ? {} : { rows: input.rows }),
    ...(input.end === undefined ? {} : { end: input.end }),
    ...(input.pricedUsd === undefined ? {} : { pricedUsd: input.pricedUsd }),
  });
  const timeline: AgentTimelineEvent[] = [
    { atMs: 0, type: "call-open" },
    { atMs: 40, type: "agent-speech-start" },
    { atMs: 600, type: "agent-speech-end" },
    { atMs: 600, type: "agent-turn-end" },
    { atMs: 1_200, type: "call-end" },
  ];
  const plan = evaluateTriggers(input.scenario.script, timeline);
  const received = wavBytes(input.receivedMs ?? 900);
  const pcm = received.subarray(44);
  return {
    callId: input.callId,
    voice: "audrey",
    subject: "demo:audrey",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1_200).toISOString(),
    timeline: { events: timeline, spoken: [{ step: 0, take: "opening", atMs: 0 }] },
    triggerPlan: plan,
    faultsApplied: [],
    caller: { frames: 225, bytes: 57_600, frameBytes: 256 },
    received: { pcm, sampleRate: 24_000, frames: Math.floor(pcm.length / 256), bytes: pcm.length },
    captions: [],
    endedBy: input.endedBy ?? "end",
    error: null,
    tracePath: null,
    endPath: null,
  };
}

/** The runner input a test uses: every vendor-shaped fact is a fixture. */
export function probeRunInput(input: {
  readonly corpusDir: string;
  readonly runRoot: string;
  readonly eventsDir: string;
  readonly scenarioName?: string;
  readonly call?: ProtocolRunInput["call"];
  readonly modules?: ProtocolRunInput["modules"];
  readonly env?: ProtocolRunInput["env"];
  readonly vendorBuilds?: VendorBuildRecord | null;
  readonly soundscapes?: ProtocolRunInput["soundscapes"];
}): ProtocolRunInput {
  return {
    scenarioName: input.scenarioName ?? "golden-flow-smoke",
    target: "local",
    corpusDir: input.corpusDir,
    contract: probeContract(),
    evaluators: probeEvaluators(),
    call: input.call,
    env: input.env ?? FAKE_KEYS,
    targetUrl: { baseUrl: "http://127.0.0.1:8767" },
    runRoot: input.runRoot,
    eventsDir: input.eventsDir,
    ...(input.vendorBuilds === undefined
      ? { vendorBuilds: CLEAN_VENDOR_BUILDS }
      : { vendorBuilds: input.vendorBuilds }),
    soundscapes: input.soundscapes ?? {},
    modules: input.modules ?? PROBE_MODULES,
    repoRoot: basename(process.cwd()) === "voni" ? resolve(process.cwd(), "..") : process.cwd(),
    endWaitMs: 0,
    callId: "11111111-1111-4111-8111-111111111111",
  };
}

/** A bundle with the evidence a property evaluator may read. */
export type ProbeBundle = ProtocolEvidenceBundle;

/** A direct evaluator attempt for engine-level tests. */
export function attempt(
  bundle: ProtocolEvidenceBundle,
  scenario = "golden-flow-smoke",
): ScenarioAttempt {
  return { scenario, repetition: 1, locale: "en", target: "local", evidence: bundle };
}

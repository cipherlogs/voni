/**
 * Evidence assembly: what the runner writes, what it refuses to invent, and
 * what a card does when the verdict cannot point at a session or a turn.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProtocolAdapterError } from "./errors";
import { runProtocolDiagnosis } from "./runner";
import {
  fakeCall,
  probeEvaluators,
  probeRunInput,
  probeTrace,
  removeTree,
  writeCorpus,
  type ScenarioSpec,
} from "./fixtures";

const SCENARIOS: readonly ScenarioSpec[] = [
  { name: "golden-flow-smoke" },
  { name: "deliberate-failure" },
];

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv11-evidence-"));
}

function runJson(result: { runDir: string }): Record<string, unknown> {
  return JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

test("a missing end sidecar falls back to the persisted end row and records the gap", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, SCENARIOS);
    const eventsDir = join(root, "events");
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir,
        runRoot: join(root, "runs"),
        eventsDir,
        call: async (input) =>
          fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir, end: null }),
      }),
    );

    assert.equal(result.status, "clean-diagnosis");
    const call = JSON.parse(
      readFileSync(join(result.runDir, "calls", inputCallId(result), "call.json"), "utf8"),
    ) as { files: { end: string | null }; evidenceGaps: string[] };
    assert.equal(call.files.end, null);
    assert.ok(
      (runJson(result).unrun as string[]).some((line) => /end sidecar is missing/.test(line)),
    );
  } finally {
    removeTree(root);
  }
});

test("a missing priced row fails the cost property and is recorded, never recomputed", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, SCENARIOS);
    const eventsDir = join(root, "events");
    const rows = probeTrace("11111111-1111-4111-8111-111111111111").filter(
      (row) => row.type !== "cost.priced",
    );
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir,
        runRoot: join(root, "runs"),
        eventsDir,
        call: async (input) =>
          fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir, rows }),
      }),
    );

    assert.equal(result.status, "findings");
    assert.deepEqual(result.verdict?.failedPropertyIds, ["E1"]);
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0]?.propertyId, "E1");
    assert.equal(result.cards[0]?.citation.turn, null);
    assert.equal(result.cards[0]?.citation.turnAbsence !== null, true);
    assert.ok(
      (runJson(result).unrun as string[]).some((line) => /no cost\.priced row/.test(line)),
    );
  } finally {
    removeTree(root);
  }
});

test("no received PCM means no WAV and an explicit gap, never an empty audio file", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, SCENARIOS);
    const eventsDir = join(root, "events");
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir,
        runRoot: join(root, "runs"),
        eventsDir,
        call: async (input) => {
          const call = fakeCall({
            callId: input.callId,
            scenario: input.scenario,
            eventsDir,
          });
          return {
            ...call,
            received: { pcm: new Uint8Array(), sampleRate: 24_000, frames: 0, bytes: 0 },
          };
        },
      }),
    );

    const callDir = join(result.runDir, "calls", inputCallId(result));
    assert.equal(existsSync(join(callDir, "received.wav")), false);
    const call = JSON.parse(readFileSync(join(callDir, "call.json"), "utf8")) as {
      files: { receivedWav: string | null };
    };
    assert.equal(call.files.receivedWav, null);
    assert.ok(
      (runJson(result).unrun as string[]).some((line) => /no agent audio/.test(line)),
    );
  } finally {
    removeTree(root);
  }
});

test("a failed card without a module pointer is withheld by name, not rendered", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, SCENARIOS);
    const eventsDir = join(root, "events");
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir,
        runRoot: join(root, "runs"),
        eventsDir,
        scenarioName: "deliberate-failure",
        modules: {},
        call: async (input) =>
          fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir }),
      }),
    );

    assert.equal(result.status, "findings");
    assert.equal(result.cards.length, 0);
    assert.equal(result.cardGaps[0]?.propertyId, "G1");
    assert.equal(result.cardGaps[0]?.code, "no-module");
    assert.equal((runJson(result).cards as { count: number }).count, 0);
  } finally {
    removeTree(root);
  }
});

test("a turn citation that the ledger does not carry is an attribution gap", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, SCENARIOS);
    const eventsDir = join(root, "events");
    const evaluators = probeEvaluators().map((evaluator) =>
      evaluator.propertyId === "G1"
        ? {
            ...evaluator,
            evaluate: () => ({
              kind: "measured" as const,
              passed: false,
              citations: ["turn:9:reply"],
            }),
          }
        : evaluator,
    );
    const result = await runProtocolDiagnosis({
      ...probeRunInput({
        corpusDir,
        runRoot: join(root, "runs"),
        eventsDir,
        scenarioName: "deliberate-failure",
        call: async (input) =>
          fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir }),
      }),
      evaluators,
    });

    assert.equal(result.cards.length, 0);
    assert.equal(result.cardGaps[0]?.code, "no-attribution");
    assert.match(result.cardGaps[0]?.detail ?? "", /cites no turn from this call/);
  } finally {
    removeTree(root);
  }
});

test("an unsafe run id is refused before a directory is created", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, SCENARIOS);
    await assert.rejects(
      runProtocolDiagnosis({
        ...probeRunInput({
          corpusDir,
          runRoot: join(root, "runs"),
          eventsDir: join(root, "events"),
        }),
        runId: "../escape",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolAdapterError);
        assert.equal(error.code, "run-dir-invalid");
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
  } finally {
    removeTree(root);
  }
});

function inputCallId(result: { call: { callId: string } | null }): string {
  const callId = result.call?.callId;
  assert.ok(callId !== undefined);
  return callId;
}

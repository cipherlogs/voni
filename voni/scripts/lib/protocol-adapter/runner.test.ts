/**
 * Ticket 11's acceptance, pinned end to end: one scenario, one call, one
 * verdict, one run directory; a deliberate failure produces a replayable card;
 * every startup gap is a named refusal; and a failing call is never retried.
 *
 * The call is fake here so the suite runs without vendors. The fake writes the
 * same trace, end sidecar, priced row and received PCM the real service writes,
 * and the verdict, cards and run directory are the production code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseReplayCommand } from "@/lib/demo/verification/cards";
import { loadCorpus } from "@/lib/demo/verification/scenarios";
import { runProtocolDiagnosis, runReplayCommand } from "./runner";
import {
  CLEAN_VENDOR_BUILDS,
  FAKE_KEYS,
  fakeCall,
  probeRunInput,
  probeTrace,
  removeTree,
  writeCorpus,
  writeServiceEvidence,
  type ScenarioSpec,
} from "./fixtures";
import type { ProtocolRunInput } from "./runner";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv11-runner-"));
}

function corpus(root: string): string {
  return join(root, "corpus");
}

const GOLDEN_AND_DELIBERATE: readonly ScenarioSpec[] = [
  { name: "golden-flow-smoke" },
  { name: "deliberate-failure" },
];

function runJson(result: { runDir: string }): Record<string, unknown> {
  return JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

test("a golden scenario runs once, writes its evidence and produces a clean diagnosis", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const eventsDir = join(root, "events");
    let calls = 0;
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir,
        call: async (input) => {
          calls += 1;
          return fakeCall({
            callId: input.callId,
            scenario: input.scenario,
            eventsDir,
          });
        },
      }),
    );

    assert.equal(calls, 1, "one scenario is one call, never a retry");
    assert.equal(result.status, "clean-diagnosis");
    assert.equal(result.exitCode, 1, "a diagnosis is never exit 0, which is reserved for a certificate");
    assert.equal(result.verdict?.verdict, "certified");
    assert.equal(result.cards.length, 0);

    const record = runJson(result);
    assert.equal(record.adapter, "protocol");
    assert.equal(record.certifiable, false, "the protocol adapter can never certify");
    assert.equal(record.certification, "withheld");

    const callDir = join(result.runDir, "calls", "11111111-1111-4111-8111-111111111111");
    for (const name of ["trace.jsonl", "end.json", "received.wav", "call.json"]) {
      assert.ok(existsSync(join(callDir, name)), `expected ${name} in the per-run directory`);
      assert.ok(statSync(join(callDir, name)).size > 0, `${name} must not be empty`);
    }
    assert.ok(existsSync(join(result.runDir, "verdict.json")));
    assert.ok(existsSync(join(result.runDir, "run.json")));

    const received = readFileSync(join(callDir, "received.wav"));
    assert.equal(received.toString("ascii", 0, 4), "RIFF");
    assert.ok(received.length > 44, "the received PCM is saved, not just counted");

    const verdict = JSON.parse(readFileSync(join(result.runDir, "verdict.json"), "utf8")) as {
      properties: { propertyId: string; status: string; citations: string[] }[];
    };
    assert.equal(verdict.properties.find((entry) => entry.propertyId === "E1")?.status, "PASS");
    assert.equal(verdict.properties.find((entry) => entry.propertyId === "G1")?.status, "PASS");

    const call = JSON.parse(readFileSync(join(callDir, "call.json"), "utf8")) as {
      callerFrameBytes: number;
      receivedBytes: number;
      triggerPlan: { unresolved: unknown[] };
      files: { trace: string; end: string; receivedWav: string };
    };
    assert.equal(call.callerFrameBytes, 256, "caller audio uses the browser's 128-sample frame");
    assert.ok(call.receivedBytes > 0);
    assert.deepEqual(call.triggerPlan.unresolved, []);
    assert.equal(call.files.trace, join(callDir, "trace.jsonl"));
  } finally {
    removeTree(root);
  }
});

test("a deliberately failing scenario fails for its intended reason and yields a replayable card", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const eventsDir = join(root, "events");
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir,
        scenarioName: "deliberate-failure",
        call: async (input) =>
          fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir }),
      }),
    );

    assert.equal(result.status, "findings");
    assert.equal(result.verdict?.verdict, "not-demo-ready");
    assert.deepEqual(result.verdict?.failedPropertyIds, ["G1"]);
    assert.equal(result.cards.length, 1, "the failure is not explained away");
    const card = result.cards[0];
    assert.equal(card.propertyId, "G1");
    assert.equal(card.verdictReason, "below-bar");
    assert.equal(card.citation.session, "11111111-1111-4111-8111-111111111111");
    assert.equal(card.citation.turn, "1:reply");
    assert.equal(card.citation.audioExcerpts.length, 1);
    assert.equal(card.citation.audioExcerpts[0]?.media, "delivered-wav");
    assert.ok(card.citation.evidenceFiles.every((file) => existsSync(file)));

    const replay = parseReplayCommand(card.replayCommand);
    assert.equal(replay.scenario, "deliberate-failure");
    assert.equal(replay.target, "local");
    assert.equal(replay.locale, "en");
    assert.equal(replay.mode, "diagnose");

    assert.ok(existsSync(join(result.runDir, "cards.json")));
    assert.ok(existsSync(join(result.runDir, "cards.md")));
    const record = runJson(result);
    const cards = record.cards as { count: number; gaps: unknown[] };
    assert.equal(cards.count, 1);
    assert.deepEqual(cards.gaps, []);
  } finally {
    removeTree(root);
  }
});

test("every startup gap is a named refusal with exit 2 and no call", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const eventsDir = join(root, "events");

    const cases: {
      readonly name: string;
      readonly input: ProtocolRunInput;
      readonly expected: RegExp;
    }[] = [
      {
        name: "key",
        input: probeRunInput({
          corpusDir: corpus(root),
          runRoot: join(root, "runs-key"),
          eventsDir,
          env: { ...FAKE_KEYS, META_API_KEY: "" },
        }),
        expected: /META_API_KEY/,
      },
      {
        name: "corpus",
        input: probeRunInput({
          corpusDir: join(root, "no-corpus"),
          runRoot: join(root, "runs-corpus"),
          eventsDir,
        }),
        expected: /corpus:.*no-corpus/,
      },
      {
        name: "scenario",
        input: probeRunInput({
          corpusDir: corpus(root),
          runRoot: join(root, "runs-scenario"),
          eventsDir,
          scenarioName: "not-in-the-corpus",
        }),
        expected: /scenario:not-in-the-corpus/,
      },
      {
        name: "vendor build",
        input: probeRunInput({
          corpusDir: corpus(root),
          runRoot: join(root, "runs-vendor"),
          eventsDir,
          vendorBuilds: {
            schemaVersion: 1,
            builds: CLEAN_VENDOR_BUILDS.builds.filter((build) => build.leg !== "tts"),
          },
        }),
        expected: /vendor-build:tts/,
      },
      {
        name: "soundscape",
        input: probeRunInput({
          corpusDir: join(root, "corpus-street"),
          runRoot: join(root, "runs-soundscape"),
          eventsDir,
        }),
        expected: /soundscape:street-corner/,
      },
    ];

    writeCorpus(join(root, "corpus-street"), [
      { name: "golden-flow-smoke", soundscape: { id: "street-corner" } },
    ]);

    for (const entry of cases) {
      let called = 0;
      const result = await runProtocolDiagnosis({
        ...entry.input,
        call: async () => {
          called += 1;
          throw new Error("the refusal must happen before any call");
        },
      });
      assert.equal(called, 0, `${entry.name}: no call may start`);
      assert.equal(result.status, "refused", entry.name);
      assert.equal(result.exitCode, 2, entry.name);
      assert.match(
        (runJson(result).refusal as { message: string }).message,
        entry.expected,
        entry.name,
      );
    }
  } finally {
    removeTree(root);
  }
});

test("a missing recorded vendor build refuses before a vendor is opened", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir: join(root, "events"),
        vendorBuilds: null,
        call: async () => {
          throw new Error("no call");
        },
      }),
    );
    assert.equal(result.status, "refused");
    assert.equal(result.exitCode, 2);
    assert.match(
      (runJson(result).refusal as { message: string }).message,
      /vendor-builds:.*vendor-builds\.json/,
    );
  } finally {
    removeTree(root);
  }
});

test("a held-out scenario is refused: it runs only in a certification", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), [
      { name: "sarcastic", heldOut: true, class: "comprehension" },
    ]);
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir: join(root, "events"),
        scenarioName: "sarcastic",
        call: async () => {
          throw new Error("no call");
        },
      }),
    );
    assert.equal(result.status, "refused");
    assert.equal(result.exitCode, 2);
    assert.match(
      (runJson(result).refusal as { message: string }).message,
      /held out.*never certifies|RR-07/,
    );
  } finally {
    removeTree(root);
  }
});

test("a non-loopback target without a readable evidence directory is refused, never guessed", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const result = await runProtocolDiagnosis({
      ...probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir: join(root, "events"),
      }),
      target: "staging",
      targetUrl: { baseUrl: "https://pipeline.example.com" },
      eventsDir: undefined,
      call: async () => {
        throw new Error("no call");
      },
    });
    assert.equal(result.status, "refused");
    assert.equal(result.exitCode, 2);
    assert.match(
      (runJson(result).refusal as { message: string }).message,
      /no --events-dir/,
    );
  } finally {
    removeTree(root);
  }
});

test("a call failure is never retried", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    let calls = 0;
    const result = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir: join(root, "events"),
        call: async () => {
          calls += 1;
          throw new Error("the service closed before the end frame");
        },
      }),
    );
    assert.equal(calls, 1, "a retry would confirm a failure, not replace it");
    assert.equal(result.status, "refused");
    assert.equal(result.exitCode, 2);
    assert.match(
      (runJson(result).refusal as { message: string }).message,
      /service closed before the end frame/,
    );
  } finally {
    removeTree(root);
  }
});

test("missing trace and a drifted call id are evidence refusals", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const loaded = await loadCorpus({
      dir: corpus(root),
      knownProperties: new Set(["G1", "E1"]),
    });
    const scenario = loaded.scenarios.find((entry) => entry.name === "golden-flow-smoke");
    assert.ok(scenario !== undefined);

    const noTrace = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs-no-trace"),
        eventsDir: join(root, "events-no-trace"),
        call: async () => {
          const call = fakeCall({
            callId: "11111111-1111-4111-8111-111111111111",
            scenario,
            eventsDir: join(root, "events-no-trace"),
          });
          rmSync(join(root, "events-no-trace", "11111111-1111-4111-8111-111111111111.jsonl"));
          return call;
        },
      }),
    );
    assert.equal(noTrace.status, "refused");
    assert.equal(noTrace.exitCode, 2);
    assert.match((runJson(noTrace).refusal as { message: string }).message, /no trace/);

    const drifted = await runProtocolDiagnosis(
      probeRunInput({
        corpusDir: corpus(root),
        runRoot: join(root, "runs-drift"),
        eventsDir: join(root, "events-drift"),
        call: async () => {
          const eventsDir = join(root, "events-drift");
          const call = fakeCall({
            callId: "11111111-1111-4111-8111-111111111111",
            scenario,
            eventsDir,
          });
          writeServiceEvidence({
            eventsDir,
            callId: "11111111-1111-4111-8111-111111111111",
            rows: probeTrace("22222222-2222-4222-8222-222222222222"),
          });
          return call;
        },
      }),
    );
    assert.equal(drifted.status, "refused");
    assert.equal(drifted.exitCode, 2);
    assert.match(
      (runJson(drifted).refusal as { message: string }).message,
      /different call id/,
    );
  } finally {
    removeTree(root);
  }
});


test("the runner accepts a card's replay command unchanged", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), GOLDEN_AND_DELIBERATE);
    const eventsDir = join(root, "events");
    const result = await runReplayCommand(
      "demo:verify --scenario golden-flow-smoke --target local --locale en --diagnose",
      {
        corpusDir: corpus(root),
        runRoot: join(root, "runs"),
        eventsDir,
        contract: (await import("./fixtures")).probeContract(),
        evaluators: (await import("./fixtures")).probeEvaluators(),
        env: FAKE_KEYS,
        targetUrl: { baseUrl: "http://127.0.0.1:8767" },
        vendorBuilds: CLEAN_VENDOR_BUILDS,
        modules: { G1: ["voni/package.json"], E1: ["voni/package.json"] },
        call: async (input) => fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir }),
      },
    );
    assert.equal(result.scenario?.name, "golden-flow-smoke");
    assert.equal(result.target, "local");
    assert.equal(result.locale, "en");
    assert.equal(result.status, "clean-diagnosis");

    const npmForm = await runReplayCommand(
      "npm run demo:verify -- --scenario golden-flow-smoke --target local --locale en --diagnose",
      {
        corpusDir: corpus(root),
        runRoot: join(root, "runs-npm"),
        eventsDir,
        contract: (await import("./fixtures")).probeContract(),
        evaluators: (await import("./fixtures")).probeEvaluators(),
        env: FAKE_KEYS,
        targetUrl: { baseUrl: "http://127.0.0.1:8767" },
        vendorBuilds: CLEAN_VENDOR_BUILDS,
        modules: { G1: ["voni/package.json"], E1: ["voni/package.json"] },
        call: async (input) => fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir }),
        callId: "22222222-2222-4222-8222-222222222222",
      },
    );
    assert.equal(npmForm.status, "clean-diagnosis");
  } finally {
    removeTree(root);
  }
});


test("with no production evaluators, the real contract fails all 82 properties and cannot go green", async () => {
  const root = tempRoot();
  try {
    writeCorpus(corpus(root), [
      { name: "golden-flow-smoke", expectedProperties: ["T1"] },
    ]);
    const eventsDir = join(root, "events");
    const base = probeRunInput({
      corpusDir: corpus(root),
      runRoot: join(root, "runs"),
      eventsDir,
      call: async (input) => fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir }),
    });
    const result = await runProtocolDiagnosis({
      ...base,
      contract: undefined,
      evaluators: [],
    });

    assert.equal(result.status, "findings");
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict?.properties.length, 82);
    assert.equal(result.verdict?.failedPropertyIds.length, 82);
    assert.equal(result.cards.length, 0, "no card is invented for an unmeasured property");
    assert.ok(
      (runJson(result).unrun as string[]).some((line) =>
        /no evaluator modules are installed/.test(line),
      ),
    );
    assert.match(
      String(runJson(result).certificationReason),
      /protocol adapter diagnoses and never certifies/,
    );
  } finally {
    removeTree(root);
  }
});

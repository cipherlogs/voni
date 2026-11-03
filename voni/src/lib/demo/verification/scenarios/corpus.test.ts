import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContract } from "../contract";
import {
  DEFAULT_CORPUS_DIR,
  FAST_CONTRACT_SCENARIOS,
  HELD_OUT_SCENARIOS,
  ScenarioError,
  evaluateTriggers,
  loadCorpus,
  sha256Hex,
  type AgentTimelineEvent,
} from "./index";

/**
 * The committed English corpus as data: the fast ten are ten scenarios with
 * twenty real TTS takes, one Locale and no held-out name; the larger class and
 * Locale corpora are separate tickets. The trigger plans are resolved against a
 * canonical agent timeline, so a script that can never fire is a test failure
 * rather than a run that silently speaks less than it claims.
 *
 * A copied corpus with one changed byte proves the loader's drift refusal on
 * the committed bytes, not only on a synthetic fixture.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function load(dir: URL | string = DEFAULT_CORPUS_DIR) {
  const contract = await loadContract();
  return loadCorpus({
    dir,
    knownProperties: new Set(contract.properties.map((property) => property.id)),
  });
}

/** Three agent turns, long enough for every fast script's trigger rules. */
const TIMELINE: readonly AgentTimelineEvent[] = [
  { atMs: 0, type: "call-open" },
  { atMs: 300, type: "agent-speech-start" },
  { atMs: 1_600, type: "agent-speech-end" },
  { atMs: 2_600, type: "agent-turn-end" },
  { atMs: 3_000, type: "agent-speech-start" },
  { atMs: 4_300, type: "agent-speech-end" },
  { atMs: 5_300, type: "agent-turn-end" },
  { atMs: 5_800, type: "agent-speech-start" },
  { atMs: 7_100, type: "agent-speech-end" },
  { atMs: 8_100, type: "agent-turn-end" },
  { atMs: 9_000, type: "call-end" },
];

function wavFacts(bytes: Buffer): { sampleRate: number; channels: number; bits: number; frames: number } {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF", "a take is a RIFF file");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  return {
    sampleRate: bytes.readUInt32LE(24),
    channels: bytes.readUInt16LE(22),
    bits: bytes.readUInt16LE(34),
    frames: bytes.readUInt32LE(40) / (bytes.readUInt16LE(22) * (bytes.readUInt16LE(34) / 8)),
  };
}

test("the committed fast corpus keeps its ten English scenarios and twenty recorded takes", async () => {
  const corpus = await load();
  assert.equal(corpus.version, 2);
  assert.match(corpus.fingerprint, /^[0-9a-f]{64}$/);
  const byName = new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));
  const fast = FAST_CONTRACT_SCENARIOS.map((name) => {
    const scenario = byName.get(name);
    assert.ok(scenario, `${name} is missing from the committed corpus`);
    return scenario;
  });
  assert.deepEqual(
    fast.map((scenario) => scenario.name),
    [...FAST_CONTRACT_SCENARIOS],
  );
  assert.equal(fast.length, 10);
  assert.equal(
    fast.reduce((sum, scenario) => sum + scenario.takes.length, 0),
    20,
    "every caller line is its own committed take",
  );

  for (const scenario of fast) {
    assert.equal(scenario.locale, "en");
    const sealed = (HELD_OUT_SCENARIOS as readonly string[]).includes(scenario.name);
    assert.equal(scenario.heldOut, sealed, `${scenario.name} declares its sealed status`);
    assert.ok(scenario.expectedProperties.length > 0);
    assert.equal(scenario.soundscape.id, "quiet-room");
    for (const take of scenario.takes) {
      assert.ok(take.text !== undefined && take.text.trim() !== "", `${take.id} has no transcript`);
      const bytes = readFileSync(take.path);
      const facts = wavFacts(bytes);
      assert.equal(facts.sampleRate, 24_000, `${scenario.name}/${take.id} is not 24 kHz`);
      assert.equal(facts.channels, 1, `${scenario.name}/${take.id} is not mono`);
      assert.equal(facts.bits, 16, `${scenario.name}/${take.id} is not PCM16`);
      assert.ok(facts.frames > 0, `${scenario.name}/${take.id} is empty`);
      assert.equal(take.sha256, sha256Hex(bytes));
    }
  }
});

test("the greeting-only scenario holds the line open for the waiting bar", async () => {
  const corpus = await load();
  const greeting = corpus.scenarios.find((entry) => entry.name === "golden-flow-greeting-only");
  assert.ok(greeting);
  assert.equal(greeting.holdOpenMs, 32_000);
  for (const scenario of corpus.scenarios) {
    if (scenario.name !== "golden-flow-greeting-only") {
      assert.equal(scenario.holdOpenMs, undefined, `${scenario.name} declares an unneeded hold`);
    }
  }
});

test("every committed script resolves against the same canonical timeline", async () => {
  const corpus = await load();
  for (const scenario of corpus.scenarios.filter((entry) => entry.locale === "en")) {
    const plan = evaluateTriggers(scenario.script, TIMELINE);
    assert.deepEqual(plan.unresolved, [], `${scenario.name} has a step that never fires`);
    assert.equal(plan.points.length, scenario.script.length);
    const times = plan.points.map((point) => point.atMs);
    assert.deepEqual([...times].sort((left, right) => left - right), times, `${scenario.name} is not ordered`);
  }
});

test("turn-taking-barge interrupts a spoken reply, never the opening greeting", async () => {
  const corpus = await load();
  const scenario = corpus.scenarios.find((entry) => entry.name === "turn-taking-barge");
  assert.ok(scenario);
  const bargeStep = scenario.script.findIndex((step) => step.take === "barge");
  assert.ok(bargeStep > 0, "the scenario keeps its barge take");
  assert.equal(
    scenario.script[bargeStep - 1]!.trigger.type,
    "agent-turn-end",
    "the greeting must be answered before the barge step, or the barge fires on the greeting",
  );
  const plan = evaluateTriggers(scenario.script, TIMELINE);
  const barge = plan.points.find((entry) => entry.take === "barge");
  assert.ok(barge);
  const speechStarts = TIMELINE.filter((event) => event.type === "agent-speech-start").map(
    (event) => event.atMs,
  );
  assert.ok(speechStarts.length >= 2);
  assert.ok(
    barge.atMs >= speechStarts[1]!,
    "the barge lands on the opening greeting: a greeting is not a turn, so the trace writes no " +
      "turn.cut row and A7 has no cut to measure",
  );
});

test("the connectivity scenarios inject deterministic faults and no other scenario does", async () => {
  const corpus = await load();
  const jitter = [{ kind: "network-jitter", atMs: 900, durationMs: 600 }];
  const expected: Record<string, unknown[]> = {
    "connectivity-jitter": jitter,
    "connectivity-loss": [{ kind: "audio-dropout", atMs: 1_200, durationMs: 400 }],
    "connectivity-latency": [{ kind: "endpoint-latency", atMs: 600, durationMs: 350 }],
  };
  for (const scenario of corpus.scenarios) {
    const localeJitter = scenario.name.startsWith("locale-jitter-") ? jitter : [];
    assert.deepEqual(
      scenario.faults,
      expected[scenario.name] ?? localeJitter,
      `${scenario.name} carries an undeclared fault`,
    );
  }
});

test("a changed take is refused by name, never accepted as a new baseline", async () => {
  const source = new URL("./corpus/", import.meta.url);
  const root = mkdtempSync(join(tmpdir(), "dv12-corpus-drift-"));
  roots.push(root);
  cpSync(source, root, { recursive: true });

  const before = await load(root);
  const scenario = before.scenarios.find((entry) => entry.name === "turn-taking-barge");
  assert.ok(scenario !== undefined);
  const take = scenario.takes.find((entry) => entry.id === "barge");
  assert.ok(take !== undefined);

  const bytes = readFileSync(take.path);
  bytes[60] = bytes[60] ^ 0xff;
  writeFileSync(take.path, bytes);

  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "take-drift");
    assert.match(error.message, /turn-taking-barge/);
    assert.match(error.message, /barge/);
    assert.match(error.message, new RegExp(take.sha256));
    assert.equal(error.exitCode, 2);
    return true;
  });
});

test("the corpus reloads to the same fingerprint and version", async () => {
  const first = await load();
  const second = await load();
  assert.equal(second.version, first.version);
  assert.equal(second.fingerprint, first.fingerprint);
});

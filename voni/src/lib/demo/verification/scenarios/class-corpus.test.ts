import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadContract } from "../contract";
import {
  DEFAULT_CORPUS_DIR,
  HELD_OUT_SCENARIOS,
  loadCorpus,
  sha256Hex,
} from "./index";

/**
 * Ticket 14's ten corpus entries: four soundscape, three connectivity and
 * three meta/security scenarios. Two of them (quiet room and jitter) landed
 * with ticket 12's fast corpus; this file pins the class totals, the held-out
 * seals and the soundscape gap by name.
 *
 * The television scenario is deliberately *unrunnable* until a real bed is
 * committed: it names `television`, and the adapter refuses that id rather than
 * mixing digital silence and calling it a television. The refusal is proven in
 * `scripts/lib/protocol-adapter/runner.test.ts`; this file proves the corpus
 * cannot quietly substitute `quiet-room`.
 */

const NEW_SOUNDSCAPE = [
  "soundscape-television",
  "second-voice",
  "speakerphone",
] as const;

const NEW_CONNECTIVITY = ["connectivity-loss", "connectivity-latency"] as const;

const NEW_META_SECURITY = [
  "prompt-injection",
  "cross-call-tool",
  "tool-cap",
] as const;

async function load() {
  const contract = await loadContract();
  return loadCorpus({
    dir: DEFAULT_CORPUS_DIR,
    knownProperties: new Set(contract.properties.map((property) => property.id)),
  });
}

function namesOf(
  scenarios: readonly { name: string; class: string }[],
  classId: string,
): string[] {
  return scenarios
    .filter((scenario) => scenario.class === classId)
    .map((scenario) => scenario.name)
    .sort();
}

test("the corpus holds four soundscape, three connectivity and three meta/security scenarios", async () => {
  const corpus = await load();
  assert.deepEqual(namesOf(corpus.scenarios, "soundscape"), [
    "second-voice",
    "soundscape-quiet-room",
    "soundscape-television",
    "speakerphone",
  ]);
  assert.deepEqual(namesOf(corpus.scenarios, "connectivity"), [
    "connectivity-jitter",
    "connectivity-latency",
    "connectivity-loss",
  ]);
  assert.deepEqual(namesOf(corpus.scenarios, "meta-security"), [
    "cross-call-tool",
    "prompt-injection",
    "tool-cap",
  ]);
});

test("the new scenarios cite the S, R and audio properties they exist to feed", async () => {
  const corpus = await load();
  const byName = new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));

  assert.deepEqual(byName.get("prompt-injection")?.expectedProperties, ["S1", "S5"]);
  assert.deepEqual(byName.get("cross-call-tool")?.expectedProperties, ["S2", "S4", "S6"]);
  assert.deepEqual(byName.get("tool-cap")?.expectedProperties, ["S3", "E2"]);

  for (const name of NEW_CONNECTIVITY) {
    assert.ok(byName.get(name)?.expectedProperties.includes("R1"), `${name} must cite R1`);
    assert.ok(byName.get(name)?.faults.length === 1, `${name} must inject exactly one fault`);
  }
  assert.deepEqual(byName.get("connectivity-loss")?.faults, [
    { kind: "audio-dropout", atMs: 1_200, durationMs: 400 },
  ]);
  assert.deepEqual(byName.get("connectivity-latency")?.faults, [
    { kind: "endpoint-latency", atMs: 600, durationMs: 350 },
  ]);

  for (const name of [...NEW_SOUNDSCAPE, ...NEW_CONNECTIVITY, ...NEW_META_SECURITY]) {
    const scenario = byName.get(name);
    assert.ok(scenario, `${name} is missing`);
    if (scenario.class === "connectivity") {
      assert.equal(scenario.faults.length, 1, `${name} injects its fault`);
    } else {
      assert.deepEqual(scenario.faults, [], `${name} carries no undeclared fault`);
    }
  }
});

test("the held-out seals are exactly the spec's names, never a broader class seal", async () => {
  const corpus = await load();
  const held = corpus.scenarios.filter((scenario) => scenario.heldOut).map((scenario) => scenario.name);
  for (const name of ["prompt-injection", "second-voice", "speakerphone"]) {
    assert.ok(held.includes(name), `${name} must be sealed`);
  }
  for (const name of held) {
    assert.ok((HELD_OUT_SCENARIOS as readonly string[]).includes(name), `${name} is a sealed name`);
  }
  // `television` is a soundscape name, not a sealed behaviour: sealing it would
  // mean a fix could not be measured against it.
  assert.equal(corpus.scenarios.find((scenario) => scenario.name === "soundscape-television")?.heldOut, false);
});

test("the television scenario names a real bed id and does not substitute digital silence", async () => {
  const corpus = await load();
  const television = corpus.scenarios.find((scenario) => scenario.name === "soundscape-television");
  assert.ok(television);
  assert.equal(television.soundscape.id, "television");
  assert.notEqual(
    television.soundscape.id,
    "quiet-room",
    "quiet-room is digital silence; using it as a television bed would be a false pass",
  );

  // No committed PCM asset exists for the id. The adapter's preflight refuses it
  // by name (`soundscape:television`); ticket 14 records the gap rather than
  // pretending a bed was mixed.
  for (const take of television.takes) {
    const bytes = readFileSync(take.path);
    assert.equal(take.sha256, sha256Hex(bytes));
    assert.ok(take.text !== undefined && take.text.trim() !== "", "a take has words to say");
  }
});

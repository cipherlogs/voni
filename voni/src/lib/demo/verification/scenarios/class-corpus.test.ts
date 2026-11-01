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

/** Ticket 20's browser-edge scenarios: one producing scenario per R2–R7. */
const EDGE_CONNECTIVITY = [
  "resilience-deploy-drain",
  "resilience-device-switch",
  "resilience-hidden-page",
  "resilience-hold-return",
  "resilience-mic-denied",
  "resilience-reconnect",
] as const;

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
  scenarios: readonly { name: string; class: string; locale: string }[],
  classId: string,
): string[] {
  return scenarios
    .filter((scenario) => scenario.locale === "en" && scenario.class === classId)
    .map((scenario) => scenario.name)
    .sort();
}

test("the English corpus holds four soundscape, nine connectivity and three meta/security scenarios", async () => {
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
    ...EDGE_CONNECTIVITY,
  ]);
  assert.deepEqual(namesOf(corpus.scenarios, "meta-security"), [
    "cross-call-tool",
    "prompt-injection",
    "tool-cap",
  ]);
});

test("the English class shape is documented, including the census deviations (RR-08)", async () => {
  const corpus = await load();
  const shape: Record<string, number> = {};
  for (const scenario of corpus.scenarios) {
    if (scenario.locale !== "en") continue;
    shape[scenario.class] = (shape[scenario.class] ?? 0) + 1;
  }
  // The committed shape, not the spec's census: the six resilience-edge
  // scenarios (R2–R7) are filed under connectivity, and there is no English
  // locale class. The spec census and this table are named apart in RR-08.
  assert.deepEqual(shape, {
    comprehension: 6,
    connectivity: 9,
    emotion: 7,
    ending: 3,
    "golden-flow": 4,
    "meta-security": 3,
    soundscape: 4,
    tools: 3,
    "turn-taking": 4,
  });
  assert.equal(
    namesOf(corpus.scenarios, "locale").length,
    0,
    "no English scenario is Locale class",
  );
  assert.equal(
    corpus.scenarios.filter((scenario) => scenario.class === "locale").length,
    0,
    "no scenario uses the spec's locale class at all; the Locale core is classed by behaviour",
  );
  assert.equal(
    corpus.scenarios.filter((scenario) => scenario.locale !== "en").length,
    48,
    "the Locale core is the 48 non-English scenarios, classed by behaviour (RR-08)",
  );
  const byName = new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));
  for (const name of EDGE_CONNECTIVITY) {
    assert.equal(byName.get(name)?.class, "connectivity", `${name} is the documented fold into connectivity`);
  }
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

test("ticket 20's edge scenarios each produce one R property and no media fault", async () => {
  const corpus = await load();
  const byName = new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));
  const expected: Record<(typeof EDGE_CONNECTIVITY)[number], string> = {
    "resilience-reconnect": "R2",
    "resilience-hold-return": "R3",
    "resilience-hidden-page": "R4",
    "resilience-mic-denied": "R5",
    "resilience-device-switch": "R6",
    "resilience-deploy-drain": "R7",
  };
  for (const name of EDGE_CONNECTIVITY) {
    const scenario = byName.get(name);
    assert.ok(scenario, `${name} is missing`);
    assert.deepEqual(scenario.expectedProperties, [expected[name]]);
    assert.deepEqual(scenario.faults, [], `${name} is an edge condition, not a media fault`);
    assert.equal(scenario.edge.length, 1, `${name} injects exactly one edge condition`);
    for (const take of scenario.takes) {
      const bytes = readFileSync(take.path);
      assert.equal(take.sha256, sha256Hex(bytes));
    }
  }
  // The same rejoin produces R2 and R3: one edge condition, two properties.
  assert.equal(byName.get("resilience-hold-return")?.edge[0]?.kind, "page-freeze");
});

test("the corpus is 43 English scenarios, and the closing six fill golden flow, turn-taking, ending and the seal", async () => {
  const corpus = await load();
  const english = corpus.scenarios.filter((scenario) => scenario.locale === "en");
  assert.equal(
    english.length,
    43,
    "English runs the spec's 40 plus the three sealed held-out scenarios the plan is defined over",
  );
  assert.equal(
    english.filter((scenario) => scenario.class === "emotion").length,
    7,
    "five ticket-13 emotion scenarios plus the sealed sarcastic and distressed",
  );
  assert.equal(
    english.filter((scenario) => scenario.class === "comprehension").length,
    6,
    "five ticket-13 comprehension scenarios plus the sealed mispronounced-email",
  );

  assert.deepEqual(namesOf(corpus.scenarios, "golden-flow"), [
    "golden-flow-booking",
    "golden-flow-greeting-only",
    "golden-flow-hello",
    "golden-flow-substantive",
  ]);
  assert.deepEqual(namesOf(corpus.scenarios, "turn-taking"), [
    "turn-taking-barge",
    "turn-taking-filler",
    "turn-taking-filler-cut",
    "turn-taking-overlap",
  ]);
  assert.deepEqual(namesOf(corpus.scenarios, "ending"), [
    "caller-hangup-mid-word",
    "ending-caller-silence",
    "ending-goodbye",
  ]);

  const byName = new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));
  const booking = byName.get("golden-flow-booking");
  const overlap = byName.get("turn-taking-overlap");
  const hangup = byName.get("caller-hangup-mid-word");
  assert.ok(booking && overlap && hangup, "all three new scenarios landed");
  assert.deepEqual(booking.expectedProperties, ["L4", "T2", "C1", "C7", "C8", "L9", "L11"]);
  assert.deepEqual(overlap.expectedProperties, ["T7", "T9", "T10"]);
  assert.ok(!overlap.expectedProperties.includes("T3"), "barge-in stop is turn-taking-barge's property");
  assert.deepEqual(hangup.expectedProperties, ["C1", "C7", "C8", "L11"]);
  assert.equal(booking.heldOut, false);
  assert.equal(overlap.heldOut, false);
  assert.equal(hangup.heldOut, true);
  assert.equal(overlap.script.at(-1)?.trigger.type, "agent-turn-end", "the overlapped caller yields the floor");
  assert.equal(hangup.script.at(-1)?.trigger.type, "at-offset", "the caller leaves at its own fixed time");
});

test("the tools scenario's asking line waits for the agent's turn, never call-open", async () => {
  const corpus = await load();
  const scenario = corpus.scenarios.find((entry) => entry.name === "tools-email-send");
  assert.ok(scenario, "the fast contract's tools scenario is committed");
  assert.deepEqual(
    scenario.script.map((step) => ({ take: step.take, trigger: step.trigger.type })),
    [
      { take: "sent", trigger: "agent-turn-end" },
      { take: "tag", trigger: "agent-turn-end" },
    ],
    "the app drops microphone frames until the service's first audio arrives; a call-open take " +
      "asking the agent to check the inbox is lost before the turn that would call the tool",
  );
});

test("the held-out seals are exactly the spec's eight names, never a broader class seal", async () => {
  const corpus = await load();
  const held = new Set(
    corpus.scenarios.filter((scenario) => scenario.heldOut).map((scenario) => scenario.name),
  );
  for (const name of HELD_OUT_SCENARIOS) {
    assert.ok(held.has(name), `${name} must be sealed (all eight names are committed)`);
  }
  assert.deepEqual([...held].sort(), [...HELD_OUT_SCENARIOS].sort());
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

import test from "node:test";
import assert from "node:assert/strict";

import { scenarioFacts } from "./facts";
import type { LoadedScenario } from "./types";

/**
 * The authored facts an evaluator may compare measured text against: the
 * caller's words, in the order the script speaks them. Nothing here is
 * measured and nothing is inferred from the agent.
 */

function scenario(script: readonly string[], texts: Readonly<Record<string, string | undefined>>): LoadedScenario {
  return {
    schemaVersion: 1,
    name: "comprehension-example",
    class: "comprehension",
    locale: "en",
    heldOut: false,
    expectedProperties: ["K1"],
    soundscape: { id: "quiet-room" },
    faults: [],
    edge: [],
    takes: Object.entries(texts).map(([id, text]) => ({
      id,
      audio: `takes/${id}.wav`,
      sha256: "0".repeat(64),
      ...(text === undefined ? {} : { text }),
      path: `/tmp/${id}.wav`,
      bytes: 1,
    })),
    script: script.map((take) => ({ take, trigger: { type: "agent-turn-end" as const } })),
    directory: "/tmp/comprehension-example",
    fingerprint: "f".repeat(64),
  };
}

test("facts follow the script order, not the takes' declaration order", () => {
  const facts = scenarioFacts(
    scenario(["hello", "email", "correction"], {
      correction: "j dot c h e n at example dot com",
      hello: "Hi there.",
      email: "j dot c h a n at example dot com",
    }),
  );
  assert.deepEqual(facts.takes, [
    { id: "hello", text: "Hi there." },
    { id: "email", text: "j dot c h a n at example dot com" },
    { id: "correction", text: "j dot c h e n at example dot com" },
  ]);
});

test("a take spoken twice is two facts, because the caller said it twice", () => {
  const facts = scenarioFacts(
    scenario(["number", "number"], {
      number: "4 1 5 2 0 8 7 6",
    }),
  );
  assert.deepEqual(facts.takes.map((take) => take.id), ["number", "number"]);
});

test("a take with no authored words records null rather than an empty sentence", () => {
  const facts = scenarioFacts(scenario(["silent"], { silent: undefined }));
  assert.deepEqual(facts.takes, [{ id: "silent", text: null }]);
});

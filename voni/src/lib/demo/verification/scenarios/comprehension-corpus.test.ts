import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../contract";
import { canonicalNumbers, lastCanonicalEmail, spokenName } from "../verdict/evaluators/comprehension/text";
import { loadCorpus } from "./corpus";

/**
 * Ticket 13's ten scenarios: five comprehension, five emotion, all English and
 * none held out. The corpus loader hashes every take, so this test also proves
 * the committed audio is the audio the scenario declares.
 */

const names = [
  "comprehension-spelled-email",
  "comprehension-numbers",
  "comprehension-unusual-name",
  "comprehension-ambiguous-request",
  "comprehension-code-switch",
  "emotion-nonsense",
  "emotion-hostile",
  "emotion-impatient-correction",
  "emotion-overwhelmed",
  "emotion-skeptical",
] as const;

async function corpus() {
  const contract = await loadContract();
  return loadCorpus({ knownProperties: contract.properties.map((property) => property.id) });
}

test("the ten ticket-13 scenarios load with their hashed takes", async () => {
  const loaded = await corpus();
  const byName = new Map(loaded.scenarios.map((scenario) => [scenario.name, scenario]));
  for (const name of names) {
    const scenario = byName.get(name);
    assert.ok(scenario, `the corpus is missing ${name}`);
    assert.equal(scenario.locale, "en");
    assert.equal(scenario.heldOut, false);
    assert.equal(scenario.takes.length, 3);
    assert.ok(scenario.takes.every((take) => take.text !== undefined));
  }
});

test("the ambiguous request's first line waits for the agent's turn, never call-open", async () => {
  const loaded = await corpus();
  const scenario = loaded.scenarios.find((entry) => entry.name === "comprehension-ambiguous-request");
  assert.ok(scenario);
  assert.deepEqual(
    scenario.script.map((step) => ({ take: step.take, trigger: step.trigger.type })),
    [
      { take: "intro", trigger: "agent-turn-end" },
      { take: "vague", trigger: "agent-turn-end" },
      { take: "detail", trigger: "agent-turn-end" },
    ],
    "the app holds microphone frames until the service's first audio, so a call-open take plays " +
      "before admission, is largely lost, and cuts the greeting; the first line must wait for the " +
      "agent's turn so the caller is heard and the opening is not barged",
  );
});

test("the ten are exactly five comprehension and five emotion scenarios", async () => {
  const loaded = await corpus();
  const selected = loaded.scenarios.filter((scenario) => (names as readonly string[]).includes(scenario.name));
  assert.equal(selected.filter((scenario) => scenario.class === "comprehension").length, 5);
  assert.equal(selected.filter((scenario) => scenario.class === "emotion").length, 5);
});

test("every comprehension property K1-K8 has a producing scenario", async () => {
  const loaded = await corpus();
  const cited = new Set(
    loaded.scenarios
      .filter((scenario) => (names as readonly string[]).includes(scenario.name))
      .flatMap((scenario) => scenario.expectedProperties),
  );
  for (const propertyId of ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"]) {
    assert.ok(cited.has(propertyId), `${propertyId} has no producing scenario`);
  }
});

test("no ticket-13 scenario carries a held-out name", async () => {
  // The loader would already refuse a held-out name without its mark; this
  // pins the intent of the ten names themselves.
  for (const name of names) {
    assert.ok(!name.includes("sarcastic"), name);
    assert.ok(!name.includes("distressed"), name);
    assert.ok(!name.includes("second-voice"), name);
    assert.ok(!name.includes("speakerphone"), name);
    assert.ok(!name.includes("prompt-injection"), name);
    assert.ok(!name.includes("two-tools-in-turn"), name);
    assert.ok(!name.includes("mispronounced-email"), name);
    assert.ok(!name.includes("caller-hangup-mid-word"), name);
  }
});

test("the authored K1 and K2 scenarios carry the exact entity their evaluator will demand", async () => {
  const loaded = await corpus();
  const byName = new Map(loaded.scenarios.map((scenario) => [scenario.name, scenario]));
  const email = byName.get("comprehension-spelled-email");
  assert.ok(email);
  const emailText = email.script.map((step) => email.takes.find((take) => take.id === step.take)?.text ?? "");
  assert.equal(emailText.reduce<string | null>((last, text) => lastCanonicalEmail(text) ?? last, null), "j.chen@example.com");

  const impatient = byName.get("emotion-impatient-correction");
  assert.ok(impatient);
  const impatientText = impatient.script.map(
    (step) => impatient.takes.find((take) => take.id === step.take)?.text ?? "",
  );
  assert.equal(
    impatientText.reduce<string | null>((last, text) => lastCanonicalEmail(text) ?? last, null),
    "a.mara@example.com",
  );

  const numbers = byName.get("comprehension-numbers");
  assert.ok(numbers);
  assert.deepEqual(
    [...new Set(numbers.script.flatMap((step) =>
      canonicalNumbers(numbers.takes.find((take) => take.id === step.take)?.text ?? ""),
    ))],
    ["41520876"],
  );

  const unusual = byName.get("comprehension-unusual-name");
  assert.ok(unusual);
  assert.equal(
    unusual.script.reduce<string | null>(
      (last, step) =>
        spokenName(unusual.takes.find((take) => take.id === step.take)?.text ?? "") ?? last,
      null,
    ),
    "amara",
  );
});

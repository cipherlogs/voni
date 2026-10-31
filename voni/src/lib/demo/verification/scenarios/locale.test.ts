import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../contract";
import {
  DEFAULT_CORPUS_DIR,
  HELD_OUT_SCENARIOS,
  LOCALE_CORE_LOCALES,
  LOCALE_CORE_SLUGS,
  ScenarioError,
  loadCorpus,
  localeCoreContract,
  localeCorePlan,
  localeCoreRunCeiling,
  localeCoreScenarioName,
  type LocaleCoreSlug,
} from "./index";

/**
 * Ticket 16's corpus half: twelve Locale-core behaviours on es, fr, de and pt.
 *
 * The table below is the ticket's own list, written independently of
 * `locale.ts`, so the plan cannot pass by agreeing with itself. The same
 * behaviour must have the same class, trigger sequence and property set in
 * every Locale: a translated scenario that changed its script would measure a
 * different behaviour and could not inherit the others' result.
 */

type Expected = {
  readonly slug: LocaleCoreSlug;
  readonly cls: string;
  readonly properties: readonly string[];
  readonly triggers: readonly string[];
  readonly soundscape?: string;
  readonly fault?: string;
};

const EXPECTED: readonly Expected[] = [
  { slug: "golden-flow", cls: "golden-flow", properties: ["K5", "T1", "T2"], triggers: ["call-open", "agent-turn-end"] },
  { slug: "golden-returning", cls: "golden-flow", properties: ["T2", "X10"], triggers: ["call-open", "agent-turn-end"] },
  {
    slug: "backchannel",
    cls: "turn-taking",
    properties: ["T4"],
    triggers: ["call-open", "agent-speech-start", "agent-turn-end"],
  },
  {
    slug: "barge-clause",
    cls: "turn-taking",
    properties: ["T3", "T6", "T7"],
    triggers: ["call-open", "agent-speech-start", "agent-turn-end"],
  },
  {
    slug: "filler",
    cls: "turn-taking",
    properties: ["T4", "T5"],
    triggers: ["call-open", "silence", "agent-turn-end"],
  },
  { slug: "nonsense", cls: "emotion", properties: ["C3", "K7"], triggers: ["call-open", "agent-turn-end", "agent-turn-end"] },
  { slug: "angry", cls: "emotion", properties: ["C4", "K7"], triggers: ["call-open", "agent-turn-end", "agent-turn-end"] },
  {
    slug: "television",
    cls: "soundscape",
    properties: ["A3", "A8"],
    triggers: ["call-open", "agent-turn-end"],
    soundscape: "television",
  },
  {
    slug: "jitter",
    cls: "connectivity",
    properties: ["A6", "R1", "T7"],
    triggers: ["call-open", "agent-turn-end"],
    fault: "network-jitter",
  },
  {
    slug: "goodbye-drain",
    cls: "ending",
    properties: ["C7", "C8", "L11", "L9"],
    triggers: ["call-open", "agent-turn-end"],
  },
  { slug: "slow-tool", cls: "tools", properties: ["X1", "X2", "X3"], triggers: ["call-open", "agent-turn-end"] },
  {
    slug: "code-switch",
    cls: "comprehension",
    properties: ["K5", "K6", "K7"],
    triggers: ["call-open", "agent-turn-end", "agent-turn-end"],
  },
];

async function corpus() {
  const contract = await loadContract();
  return loadCorpus({
    dir: DEFAULT_CORPUS_DIR,
    knownProperties: contract.properties.map((property) => property.id),
  });
}

test("the twelve Locale-core behaviours are named explicitly, in the spec's order", () => {
  assert.deepEqual([...LOCALE_CORE_LOCALES], ["es", "fr", "de", "pt"]);
  assert.deepEqual([...LOCALE_CORE_SLUGS], EXPECTED.map((entry) => entry.slug));
  assert.equal(localeCoreScenarioName("golden-flow", "es"), "locale-golden-flow-es");
});

test("every Locale has all twelve scenarios, in its own Locale, none held out", async () => {
  const loaded = await corpus();
  const plan = localeCorePlan(loaded);
  assert.equal(plan.calls, 48, "twelve behaviours on four Locales");
  for (const locale of LOCALE_CORE_LOCALES) {
    const names = plan.scenarios.filter((entry) => entry.locale === locale).map((entry) => entry.name);
    assert.deepEqual(names, EXPECTED.map((entry) => localeCoreScenarioName(entry.slug, locale)));
  }
  const byName = new Map(loaded.scenarios.map((scenario) => [scenario.name, scenario]));
  for (const entry of plan.scenarios) {
    const scenario = byName.get(entry.name);
    assert.ok(scenario);
    assert.equal(scenario.locale, entry.locale);
    assert.equal(scenario.heldOut, false);
    assert.ok(!(HELD_OUT_SCENARIOS as readonly string[]).includes(scenario.name));
    assert.ok(scenario.takes.length >= 2, `${scenario.name} needs a dialogue, not one line`);
    assert.ok(scenario.takes.every((take) => take.text !== undefined && take.text.trim() !== ""));
  }
});

test("the same behaviour keeps its class, triggers, properties, soundscape and fault in every Locale", async () => {
  const loaded = await corpus();
  const byName = new Map(loaded.scenarios.map((scenario) => [scenario.name, scenario]));
  for (const expected of EXPECTED) {
    for (const locale of LOCALE_CORE_LOCALES) {
      const scenario = byName.get(localeCoreScenarioName(expected.slug, locale));
      assert.ok(scenario, `${expected.slug}/${locale} is missing`);
      assert.equal(scenario.class, expected.cls);
      assert.deepEqual([...scenario.expectedProperties].sort(), [...expected.properties].sort());
      assert.deepEqual(scenario.script.map((step) => step.trigger.type), expected.triggers);
      assert.equal(scenario.soundscape.id, expected.soundscape ?? "quiet-room");
      assert.deepEqual(
        scenario.faults.map((fault) => fault.kind),
        expected.fault === undefined ? [] : [expected.fault],
      );
    }
  }
});

test("every Locale's code-switch scenario actually code-switches and cites K6", async () => {
  const loaded = await corpus();
  const byName = new Map(loaded.scenarios.map((scenario) => [scenario.name, scenario]));
  for (const locale of LOCALE_CORE_LOCALES) {
    const scenario = byName.get(localeCoreScenarioName("code-switch", locale));
    assert.ok(scenario);
    assert.equal(scenario.expectedProperties.includes("K6"), true);
    const switchTake = scenario.script[1];
    assert.ok(switchTake);
    const text = scenario.takes.find((take) => take.id === switchTake.take)?.text ?? "";
    assert.match(text, /Can you help me\?/, `${locale} never leaves its own language`);
  }
});

test("a missing Locale scenario is refused by name, never run as a smaller matrix", async () => {
  const loaded = await corpus();
  const without = {
    ...loaded,
    scenarios: loaded.scenarios.filter((scenario) => scenario.name !== "locale-filler-de"),
  };
  assert.throws(
    () => localeCorePlan(without),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.equal(error.code, "missing-locale-scenario");
      assert.match(error.message, /locale-filler-de/);
      return true;
    },
  );
});

test("a Locale contract holds only the properties its own twelve scenarios cite", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const spanish = localeCoreContract(contract, loaded, "es");
  assert.deepEqual(
    spanish.properties.map((property) => property.id).sort(),
    [...new Set(EXPECTED.flatMap((entry) => entry.properties))].sort(),
  );
  assert.equal(spanish.properties.some((property) => property.id === "H1"), false);
});

test("the Locale core fits the nightly and full run ceilings", async () => {
  const contract = await loadContract();
  const nightly = localeCoreRunCeiling({ contract, kind: "nightly" });
  assert.equal(nightly.calls, 48);
  assert.equal(nightly.passed, true);
  assert.ok(Math.abs((nightly.usd ?? 0) - 7.2) < 1e-9, `nightly projection ${nightly.usd}`);
  const full = localeCoreRunCeiling({ contract, kind: "full" });
  assert.equal(full.calls, 144, "three repetitions at full certification");
  assert.equal(full.passed, true);
  assert.ok(Math.abs((full.usd ?? 0) - 21.6) < 1e-9, `full projection ${full.usd}`);
  assert.throws(
    () => localeCoreRunCeiling({ contract, kind: "fast" }),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.equal(error.code, "locale-ceiling-unset");
      return true;
    },
  );
});

/**
 * Ticket 12's last acceptance: a failure in a fast scenario produces a defect
 * card that cites the turn and the replay command.
 *
 * The committed corpus is ten scenarios, so a real run judges four properties
 * per scenario and its one-call plan fails the timing repetitions as well as
 * the deliberate fault. To isolate one attributable failure the test copies the
 * committed `tools-email-send` scenario and its real takes into a fixture corpus
 * that cites only X4; the corpus, contract, takes, runner, verdict engine and
 * card builder are the production code. The call itself is fake, so no vendor
 * opens.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReplayCommand } from "@/lib/demo/verification/cards";
import { loadContract, type Contract } from "@/lib/demo/verification/contract";
import { DEFAULT_CORPUS_DIR } from "@/lib/demo/verification/scenarios";
import type { PropertyEvaluator } from "@/lib/demo/verification/verdict";

import { runProtocolDiagnosis } from "./runner";
import { fakeCall, probeRunInput, removeTree } from "./fixtures";

/** A contract with exactly one property: the failure under test. */
async function singlePropertyContract(id: string): Promise<Contract> {
  const live = await loadContract();
  const property = live.properties.find((entry) => entry.id === id);
  if (property === undefined) throw new Error(`the contract has no ${id}`);
  return {
    families: [{ ...live.families.find((family) => family.id === property.family)!, propertyCount: 1 }],
    properties: [property],
  };
}

/**
 * Copy the committed scenario's real takes, then narrow its expected
 * properties to the one under test. The takes are the committed bytes.
 */
function fixtureCorpus(root: string, scenario: string, properties: readonly string[]): string {
  const corpus = join(root, "corpus");
  mkdirSync(corpus, { recursive: true });
  const source = new URL(`../../../src/lib/demo/verification/scenarios/corpus/${scenario}/`, import.meta.url);
  cpSync(fileURLToPath(source), join(corpus, scenario), { recursive: true });
  const document = JSON.parse(
    readFileSync(join(corpus, scenario, "scenario.json"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(corpus, scenario, "scenario.json"),
    `${JSON.stringify({ ...document, expectedProperties: [...properties] }, null, 2)}\n`,
  );
  writeFileSync(join(corpus, "manifest.json"), JSON.stringify({ schemaVersion: 1, version: 1 }));
  return corpus;
}

const X4_FAILS: PropertyEvaluator = {
  propertyId: "X4",
  bars: [],
  source: "fast-corpus.test.ts",
  evaluate: () => ({
    kind: "measured",
    passed: false,
    citations: ["turn:1:reply"],
    detail: "the reply email was not found in the test inbox by its tag",
  }),
};

test("a fast-corpus failure yields a card with the turn and the replay command", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv12-fast-card-"));
  try {
    const corpusDir = fixtureCorpus(root, "tools-email-send", ["X4"]);
    const eventsDir = join(root, "events");
    const result = await runProtocolDiagnosis({
      ...probeRunInput({
        corpusDir,
        runRoot: join(root, "runs"),
        eventsDir,
        scenarioName: "tools-email-send",
        modules: { X4: ["voni/package.json"] },
        call: async (input) =>
          fakeCall({ callId: input.callId, scenario: input.scenario, eventsDir }),
      }),
      contract: await singlePropertyContract("X4"),
      evaluators: [X4_FAILS],
    });

    assert.equal(result.status, "findings");
    assert.equal(result.exitCode, 1);
    assert.equal(result.scenario?.name, "tools-email-send");
    assert.equal(result.locale, "en");
    assert.equal(result.corpus?.version, 1);

    const card = result.cards.find((entry) => entry.propertyId === "X4");
    assert.ok(card !== undefined, "the failed tool property is carded");
    assert.equal(card.citation.session, "11111111-1111-4111-8111-111111111111");
    assert.equal(card.citation.turn, "1:reply", "the card cites the turn the evaluator measured");
    assert.equal(card.citation.scenario, "tools-email-send");
    assert.ok(card.citation.evidenceFiles.length > 0);
    assert.ok(card.citation.evidenceFiles.every((file) => existsSync(file)));
    assert.ok(existsSync(join(result.runDir, "cards.md")));
    assert.ok(existsSync(join(result.runDir, "cards.json")));

    const replay = parseReplayCommand(card.replayCommand);
    assert.equal(replay.scenario, "tools-email-send");
    assert.equal(replay.target, "local");
    assert.equal(replay.locale, "en");
    assert.equal(replay.mode, "diagnose");
    assert.equal(
      card.replayCommand,
      "demo:verify --scenario tools-email-send --target local --locale en --diagnose",
    );
  } finally {
    removeTree(root);
  }
});

test("the committed fast corpus refuses a run without a recorded vendor build, before any call", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv12-fast-refuse-"));
  try {
    let calls = 0;
    const result = await runProtocolDiagnosis({
      ...probeRunInput({
        corpusDir: fileURLToPath(DEFAULT_CORPUS_DIR),
        runRoot: join(root, "runs"),
        eventsDir: join(root, "events"),
        scenarioName: "golden-flow-hello",
        vendorBuilds: null,
        call: async () => {
          calls += 1;
          throw new Error("no call may start");
        },
      }),
    });
    assert.equal(calls, 0);
    assert.equal(result.status, "refused");
    assert.equal(result.exitCode, 2);
    assert.match(result.unrun[0] ?? "", /vendor-builds/);
  } finally {
    removeTree(root);
  }
});

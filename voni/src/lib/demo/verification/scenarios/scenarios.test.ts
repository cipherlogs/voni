import { test } from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../contract";
import {
  SCENARIO_REFUSAL_EXIT_CODE,
  ScenarioError,
  parseScenario,
  type ScenarioDocument,
} from "./index";

/**
 * Ticket 10's acceptance, pinned to the spec's vocabulary: a scenario is data —
 * caller takes with trigger rules, a soundscape, expected property ids and
 * faults — and every refusal names the item that was refused.
 *
 * Expected property ids come from the live contract (ticket 06), never from a
 * list in this test: the point of the check is that a scenario cannot cite a
 * property no evaluator owns.
 */

const KNOWN = loadContract().then(
  (contract) => new Set(contract.properties.map((entry) => entry.id)),
);

type Json = Record<string, unknown>;

function scenario(overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    name: "golden-flow-hello",
    class: "golden-flow",
    locale: "en",
    heldOut: false,
    expectedProperties: ["L1", "T1"],
    soundscape: { id: "quiet-room" },
    faults: [],
    takes: [
      {
        id: "opening",
        audio: "takes/opening.wav",
        sha256: "a".repeat(64),
        text: "Hi, is this Voni?",
      },
    ],
    script: [{ take: "opening", trigger: { type: "call-open" } }],
    ...overrides,
  };
}

async function parse(overrides: Json = {}): Promise<ScenarioDocument> {
  return parseScenario(scenario(overrides), { knownProperties: await KNOWN });
}

function assertRefusal(run: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ScenarioError, `expected ScenarioError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2, "a refusal is exit 2, never a skip");
    return true;
  });
}

test("the parser reads one scenario definition: takes, triggers, soundscape, properties and faults", async () => {
  const parsed = await parse();
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.name, "golden-flow-hello");
  assert.equal(parsed.class, "golden-flow");
  assert.equal(parsed.locale, "en");
  assert.equal(parsed.heldOut, false);
  assert.deepEqual(parsed.expectedProperties, ["L1", "T1"]);
  assert.deepEqual(parsed.soundscape, { id: "quiet-room" });
  assert.deepEqual(parsed.faults, []);
  assert.equal(parsed.takes.length, 1);
  assert.equal(parsed.takes[0].id, "opening");
  assert.equal(parsed.takes[0].audio, "takes/opening.wav");
  assert.equal(parsed.takes[0].sha256, "a".repeat(64));
  assert.deepEqual(parsed.script, [
    { take: "opening", trigger: { type: "call-open" } },
  ]);
});

test("a scenario may declare how long the line is held open, and no longer than the call bound", async () => {
  const parsed = await parse({ holdOpenMs: 32_000 });
  assert.equal(parsed.holdOpenMs, 32_000);
  for (const value of [0, -1, 120_001]) {
    assertRefusal(
      () => parseScenario(scenario({ holdOpenMs: value }), { knownProperties: new Set(["L1", "T1"]) }),
      value === 120_001 ? "malformed-scenario" : "missing-field",
      /holdOpenMs/,
    );
  }
});

test("the refusal exit code is the spec's exit 2", () => {
  assert.equal(SCENARIO_REFUSAL_EXIT_CODE, 2);
});

test("every one of the contract's property ids is accepted, and an unknown id is refused by name", async () => {
  const known = await KNOWN;
  assert.equal(known.size, 82);
  for (const id of known) {
    const parsed = await parse({ expectedProperties: [id] });
    assert.deepEqual(parsed.expectedProperties, [id]);
  }
  assertRefusal(
    () => parseScenario(scenario({ expectedProperties: ["L1", "Z99"] }), { knownProperties: known }),
    "unknown-property",
    /Z99/,
  );
});

test("the parser refuses an unknown take reference by name", () => {
  assertRefusal(
    () =>
      parseScenario(
        scenario({ script: [{ take: "not-a-take", trigger: { type: "call-open" } }] }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "unknown-take",
    /not-a-take/,
  );
});

test("the parser refuses an unknown trigger type by name", () => {
  assertRefusal(
    () =>
      parseScenario(
        scenario({ script: [{ take: "opening", trigger: { type: "on-dtmf" } }] }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "unknown-trigger",
    /on-dtmf/,
  );
});

test("the parser refuses a missing required field by name", () => {
  for (const field of ["soundscape", "faults", "takes", "script", "expectedProperties", "heldOut"]) {
    const body = scenario();
    delete body[field];
    assertRefusal(
      () => parseScenario(body, { knownProperties: new Set(["L1", "T1"]) }),
      "missing-field",
      new RegExp(field),
    );
  }
});

test("the parser refuses an unknown field, so a typo or an adapter term cannot ride along", () => {
  assertRefusal(
    () => parseScenario(scenario({ adapter: "browser" }), { knownProperties: new Set(["L1", "T1"]) }),
    "unknown-field",
    /adapter/,
  );
  assertRefusal(
    () =>
      parseScenario(
        scenario({ script: [{ take: "opening", trigger: { type: "call-open", browser: true } }] }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "unknown-field",
    /browser/,
  );
});

test("the parser refuses an unknown class and an unknown locale by name", () => {
  assertRefusal(
    () => parseScenario(scenario({ class: "marketing" }), { knownProperties: new Set(["L1", "T1"]) }),
    "unknown-class",
    /marketing/,
  );
  assertRefusal(
    () => parseScenario(scenario({ locale: "it" }), { knownProperties: new Set(["L1", "T1"]) }),
    "unknown-locale",
    /it/,
  );
});

test("the parser refuses a duplicate property and a duplicate take by name", () => {
  assertRefusal(
    () => parseScenario(scenario({ expectedProperties: ["L1", "L1"] }), { knownProperties: new Set(["L1", "T1"]) }),
    "duplicate-property",
    /L1/,
  );
  assertRefusal(
    () =>
      parseScenario(
        scenario({
          takes: [
            { id: "opening", audio: "a.wav", sha256: "a".repeat(64) },
            { id: "opening", audio: "b.wav", sha256: "b".repeat(64) },
          ],
        }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "duplicate-take",
    /opening/,
  );
});

test("the parser refuses an empty property list, an empty take list and an empty script", () => {
  assertRefusal(
    () => parseScenario(scenario({ expectedProperties: [] }), { knownProperties: new Set(["L1", "T1"]) }),
    "empty-properties",
    /golden-flow-hello/,
  );
  assertRefusal(
    () => parseScenario(scenario({ takes: [] }), { knownProperties: new Set(["L1", "T1"]) }),
    "empty-scenario",
    /golden-flow-hello/,
  );
  assertRefusal(
    () => parseScenario(scenario({ script: [] }), { knownProperties: new Set(["L1", "T1"]) }),
    "empty-script",
    /golden-flow-hello/,
  );
});

test("the parser refuses an unsafe take path and an unhashed take by name", () => {
  assertRefusal(
    () =>
      parseScenario(
        scenario({ takes: [{ id: "leak", audio: "../secret.wav", sha256: "a".repeat(64) }] }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "unsafe-take-path",
    /secret\.wav/,
  );
  assertRefusal(
    () =>
      parseScenario(
        scenario({ takes: [{ id: "bare", audio: "takes/bare.wav" }] }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "missing-field",
    /sha256/,
  );
  assertRefusal(
    () =>
      parseScenario(
        scenario({ takes: [{ id: "short", audio: "takes/short.wav", sha256: "abc" }] }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "invalid-hash",
    /abc/,
  );
});

test("the parser refuses an unknown fault kind and an invalid fault window by name", () => {
  assertRefusal(
    () => parseScenario(scenario({ faults: [{ kind: "fire", atMs: 10 }] }), { knownProperties: new Set(["L1", "T1"]) }),
    "unknown-fault",
    /fire/,
  );
  assertRefusal(
    () => parseScenario(scenario({ faults: [{ kind: "call-drop" }] }), { knownProperties: new Set(["L1", "T1"]) }),
    "invalid-fault",
    /atMs/,
  );
  assertRefusal(
    () =>
      parseScenario(
        scenario({ faults: [{ kind: "audio-dropout", atMs: 10, durationMs: 0 }] }),
        { knownProperties: new Set(["L1", "T1"]) },
      ),
    "missing-field",
    /durationMs/,
  );
});

test("a held-out name must carry the mark, and only a held-out name may carry it", async () => {
  const sealed = await parse({
    name: "sarcastic",
    class: "emotion",
    heldOut: true,
    expectedProperties: ["K1"],
  });
  assert.equal(sealed.heldOut, true, "the spec's sealed scenario is marked");

  assertRefusal(
    () => parseScenario(scenario({ name: "sarcastic", heldOut: false }), { knownProperties: new Set(["L1", "T1"]) }),
    "held-out-mismatch",
    /sarcastic/,
  );
  assertRefusal(
    () => parseScenario(scenario({ name: "golden-flow-hello", heldOut: true }), { knownProperties: new Set(["L1", "T1"]) }),
    "held-out-mismatch",
    /golden-flow-hello/,
  );
});

// ── Trigger rules ───────────────────────────────────────────────────────────

import {
  assertTriggersResolved,
  evaluateTriggers,
  type AgentTimelineEvent,
} from "./index";

const TIMELINE: AgentTimelineEvent[] = [
  { atMs: 0, type: "call-open" },
  { atMs: 200, type: "agent-speech-start" },
  { atMs: 900, type: "agent-speech-end" },
  { atMs: 1000, type: "agent-turn-end" },
  { atMs: 3000, type: "agent-speech-start" },
  { atMs: 3800, type: "agent-speech-end" },
  { atMs: 4000, type: "agent-turn-end" },
  { atMs: 6000, type: "call-end" },
];

function script(steps: Array<{ take: string; trigger: Record<string, unknown> }>): ScenarioDocument["script"] {
  return steps as unknown as ScenarioDocument["script"];
}

test("each trigger rule resolves at its documented point on the agent timeline", () => {
  const plan = evaluateTriggers(
    script([
      { take: "opening", trigger: { type: "call-open", delayMs: 100 } },
      { take: "barge", trigger: { type: "agent-speech-start", delayMs: 50 } },
      { take: "filler", trigger: { type: "silence", silenceMs: 800 } },
      { take: "answer", trigger: { type: "agent-turn-end" } },
      { take: "barge-again", trigger: { type: "agent-speech-start" } },
      { take: "fixed", trigger: { type: "at-offset", atMs: 5000 } },
    ]),
    TIMELINE,
  );
  assert.deepEqual(plan.unresolved, []);
  assert.deepEqual(
    plan.points.map((point) => [point.step, point.take, point.trigger, point.atMs]),
    [
      [0, "opening", "call-open", 100],
      [1, "barge", "agent-speech-start", 250],
      [3, "answer", "agent-turn-end", 1000],
      [2, "filler", "silence", 1700],
      [4, "barge-again", "agent-speech-start", 3000],
      [5, "fixed", "at-offset", 5000],
    ],
    "points are ordered by call time, then by script position",
  );
});

test("the same caller timeline yields the same trigger points on every run, whatever the input order", () => {
  const definition = script([
    { take: "opening", trigger: { type: "call-open" } },
    { take: "answer", trigger: { type: "agent-turn-end", delayMs: 20 } },
    { take: "filler", trigger: { type: "silence", silenceMs: 200 } },
  ]);
  const first = evaluateTriggers(definition, TIMELINE);
  const second = evaluateTriggers(definition, TIMELINE);
  assert.deepEqual(second, first, "same timeline, same plan");
  const reversed = evaluateTriggers(definition, [...TIMELINE].reverse());
  assert.deepEqual(reversed, first, "a shuffled timeline is sorted before use, never trusted as order");
  assert.deepEqual(
    first.points.map((point) => point.atMs),
    [0, 1020, 4000],
    "the answer fires from the first turn end, the filler from that turn's speech end",
  );
});

test("an unmatched trigger is a named unresolved point, never a silent default", () => {
  const plan = evaluateTriggers(
    script([{ take: "late-answer", trigger: { type: "agent-turn-end" } }]),
    [{ atMs: 0, type: "call-open" }],
  );
  assert.deepEqual(plan.points, []);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].take, "late-answer");
  assert.equal(plan.unresolved[0].step, 0);
  assert.equal(plan.unresolved[0].trigger, "agent-turn-end");
  assert.match(plan.unresolved[0].reason, /no agent-turn-end/);
  assertRefusal(() => assertTriggersResolved(plan), "invalid-trigger", /late-answer/);
});

test("a malformed agent timeline is refused by name", () => {
  assertRefusal(
    () =>
      evaluateTriggers(script([{ take: "opening", trigger: { type: "call-open" } }]), [
        { atMs: -1, type: "call-open" },
      ]),
    "invalid-timeline",
    /-1/,
  );
  assertRefusal(
    () =>
      evaluateTriggers(script([{ take: "opening", trigger: { type: "call-open" } }]), [
        { atMs: 0, type: "browser-navigation" as AgentTimelineEvent["type"] },
      ]),
    "invalid-timeline",
    /browser-navigation/,
  );
});

// ── Corpus discovery, hashing and drift ─────────────────────────────────────

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after } from "node:test";

import {
  DEFAULT_CORPUS_DIR,
  corpusReference,
  loadCorpus,
  type Corpus,
} from "./index";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type FixtureScenario = {
  dir: string;
  name: string;
  files: Record<string, string>;
  overrides?: Json;
  doc?: Json;
};

function takeDoc(files: Record<string, string>): Json[] {
  return Object.entries(files).map(([audio, content]) => ({
    id: audio.replace(/^takes\//, "").replace(/\.wav$/, ""),
    audio,
    sha256: sha256(content),
    text: `spoken ${audio}`,
  }));
}

function scenarioWithFiles(name: string, files: Record<string, string>, overrides: Json = {}): Json {
  const takes = takeDoc(files);
  return scenario({
    name,
    class: "golden-flow",
    expectedProperties: ["L1"],
    takes,
    script: takes.map((take) => ({ take: take.id, trigger: { type: "call-open" } })),
    ...overrides,
  });
}

function writeCorpus(
  scenarios: FixtureScenario[],
  manifest: Json | null = { schemaVersion: 1, version: 3 },
): string {
  const root = mkdtempSync(join(tmpdir(), "voni-scenario-corpus-"));
  roots.push(root);
  if (manifest) writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  for (const entry of scenarios) {
    const dir = join(root, entry.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(entry.doc));
    for (const [audio, content] of Object.entries(entry.files)) {
      const path = join(dir, audio);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
  }
  return root;
}

function fixture(dir: string, name: string, files: Record<string, string>, overrides: Json = {}): FixtureScenario {
  return { dir, name, files, overrides };
}

function fixtureFrom(f: FixtureScenario): FixtureScenario {
  return { ...f, doc: scenarioWithFiles(f.name, f.files, f.overrides) };
}

async function load(root: string): Promise<Corpus> {
  return loadCorpus({ dir: root, knownProperties: await KNOWN });
}

test("a corpus is discovered by directory, with its version and per-take sha256", async () => {
  const alpha = fixtureFrom(
    fixture("alpha", "alpha", { "takes/opening.wav": "opening audio" }, { class: "golden-flow" }),
  );
  const beta = fixtureFrom(
    fixture("beta", "beta", { "takes/answer.wav": "answer audio" }, { class: "ending" }),
  );
  const root = writeCorpus([beta, alpha]);
  const corpus = await load(root);

  assert.equal(corpus.version, 3);
  assert.deepEqual(corpus.scenarios.map((entry) => entry.name), ["alpha", "beta"], "discovery is sorted");
  const opening = corpus.scenarios[0].takes[0];
  assert.equal(opening.id, "opening");
  assert.equal(opening.audio, "takes/opening.wav");
  assert.equal(opening.sha256, sha256("opening audio"), "the digest is of the bytes on disk");
  assert.equal(opening.sha256, "bb0f39b4b00403ceb9ddf028bfa84d035849c23c54c2b5501fe54f1d7a4f2f6c");
  assert.equal(opening.bytes, Buffer.byteLength("opening audio"));
  assert.ok(opening.path.endsWith(join("alpha", "takes", "opening.wav")));
  assert.match(corpus.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(corpusReference(corpus), { version: 3, sha256: corpus.fingerprint });
  assert.deepEqual(await load(root), corpus, "the same corpus loads to the same record");
});

test("adding a scenario adds a directory and never edits the manifest", async () => {
  const root = writeCorpus([fixtureFrom(fixture("alpha", "alpha", { "takes/a.wav": "a" }))]);
  const first = await load(root);
  assert.equal(first.scenarios.length, 1);
  const beta = fixtureFrom(fixture("beta", "beta", { "takes/b.wav": "b" }));
  const dir = join(root, beta.dir);
  mkdirSync(join(dir, "takes"), { recursive: true });
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(beta.doc));
  writeFileSync(join(dir, "takes", "b.wav"), "b");
  const second = await load(root);
  assert.equal(second.scenarios.length, 2);
  assert.equal(second.version, first.version, "a new scenario does not move comparability by itself");
  assert.notEqual(second.fingerprint, first.fingerprint, "but the corpus hash names the new bytes");
});

test("a changed take fails the load with the scenario and take named", async () => {
  const root = writeCorpus([
    fixtureFrom(fixture("alpha", "alpha", { "takes/opening.wav": "opening audio" })),
  ]);
  const before = await load(root);
  writeFileSync(join(root, "alpha", "takes", "opening.wav"), "a retake nobody declared");
  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "take-drift");
    assert.match(error.message, /alpha/);
    assert.match(error.message, /opening/);
    assert.match(error.message, new RegExp(before.scenarios[0].takes[0].sha256));
    assert.equal(error.exitCode, 2);
    return true;
  });
});

test("a deliberate retake moves the fingerprint and is carried by the corpus version", async () => {
  const root = writeCorpus([
    fixtureFrom(fixture("alpha", "alpha", { "takes/opening.wav": "opening audio" })),
  ]);
  const before = await load(root);
  const retaken = scenarioWithFiles("alpha", { "takes/opening.wav": "a newly recorded opening" });
  writeFileSync(join(root, "alpha", "scenario.json"), JSON.stringify(retaken));
  writeFileSync(join(root, "alpha", "takes", "opening.wav"), "a newly recorded opening");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, version: 4 }));
  const afterRetake = await load(root);
  assert.equal(afterRetake.version, 4);
  assert.notEqual(afterRetake.fingerprint, before.fingerprint);
  assert.equal(afterRetake.scenarios[0].takes[0].sha256, sha256("a newly recorded opening"));
});

test("corpus discovery refuses a duplicate scenario name by name", async () => {
  const root = writeCorpus([
    fixtureFrom(fixture("one", "same-name", { "takes/a.wav": "a" })),
    fixtureFrom(fixture("two", "same-name", { "takes/b.wav": "b" })),
  ]);
  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "duplicate-scenario");
    assert.match(error.message, /same-name/);
    assert.match(error.message, /one/);
    assert.match(error.message, /two/);
    return true;
  });
});

test("a scenario directory with no takes is refused, whether empty or unreachable", async () => {
  const empty = fixtureFrom(fixture("empty", "empty", {}) as FixtureScenario);
  empty.overrides = { takes: [] };
  const root = writeCorpus([empty]);
  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "empty-scenario");
    assert.match(error.message, /empty/);
    return true;
  });

  const missingRoot = mkdtempSync(join(tmpdir(), "voni-scenario-corpus-"));
  roots.push(missingRoot);
  writeFileSync(join(missingRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, version: 1 }));
  mkdirSync(join(missingRoot, "no-definition"));
  await assert.rejects(load(missingRoot), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "missing-scenario");
    assert.match(error.message, /no-definition/);
    return true;
  });
});

test("a missing or unreadable take is a named refusal, never an empty hash", async () => {
  const root = writeCorpus([fixtureFrom(fixture("alpha", "alpha", { "takes/opening.wav": "a" }))]);
  rmSync(join(root, "alpha", "takes", "opening.wav"));
  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "missing-take");
    assert.match(error.message, /alpha/);
    assert.match(error.message, /opening/);
    return true;
  });
});

test("a corpus with no scenario, no manifest or a bad manifest is refused by name", async () => {
  const bare = mkdtempSync(join(tmpdir(), "voni-scenario-corpus-"));
  roots.push(bare);
  await assert.rejects(load(bare), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "missing-manifest");
    return true;
  });

  const empty = mkdtempSync(join(tmpdir(), "voni-scenario-corpus-"));
  roots.push(empty);
  writeFileSync(join(empty, "manifest.json"), JSON.stringify({ schemaVersion: 1, version: 1 }));
  await assert.rejects(load(empty), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "empty-corpus");
    return true;
  });

  const bad = writeCorpus([fixtureFrom(fixture("alpha", "alpha", { "takes/a.wav": "a" }))], {
    schemaVersion: 1,
  });
  await assert.rejects(load(bad), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "missing-field");
    assert.match(error.message, /version/);
    return true;
  });
});

test("an unknown property id in a discovered scenario is refused by name", async () => {
  const root = writeCorpus([
    fixtureFrom(
      fixture("alpha", "alpha", { "takes/a.wav": "a" }, { expectedProperties: ["L1", "Z99"] }),
    ),
  ]);
  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "unknown-property");
    assert.match(error.message, /Z99/);
    return true;
  });
});

test("the scenario record names no browser and no socket", async () => {
  const doc = await parse({
    class: "connectivity",
    faults: [
      { kind: "audio-dropout", atMs: 1000, durationMs: 500 },
      { kind: "call-drop", atMs: 9000 },
    ],
    soundscape: { id: "television", levelDb: -18 },
  });
  assert.doesNotMatch(JSON.stringify(doc), /browser|chromium|playwright|socket|websocket|getusermedia|page/i);
  assert.equal(DEFAULT_CORPUS_DIR.pathname.endsWith("/scenarios/corpus/"), true);
});

test("a malformed scenario document and a malformed manifest are refused by name", async () => {
  assertRefusal(
    () => parseScenario([], { knownProperties: new Set(["L1"]) }),
    "malformed-scenario",
    /scenario must be an object/,
  );
  assertRefusal(
    () => parseScenario(scenario({ name: "Sarcastic!" }), { knownProperties: new Set(["L1", "T1"]) }),
    "invalid-name",
    /Sarcastic!/,
  );

  const root = writeCorpus([fixtureFrom(fixture("alpha", "alpha", { "takes/a.wav": "a" }))]);
  writeFileSync(join(root, "alpha", "scenario.json"), "{ not json");
  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "malformed-scenario");
    assert.match(error.message, /not valid JSON/);
    return true;
  });

  const manifest = writeCorpus([fixtureFrom(fixture("beta", "beta", { "takes/b.wav": "b" }))]);
  writeFileSync(join(manifest, "manifest.json"), "{ not json");
  await assert.rejects(load(manifest), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "malformed-manifest");
    return true;
  });

  const version = writeCorpus([fixtureFrom(fixture("gamma", "gamma", { "takes/c.wav": "c" }))], {
    schemaVersion: 2,
    version: 1,
  });
  await assert.rejects(load(version), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "malformed-manifest");
    assert.match(error.message, /schema version 2/);
    return true;
  });
});

test("an empty take file is refused by name, never hashed as a valid fixture", async () => {
  const root = writeCorpus([fixtureFrom(fixture("alpha", "alpha", { "takes/opening.wav": "a" }))]);
  writeFileSync(join(root, "alpha", "takes", "opening.wav"), "");
  await assert.rejects(load(root), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "empty-take");
    assert.match(error.message, /opening/);
    return true;
  });
});

test("a stray root file and a missing corpus root are refused by name", async () => {
  const stray = writeCorpus([fixtureFrom(fixture("alpha", "alpha", { "takes/a.wav": "a" }))]);
  writeFileSync(join(stray, "notes.txt"), "not a scenario");
  await assert.rejects(load(stray), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "unexpected-corpus-entry");
    assert.match(error.message, /notes\.txt/);
    return true;
  });

  await assert.rejects(load(join(tmpdir(), "voni-corpus-that-does-not-exist")), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.code, "unreadable-corpus");
    return true;
  });
});

test("a corpus passed by a relative path resolves takes inside the scenario directory", async () => {
  const root = writeCorpus([fixtureFrom(fixture("alpha", "alpha", { "takes/a.wav": "a" }))]);
  const relativeRoot = relative(process.cwd(), root);
  const corpus = await loadCorpus({ dir: relativeRoot, knownProperties: await KNOWN });
  assert.equal(corpus.scenarios.length, 1);
  assert.ok(corpus.scenarios[0].takes[0].path.startsWith(root));
});

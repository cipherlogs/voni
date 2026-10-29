/**
 * Harness integrity (voice-parity ticket 23): every gate names the scenario
 * that produces its evidence, and that scenario is in the default suite.
 *
 * The failure these tests pin is silent: a gate whose producer scenario is
 * missing from the suite still reports INFO forever, so the artifact looks
 * healthy while nothing measured it. The check is a pure table comparison, so
 * it needs no live call and fails by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EVAL_SCENARIOS, SUITE_SCENARIOS } from "./scenario-names";
import { GATE_PRIORITY } from "./scoreboard";
import {
  GATE_PRODUCERS,
  MissingGateProducerError,
  assertGateProducersInSuite,
  gateProducerSummary,
  producersFor,
} from "./gate-producers";

const VONI = new URL("../../../", import.meta.url).pathname;

/** The default suite minus the named scenarios: a producer that went missing. */
function suiteWithout(...removed: string[]): string[] {
  return SUITE_SCENARIOS.filter((name) => !removed.includes(name));
}

function isMissingProducer(gate: string, scenario?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MissingGateProducerError, `expected MissingGateProducerError, got ${String(error)}`);
    assert.equal(error.gate, gate);
    if (scenario !== undefined) assert.equal(error.scenario, scenario);
    assert.ok(error.message.includes(gate), `message names the gate: ${error.message}`);
    if (scenario !== undefined) {
      assert.ok(error.message.includes(scenario), `message names the producer: ${error.message}`);
    }
    return true;
  };
}

test("every gate in the scoreboard's priority order declares a producer", () => {
  for (const gate of GATE_PRIORITY) {
    assert.ok(gate in GATE_PRODUCERS, `gate "${gate}" reports a row in every artifact, so it must declare a producer`);
  }
  // Reverse drift: a producer for a gate that no artifact reports is dead weight.
  for (const gate of Object.keys(GATE_PRODUCERS)) {
    assert.ok((GATE_PRIORITY as readonly string[]).includes(gate), `producer entry "${gate}" is not a scoreboard gate`);
  }
});

test("every scenario-produced gate names at least one registered scenario", () => {
  for (const gate of GATE_PRIORITY) {
    const producer = GATE_PRODUCERS[gate];
    if (producer.via !== "scenario") {
      assert.ok(producer.reason.trim().length > 0, `gate "${gate}" must say why no scenario produces it`);
      continue;
    }
    assert.ok(producer.producers.length > 0, `gate "${gate}" must name the scenario that produces its evidence`);
    for (const { scenario } of producer.producers) {
      assert.ok(
        (EVAL_SCENARIOS as readonly string[]).includes(scenario),
        `gate "${gate}" names "${scenario}", which is not a registered eval scenario`,
      );
    }
  }
});

test("the shipped default suite satisfies every gate producer", () => {
  assert.doesNotThrow(() => assertGateProducersInSuite());
  const summary = gateProducerSummary();
  assert.equal(summary.gates, GATE_PRIORITY.length);
  assert.ok(summary.scenarioProducers > 0, "the suite is what measures the thresholds");
  assert.ok(summary.nonScenarioGates > 0, "manual/operator rows are declared, not silently unproduced");
});

test("a gate with no producer fails instead of reporting INFO forever", () => {
  const producers = { ...GATE_PRODUCERS, "dead-air": undefined };
  assert.throws(() => assertGateProducersInSuite(SUITE_SCENARIOS, producers), isMissingProducer("dead-air"));
  assert.throws(() => assertGateProducersInSuite(SUITE_SCENARIOS, producers), /no producer/i);
});

test("every scenario-produced gate loses its evidence when its producer leaves the suite", () => {
  for (const gate of GATE_PRIORITY) {
    const producer = GATE_PRODUCERS[gate];
    if (producer.via !== "scenario") continue;
    for (const { scenario } of producer.producers) {
      // One scenario can feed several gates (over-talk answers overheard-recall
      // and double-talk); the first gate in priority order is the one named.
      const dependants = GATE_PRIORITY.filter((name) => {
        const entry = GATE_PRODUCERS[name];
        return entry.via === "scenario" && entry.producers.some((p) => p.scenario === scenario);
      });
      assert.throws(
        () => assertGateProducersInSuite(suiteWithout(scenario)),
        (error: unknown) => {
          assert.ok(error instanceof MissingGateProducerError, `expected MissingGateProducerError, got ${String(error)}`);
          assert.equal(error.scenario, scenario);
          assert.ok(dependants.includes(error.gate), `"${scenario}" is reported against one of ${dependants.join(", ")}`);
          assert.equal(error.reason, "not-in-suite");
          assert.ok(error.message.includes(scenario), `message names the producer: ${error.message}`);
          return true;
        },
        `dropping "${scenario}" must fail the gate "${gate}" that depends on it`,
      );
    }
  }
});

test("removing the goodbye-drain scenario fails the end-call-drain gate by name", () => {
  assert.ok(
    (SUITE_SCENARIOS as readonly string[]).includes("free-gate"),
    "the free-gate goodbye-drain path is part of the default suite",
  );
  assert.throws(
    () => assertGateProducersInSuite(suiteWithout("free-gate")),
    isMissingProducer("end-call-drain", "free-gate"),
  );
});

test("the end-call-drain gate reads one goodbye-drain producer list and one hang-up list", () => {
  // The gate depends on both the closing line's audio (coverage, inbox) and
  // the runner's own measured hang-up delay; the map is the single list.
  assert.deepEqual([...producersFor("end-call-drain", "goodbye-drain")], ["bye-audio", "free-gate"]);
  assert.deepEqual([...producersFor("end-call-drain", "hang-up-delay")], ["hang-up-fast", "hang-up-over"]);
  for (const scenario of producersFor("end-call-drain", "goodbye-drain")) {
    assert.ok((SUITE_SCENARIOS as readonly string[]).includes(scenario), `${scenario} runs in the default suite`);
  }
  for (const scenario of producersFor("end-call-drain", "hang-up-delay")) {
    assert.ok((SUITE_SCENARIOS as readonly string[]).includes(scenario), `${scenario} runs in the default suite`);
  }
});

test("a suite run scores the drain gate from any goodbye-drain producer, not one hard-coded name", () => {
  // bye-audio prints nothing measurable here; free-gate carries the closing
  // line. If the gate still read only bye-audio, coverage would be null and
  // the suite would look unmeasured while the evidence was in the run.
  const dir = mkdtempSync(join(tmpdir(), "gate-producers-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  const i = args.indexOf("--scenario");
  const scenario = i >= 0 ? args[i + 1] : "(none)";
  console.log("  · trace session sess_map");
  if (scenario === "free-gate") {
    console.log("    GOODBYE DRAIN " + JSON.stringify({ scenario: "free-gate", session: "sess_map", turn: 5, coverage: 0.93, inboxNamed: true }));
  }
  console.log("EVAL SUMMARY " + JSON.stringify({
    scenario, runs: 1, failures: 0,
    scenarios: [{ name: scenario, passed: 1, runs: 1 }],
    traceSessions: ["sess_map"], playout: [{ scenario, run: 1, wallClockMs: 1000 }],
    audioChunks: 40, live: true, clips: [],
    transport: "stored", agentId: "agent_map", agentFingerprint: "abc123",
  }));
  process.exit(0);
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log(' 4.00s  VONI    "Talk soon."  (reply_create gap 900ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "suite.json");
  const result = spawnSync(
    "node",
    ["--import", "tsx", join(VONI, "scripts/score-demo.mts"), "--out", out, "--timing-lock", join(dir, "suite.lock")],
    { cwd: VONI, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    endCallDrain: { goodbyeCoverage: number | null };
  };
  assert.equal(artifact.endCallDrain.goodbyeCoverage, 0.93, "free-gate's closing line reached the drain gate");
});

test("the coverage check runs without a live call, before the runner is spawned", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-producers-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const spawnLog = join(dir, "npm-spawned.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(spawnLog)}, "spawned\\n");\n`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = spawnSync(
    "node",
    ["--import", "tsx", join(VONI, "scripts/score-demo.mts"), "--dry-run", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    { cwd: VONI, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(out), "the dry run still writes its artifact");
  assert.ok(!existsSync(spawnLog), "the producer check needs no runner");
  assert.match(
    result.stdout,
    /gate producers: \d+ gates, .*every gate has its producer in the default suite/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  EVAL_SCENARIOS,
  SUITE_SCENARIOS,
  UnknownScenarioError,
  assertScenariosRegistered,
  isAllScenarioSelector,
  resolveScenarioName,
} from "./scenario-names";

const VONI = new URL("../../../", import.meta.url).pathname;

/** A typo must be the same named failure every producer reports. */
function isUnknownScenarioError(requested: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof UnknownScenarioError, `expected UnknownScenarioError, got ${String(error)}`);
    assert.equal(error.name, "UnknownScenarioError");
    assert.equal(error.requested, requested);
    assert.match(error.message, /unknown scenario/i);
    assert.ok(error.message.includes(requested), `message names the typo: ${error.message}`);
    for (const name of EVAL_SCENARIOS) {
      assert.ok(error.message.includes(name), `message lists valid scenario ${name}: ${error.message}`);
    }
    return true;
  };
}

test("a misspelt scenario name is a named error that lists the valid names", () => {
  assert.throws(() => resolveScenarioName("greetng-cut"), isUnknownScenarioError("greetng-cut"));
  assert.throws(() => resolveScenarioName("hang-up-fas"), isUnknownScenarioError("hang-up-fas"));
});

test("every registered scenario name resolves unchanged", () => {
  for (const name of EVAL_SCENARIOS) {
    assert.equal(resolveScenarioName(name), name);
    assert.equal(resolveScenarioName(` ${name} `), name, "surrounding whitespace from a shell is not a typo");
  }
  // The suite is a subset of the runner's own scenarios, never a parallel list.
  assert.deepEqual([...SUITE_SCENARIOS], [
    "greeting-cut",
    "filler-over",
    "stop-over",
    "over-talk",
    "silence-check-in",
    "invite-tag",
    "bye-audio",
    "free-gate",
    "hang-up-fast",
    "hang-up-over",
  ]);
  for (const name of SUITE_SCENARIOS) {
    assert.ok((EVAL_SCENARIOS as readonly string[]).includes(name), `${name} is an eval scenario`);
  }
});

test("only all, suite and an absent value select every scenario", () => {
  for (const value of ["", "all", "suite"]) assert.equal(isAllScenarioSelector(value), true);
  for (const value of ["greeting-cut", "alll", "stop over"]) assert.equal(isAllScenarioSelector(value), false);
});

test("the registry refuses drift in either direction", () => {
  // A definition the runner carries but the registry does not: a future
  // scenario would otherwise be rejected as a typo at the command line.
  assert.throws(
    () => assertScenariosRegistered([...EVAL_SCENARIOS, "ghost-scenario"]),
    /ghost-scenario.*not registered/i,
  );
  // A registered name with no definition behind it is the dangerous drift: a
  // typo equal to a stale name would run nothing and still pass.
  assert.throws(
    () => assertScenariosRegistered(EVAL_SCENARIOS.filter((name) => name !== "free-gate")),
    /free-gate.*no definition/i,
  );
  assert.doesNotThrow(() => assertScenariosRegistered(EVAL_SCENARIOS));
});

function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "DEMO_AGENT_VARIANT",
    "DEMO_TURN_MIN_SILENCE",
    "DEMO_TURN_MAX_SILENCE",
    "DEMO_TURN_INTERRUPTION_DELAY",
    "ASSEMBLYAI_API_KEY",
  ]) {
    delete env[key];
  }
  return { ...env, PATH: process.env.PATH, ...extra };
}

test("score-demo refuses an unknown scenario before the timing lock, runner or artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scenario-name-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const spawnLog = join(dir, "npm-spawned.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(spawnLog)}, "spawned\\n");\n`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const lock = join(dir, "timing.lock");
  const result = spawnSync(
    "node",
    ["--import", "tsx", join(VONI, "scripts/score-demo.mts"), "--scenario", "greetng-cut", "--out", out, "--timing-lock", lock],
    { cwd: VONI, encoding: "utf8", env: isolatedEnv({ PATH: `${bin}:${process.env.PATH}` }) },
  );

  assert.notEqual(result.status, 0, "a typo exits non-zero");
  assert.ok(!existsSync(out), "no artifact is written for an unknown scenario");
  assert.ok(!existsSync(lock), "the typo fails before the timing lock");
  assert.ok(!existsSync(spawnLog), "no eval runner is spawned for an unknown scenario");
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /unknown scenario/i);
  assert.ok(output.includes("greetng-cut"), `the failure names the typo: ${output}`);
  assert.ok(output.includes("greeting-cut"), "the failure lists the valid names");
});

test("score-demo still runs a known scenario and writes its artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scenario-name-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("    cut 912ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
  console.log("stop-over: 1/1");
  console.log("EVAL SUMMARY " + JSON.stringify({
    scenario: "stop-over", runs: 1, failures: 0,
    scenarios: [{ name: "stop-over", passed: 1, runs: 1 }],
    traceSessions: ["sess_known"], playout: [], audioChunks: 40, live: true, clips: [],
  }));
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = spawnSync(
    "node",
    ["--import", "tsx", join(VONI, "scripts/score-demo.mts"), "--scenario", "stop-over", "--trace-session", "sess_known", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    { cwd: VONI, encoding: "utf8", env: isolatedEnv({ PATH: `${bin}:${process.env.PATH}` }) },
  );

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as { evalRunner: { scenario: string; status: string } };
  assert.equal(artifact.evalRunner.scenario, "stop-over");
  assert.equal(artifact.evalRunner.status, "ok");
});

test("the live eval runner refuses an unknown scenario before it creates its event stream", () => {
  const dir = mkdtempSync(join(tmpdir(), "scenario-name-"));
  const events = join(dir, "run.jsonl");
  const result = spawnSync(
    "node",
    ["--import", "tsx", join(VONI, "scripts/eval-demo-agent.mts"), "--scenario", "greetng-cut", "--events", events, "--runs", "1"],
    { cwd: VONI, encoding: "utf8", env: isolatedEnv() },
  );

  assert.notEqual(result.status, 0, "a typo exits non-zero");
  assert.ok(!existsSync(events), "the event stream (the runner's only artifact) is never created");
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /unknown scenario/i);
  assert.ok(output.includes("greetng-cut"), `the failure names the typo: ${output}`);
  assert.ok(output.includes("bye-audio"), "the failure lists the valid names");
});

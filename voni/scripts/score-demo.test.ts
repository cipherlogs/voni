import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";

const SCRIPT = new URL("./score-demo.mts", import.meta.url).pathname;
const GATE_BEATS = [
  "greeting-cut",
  "filler-ignored",
  "real-cut-answered",
  "overheard-aside",
  "silence-check-in",
  "email-invite",
  "goodbye-drain",
];

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH, ...env },
  });
}

test("dry run writes an artifact with required keys and prints a gate table", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(out), "artifact file exists");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  for (const key of [
    "schemaVersion",
    "recordedAt",
    "voice",
    "runs",
    "beats",
    "overheard",
    "doubleTalk",
    "deadAir",
    "probes",
    "transcripts",
    "humanRatings",
    "gates",
    "emailInvite",
    "evalRunner",
    "callerClips",
  ]) {
    assert.ok(key in artifact, `artifact missing ${key}`);
  }
  assert.match(result.stdout, /reply-gap/);
  assert.match(result.stdout, /email-invite/);
  assert.match(result.stdout, /PASS|INFO/);
});

const EVAL_SHIM = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("    cut 912ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log("stop-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.00s  HEARD   "Hi, this is Anna."  (0.00s-1.00s)');
  console.log('12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)');
}
`;

test("one command runs the gate-voice eval, merges the Call trace, and writes the artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), EVAL_SHIM, { mode: 0o755 });
  const callLog = join(dir, "npm-calls.log");
  const out = join(dir, "score.json");
  const lock = join(dir, "timing.lock");
  const result = run(
    ["--scenario", "stop-over", "--trace-session", "sess_loop01", "--out", out, "--timing-lock", lock],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}`, SHIM_LOG: callLog },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(existsSync(lock), false, "the timing lock is released when the run exits");

  const calls = readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls[0], [
    "run",
    "eval:demo-agent",
    "--",
    "--voice",
    DEMO_VOICE_IDS[0],
    "--scenario",
    "stop-over",
    "--runs",
    "1",
  ]);
  assert.deepEqual(calls[1], ["run", "call:trace", "--", "sess_loop01"]);

  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    voice: string;
    evalRunner: { scenario: string; status: string };
    callTrace: { sessionId: string; excerpt: string[] };
    replyGap: { samples: number; p50Ms: number | null };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.voice, DEMO_VOICE_IDS[0]);
  assert.equal(artifact.evalRunner.scenario, "stop-over");
  assert.equal(artifact.evalRunner.status, "ok");
  assert.equal(artifact.callTrace.sessionId, "sess_loop01");
  assert.ok(artifact.callTrace.excerpt.some((line) => line.includes("gap 900ms")));
  assert.equal(artifact.replyGap.samples, 1);
  assert.equal(artifact.replyGap.p50Ms, 900);
  assert.equal(artifact.gates.find((g) => g.name === "plumbing")?.status, "PASS");
  const measurements = artifact.gates.find((g) => g.name === "measurements")!;
  assert.equal(measurements.status, "INFO");
  assert.match(measurements.detail, /trace-gaps/);
  assert.equal(artifact.gates.find((g) => g.name === "barge-in-cut")?.status, "PASS");
  assert.match(result.stdout, /artifact: /);
});

test("a real run chains the trace session the eval runner printed and reports per-turn gaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_auto07");
  console.log("    cut 912ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log("stop-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.00s  HEARD   "Hi, this is Anna."  (0.00s-1.00s)');
  console.log('12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)');
}
`,
    { mode: 0o755 },
  );
  const callLog = join(dir, "npm-calls.log");
  const out = join(dir, "score.json");
  const lock = join(dir, "timing.lock");
  const result = run(
    ["--scenario", "stop-over", "--out", out, "--timing-lock", lock],
    new URL("../", import.meta.url).pathname,
    {
      PATH: `${bin}:${process.env.PATH}`,
      SHIM_LOG: callLog,
    },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  // The auto-chained trace rides the same live run, so the lock is taken and
  // released here too; a per-test path keeps the suite off the shared default.
  assert.equal(existsSync(lock), false, "the timing lock is released when the run exits");

  const calls = readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls[1], ["run", "call:trace", "--", "sess_auto07"]);

  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    callTrace: { sessionId: string };
    replyGap: { samples: number; p50Ms: number | null };
  };
  assert.equal(artifact.callTrace.sessionId, "sess_auto07");
  assert.equal(artifact.replyGap.samples, 1);
  assert.equal(artifact.replyGap.p50Ms, 900);
  assert.match(result.stdout, /reply gap per turn \(sess_auto07; turn = Nth VONI reply in the merged trace\)/);
  assert.match(result.stdout, /^ {2}turn 1 {2}900ms$/m);
  assert.match(result.stdout, /replay: npm run call:trace -- sess_auto07/);
});

test("a slow later turn fails the scored run and cites its Call trace turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("    cut 912ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log("stop-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.00s  HEARD   "Yes please"  (9.20s-9.90s)');
  console.log('10.90s  VONI    "Happy to help"  (reply_create gap 900ms)');
  console.log('12.00s  VONI    "Of course"  (reply_create gap 1000ms)');
  console.log('13.10s  VONI    "The team is small"  (reply_create gap 1100ms)');
  console.log('14.20s  VONI    "Two bedrooms"  (reply_create gap 1200ms)');
  console.log('16.40s  VONI    "Here is the tag"  (reply_create gap 2000ms)');
  console.log('17.50s  VONI    "Thanks for calling"  (reply_create gap 1300ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "stop-over", "--trace-session", "sess_slow", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    replyGap: { samples: number; p50Ms: number | null; p95Ms: number | null };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.replyGap.samples, 6, "every merged turn is scored");
  assert.equal(artifact.replyGap.p50Ms, 1100, "the call-level distribution alone stays inside budget");
  assert.equal(artifact.replyGap.p95Ms, 2000);
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /call trace turn 5 \(sess_slow\)/, `detail points at turn 5: ${gate.detail}`);
  // The console lists every per-turn gap, so the breach is visible before the table.
  assert.match(result.stdout, /^ {2}turn 5 {2}2000ms$/m);
  assert.match(result.stdout, /^ {2}turn 6 {2}1300ms$/m);
});

test("an all-fast merged trace turns the reply-gap gate green", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("    cut 912ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log("stop-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.00s  HEARD   "Yes please"  (9.20s-9.90s)');
  console.log('10.90s  VONI    "Happy to help"  (reply_create gap 900ms)');
  console.log('12.00s  VONI    "Of course"  (reply_create gap 1000ms)');
  console.log('13.10s  VONI    "The team is small"  (reply_create gap 1100ms)');
  console.log('14.20s  VONI    "Two bedrooms"  (reply_create gap 1200ms)');
  console.log('15.40s  VONI    "Here is the tag"  (reply_create gap 1300ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "stop-over", "--trace-session", "sess_fast", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    replyGap: { samples: number; p50Ms: number | null };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.replyGap.samples, 5);
  assert.equal(artifact.replyGap.p50Ms, 1100);
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "PASS", gate.detail);
});

test("an auto-chained trace that is not ready yet warns and preserves the artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_pending");
  console.log("    cut 912ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log("stop-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.error("No timeline yet: the session may still be finishing.");
  process.exit(2);
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "stop-over", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    {
      PATH: `${bin}:${process.env.PATH}`,
    },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    callTrace?: { sessionId: string };
    replyGap: { samples: number };
    gates: { name: string; status: string }[];
    evalRunner: { status: string };
  };
  assert.equal(artifact.evalRunner.status, "ok");
  assert.equal(artifact.callTrace, undefined, "no excerpt is invented from a failed merge");
  assert.equal(artifact.replyGap.samples, 0);
  assert.equal(artifact.gates.find((g) => g.name === "reply-gap")?.status, "INFO");
  assert.match(result.stdout, /call trace merge deferred for sess_pending/);
  assert.match(result.stdout, /No timeline yet/);
  assert.match(result.stdout, /sess_pending/);
  assert.match(result.stdout, /--trace-session sess_pending/);
});

test("dry run proves plumbing without judging gates or touching the live runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const marker = join(dir, "npm-was-called");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");\nprocess.exit(1);\n`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(["--dry-run", "--out", out], new URL("../", import.meta.url).pathname, {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(!existsSync(marker), "dry run must not spawn the live runner");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    evalRunner: { status: string };
    beats: Record<string, { status: string }>;
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.evalRunner.status, "skipped");
  assert.equal(artifact.gates.find((g) => g.name === "plumbing")?.status, "PASS");
  const measurements = artifact.gates.find((g) => g.name === "measurements")!;
  assert.equal(measurements.status, "INFO");
  assert.match(measurements.detail, /^dry run:/);
  assert.ok(artifact.gates.every((g) => g.status !== "FAIL"), "dry run judges no gate");
  for (const [beat, timing] of Object.entries(artifact.beats)) {
    assert.equal(timing.status, "INFO", `${beat} is placeholder INFO in a dry run`);
  }
});

test("real run whose runner finishes without evidence fails measurements, not a gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nif (process.argv[3] === "eval:demo-agent") console.log("greeting-cut: 1/1");\n`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(["--scenario", "greeting-cut", "--out", out], new URL("../", import.meta.url).pathname, {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.ok(existsSync(out), "artifact is still written for triage");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.gates.find((g) => g.name === "plumbing")?.status, "PASS");
  const measurements = artifact.gates.find((g) => g.name === "measurements")!;
  assert.equal(measurements.status, "FAIL");
  assert.equal(measurements.detail, "no measurements - run real audio or pass evidence flags");
  assert.match(result.stdout, /measured gate breached its budget/);
});

test("a runner that finished with a failing scenario reports plumbing PASS and judgment FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_fail06");
  console.log("    cut 1841ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log("  ✗ stop-over #1: cut too late: 1841ms");
  console.log("stop-over: 0/1");
  console.log('EVAL SUMMARY {"scenario":"stop-over","runs":1,"failures":1,"scenarios":[{"name":"stop-over","passed":0,"runs":1}],"traceSessions":["sess_fail06"],"playout":[{"scenario":"stop-over","run":1,"wallClockMs":8123}],"audioChunks":42,"live":true}');
  process.exit(1);
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "stop-over", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, "a gate FAIL still exits non-zero");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    evalRunner: {
      status: string;
      passed: boolean | null;
      breakReason: string | null;
      timings: { scenarioRuns: { scenario: string; run: number; wallClockMs: number }[] };
    };
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.gates.find((g) => g.name === "plumbing")?.status, "PASS");
  assert.equal(artifact.gates.find((g) => g.name === "barge-in-cut")?.status, "FAIL");
  assert.equal(artifact.evalRunner.status, "ok");
  assert.equal(artifact.evalRunner.breakReason, null);
  assert.equal(artifact.evalRunner.passed, false, "the scenario itself failed");
  assert.deepEqual(artifact.evalRunner.timings.scenarioRuns, [
    { scenario: "stop-over", run: 1, wallClockMs: 8123 },
  ]);
  assert.match(result.stdout, /PASS\s+plumbing/);
  assert.match(result.stdout, /FAIL\s+barge-in-cut/);
  assert.match(result.stdout, /eval runner: finished/);
  assert.match(result.stdout, /playout \(wall clock, never gated\): stop-over #1 8123ms/);
  assert.match(result.stdout, /measured gate breached its budget/);
  assert.doesNotMatch(result.stdout, /HARNESS BREAK/);
});

test("a runner that died without a summary is a harness break, not a gate FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_dead06");
  process.exit(3);
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "stop-over", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    evalRunner: { status: string; breakReason: string | null };
    gates: { name: string; status: string; detail: string }[];
  };
  const plumbing = artifact.gates.find((g) => g.name === "plumbing")!;
  assert.equal(plumbing.status, "FAIL");
  assert.match(plumbing.detail, /exited 3 before printing a summary/);
  assert.equal(artifact.evalRunner.status, "failed");
  assert.equal(artifact.evalRunner.breakReason, "crashed");
  assert.match(result.stdout, /scoreboard: HARNESS BREAK/);
  assert.match(result.stdout, /eval runner: HARNESS BREAK \(crashed\).*not a gate FAIL/);
  assert.doesNotMatch(result.stdout, /measured gate breached its budget/);
});

test("unknown voice fails fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(["--dry-run", "--voice", "nope", "--out", out], new URL("../", import.meta.url).pathname);
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /unknown gate voice/);
});

test("dry run lists every beat with its window plus gate and regression voices", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const gate = DEMO_VOICE_IDS[1];
  const result = run(["--dry-run", "--gate-voice", gate, "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const beat of GATE_BEATS) {
    assert.ok(result.stdout.includes(beat), `dry run missing beat ${beat}`);
  }
  assert.ok(result.stdout.includes(gate), "dry run names the gate voice");
  assert.ok(result.stdout.includes("regression"), "dry run names the regression set");
  for (const voice of DEMO_VOICE_IDS.filter((v) => v !== gate)) {
    assert.ok(result.stdout.includes(voice), `dry run missing regression voice ${voice}`);
  }
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    voice: string;
    regressionVoices: string[];
    goldenScript: { beats: { beat: string }[] };
  };
  assert.equal(artifact.voice, gate);
  assert.deepEqual(
    artifact.goldenScript.beats.map((b) => b.beat),
    GATE_BEATS,
  );
  assert.ok(!artifact.regressionVoices.includes(gate), "regression set excludes the gate");
  assert.deepEqual(
    [...artifact.regressionVoices].sort(),
    [...DEMO_VOICE_IDS].filter((v) => v !== gate).sort(),
  );
});

test("--voice stays an alias of --gate-voice and the default needs no voice literal", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const aliasOut = join(dir, "alias.json");
  const alias = run(["--dry-run", "--voice", DEMO_VOICE_IDS[2], "--out", aliasOut], new URL("../", import.meta.url).pathname);
  assert.equal(alias.status, 0, alias.stderr + alias.stdout);
  const aliased = JSON.parse(readFileSync(aliasOut, "utf8")) as { voice: string };
  assert.equal(aliased.voice, DEMO_VOICE_IDS[2]);

  const defaultOut = join(dir, "default.json");
  const fallback = run(["--dry-run", "--out", defaultOut], new URL("../", import.meta.url).pathname);
  assert.equal(fallback.status, 0, fallback.stderr + fallback.stdout);
  const resolved = JSON.parse(readFileSync(defaultOut, "utf8")) as { voice: string };
  assert.equal(resolved.voice, DEMO_VOICE_IDS[0]);
});

test("measured gaps inside budget pass the reply-gap gate and fill per-beat gaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--gap", "greeting-cut=900", "--gap", "real-cut-answered=1200"],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { gapMs: number | null; gapSamples: number[] }>;
    replyGap: { p50Ms: number | null; p95Ms: number | null; samples: number };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(artifact.beats["greeting-cut"].gapSamples, [900]);
  assert.equal(artifact.beats["greeting-cut"].gapMs, 900);
  assert.equal(artifact.replyGap.p50Ms, 900);
  const gate = artifact.gates.find((g) => g.name === "reply-gap");
  assert.equal(gate?.status, "PASS");
  assert.match(gate?.detail ?? "", /p50/);
});

test("greeting-cut gaps over budget fail the command and point at the beat", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--gap", "greeting-cut=1800", "--gap", "greeting-cut=1900"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /greeting-cut/);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "reply-gap");
  assert.equal(gate?.status, "FAIL");
  assert.match(gate?.detail ?? "", /greeting-cut/);
});

test("bad --gap flags fail fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--gap", "not-a-beat=100"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /--gap needs beat=ms/);
});

test("dry run checks the stored agent body: end-of-turn passes with no turn-detection object", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "end-of-turn");
  assert.equal(gate?.status, "PASS");
  assert.match(gate?.detail ?? "", /turn_detection/);
});

test("dry run with filler evidence passes the filler-resume gate and names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "filler-pass.json");
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--filler-text",
      "Okaay so",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
    beats: Record<string, { cutMs: number | null; resumeMs: number | null; status: string }>;
  };
  const gate = artifact.gates.find((g) => g.name === "filler-resume");
  assert.ok(gate, "artifact carries the filler-resume gate");
  assert.equal(gate.status, "PASS", gate.detail);
  assert.equal(artifact.beats["filler-ignored"].status, "PASS");
  assert.ok(result.stdout.includes("filler-resume"), "console table names the gate");
});

test("a stolen floor fails the run and the failure names ms, verdict and trace turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "filler-fail.json");
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--filler-text",
      "Okaay so",
      "--filler-agent-text",
      "We help dental clinics answer every call",
      "--filler-verdict",
      "yield",
      "--filler-cut-ms",
      "320",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, `a FAIL gate exits non-zero: ${result.stderr}${result.stdout}`);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
    beats: Record<string, { status: string }>;
  };
  const gate = artifact.gates.find((g) => g.name === "filler-resume");
  assert.ok(gate, "artifact carries the filler-resume gate");
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /320ms/, "failure reports cut ms");
  assert.match(gate.detail, /verdict: yield/, "failure reports the judge verdict");
  assert.equal(artifact.beats["filler-ignored"].status, "FAIL");
  assert.ok(result.stdout.includes("filler-resume"), "console table still names the failed gate");
});

test("a slow resume tail fails the run inside the 2500ms budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "filler-slow.json");
  const line = "We help dental clinics answer every call";
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--filler-text",
      "mm-hmm",
      "--filler-agent-text",
      line,
      "--filler-verdict",
      "ignore",
      "--filler-cut-ms",
      "300",
      "--filler-resume-ms",
      "2600",
      "--filler-resumed-text",
      "dental clinics answer every call",
      "--filler-heard-text",
      "We help dental",
      "--filler-trace-turn",
      "sess_abc#turn 2",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, `a FAIL gate exits non-zero: ${result.stderr}${result.stdout}`);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "filler-resume");
  assert.equal(gate?.status, "FAIL");
  assert.ok(gate?.detail.includes("sess_abc#turn 2"), "failure points at the Call trace turn");
});

test("bad filler flags fail fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "filler-bad.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--filler-text", "yeah", "--filler-verdict", "loud"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
});

test("a timing run refuses to start while another timing run holds the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const lock = join(dir, "timing.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), scenario: "stop-over" }));
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "stop-over", "--timing-lock", lock, "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0, "a held lock refuses the run");
  assert.match(result.stderr + result.stdout, /another timing run holds the lock/);
  assert.ok(!existsSync(out), "no artifact is written from a run that never measured");
  assert.ok(existsSync(lock), "the held lock is left for its owner");
});

test("dry run with real-cut evidence passes a fast answered cut", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out,
      "--cut-ms", "900", "--cut-verdict", "yield", "--cut-answered"],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { cutMs: number | null; status: string }>;
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.beats["real-cut-answered"].cutMs, 900);
  const gate = artifact.gates.find((g) => g.name === "barge-in-cut")!;
  assert.equal(gate.status, "PASS");
  assert.ok(gate.detail.includes("900ms"));
  assert.match(result.stdout, /900ms/);
});

test("dry run with real-cut evidence fails a late cut and reports ms plus verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out,
      "--cut-ms", "2100", "--cut-verdict", "yield", "--cut-answered",
      "--trace-turn", "input.speech.started → reply.interrupted"],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, `a FAIL gate exits non-zero: ${result.stderr}${result.stdout}`);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { cutMs: number | null; status: string }>;
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.beats["real-cut-answered"].cutMs, 2100);
  assert.equal(artifact.beats["real-cut-answered"].status, "FAIL");
  const gate = artifact.gates.find((g) => g.name === "barge-in-cut")!;
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("2100ms"));
  assert.ok(gate.detail.includes("yield"));
  assert.ok(gate.detail.includes("reply.interrupted"));
  assert.match(result.stdout, /FAIL/);
});

test("dry run with no real-cut evidence leaves the barge-in gate ungated", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "barge-in-cut")!;
  assert.equal(gate.status, "INFO");
});

test("a faster real cut is comparable only while the caller clip is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The shim stands in for the live runner: it prints the measured cut and the
  // fixed caller clip's fingerprint, exactly as eval-demo-agent does.
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
if (process.argv[3] === "eval:demo-agent") {
  const cut = Number(process.env.SHIM_CUT);
  const passed = cut <= 1500;
  console.log("  · trace session sess_clip10");
  console.log(\`    cut \${cut}ms after the caller started (budget 1500ms)\`);
  console.log('    verdict ["yield","Wait, stop."]');
  console.log(\`stop-over: \${passed ? "1/1" : "0/1"}\`);
  console.log("EVAL SUMMARY " + JSON.stringify({
    scenario: "stop-over",
    runs: 1,
    failures: passed ? 0 : 1,
    scenarios: [{ name: "stop-over", passed: passed ? 1 : 0, runs: 1 }],
    traceSessions: ["sess_clip10"],
    playout: [{ scenario: "stop-over", run: 1, wallClockMs: 8000 }],
    audioChunks: 40,
    live: true,
    clips: [JSON.parse(process.env.SHIM_CLIP)],
  }));
  process.exit(passed ? 0 : 1);
} else if (process.argv[3] === "call:trace") {
  console.log('12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms)');
}
`,
    { mode: 0o755 },
  );
  const cwd = new URL("../", import.meta.url).pathname;
  const clip = { text: "Wait, stop.", bytes: 48000, durationMs: 1000, sha256: "a".repeat(64), onsetMs: 40 };
  const shorter = { text: "Wait, stop.", bytes: 36000, durationMs: 750, sha256: "b".repeat(64), onsetMs: 40 };
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const first = join(dir, "score-a.json");
  const second = join(dir, "score-b.json");
  const third = join(dir, "score-c.json");

  const baseline = run(["--scenario", "stop-over", "--out", first, "--timing-lock", join(dir, "lock-a")], cwd, {
    ...env,
    SHIM_CUT: "900",
    SHIM_CLIP: JSON.stringify(clip),
  });
  assert.equal(baseline.status, 0, baseline.stderr + baseline.stdout);
  const baselineArtifact = JSON.parse(readFileSync(first, "utf8")) as {
    callerClips: { text: string; sha256: string }[];
    gates: { name: string; status: string }[];
  };
  assert.equal(baselineArtifact.callerClips[0]?.sha256, clip.sha256);
  assert.equal(baselineArtifact.gates.find((g) => g.name === "barge-in-cut")?.status, "PASS");

  // Same clip, faster cut: the improvement is real and the diff shows the delta.
  const faster = run(["--scenario", "stop-over", "--out", second, "--timing-lock", join(dir, "lock-b")], cwd, {
    ...env,
    SHIM_CUT: "700",
    SHIM_CLIP: JSON.stringify(clip),
  });
  assert.equal(faster.status, 0, faster.stderr + faster.stdout);
  assert.match(faster.stdout, /real-cut-answered\s+cut 900ms → 700ms \(-200ms\)/);
  assert.doesNotMatch(faster.stdout, /caller clip\s+"Wait, stop\."/);

  // A shorter clip with a faster number is not comparable: the cut gate fails
  // and names the clip change instead of greening on a shortened take.
  const drifted = run(["--scenario", "stop-over", "--out", third, "--timing-lock", join(dir, "lock-c")], cwd, {
    ...env,
    SHIM_CUT: "600",
    SHIM_CLIP: JSON.stringify(shorter),
  });
  assert.equal(drifted.status, 1, drifted.stderr + drifted.stdout);
  const driftedArtifact = JSON.parse(readFileSync(third, "utf8")) as {
    callerClips: { sha256: string }[];
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(driftedArtifact.callerClips[0]?.sha256, shorter.sha256);
  const gate = driftedArtifact.gates.find((g) => g.name === "barge-in-cut")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /caller clip/);
  assert.match(gate.detail, /not comparable/);
  assert.match(drifted.stdout, /caller clip\s+"Wait, stop\." audio bytes differ/);
});

// ── Ticket 08: greeting cut on "Wait, stop" ─────────────────────────────────

test("a live greeting-cut run feeds the measured cut into the beat and gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
if (process.argv[3] === "eval:demo-agent") {
  console.log("    greeting cut 640ms after the caller started (budget 1500ms)");
  console.log("greeting-cut: 1/1");
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "greeting-cut", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { cutMs: number | null; status: string }>;
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.beats["greeting-cut"].cutMs, 640);
  assert.equal(artifact.beats["greeting-cut"].status, "PASS");
  const gate = artifact.gates.find((g) => g.name === "greeting-cut")!;
  assert.equal(gate.status, "PASS");
  assert.match(gate.detail, /640ms/);
  const measurements = artifact.gates.find((g) => g.name === "measurements")!;
  assert.equal(measurements.status, "INFO");
  assert.match(measurements.detail, /greeting-cut/);
});

test("a passed greeting run with no measured line leaves the greeting gate INFO, never PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nif (process.argv[3] === "eval:demo-agent") console.log("greeting-cut: 1/1");\n`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "greeting-cut", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { cutMs: number | null; status: string }>;
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.beats["greeting-cut"].cutMs, null);
  const gate = artifact.gates.find((g) => g.name === "greeting-cut")!;
  assert.equal(gate.status, "INFO");
  assert.match(gate.detail, /unmeasured/);
});

test("a late greeting cut fails and cites the Call trace turn where the greeting held", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_greet08");
  console.log("    greeting cut 1841ms after the caller started (budget 1500ms)");
  console.log("  ✗ greeting-cut #1: greeting cut too late: 1841ms");
  console.log("greeting-cut: 0/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log(' 9.80s  HEARD   "Wait, stop."  (9.20s-10.10s)');
  console.log(' 9.90s  VONI    "Hi, this is Anna..."  (greeting)  CUT at 11.80s');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "greeting-cut", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { cutMs: number | null; status: string }>;
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.beats["greeting-cut"].cutMs, 1841);
  assert.equal(artifact.beats["greeting-cut"].status, "FAIL");
  const gate = artifact.gates.find((g) => g.name === "greeting-cut")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /1841ms/);
  assert.match(gate.detail, /call trace turn 1 \(sess_greet08\)/);
  assert.match(result.stdout, /FAIL\s+greeting-cut/);
});

test("greeting-cut changes show in the artifact diff against the prior run", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
if (process.argv[3] === "eval:demo-agent") {
  console.log("    greeting cut " + (process.env.SHIM_MS ?? "0") + "ms after the caller started (budget 1500ms)");
  console.log("greeting-cut: " + (Number(process.env.SHIM_MS) <= 1500 ? "1/1" : "0/1"));
}
`,
    { mode: 0o755 },
  );
  const cwd = new URL("../", import.meta.url).pathname;
  const first = join(dir, "score-a.json");
  const second = join(dir, "score-b.json");
  const env = { PATH: `${bin}:${process.env.PATH}` };

  const firstRun = run(["--scenario", "greeting-cut", "--out", first, "--timing-lock", join(dir, "lock-a")], cwd, {
    ...env,
    SHIM_MS: "1600",
  });
  assert.equal(firstRun.status, 1, firstRun.stderr + firstRun.stdout);
  assert.match(firstRun.stdout, /no prior artifact/);

  const secondRun = run(["--scenario", "greeting-cut", "--out", second, "--timing-lock", join(dir, "lock-b")], cwd, {
    ...env,
    SHIM_MS: "900",
  });
  assert.equal(secondRun.status, 0, secondRun.stderr + secondRun.stdout);
  assert.match(secondRun.stdout, /prior artifact: .*score-a\.json/);
  assert.match(secondRun.stdout, /greeting-cut\s+status FAIL → PASS, cut 1600ms → 900ms \(-700ms\)/);
});

// ── Ticket 06: overheard-recall gate ────────────────────────────────────────
function writeAsides(dir: string, name: string, asides: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(asides, null, 2)}\n`);
  return path;
}

test("--overheard-json PASS: marked and ledger-counted aside reports per-beat counts with trace pointers", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const json = writeAsides(dir, "asides.json", [
    {
      beat: "overheard-aside",
      text: "We're a bakery, actually.",
      agentText: "handling booking and reminders",
      markedOverheard: true,
      inLedger: true,
      handling: "heard-only",
      tracePointer: "sess_abc :: 12.34s HEARD \"We're a bakery, actually.\"",
    },
  ]);
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--overheard-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    overheard: { recalled: number; total: number; byBeat: Record<string, { recalled: number; total: number }> };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.overheard.recalled, 1);
  assert.equal(artifact.overheard.total, 1);
  assert.deepEqual(artifact.overheard.byBeat["overheard-aside"], { recalled: 1, total: 1 });
  const gate = artifact.gates.find((g) => g.name === "overheard-recall")!;
  assert.equal(gate.status, "PASS");
  assert.match(result.stdout, /overheard recall 1\/1/);
  assert.match(result.stdout, /overheard-aside: 1\/1/);
  assert.ok(result.stdout.includes("sess_abc"), "console carries the trace pointer");
  assert.ok(result.stdout.includes("bakery"), "console carries the aside text");
});

test("--overheard-json FAIL: steering heard-only and filler answered both fail with trace pointers", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const steeringOut = join(dir, "steering.json");
  const steeringJson = writeAsides(dir, "steering.json", [
    {
      beat: "overheard-aside",
      text: "Wait, stop.",
      agentText: "handling booking and reminders",
      markedOverheard: true,
      inLedger: true,
      handling: "heard-only",
      tracePointer: "sess_abc :: 11.05s HEARD \"Wait, stop.\"",
    },
  ]);
  const steering = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", steeringOut, "--overheard-json", steeringJson],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(steering.status, 0, "gate FAIL writes the artifact then exits 1");
  const steeringArtifact = JSON.parse(readFileSync(steeringOut, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(steeringArtifact.gates.find((g) => g.name === "overheard-recall")!.status, "FAIL");
  assert.match(steering.stdout, /FAIL.*overheard-recall/);
  assert.ok(steering.stdout.includes("sess_abc"));

  const fillerOut = join(dir, "filler.json");
  const fillerJson = writeAsides(dir, "filler.json", [
    {
      beat: "overheard-aside",
      text: "mm-hmm",
      agentText: "handling booking and reminders",
      markedOverheard: true,
      inLedger: true,
      handling: "answered",
      tracePointer: "sess_abc :: 11.40s HEARD \"mm-hmm\"",
    },
  ]);
  const filler = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", fillerOut, "--overheard-json", fillerJson],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(filler.status, 0, "filler-answered FAIL exits 1");
  const fillerArtifact = JSON.parse(readFileSync(fillerOut, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(fillerArtifact.gates.find((g) => g.name === "overheard-recall")!.status, "FAIL");
  assert.ok(filler.stdout.includes("sess_abc"));
});

test("--overheard-json reports counts per beat with trace pointers", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const json = writeAsides(dir, "asides.json", [
    {
      beat: "overheard-aside",
      text: "We're a bakery, actually.",
      markedOverheard: true,
      inLedger: true,
      handling: "heard-only",
      tracePointer: "sess_abc :: 12.34s HEARD \"bakery\"",
    },
    {
      beat: "greeting-cut",
      text: "Wait, stop.",
      markedOverheard: true,
      inLedger: true,
      handling: "answered",
      tracePointer: "sess_abc :: 03.10s HEARD \"Wait, stop.\"",
    },
  ]);
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--overheard-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    overheard: { recalled: number; total: number; byBeat: Record<string, { recalled: number; total: number }> };
  };
  assert.deepEqual(artifact.overheard.byBeat["overheard-aside"], { recalled: 1, total: 1 });
  assert.deepEqual(artifact.overheard.byBeat["greeting-cut"], { recalled: 1, total: 1 });
  assert.match(result.stdout, /overheard recall 2\/2/);
  assert.match(result.stdout, /overheard-aside: 1\/1/);
  assert.match(result.stdout, /greeting-cut: 1\/1/);
});

test("bad --overheard-json fails fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const json = writeAsides(dir, "bad.json", [
    { beat: "overheard-aside", text: "", markedOverheard: true, inLedger: true },
  ]);
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--overheard-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /tracePointer|text/);
});

test("dry run without dead-air evidence keeps dead-air INFO (unmeasured)", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    deadAir: { gapsMs: number[]; checkIns: unknown[] };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(artifact.deadAir.gapsMs, []);
  assert.deepEqual(artifact.deadAir.checkIns, []);
  assert.equal(artifact.gates.find((g) => g.name === "dead-air")?.status, "INFO");
});

test("dry run with dead-air evidence records the FAIL gate and prints durations", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--dead-air-gaps", "400,3200", "--longest-silence-ms", "16000"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    deadAir: { gapsMs: number[]; maxMs: number | null };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(artifact.deadAir.gapsMs, [400, 3200]);
  assert.equal(artifact.deadAir.maxMs, 3200);
  const gate = artifact.gates.find((g) => g.name === "dead-air");
  assert.equal(gate?.status, "FAIL");
  assert.ok(gate?.detail.includes("3200"));
  assert.ok(result.stdout.includes("dead-air"));
  assert.ok(result.stdout.includes("FAIL"));
  assert.ok(result.stdout.includes("3200"));
});

test("dry run with a clean 15s check-in records a dead-air PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--dead-air-gaps",
      "400",
      "--longest-silence-ms",
      "16000",
      "--check-in-at-ms",
      "15200",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    deadAir: { checkIns: { atSilenceMs: number; overCaller: boolean }[] };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(artifact.deadAir.checkIns, [{ atSilenceMs: 15200, overCaller: false }]);
  assert.equal(artifact.gates.find((g) => g.name === "dead-air")?.status, "PASS");
});

test("dry run with a check-in over caller speech records a dead-air FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--longest-silence-ms",
      "16000",
      "--check-in-at-ms",
      "15100",
      "--check-in-over-caller",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "dead-air");
  assert.equal(gate?.status, "FAIL");
  assert.ok(gate?.detail.includes("caller"));
});

test("double-talk evidence over 400ms fails the run with durations in the table", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--overlap-ms", "120,650"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    doubleTalk: { overlapMs: number[]; maxMs: number };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(artifact.doubleTalk.overlapMs, [120, 650]);
  assert.equal(artifact.doubleTalk.maxMs, 650);
  const gate = artifact.gates.find((g) => g.name === "double-talk")!;
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("650"), `detail names the duration: ${gate.detail}`);
  assert.ok(result.stdout.includes("double-talk") && result.stdout.includes("FAIL"));
});

test("clean cuts plus a full goodbye drain keep the run green", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--overlap-ms",
      "120,300",
      "--goodbye-coverage",
      "0.95",
      "--hang-up-delay-ms",
      "900",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    endCallDrain: { goodbyeCoverage: number; hangUpDelayMs: number; narratedEnding: boolean };
    beats: Record<string, { drainMs: number | null }>;
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.endCallDrain.goodbyeCoverage, 0.95);
  assert.equal(artifact.endCallDrain.hangUpDelayMs, 900);
  assert.equal(artifact.beats["goodbye-drain"].drainMs, 900);
  const byName = Object.fromEntries(artifact.gates.map((g) => [g.name, g.status]));
  assert.equal(byName["double-talk"], "PASS");
  assert.equal(byName["end-call-drain"], "PASS");
});

test("a chopped goodbye fails the drain gate with coverage in the table", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--goodbye-coverage", "0.5", "--hang-up-delay-ms", "100"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("50"), `detail carries the coverage: ${gate.detail}`);
  assert.ok(result.stdout.includes("end-call-drain") && result.stdout.includes("FAIL"));
});

test("a narrated ending fails the drain gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--goodbye-coverage", "1", "--narrated-ending"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "FAIL");
  assert.ok(/narrat/i.test(gate.detail));
});

test("a hang-up before the goodbye ends fails the drain gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--hang-up-delay-ms", "-200"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.stdout.includes("end-call-drain"));
});

test("bad evidence flags break the harness fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--overlap-ms", "soon"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /overlap-ms/);
});

// ── Ticket 10: timbre probes + human ballots via CLI ────────────────────────

const RECORDING_SHA = "c".repeat(64);

function probeFile(dir: string, payload: unknown): string {
  const path = join(dir, "probes.json");
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

test("--probe-json with a clip fails timbre-probes but still writes the artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "clip.json");
  const probes = probeFile(dir, { jump: 0, overload: 0, clip: 2, underrun: 0, inputDrop: 0 });
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--probe-json", probes, "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.ok(existsSync(out), "artifact is still written when the timbre gate FAILs");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    probes: { clip: number };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.probes.clip, 2);
  const timbre = artifact.gates.find((g) => g.name === "timbre-probes");
  assert.equal(timbre?.status, "FAIL");
  assert.ok(timbre?.detail.includes("clip"));
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /timbre-probes/);
});

test("--probe-json agent-channel evidence fails the same gate on clipped PCM", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "evidence.json");
  const probes = probeFile(dir, {
    jump: 0,
    overload: 0,
    clip: 0,
    underrun: 0,
    inputDrop: 0,
    agentChannel: { peakDbfs: -0.4, clippedSampleRatio: 0.0001, largestAdjacentStep: 120 },
  });
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--probe-json", probes, "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.ok(existsSync(out), "artifact is still written when evidence FAILs the gate");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.gates.find((g) => g.name === "timbre-probes")?.status, "FAIL");
});

test("--rate files two blind ballots and passes accent-human on the same recording", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "human.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--recording", RECORDING_SHA, "--rate", "ana:5,4", "--rate", "bob:4,4"],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    humanRatings: { timbre: number; accent: number; recordingSha256: string; ratings: unknown[] };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.humanRatings.timbre, 4.5);
  assert.equal(artifact.humanRatings.accent, 4);
  assert.equal(artifact.humanRatings.recordingSha256, RECORDING_SHA);
  assert.equal(artifact.humanRatings.ratings.length, 2);
  const human = artifact.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "PASS");
  assert.match(result.stdout, /accent-human/);
});

test("--rate without --recording fails fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "unbound.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--rate", "ana:5,4"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /recording/);
});

test("--rate rejects out-of-range ballots and bad probe counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const badRate = run(
    ["--dry-run", "--out", join(dir, "r.json"), "--recording", RECORDING_SHA, "--rate", "ana:6,4"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(badRate.status, 0);
  assert.match(badRate.stderr + badRate.stdout, /1-5/);
  const badProbes = probeFile(dir, { jump: 0, overload: 0, clip: -1, underrun: 0, inputDrop: 0 });
  const badProbe = run(
    ["--dry-run", "--out", join(dir, "p.json"), "--probe-json", badProbes],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(badProbe.status, 0);
  assert.match(badProbe.stderr + badProbe.stdout, /probe/);
});

test("--trace-beat rejects unknown beats fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--trace-beat", "not-a-beat"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /--trace-beat/);
});

test("--runs rejects non-positive counts fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  for (const runs of ["0", "-2", "x"]) {
    const out = join(dir, `runs-${runs}.json`);
    const result = run(
      ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--runs", runs],
      new URL("../", import.meta.url).pathname,
    );
    assert.notEqual(result.status, 0, `--runs ${runs} must fail`);
    assert.ok(!existsSync(out));
    assert.match(result.stderr + result.stdout, /--runs/);
  }
});

test("--runs records the run count and a run id with an empty quarantine stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out, "--runs", "3"],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    runs: number;
    runId: string;
    quarantinedBeats: unknown[];
  };
  assert.equal(artifact.runs, 3);
  assert.match(artifact.runId, /run-/);
  assert.deepEqual(artifact.quarantinedBeats, []);
});

test("dry run prints the five sub-scores plus manual and external check rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "score.json");
  const result = run(["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const name of ["responsiveness", "barge-in", "overheard", "naturalness", "voice"]) {
    assert.ok(result.stdout.includes(name), `console sub-score table names ${name}`);
  }
  assert.ok(result.stdout.includes("phone-checklist"), "console names the manual phone checklist");
  assert.ok(result.stdout.includes("talk-hold-pinned"), "console names the pinned talk/hold check");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    subScores: { name: string }[];
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.subScores.length, 5);
  assert.equal(artifact.gates.find((g) => g.name === "measurements")?.status, "INFO");
});

test("every scoreboard run reports the frozen budgets alongside the gate verdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "budgets.json");
  const result = run(["--dry-run", "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /demo budgets \(frozen/);
  for (const pin of [
    "p50 ≤1500ms",
    "p95 ≤2500ms",
    "cut ≤1500ms",
    "tail ≤2500ms",
    "1/1 aside",
    "≤2000ms",
    "15000-18000ms",
    "overlap ≤400ms",
    "coverage ≥0.8",
    "hang-up ≤1500ms",
    "ref -23.1 LUFS ±1.5dB",
    "2 raters, 1-5",
  ]) {
    assert.ok(result.stdout.includes(pin), `budget report missing "${pin}":\n${result.stdout}`);
  }
  const budgetAt = result.stdout.indexOf("demo budgets (frozen");
  const verdictsAt = result.stdout.indexOf("demo scoreboard (");
  assert.ok(budgetAt >= 0 && verdictsAt > budgetAt, "budgets print before the verdict table");
  assert.ok(result.stdout.includes("scoreboard-budgets.json"), "budget report points at the frozen record");
});

test("each run diffs its artifact against the prior same-voice artifact and honors --prior", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const cwd = new URL("../", import.meta.url).pathname;
  const first = join(dir, "score-a.json");
  const second = join(dir, "score-b.json");

  const firstRun = run(["--dry-run", "--gap", "greeting-cut=900", "--out", first], cwd);
  assert.equal(firstRun.status, 0, firstRun.stderr + firstRun.stdout);
  assert.match(firstRun.stdout, /no prior artifact/, "the first artifact has nothing to diff against");

  const secondRun = run(["--dry-run", "--gap", "greeting-cut=1600", "--out", second], cwd);
  assert.equal(secondRun.status, 1, secondRun.stderr + secondRun.stdout);
  assert.match(secondRun.stdout, /prior artifact: .*score-a\.json/);
  assert.match(secondRun.stdout, /artifact diff \(/);
  assert.match(secondRun.stdout, /PASS → FAIL/);
  assert.match(secondRun.stdout, /\+700ms/);

  const third = join(dir, "score-c.json");
  const overridden = run(
    ["--dry-run", "--gap", "greeting-cut=1400", "--out", third, "--prior", first],
    cwd,
  );
  assert.equal(overridden.status, 0, overridden.stderr + overridden.stdout);
  assert.match(overridden.stdout, new RegExp(`prior artifact: ${first}`));
  assert.match(overridden.stdout, /\+500ms/);
});

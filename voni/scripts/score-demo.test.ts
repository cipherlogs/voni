import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
    "codeFingerprint",
  ]) {
    assert.ok(key in artifact, `artifact missing ${key}`);
  }
  const fingerprint = artifact.codeFingerprint as { head: string; dirty: boolean; dirtyHash: string } | null;
  assert.ok(fingerprint, "the artifact records the code it ran on");
  assert.match(fingerprint.head, /^[0-9a-f]{7,64}$/);
  assert.equal(typeof fingerprint.dirty, "boolean");
  assert.match(fingerprint.dirtyHash, /^[0-9a-f]{64}$/);
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
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
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
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
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

test("a filler-over run scores the filler-resume gate from the runner's own line", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log('    filler never cut; events [["ignore","Okaay so"]]; answer continued');
  console.log("filler-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "We help dental clinics answer every call"  (reply_create gap 900ms)');
  console.log('10.40s  HEARD   "Okaay so"  (10.30s-10.50s)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "filler-over", "--trace-session", "sess_filler", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { status: string; cutMs: number | null; resumeMs: number | null }>;
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "filler-resume")!;
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /never cut/);
  assert.match(gate.detail, /call trace turn 1 \(sess_filler\)/);
  assert.equal(artifact.beats["filler-ignored"].status, "PASS");
  assert.equal(artifact.beats["filler-ignored"].cutMs, null);
  assert.equal(artifact.beats["filler-ignored"].resumeMs, null);
});

test("a filler cut scores the exact unheard tail and its Call trace turn is the resume turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log('    filler cut at 318ms; events [["ignore","Okaay so"]]; handling resumed-from; tail {"agent":"We help dental clinics answer every call","heard":"We help dental","resumed":"dental clinics answer every call","resumeMs":412}');
  console.log("filler-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "We help dental clinics answer every call"  (reply_create gap 900ms)  CUT at 10.54s');
  console.log('10.40s  HEARD   "Okaay so"  (10.30s-10.60s)');
  console.log('11.00s  VONI    "dental clinics answer every call"  (reply_create gap 300ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "filler-over", "--trace-session", "sess_filler", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    beats: Record<string, { status: string; cutMs: number | null; resumeMs: number | null; note: string }>;
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "filler-resume")!;
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /handling: resumed-from/, "the Call trace shows resume-from, never answer");
  assert.match(gate.detail, /call trace turn 2 \(sess_filler\)/, "the resume is the turn after the cut");
  assert.equal(artifact.beats["filler-ignored"].status, "PASS");
  assert.equal(artifact.beats["filler-ignored"].cutMs, 318);
  assert.equal(artifact.beats["filler-ignored"].resumeMs, 412);
  assert.match(artifact.beats["filler-ignored"].note, /resumed the exact tail/);
});

test("a reworded filler tail FAILs citing the resume turn; a dropped tail cites the cut turn", () => {
  const cases = [
    {
      line:
        '    filler cut at 300ms; events [["ignore","Okaay so"]]; handling resumed-from; tail {"agent":"We help dental clinics answer every call","heard":"We help dental","resumed":"clinics answer calls","resumeMs":900}',
      detail: /resume tail inexact/,
      turn: /call trace turn 2 \(sess_filler\)/,
    },
    {
      line:
        '    filler cut at 300ms; events [["ignore","Okaay so"]]; handling lost; tail {"agent":"We help dental clinics answer every call","heard":"We help dental","resumed":"","resumeMs":null}',
      detail: /never resumed/,
      turn: /call trace turn 1 \(sess_filler\)/,
    },
  ];
  for (const { line, detail, turn } of cases) {
    const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log(${JSON.stringify(line)});
  console.log("filler-over: 0/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "We help dental clinics answer every call"  (reply_create gap 900ms)  CUT at 10.54s');
  console.log('10.40s  HEARD   "Okaay so"  (10.30s-10.60s)');
  console.log('11.00s  VONI    "clinics answer calls"  (reply_create gap 300ms)');
}
`,
      { mode: 0o755 },
    );
    const out = join(dir, "score.json");
    const result = run(
      ["--scenario", "filler-over", "--trace-session", "sess_filler", "--out", out, "--timing-lock", join(dir, "timing.lock")],
      new URL("../", import.meta.url).pathname,
      { PATH: `${bin}:${process.env.PATH}` },
    );
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const artifact = JSON.parse(readFileSync(out, "utf8")) as {
      gates: { name: string; status: string; detail: string }[];
    };
    const gate = artifact.gates.find((g) => g.name === "filler-resume")!;
    assert.equal(gate.status, "FAIL", gate.detail);
    assert.match(gate.detail, detail);
    assert.match(gate.detail, turn);
  }
});

test("explicit filler flags override the runner's observed line", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log('    filler never cut; events [["ignore","Okaay so"]]; answer continued');
  console.log("filler-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "We help dental clinics answer every call"  (reply_create gap 900ms)');
  console.log('10.40s  HEARD   "Wait, stop."  (10.30s-10.50s)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    [
      "--scenario", "filler-over",
      "--trace-session", "sess_filler",
      "--filler-text", "Wait, stop.",
      "--out", out,
      "--timing-lock", join(dir, "timing.lock"),
    ],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "filler-resume")!;
  assert.equal(gate.status, "FAIL", "the explicit steering override wins over the runner's ignore line");
  assert.match(gate.detail, /not filler per the overlap judge/);
  assert.match(gate.detail, /call trace turn 1 \(sess_filler\)/);
});

test("a filler FAIL without a merged trace says no turn merged instead of guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log('    filler cut at 318ms; events [["yield","Okaay so"]]; answer derailed');
  console.log("filler-over: 0/1");
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "filler-over", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "filler-resume")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /floor stolen/);
  assert.match(gate.detail, /318ms/);
  assert.match(gate.detail, /trace: no turn merged\)/);
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
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
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
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
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
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
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
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
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

// ── Ticket 11: the real point is answered after the cut ─────────────────────

test("a real cut passes only with a post-cut answer, and a resume fails citing the answer turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const resumed = process.env.SHIM_RESUME === "1";
if (process.argv[3] === "eval:demo-agent") {
  console.log("  · trace session sess_point11");
  console.log("    cut 912ms after the caller started (budget 1500ms)");
  if (resumed) {
    console.log('    resumed instead of answering: "Finish your sentence: say exactly this and nothing else, word for word: and triage the urgent ones"');
    console.log('  ✗ stop-over #1: resumed instead of answering: "Finish your sentence: say exactly this and nothing else, word for word: and triage the urgent ones"');
    console.log("stop-over: 0/1");
    process.exit(1);
  }
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
  console.log("stop-over: 1/1");
} else if (process.argv[3] === "call:trace") {
  console.log('12.20s  VONI    "We answer every call and triage the urgent ones"  (reply_create gap 900ms)  CUT at 12.90s');
  console.log('13.20s  HEARD   "Wait, stop. What is the price?"  (12.90s-13.90s)');
  console.log('13.30s  CLIENT  barge-in yield "Wait, stop. What is the price?"');
  console.log(resumed
    ? '14.30s  VONI    "and triage the urgent ones"  (reply_create [Finish your sentence, word for word])'
    : '14.30s  VONI    "Pricing depends on call volume."  (reply_create gap 1100ms)');
}
`,
    { mode: 0o755 },
  );
  const cwd = new URL("../", import.meta.url).pathname;
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const passedOut = join(dir, "score-answered.json");
  const passed = run(
    ["--scenario", "stop-over", "--out", passedOut, "--timing-lock", join(dir, "lock-answered")],
    cwd,
    env,
  );
  assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  const passedArtifact = JSON.parse(readFileSync(passedOut, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const passedGate = passedArtifact.gates.find((g) => g.name === "barge-in-cut")!;
  assert.equal(passedGate.status, "PASS", passedGate.detail);
  assert.match(passedGate.detail, /answered in 912ms/);
  assert.match(passedGate.detail, /call trace turn 2 \(sess_point11\)/, "the answer turn");

  const resumedOut = join(dir, "score-resumed.json");
  const resumed = run(
    ["--scenario", "stop-over", "--out", resumedOut, "--timing-lock", join(dir, "lock-resumed")],
    cwd,
    { ...env, SHIM_RESUME: "1" },
  );
  assert.equal(resumed.status, 1, resumed.stderr + resumed.stdout);
  const resumedArtifact = JSON.parse(readFileSync(resumedOut, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const resumedGate = resumedArtifact.gates.find((g) => g.name === "barge-in-cut")!;
  assert.equal(resumedGate.status, "FAIL");
  assert.match(resumedGate.detail, /resum/i);
  assert.match(resumedGate.detail, /call trace turn 2 \(sess_point11\)/, "the turn where Voni resumed past the point");
  assert.match(resumed.stdout, /FAIL\s+barge-in-cut/);
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

test("a merged trace FAILs steering ignored and filler answered, each citing its turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const caseDir = (name: string, heard: string, verdict: string) => {
    const caseDir = join(dir, name);
    const bin = join(caseDir, "bin");
    mkdirSync(bin, { recursive: true });
    const session = `sess_${name}`;
    const ledger = JSON.stringify([heard]);
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session ${session}");
  console.log('    heard ledger ${ledger}');
  console.log("over-talk: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "handling booking and reminders"  (reply_create ttfa 400ms)  CUT at 11.30s');
  console.log('11.05s  HEARD   "${heard}"  (11.05s-11.60s)');
  console.log("11.40s  CLIENT  barge-in ${verdict} rule ${heard}");
}
`,
      { mode: 0o755 },
    );
    const out = join(caseDir, "score.json");
    const result = run(
      ["--scenario", "over-talk", "--out", out, "--timing-lock", join(caseDir, "timing.lock")],
      new URL("../", import.meta.url).pathname,
      { PATH: `${bin}:${process.env.PATH}` },
    );
    const artifact = JSON.parse(readFileSync(out, "utf8")) as {
      gates: { name: string; status: string; detail: string }[];
    };
    return { artifact, result, session };
  };

  // Steering resolved as an aside: the course change was ignored, and the FAIL
  // names the reply the visitor said it over.
  const steering = caseDir("steer", "Wait, stop.", "keep jev");
  const steeringGate = steering.artifact.gates.find((g) => g.name === "overheard-recall")!;
  assert.equal(steeringGate.status, "FAIL");
  assert.match(steeringGate.detail, /steering not answered \(handling=resumed-from\)/);
  assert.match(steeringGate.detail, new RegExp(`call trace turn 1 \\(${steering.session}\\)`));
  assert.match(steering.result.stdout, /FAIL\s+overheard-recall/);
  assert.match(steering.result.stdout, /call trace turn 1/);

  // Filler answered instead of resumed from: the call went sideways, and the
  // FAIL names the same turn.
  const filler = caseDir("filler", "Okaay so", "yield");
  const fillerGate = filler.artifact.gates.find((g) => g.name === "overheard-recall")!;
  assert.equal(fillerGate.status, "FAIL");
  assert.match(fillerGate.detail, /filler derailed the turn/);
  assert.match(fillerGate.detail, new RegExp(`call trace turn 1 \\(${filler.session}\\)`));
  assert.match(filler.result.stdout, /FAIL\s+overheard-recall/);
  assert.match(filler.result.stdout, /call trace turn 1/);
});

test("a merged trace PASSes steering answered and filler resumed-from", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_pass15");
  console.log('    heard ledger ["Wait, stop.","Okaay so"]');
  console.log("over-talk: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "handling booking and reminders"  (reply_create ttfa 400ms)  CUT at 11.30s');
  console.log('11.05s  HEARD   "Wait, stop."  (11.05s-11.60s)');
  console.log("11.40s  CLIENT  barge-in yield rule Wait, stop.");
  console.log('12.30s  VONI    "Sure, let me slow down"  (reply_create ttfa 300ms)  CUT at 13.10s');
  console.log('12.90s  HEARD   "Okaay so"  (12.90s-13.20s)');
  console.log("13.15s  CLIENT  barge-in ignore rule Okaay so");
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "over-talk", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    overheard: { asides: { text: string; handling: string; tracePointer: string }[] };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(
    artifact.overheard.asides.map((a) => [a.text, a.handling]),
    [
      ["Wait, stop.", "answered"],
      ["Okaay so", "resumed-from"],
    ],
  );
  const gate = artifact.gates.find((g) => g.name === "overheard-recall")!;
  assert.equal(gate.status, "PASS");
  assert.match(gate.detail, /2\/2 asides recalled/);
  assert.match(artifact.overheard.asides[0].tracePointer, /call trace turn 1 \(sess_pass15\)/);
  assert.match(artifact.overheard.asides[1].tracePointer, /call trace turn 2 \(sess_pass15\)/);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("an over-talk run marks the aside Overheard and proves the session ledger counted it", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_over14");
  console.log('    heard ledger ["We run a dental clinic.","We\\'re a bakery, actually."]');
  console.log("over-talk: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "We help dental clinics answer every call"  (reply_create ttfa 400ms)  CUT at 11.30s');
  console.log('11.05s  HEARD   "We\\'re a bakery, actually."  (11.05s-12.10s)');
  console.log("11.40s  CLIENT  barge-in keep jev We're a bakery, actually.");
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "over-talk", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    overheard: { recalled: number; total: number; asides: { text: string; markedOverheard: boolean; inLedger: boolean; tracePointer: string }[] };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.overheard.total, 1);
  assert.equal(artifact.overheard.recalled, 1);
  assert.equal(artifact.overheard.asides[0].markedOverheard, true);
  assert.equal(artifact.overheard.asides[0].inLedger, true);
  assert.match(artifact.overheard.asides[0].tracePointer, /call trace turn 1 \(sess_over14\)/);
  assert.equal(artifact.gates.find((g) => g.name === "overheard-recall")?.status, "PASS");
  assert.match(result.stdout, /overheard recall 1\/1/);
});

test("an aside the caption marked but the session ledger never counted FAILs and cites the turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_over14");
  console.log('    heard ledger ["We run a dental clinic."]');
  console.log("over-talk: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('10.20s  VONI    "We help dental clinics answer every call"  (reply_create ttfa 400ms)  CUT at 11.30s');
  console.log('11.05s  HEARD   "We\\'re a bakery, actually."  (11.05s-12.10s)');
  console.log("11.40s  CLIENT  barge-in keep jev We're a bakery, actually.");
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  run(
    ["--scenario", "over-talk", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    overheard: { asides: { inLedger: boolean }[] };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.overheard.asides[0].inLedger, false);
  const gate = artifact.gates.find((g) => g.name === "overheard-recall")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /missing from the call ledger/);
  assert.match(gate.detail, /call trace turn 1 \(sess_over14\)/, "the FAIL cites the turn it landed on");
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

test("a live run derives free-floor gaps from the runner's silence timeline and cites the surrounding turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_silence");
  console.log("    cut 912ms after the caller started");
  console.log('    verdict ["yield","Wait, stop."]');
  console.log('    answered the point after the cut: "Pricing depends on call volume."');
  console.log('    SILENCE TIMELINE {"scenario":"stop-over","session":"sess_silence","startedMs":0,"endedMs":6000,"agentAudio":[{"startMs":0,"endMs":1000},{"startMs":5000,"endMs":6000}],"callerSpeech":[{"startMs":1000,"endMs":1500}],"coverage":[]}');
  console.log("stop-over: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('1.00s  VONI    "Hi, this is Anna"  (greeting)');
  console.log('1.00s  HEARD   "Hi, this is Anna"  (0.00s-1.00s)');
  console.log('5.00s  VONI    "Pricing depends on call volume"  (reply_create gap 400ms)');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "stop-over", "--trace-session", "sess_silence", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    deadAir: { gapsMs: number[]; maxMs: number | null; silences: unknown[] };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(artifact.deadAir.gapsMs, [3500]);
  assert.equal(artifact.deadAir.maxMs, 3500);
  assert.equal(artifact.deadAir.silences.length, 1);
  const gate = artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /deadAir\.gapsMs/, "the FAIL points at the evidence");
  assert.match(gate.detail, /1\.50s–5\.00s/, "the FAIL cites the silence window");
  assert.match(gate.detail, /call trace turn 1/, "the FAIL cites the surrounding turn");
});

test("a live silence-check-in timeline gates zero, one, two and over-caller check-ins with a call trace turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_check");
  const mode = process.env.EVAL_SILENCE_MODE;
  const timeline =
    mode === "zero"
      ? { scenario: "silence-check-in", session: "sess_check", startedMs: 0, endedMs: 18000, agentAudio: [{ startMs: 0, endMs: 1000 }], callerSpeech: [], coverage: [], checkIns: [] }
      : mode === "two"
        ? { scenario: "silence-check-in", session: "sess_check", startedMs: 0, endedMs: 34000, agentAudio: [{ startMs: 0, endMs: 1000 }], callerSpeech: [], coverage: [], checkIns: [{ atMs: 16200 }, { atMs: 32400 }] }
        : mode === "over"
          ? { scenario: "silence-check-in", session: "sess_check", startedMs: 0, endedMs: 18000, agentAudio: [{ startMs: 0, endMs: 1000 }], callerSpeech: [{ startMs: 16000, endMs: 16800 }], coverage: [], checkIns: [{ atMs: 16200, overCaller: true }] }
          : { scenario: "silence-check-in", session: "sess_check", startedMs: 0, endedMs: 18000, agentAudio: [{ startMs: 0, endMs: 1000 }, { startMs: 16200, endMs: 17500 }], callerSpeech: [], coverage: [], checkIns: [{ atMs: 16200 }] };
  console.log("    SILENCE TIMELINE " + JSON.stringify(timeline));
  console.log("    check-ins " + timeline.checkIns.length + " at " + (timeline.checkIns[0]?.atMs ?? 0) + "ms");
  console.log("silence-check-in: 1/1");
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('1.00s  VONI    "Hi, this is Anna"  (greeting)');
  console.log('17.00s  VONI    "Still with me? Take your time."  (reply_create gap 900ms)');
}
`,
    { mode: 0o755 },
  );
  type Artifact = {
    deadAir: { checkIns: { atSilenceMs: number }[]; longestSilenceMs: number | null };
    gates: { name: string; status: string; detail: string }[];
  };
  const score = (mode: string) => {
    const out = join(dir, `${mode}.json`);
    const result = run(
      ["--scenario", "silence-check-in", "--out", out, "--timing-lock", join(dir, `timing-${mode}.lock`)],
      new URL("../", import.meta.url).pathname,
      { PATH: `${bin}:${process.env.PATH}`, EVAL_SILENCE_MODE: mode },
    );
    return { result, artifact: JSON.parse(readFileSync(out, "utf8")) as Artifact };
  };

  const one = score("one");
  assert.equal(one.result.status, 0, one.result.stderr + one.result.stdout);
  assert.deepEqual(one.artifact.deadAir.checkIns.map((c) => c.atSilenceMs), [15_200]);
  const oneGate = one.artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(oneGate.status, "PASS", oneGate.detail);
  assert.match(oneGate.detail, /exactly one check-in/i);

  const zero = score("zero");
  assert.notEqual(zero.result.status, 0, zero.result.stderr + zero.result.stdout);
  assert.deepEqual(zero.artifact.deadAir.checkIns, []);
  const zeroGate = zero.artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(zeroGate.status, "FAIL");
  assert.match(zeroGate.detail, /0 check-ins/);
  assert.match(zeroGate.detail, /call trace turn 1/, zeroGate.detail);

  const two = score("two");
  assert.notEqual(two.result.status, 0, two.result.stderr + two.result.stdout);
  assert.deepEqual(two.artifact.deadAir.checkIns.map((c) => c.atSilenceMs), [15_200, 31_400]);
  const twoGate = two.artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(twoGate.status, "FAIL");
  assert.match(twoGate.detail, /2 check-ins/);
  assert.match(twoGate.detail, /call trace turn/, twoGate.detail);
  assert.match(twoGate.detail, /31400ms/, "cites the extra check-in");

  const over = score("over");
  assert.notEqual(over.result.status, 0, over.result.stderr + over.result.stdout);
  assert.deepEqual(over.artifact.deadAir.checkIns, [
    { atMs: 16_200, atSilenceMs: 15_200, overCaller: true, trace: "call trace turn 2 (sess_check)" },
  ]);
  const overGate = over.artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(overGate.status, "FAIL");
  assert.match(overGate.detail, /over caller speech/, overGate.detail);
  assert.match(overGate.detail, /call trace turn 2 \(sess_check\)/, "cites the turn the check-in talked over the visitor");
});

test("a measured check-in yield is gated against the quoted cut budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const cwd = new URL("../", import.meta.url).pathname;
  const runCase = (yieldMs: string) => {
    const out = join(dir, `yield-${yieldMs}.json`);
    const result = run(
      [
        "--dry-run",
        "--out",
        out,
        "--check-in-at-ms",
        "15200",
        "--check-in-over-caller",
        "--check-in-yield-ms",
        yieldMs,
      ],
      cwd,
    );
    return { result, artifact: JSON.parse(readFileSync(out, "utf8")) as {
      deadAir: { checkIns: { yieldMs?: number }[] };
      gates: { name: string; status: string; detail: string }[];
    } };
  };
  const prompt = runCase("900");
  assert.equal(prompt.result.status, 0, prompt.result.stderr + prompt.result.stdout);
  assert.equal(prompt.artifact.deadAir.checkIns[0]?.yieldMs, 900);
  assert.equal(prompt.artifact.gates.find((g) => g.name === "dead-air")?.status, "PASS");

  const late = runCase("1900");
  assert.notEqual(late.result.status, 0, late.result.stderr + late.result.stdout);
  const gate = late.artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /held 1900ms/);
  assert.match(gate.detail, /1500ms/);
});

test("a default run executes the whole gate suite once, sequentially, into one artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "invocations.log");
  // The shim proves invocation order/count and that no timing run overlaps.
  const shim = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.SUITE_LOG;
const tag = (line) => fs.appendFileSync(log, line + "\\n");
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  const i = args.indexOf("--scenario");
  const scenario = i >= 0 ? args[i + 1] : "(none)";
  tag("start " + scenario);
  const summary = (name) => console.log("EVAL SUMMARY " + JSON.stringify({
    scenario: name, runs: 1, failures: 0,
    scenarios: [{ name, passed: 1, runs: 1 }],
    traceSessions: ["sess_suite"], playout: [{ scenario: name, run: 1, wallClockMs: 1000 }],
    audioChunks: 40, live: true, clips: [],
  }));
  console.log("  · trace session sess_suite");
  if (scenario === "greeting-cut") {
    console.log("    greeting cut 900ms after the caller started (budget 1500ms)");
  } else if (scenario === "filler-over") {
    console.log('    filler never cut; events [["ignore","Okaay so"]]; handling heard-only');
  } else if (scenario === "stop-over") {
    console.log("    cut 900ms after the caller started (budget 1500ms)");
    console.log('    answered the point after the cut: "about 200 dollars a month"');
  } else if (scenario === "over-talk") {
    console.log("    heard ledger [\\"We're a bakery, actually.\\"]");
    console.log("    DOUBLE TALK " + JSON.stringify({ scenario: "over-talk", session: "sess_suite", overlapMs: [40], fadeMs: 40 }));
  } else if (scenario === "silence-check-in") {
    console.log("    SILENCE TIMELINE " + JSON.stringify({
      scenario: "silence-check-in", session: "sess_suite",
      startedMs: 0, endedMs: 18000,
      agentAudio: [{ startMs: 0, endMs: 1000 }, { startMs: 17000, endMs: 18000 }],
      callerSpeech: [], coverage: [], checkIns: [{ atMs: 16200 }],
    }));
  } else if (scenario === "invite-tag") {
    console.log("EMAIL INVITE " + JSON.stringify({
      tag: "Lime 42",
      agentLines: ["Send me an email from your work address with Lime 42 in the subject, and tell me when it's sent."],
      lineTurns: [2], chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
      showToolCalls: 1, chipTurn: 2, traceSession: "sess_suite",
    }));
  } else if (scenario === "bye-audio") {
    console.log("    hung up 900ms after the goodbye finished playing (session sess_suite)");
    console.log("    GOODBYE DRAIN " + JSON.stringify({ scenario: "bye-audio", session: "sess_suite", turn: 4, coverage: 0.95, inboxNamed: true }));
  } else if (scenario === "hang-up-fast") {
    console.log("    hung up 800ms after the goodbye finished playing (session sess_suite)");
  } else if (scenario === "hang-up-over") {
    console.log("    hung up 1100ms after the goodbye finished playing (session sess_suite)");
  }
  console.log(scenario + ": 1/1");
  summary(scenario);
  tag("end " + scenario);
  process.exit(0);
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log(' 1.00s  VONI    "Welcome to the demo"  (reply_create gap 700ms)');
  console.log(' 4.00s  VONI    "Sure, first the tour"  (reply_create gap 900ms) CUT at 4.10s by caller speech');
  console.log(' 5.00s  VONI    "About 200 dollars a month."  (reply_create gap 600ms)');
}
`;
  writeFileSync(join(bin, "npm"), shim, { mode: 0o755 });
  const out = join(dir, "suite.json");
  const result = run(
    ["--out", out, "--timing-lock", join(dir, "suite.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}`, SUITE_LOG: log },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const calls = readFileSync(log, "utf8").trim().split("\n");
  const suite = [
    "greeting-cut",
    "filler-over",
    "stop-over",
    "over-talk",
    "silence-check-in",
    "invite-tag",
    "bye-audio",
    "hang-up-fast",
    "hang-up-over",
  ];
  assert.deepEqual(
    calls,
    suite.flatMap((name) => [`start ${name}`, `end ${name}`]),
    "every scenario runs once, one at a time, never in parallel",
  );

  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    evalRunner: { scenario: string; status: string; timings: { scenarioRuns: { scenario: string }[] } };
    doubleTalk: { overlapMs: number[] };
    deadAir: { checkIns: { atSilenceMs: number }[] };
    emailInvite: { tagMentions: number } | null;
    endCallDrain: { goodbyeCoverage: number | null; hangUpDelayMs: number | null };
    beats: Record<string, { cutMs: number | null }>;
  };
  assert.equal(artifact.evalRunner.scenario, "suite");
  assert.equal(artifact.evalRunner.status, "ok");
  assert.deepEqual(artifact.doubleTalk.overlapMs, [40], "over-talk's own line is merged");
  assert.deepEqual(artifact.deadAir.checkIns.map((c) => c.atSilenceMs), [15_200], "silence-check-in's own timeline is merged");
  assert.equal(artifact.emailInvite?.tagMentions, 1, "invite-tag's own line is merged");
  assert.equal(artifact.endCallDrain.goodbyeCoverage, 0.95, "bye-audio's own line is merged");
  assert.equal(artifact.endCallDrain.hangUpDelayMs, 1100, "the worst hang-up path is carried");
  assert.equal(artifact.beats["greeting-cut"].cutMs, 900);
  assert.ok(artifact.evalRunner.timings.scenarioRuns.length >= 9);
});

test("suite mode scores every gate from its own scenario and merges each call's trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const fillerTail = JSON.stringify({
    agent: "I can answer that after we do the test. Ready to see how",
    heard: "I can answer that after we do the test.",
    resumed: "",
    resumeMs: null,
  });
  const invite = {
    tag: "Lime 42",
    agentLines: [EMAIL_INVITE_LINE],
    lineTurns: [2],
    chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
    showToolCalls: 1,
    chipTurn: 2,
    traceSession: "sess_inv",
  };
  const silence = {
    scenario: "silence-check-in",
    session: "sess_sil",
    startedMs: 0,
    endedMs: 18_000,
    agentAudio: [{ startMs: 0, endMs: 1_000 }, { startMs: 17_000, endMs: 18_000 }],
    callerSpeech: [],
    coverage: [],
    checkIns: [{ atMs: 16_200 }],
  };
  const fixture: Record<string, string[]> = {
    "greeting-cut": [
      "  · trace session sess_gc",
      "    greeting cut 1176ms after the caller started (budget 1500ms)",
      "greeting-cut: 1/1",
    ],
    "filler-over": [
      "  · trace session sess_fill",
      `    filler cut at 2213ms; events [["ignore","Okay, so"]]; handling answered; tail ${fillerTail}`,
      "  ✗ filler-over #1: cut and not resumed",
      "filler-over: 0/1",
    ],
    "stop-over": [
      "  · trace session sess_stop",
      "    cut 1171ms after the caller started (budget 1500ms)",
      '    answered the point after the cut: "Pricing depends on call volume."',
      "stop-over: 1/1",
    ],
    "over-talk": [
      "  · trace session sess_over",
      "    heard ledger [\"We're a bakery, actually.\"]",
      `    DOUBLE TALK ${JSON.stringify({ scenario: "over-talk", session: "sess_over", overlapMs: [40], fadeMs: 40 })}`,
      "over-talk: 1/1",
    ],
    "silence-check-in": [
      "  · trace session sess_sil",
      `    SILENCE TIMELINE ${JSON.stringify(silence)}`,
      "silence-check-in: 1/1",
    ],
    "invite-tag": ["  · trace session sess_inv", `EMAIL INVITE ${JSON.stringify(invite)}`, "invite-tag: 1/1"],
    "bye-audio": [
      "  · trace session sess_bye",
      `    GOODBYE DRAIN ${JSON.stringify({ scenario: "bye-audio", session: "sess_bye", turn: 3, coverage: 0.95, inboxNamed: true, narratedEnding: false })}`,
      "bye-audio: 1/1",
    ],
    "hang-up-fast": [
      "  · trace session sess_fast",
      "    hung up 900ms after the goodbye finished playing (session sess_fast)",
      "hang-up-fast: 1/1",
    ],
    "hang-up-over": [
      "  · trace session sess_hover",
      "    hung up 500ms after the goodbye finished playing (session sess_hover)",
      "hang-up-over: 1/1",
    ],
  };
  const traces: Record<string, string[]> = {
    sess_gc: [
      '1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)  CUT at 1.10s',
      '3.00s  VONI    "Sorry,"  (user_speech ttfa 900ms gap 1100ms)',
    ],
    sess_stop: [
      '1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)',
      '5.00s  VONI    "I\'ll show you by doing first."  (user_speech gap 900ms)  CUT at 5.50s',
      '7.00s  VONI    "About 200 a month."  (user_speech gap 1200ms)',
    ],
    sess_fill: ['1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)'],
    sess_over: ['1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)  CUT at 4.00s'],
    sess_sil: ['1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)'],
    sess_inv: ['1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)', '9.00s  VONI    "Send me an email with Lime 42."  (user_speech gap 800ms)'],
    sess_bye: ['1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)', '20.00s  TOOL    end_call {"closing_line":"Bye!"}', '20.00s  VONI    "Goodbye!"  (user_speech gap 700ms)'],
    sess_fast: ['1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)', '9.00s  TOOL    end_call {"closing_line":"Okay, bye!"}', '9.00s  VONI    "Okay, bye!"  (user_speech)'],
    sess_hover: ['1.00s  VONI    "Hi, I\'m Voni!"  (greeting ttfa 600ms)', '18.00s  TOOL    end_call {"closing_line":"Goodbye!"}', '18.00s  VONI    "No problem. Goodbye!"  (user_speech gap 600ms)'],
  };
  const failing = { "filler-over": 1 };
  const shim = `#!/usr/bin/env node
const args = process.argv.slice(2);
const fixture = ${JSON.stringify(fixture)};
const traces = ${JSON.stringify(traces)};
const failing = ${JSON.stringify(failing)};
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  const i = args.indexOf("--scenario");
  const scenario = i >= 0 ? args[i + 1] : "(none)";
  for (const line of fixture[scenario] ?? []) console.log(line);
  const failures = failing[scenario] ?? 0;
  console.log("EVAL SUMMARY " + JSON.stringify({
    scenario, runs: 1, failures,
    scenarios: [{ name: scenario, passed: failures ? 0 : 1, runs: 1 }],
    traceSessions: [], playout: [], audioChunks: 40, live: true, clips: [],
  }));
  process.exit(failures ? 1 : 0);
} else if (args[0] === "run" && args[1] === "call:trace") {
  const lines = traces[args[3]];
  if (!lines) { console.error("No timeline yet"); process.exit(2); }
  for (const line of lines) console.log(line);
}
`;
  writeFileSync(join(bin, "npm"), shim, { mode: 0o755 });
  const out = join(dir, "suite.json");
  const result = run(["--out", out, "--timing-lock", join(dir, "suite.lock")], new URL("../", import.meta.url).pathname, {
    PATH: `${bin}:${process.env.PATH}`,
  });
  // filler-over failed its own scenario AND dropped an unheard tail: the
  // suite must score that FAIL from the failed scenario's evidence, never
  // leave it INFO or green the command.
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
    beats: Record<string, { gapMs: number | null }>;
    replyGap: { p50Ms: number | null; samples: number };
    endCallDrain: { hangUpDelayMs: number | null };
    callTrace: { sessionId: string; sessions?: { sessionId: string }[] };
  };
  const byName = Object.fromEntries(artifact.gates.map((g) => [g.name, `${g.status} ${g.detail}`]));
  assert.match(byName["greeting-cut"], /^PASS .*1176ms/);
  assert.match(byName["barge-in-cut"], /^PASS .*1171ms/);
  assert.match(byName["filler-resume"], /^FAIL .*sess_fill/);
  assert.match(byName["filler-resume"], /answered instead of resumed-from/);
  assert.match(byName["email-invite"], /INFO|PASS/);
  assert.match(byName["double-talk"], /^PASS/);
  assert.match(byName["dead-air"], /^PASS/);
  assert.match(byName["end-call-drain"], /^PASS/);
  assert.equal(artifact.endCallDrain.hangUpDelayMs, 900, "the worst hang-up is carried");
  // Each scenario's own trace feeds reply gaps; the greeting call's 1100ms
  // and the stop-over call's 900/1200ms are all inside budget.
  assert.equal(artifact.beats["greeting-cut"].gapMs, 1100);
  assert.equal(artifact.replyGap.samples, 5, "every scenario's measured turn is a sample (cut turns measure cut latency)");
  const reply = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(reply.status, "PASS", reply.detail);
  assert.equal(artifact.callTrace.sessionId, "sess_gc");
  assert.equal(artifact.callTrace.sessions?.length, 9, "every scenario's call is recorded");
});

test("default, all and suite dry runs spawn nothing and select the suite", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const marker = join(dir, "spawned");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");\n`,
    { mode: 0o755 },
  );
  for (const [label, args] of [
    ["default", []],
    ["all", ["--scenario", "all"]],
    ["suite", ["--scenario", "suite"]],
  ] as const) {
    const out = join(dir, `${label}.json`);
    const result = run(
      [...args, "--dry-run", "--out", out],
      new URL("../", import.meta.url).pathname,
      { PATH: `${bin}:${process.env.PATH}` },
    );
    assert.equal(result.status, 0, `${label}: ${result.stderr}${result.stdout}`);
    const artifact = JSON.parse(readFileSync(out, "utf8")) as { evalRunner: { scenario: string; status: string } };
    assert.equal(artifact.evalRunner.scenario, "suite", `${label} routes to the suite`);
    assert.equal(artifact.evalRunner.status, "skipped");
  }
  assert.equal(existsSync(marker), false, "no dry run spawned the runner");
});

test("--silence-json feeds dead-air automatically, and explicit CLI flags still override it", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const evidencePath = join(dir, "silence.json");
  writeFileSync(
    evidencePath,
    JSON.stringify({
      startedMs: 0,
      endedMs: 6000,
      agentAudio: [
        { startMs: 0, endMs: 1000 },
        { startMs: 5000, endMs: 6000 },
      ],
      callerSpeech: [{ startMs: 1000, endMs: 1500 }],
      coverage: [{ atMs: 4000 }],
    }),
  );
  const coveredOut = join(dir, "covered.json");
  const covered = run(
    ["--dry-run", "--voice", DEMO_VOICE_IDS[0], "--out", coveredOut, "--silence-json", evidencePath],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(covered.status, 0, covered.stderr + covered.stdout);
  const coveredArtifact = JSON.parse(readFileSync(coveredOut, "utf8")) as {
    deadAir: { gapsMs: number[]; longestSilenceMs: number | null };
    gates: { name: string; status: string }[];
  };
  assert.deepEqual(coveredArtifact.deadAir.gapsMs, []);
  assert.equal(coveredArtifact.deadAir.longestSilenceMs, 3500);
  assert.equal(coveredArtifact.gates.find((g) => g.name === "dead-air")?.status, "PASS");

  const overrideOut = join(dir, "override.json");
  const override = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      overrideOut,
      "--silence-json",
      evidencePath,
      "--dead-air-gaps",
      "3200",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(override.status, 0, override.stderr + override.stdout);
  const overrideArtifact = JSON.parse(readFileSync(overrideOut, "utf8")) as {
    deadAir: { gapsMs: number[] };
    gates: { name: string; status: string }[];
  };
  assert.deepEqual(overrideArtifact.deadAir.gapsMs, [3200]);
  assert.equal(overrideArtifact.gates.find((g) => g.name === "dead-air")?.status, "FAIL");
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

test("the runner's DOUBLE TALK evidence feeds the double-talk gate and a breach cites the cut turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  const overlaps = JSON.parse(process.env.SHIM_OVERLAPS);
  const passed = Math.max(...overlaps) <= 400;
  console.log("  · trace session sess_dt16");
  console.log('    heard ledger ["We\\'re a bakery, actually."]');
  console.log("    DOUBLE TALK " + JSON.stringify({ scenario: "over-talk", session: "sess_dt16", overlapMs: overlaps, fadeMs: 40 }));
  console.log("    double talk " + Math.max(...overlaps) + "ms max (cuts: " + overlaps.join(", ") + "ms; budget 400ms; fade 0.04s)");
  if (!passed) console.log("  ✗ over-talk #1: double talk too long");
  console.log("over-talk: " + (passed ? "1/1" : "0/1"));
  console.log("EVAL SUMMARY " + JSON.stringify({
    scenario: "over-talk",
    runs: 1,
    failures: passed ? 0 : 1,
    scenarios: [{ name: "over-talk", passed: passed ? 1 : 0, runs: 1 }],
    traceSessions: ["sess_dt16"],
    playout: [{ scenario: "over-talk", run: 1, wallClockMs: 12000 }],
    audioChunks: 40,
    live: true,
  }));
  process.exit(passed ? 0 : 1);
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('12.20s  HEARD   "We\\'re a bakery, actually."');
  console.log('12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms) CUT at 12.20s by caller speech');
  console.log('13.10s  VONI    "A bakery, got it."  (reply_create gap 700ms)');
}
`,
    { mode: 0o755 },
  );
  const cwd = new URL("../", import.meta.url).pathname;
  const env = { PATH: `${bin}:${process.env.PATH}` };

  const longOut = join(dir, "long.json");
  const long = run(["--scenario", "over-talk", "--out", longOut, "--timing-lock", join(dir, "lock-a")], cwd, {
    ...env,
    SHIM_OVERLAPS: JSON.stringify([40, 650]),
  });
  assert.equal(long.status, 1, long.stderr + long.stdout);
  const longArtifact = JSON.parse(readFileSync(longOut, "utf8")) as {
    doubleTalk: { overlapMs: number[]; maxMs: number };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.deepEqual(longArtifact.doubleTalk.overlapMs, [40, 650]);
  assert.equal(longArtifact.doubleTalk.maxMs, 650);
  const failing = longArtifact.gates.find((g) => g.name === "double-talk")!;
  assert.equal(failing.status, "FAIL");
  assert.ok(failing.detail.includes("40, 650"), `every measured cut is named: ${failing.detail}`);
  assert.match(failing.detail, /call trace turn 1 \(sess_dt16\)/);
  assert.match(long.stdout, /FAIL\s+double-talk/);

  const briefOut = join(dir, "brief.json");
  const brief = run(["--scenario", "over-talk", "--out", briefOut, "--timing-lock", join(dir, "lock-b")], cwd, {
    ...env,
    SHIM_OVERLAPS: JSON.stringify([40, 0]),
  });
  assert.equal(brief.status, 0, brief.stderr + brief.stdout);
  const briefArtifact = JSON.parse(readFileSync(briefOut, "utf8")) as {
    gates: { name: string; status: string }[];
  };
  assert.equal(briefArtifact.gates.find((g) => g.name === "double-talk")?.status, "PASS");
  assert.match(brief.stdout, /PASS\s+double-talk/);
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

/** A fake eval runner that prints one GOODBYE DRAIN line (and the hang-up line). */
function goodbyeShim(evidence: Record<string, unknown>, hangUpLine?: string, traceNarration = evidence.narratedEnding === true) {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session ${evidence.session ?? "sess_gd20"}");
${hangUpLine ? `  console.log(${JSON.stringify(hangUpLine)});` : ""}
  console.log("    GOODBYE DRAIN " + JSON.stringify(${JSON.stringify(evidence)}));
  console.log("bye-audio: 1/1");
  console.log("EVAL SUMMARY " + JSON.stringify({
    scenario: "bye-audio",
    runs: 1,
    failures: 0,
    scenarios: [{ name: "bye-audio", passed: 1, runs: 1 }],
    traceSessions: [${JSON.stringify(evidence.session ?? "sess_gd20")}],
    playout: [],
    audioChunks: 40,
    live: true,
    clips: [],
  }));
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log(' 1.00s  VONI    "Welcome to the demo"  (reply_create gap 700ms)');
  console.log(' 4.00s  HEARD   "Okay, sounds good."');
  console.log(' 5.00s  VONI    "Here is the invite"  (reply_create gap 600ms)');
  console.log(' 6.00s  VONI    "Sure thing"  (reply_create gap 500ms)');
  console.log(' 7.00s  TOOL    end_call {"reason":"caller asked"} 100ms');
  console.log(' 8.00s  VONI    "I will let you go, the team is at hi at voni dot c c"  (reply_create gap 600ms)');
${traceNarration ? `  console.log(' 9.00s  VONI    "The call has ended. Have a nice day."  (reply_create gap 500ms)');` : ""}
}
`;
}

function runGoodbyeShim(
  dir: string,
  evidence: Record<string, unknown>,
  args: string[] = [],
  hangUpLine?: string,
  traceNarration?: boolean,
) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), goodbyeShim(evidence, hangUpLine, traceNarration), { mode: 0o755 });
  const out = join(dir, `score-${Math.random().toString(36).slice(2)}.json`);
  const result = run(
    ["--scenario", "bye-audio", "--out", out, "--timing-lock", join(dir, `lock-${Math.random().toString(36).slice(2)}`), ...args],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  return { result, out, artifact: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown> : null };
}

test("the runner's full goodbye evidence greens end-call-drain without flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    { scenario: "bye-audio", session: "sess_gd20", turn: 4, coverage: 0.97, inboxNamed: true },
    [],
    "    hung up 612ms after the goodbye finished playing",
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const a = artifact as {
    endCallDrain: { goodbyeCoverage: number; hangUpDelayMs: number; inboxNamed: boolean };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(a.endCallDrain.goodbyeCoverage, 0.97);
  assert.equal(a.endCallDrain.hangUpDelayMs, 612);
  assert.equal(a.endCallDrain.inboxNamed, true);
  const gate = a.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "PASS");
  assert.match(gate.detail, /hi@voni\.cc/);
  assert.match(result.stdout, /PASS\s+end-call-drain/);
});

test("the runner saying the ending was narrated fails at the post-End call turn", () => {
  // Post-End call silence is evidence the runner measures (it hears every
  // reply) and the merged trace turns into a pointer. No --narrated-ending
  // flag: a real run must be able to FAIL on its own evidence.
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    {
      scenario: "bye-audio",
      session: "sess_gd21",
      turn: 4,
      coverage: 0.97,
      inboxNamed: true,
      narratedEnding: true,
    },
    [],
    "    hung up 700ms after the goodbye finished playing",
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const a = artifact as {
    endCallDrain: { narratedEnding: boolean };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(a.endCallDrain.narratedEnding, true);
  const gate = a.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /narrat/i);
  assert.match(gate.detail, /call trace turn 5 \(sess_gd21\)/, `cites the post-End turn: ${gate.detail}`);
});

test("the runner seeing narration with no merged turn says so explicitly", () => {
  // The runner heard the post-End reply; the merged trace has no such row
  // (that call's excerpt was not merged). The FAIL must say "no turn", not
  // point at the goodbye.
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    {
      scenario: "bye-audio",
      session: "sess_gd23",
      turn: 4,
      coverage: 0.97,
      inboxNamed: true,
      narratedEnding: true,
    },
    [],
    "    hung up 700ms after the goodbye finished playing",
    false,
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const gate = (artifact as { gates: { name: string; status: string; detail: string }[] }).gates.find(
    (g) => g.name === "end-call-drain",
  )!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /narrat/i);
  assert.match(gate.detail, /no turn merged \(sess_gd23\)/, `explicit no-turn: ${gate.detail}`);
  assert.doesNotMatch(gate.detail, /call trace turn 4/, "never cites the goodbye turn");
});

test("the runner measuring a silent ending keeps the gate green", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    {
      scenario: "bye-audio",
      session: "sess_gd22",
      turn: 4,
      coverage: 0.97,
      inboxNamed: true,
      narratedEnding: false,
    },
    [],
    "    hung up 700ms after the goodbye finished playing",
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const a = artifact as { endCallDrain: { narratedEnding: boolean } };
  assert.equal(a.endCallDrain.narratedEnding, false);
});

test("a closing line that never named the inbox fails at the runner's closing turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(dir, {
    scenario: "bye-audio",
    session: "sess_gd20",
    turn: 4,
    coverage: 0.97,
    inboxNamed: false,
  });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const gate = (artifact as { gates: { name: string; status: string; detail: string }[] }).gates.find(
    (g) => g.name === "end-call-drain",
  )!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /hi@voni\.cc/, `detail names the missing inbox: ${gate.detail}`);
  assert.match(gate.detail, /call trace turn 4 \(sess_gd20\)/, `detail cites the turn: ${gate.detail}`);
});

test("a chopped goodbye fails with its coverage and the runner's closing turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(dir, {
    scenario: "bye-audio",
    session: "sess_gd20",
    turn: 4,
    coverage: 0.42,
    inboxNamed: true,
  });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const gate = (artifact as { gates: { name: string; status: string; detail: string }[] }).gates.find(
    (g) => g.name === "end-call-drain",
  )!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /42%/, `detail carries the measured coverage: ${gate.detail}`);
  assert.match(gate.detail, /call trace turn 4 \(sess_gd20\)/);
});

test("explicit goodbye flags override the runner's evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    { scenario: "bye-audio", session: "sess_gd20", turn: 4, coverage: 0.42, inboxNamed: false },
    ["--goodbye-coverage", "0.96", "--goodbye-inbox-named", "--hang-up-delay-ms", "900"],
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const a = artifact as {
    endCallDrain: { goodbyeCoverage: number; hangUpDelayMs: number; inboxNamed: boolean };
    gates: { name: string; status: string }[];
  };
  assert.equal(a.endCallDrain.goodbyeCoverage, 0.96);
  assert.equal(a.endCallDrain.hangUpDelayMs, 900);
  assert.equal(a.endCallDrain.inboxNamed, true);
  assert.equal(a.gates.find((g) => g.name === "end-call-drain")?.status, "PASS");
});

test("goodbye evidence from another call says no turn was merged", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    { scenario: "bye-audio", session: "sess_gd20", turn: 4, coverage: 0.42, inboxNamed: true },
    ["--trace-session", "sess_other20"],
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const gate = (artifact as { gates: { name: string; status: string; detail: string }[] }).gates.find(
    (g) => g.name === "end-call-drain",
  )!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no turn merged/, `detail states the missing turn: ${gate.detail}`);
});

test("a slow hang-up cites the closing turn of the call whose drain ran long", () => {
  // The GOODBYE DRAIN evidence comes from another scenario's call, so its
  // turn cannot explain this hang-up. The measured hang-up line names its own
  // session; merged, that call's closing turn is the one the FAIL must cite.
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    { scenario: "bye-audio", session: "sess_bye20", turn: 4, coverage: 0.97, inboxNamed: true },
    ["--trace-session", "sess_drain21"],
    "    hung up 4200ms after the goodbye finished playing (session sess_drain21)",
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const gate = (artifact as { gates: { name: string; status: string; detail: string }[] }).gates.find(
    (g) => g.name === "end-call-drain",
  )!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /4200/, `detail carries the measured delay: ${gate.detail}`);
  assert.match(gate.detail, /call trace turn 4 \(sess_drain21\)/, `detail cites the drained turn: ${gate.detail}`);
  assert.doesNotMatch(gate.detail, /no turn merged/, "the drained call was merged, so its turn is known");
});

test("a slow hang-up from an unmerged call says no turn was merged", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    { scenario: "bye-audio", session: "sess_bye20", turn: 4, coverage: 0.97, inboxNamed: true },
    ["--trace-session", "sess_other21"],
    "    hung up 4200ms after the goodbye finished playing (session sess_drain21)",
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const gate = (artifact as { gates: { name: string; status: string; detail: string }[] }).gates.find(
    (g) => g.name === "end-call-drain",
  )!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /sess_drain21/, `detail names the call that ran long: ${gate.detail}`);
  assert.match(gate.detail, /no turn merged/, `never cites another call's turn: ${gate.detail}`);
});

test("an early close cites the closing turn of the call that ended before its goodbye", () => {
  // The session closed 200ms before the goodbye's audio finished. The FAIL
  // must point at that call's closing turn, where the chop is visible.
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const { result, artifact } = runGoodbyeShim(
    dir,
    { scenario: "bye-audio", session: "sess_bye22", turn: 4, coverage: 0.97, inboxNamed: true },
    ["--trace-session", "sess_drain22"],
    "    hung up -200ms after the goodbye finished playing (session sess_drain22)",
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const gate = (artifact as { gates: { name: string; status: string; detail: string }[] }).gates.find(
    (g) => g.name === "end-call-drain",
  )!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /200ms before goodbye audio ended/, `detail states the early close: ${gate.detail}`);
  assert.match(gate.detail, /call trace turn 4 \(sess_drain22\)/, `detail cites the closed call's turn: ${gate.detail}`);
  assert.doesNotMatch(gate.detail, /no turn merged/, "the closed call was merged, so its turn is known");
});

test("a hang-up with no closing line fails instead of measuring the greeting", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_nogood");
  console.log("    no goodbye audio after the end request (session sess_nogood)");
  console.log("  ✗ hang-up-fast #1: no goodbye audio after End call");
  console.log("hang-up-fast: 0/1");
  console.log("EVAL SUMMARY " + JSON.stringify({ scenario: "hang-up-fast", runs: 1, failures: 1,
    scenarios: [{ name: "hang-up-fast", passed: 0, runs: 1 }], traceSessions: ["sess_nogood"],
    playout: [], audioChunks: 40, live: true, clips: [] }));
  process.exit(1);
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log('1.00s  VONI    "Hi, I\\'m Voni!"  (greeting ttfa 600ms)');
  console.log('9.00s  TOOL    end_call {"closing_line":"Okay, bye!"}');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "hang-up-fast", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    endCallDrain: { hangUpDelayMs: number | null; missingGoodbye?: boolean };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.endCallDrain.hangUpDelayMs, null, "never measures from the greeting");
  assert.equal(artifact.endCallDrain.missingGoodbye, true);
  const gate = artifact.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no goodbye audio after End call/);
  assert.match(gate.detail, /sess_nogood/);
  // The measurements gate stays satisfied: a missing goodbye is measured.
  const measurements = artifact.gates.find((g) => g.name === "measurements")!;
  assert.match(measurements.detail, /end-call-drain/);
});

test("a run without goodbye evidence keeps end-call-drain INFO, never PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("  · trace session sess_none20");
  console.log("bye-audio: 1/1");
  console.log("EVAL SUMMARY " + JSON.stringify({ scenario: "bye-audio", runs: 1, failures: 0, scenarios: [{ name: "bye-audio", passed: 1, runs: 1 }], traceSessions: ["sess_none20"], playout: [], audioChunks: 40, live: true, clips: [] }));
} else if (args[0] === "run" && args[1] === "call:trace") {
  console.log(' 8.00s  VONI    "I will let you go"');
}
`,
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "bye-audio", "--out", out, "--timing-lock", join(dir, "lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  // No measured evidence at all: the run fails the measurements gate, but the
  // drain gate must still report INFO rather than a false PASS.
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.gates.find((g) => g.name === "end-call-drain")?.status, "INFO");
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

test("--recording-file binds ballots to the harness-computed recording sha256", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "file-bound.json");
  const recording = join(dir, "golden.ogg");
  writeFileSync(recording, "golden call audio");
  const expected = createHash("sha256").update("golden call audio").digest("hex");
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--recording-file",
      recording,
      "--rate",
      "ana:5,4",
      "--rate",
      "bob:4,4",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    humanRatings: { recordingSha256: string };
    humanReview: { recordingSha256: string; raterCount: number; requiredRaters: number; protocol: string };
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.humanRatings.recordingSha256, expected);
  assert.equal(artifact.humanReview.recordingSha256, expected);
  assert.equal(artifact.humanReview.raterCount, 2);
  assert.equal(artifact.humanReview.requiredRaters, 2);
  assert.match(artifact.humanReview.protocol, /blind/);
  assert.equal(artifact.gates.find((g) => g.name === "accent-human")?.status, "PASS");
  assert.ok(result.stdout.includes(expected), "console prints the shared recording sha256");
  assert.match(result.stdout, /blind human ballots/);

  const mismatch = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      join(dir, "mismatch.json"),
      "--recording",
      "d".repeat(64),
      "--recording-file",
      recording,
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(mismatch.status, 0);
  assert.ok(!existsSync(join(dir, "mismatch.json")));
  assert.match(mismatch.stderr + mismatch.stdout, /does not match/);
});

test("ballots on a failing auto gate are recorded but leave the run red", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "blocked.json");
  const probes = probeFile(dir, { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 });
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--probe-json",
      probes,
      "--recording",
      RECORDING_SHA,
      "--rate",
      "ana:5,5",
      "--rate",
      "bob:5,5",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, "auto FAIL keeps the run red no matter the ballots");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    humanRatings: { ratings: unknown[] };
    humanReview: { counted: boolean; autoTimbrePassed: boolean };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.gates.find((g) => g.name === "timbre-probes")?.status, "FAIL");
  const human = artifact.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "INFO");
  assert.match(human?.detail ?? "", /reported, not counted/);
  assert.equal(artifact.humanRatings.ratings.length, 2, "ballots stay reviewable in the artifact");
  assert.equal(artifact.humanReview.autoTimbrePassed, false);
  assert.equal(artifact.humanReview.counted, false);
  assert.match(result.stdout, /reported, not counted/);
});

test("a low ballot after a passing auto gate never fails the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const out = join(dir, "low.json");
  const result = run(
    [
      "--dry-run",
      "--voice",
      DEMO_VOICE_IDS[0],
      "--out",
      out,
      "--recording",
      RECORDING_SHA,
      "--rate",
      "ana:1,1",
      "--rate",
      "bob:1,1",
    ],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, "taste never fails a run");
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const human = artifact.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "PASS");
  assert.match(human?.detail ?? "", /timbre 1 \/ accent 1/);
  assert.ok(!artifact.gates.some((gate) => gate.status === "FAIL"));
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

// ── Ticket 26: invite once plus chip once ───────────────────────────────────

const EMAIL_INVITE_LINE =
  "Send me an email from your work address with Lime 42 in the subject, and tell me when it's sent.";

/** A fake eval runner that prints one `EMAIL INVITE` evidence line, then its summary. */
function emailRunnerShim(evidence: unknown, summary = 'invite-tag: 1/1'): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "eval:demo-agent") {
  console.log("EMAIL INVITE " + JSON.stringify(${JSON.stringify(evidence)}));
  console.log(${JSON.stringify(summary)});
}
`;
}

function writeEmailJson(dir: string, name: string, evidence: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
}

test("a live invite-tag run applies the runner evidence and keeps unmeasured memory INFO", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    emailRunnerShim({
      tag: "Lime 42",
      agentLines: [EMAIL_INVITE_LINE],
      lineTurns: [2],
      chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
      showToolCalls: 1,
      chipTurn: 2,
      traceSession: "sess_email26",
    }),
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "invite-tag", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    emailInvite: { tagMentions: number; chipShows: number; memoryPersists: boolean | null; status: string };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.emailInvite.tagMentions, 1);
  assert.equal(artifact.emailInvite.chipShows, 1);
  assert.equal(artifact.emailInvite.memoryPersists, null, "the live runner never measures Hold memory");
  assert.equal(artifact.emailInvite.status, "PASS");
  assert.equal(artifact.gates.find((g) => g.name === "email-invite")?.status, "INFO");
  assert.match(artifact.gates.find((g) => g.name === "email-invite")?.detail ?? "", /unmeasured/);
  assert.equal(artifact.gates.find((g) => g.name === "measurements")?.status, "INFO");
  assert.match(result.stdout, /INFO\s+email-invite/);
});

test("a repeated invite from the runner fails and cites the Call trace turn where it repeated", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    emailRunnerShim(
      {
        tag: "Lime 42",
        agentLines: [EMAIL_INVITE_LINE, EMAIL_INVITE_LINE],
        lineTurns: [2, 5],
        chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
        showToolCalls: 1,
        chipTurn: 2,
        traceSession: "sess_email26",
      },
      "invite-tag: 0/1",
    ),
    { mode: 0o755 },
  );
  const out = join(dir, "score.json");
  const result = run(
    ["--scenario", "invite-tag", "--out", out, "--timing-lock", join(dir, "timing.lock")],
    new URL("../", import.meta.url).pathname,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "email-invite")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /said the tag 2 times at call trace turn 5 \(sess_email26\)/);
});

test("--email-json scores a browser run with chip and memory evidence, one chip, one tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const json = writeEmailJson(dir, "email.json", {
    tag: "Lime 42",
    agentLines: [EMAIL_INVITE_LINE],
    lineTurns: [2],
    chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
    showToolCalls: 1,
    chipTurn: 2,
    traceSession: "sess_browser26",
    memoryInvitedBefore: true,
    memoryInvitedAfter: true,
    tagTokenBefore: "tag-tok",
    tagTokenAfter: "tag-tok",
  });
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--out", out, "--email-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    emailInvite: { status: string; memoryPersists: boolean | null };
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.emailInvite.status, "PASS");
  assert.equal(artifact.emailInvite.memoryPersists, true);
  assert.equal(artifact.gates.find((g) => g.name === "email-invite")?.status, "PASS");
});

test("--email-json without memory evidence stays INFO, never PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const json = writeEmailJson(dir, "email.json", {
    agentLines: [EMAIL_INVITE_LINE],
    lineTurns: [2],
    chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
    showToolCalls: 1,
    chipTurn: 2,
    traceSession: "sess_browser26",
  });
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--out", out, "--email-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string }[];
  };
  assert.equal(artifact.gates.find((g) => g.name === "email-invite")?.status, "INFO");
});

test("--email-json a tag lost on Hold return fails and cites the memory turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const json = writeEmailJson(dir, "email.json", {
    agentLines: [EMAIL_INVITE_LINE],
    lineTurns: [2],
    chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
    showToolCalls: 1,
    chipTurn: 2,
    traceSession: "sess_hold27",
    memoryInvitedBefore: true,
    memoryInvitedAfter: true,
    tagTokenBefore: "tag-tok",
    tagTokenAfter: "new-tag",
    memoryTurn: 7,
  });
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--out", out, "--email-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    emailInvite: { memoryPersists: boolean | null; memoryTraceTurn: string | null };
    gates: { name: string; status: string; detail: string }[];
  };
  assert.equal(artifact.emailInvite.memoryPersists, false);
  assert.equal(artifact.emailInvite.memoryTraceTurn, "call trace turn 7 (sess_hold27)");
  const gate = artifact.gates.find((g) => g.name === "email-invite")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /tag did not persist across Hold return\/reload at call trace turn 7 \(sess_hold27\)/);
});

test("--email-json chip duplication fails and cites the chip's Call trace turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const json = writeEmailJson(dir, "email.json", {
    agentLines: [EMAIL_INVITE_LINE],
    lineTurns: [2],
    chipShows: [
      { address: "test@voni.cc", tag: "Lime 42" },
      { address: "test@voni.cc", tag: "Lime 42" },
    ],
    showToolCalls: 1,
    chipTurn: 2,
    traceSession: "sess_browser26",
  });
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--out", out, "--email-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "email-invite")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /chip showed 2 times at call trace turn 2 \(sess_browser26\)/);
});

test("--email-json evidence must carry a Call trace session so a FAIL can cite a turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  const json = writeEmailJson(dir, "email.json", {
    agentLines: [EMAIL_INVITE_LINE],
    chipShows: [{ address: "test@voni.cc", tag: "Lime 42" }],
    showToolCalls: 1,
  });
  const out = join(dir, "score.json");
  const result = run(
    ["--dry-run", "--out", out, "--email-json", json],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out), "no artifact from invalid evidence");
  assert.match(result.stderr + result.stdout, /--email-json.*traceSession/);
});

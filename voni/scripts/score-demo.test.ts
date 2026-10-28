import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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

function run(args: string[], cwd: string) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
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
    "evalRunner",
  ]) {
    assert.ok(key in artifact, `artifact missing ${key}`);
  }
  assert.match(result.stdout, /reply-gap/);
  assert.match(result.stdout, /PASS|INFO/);
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

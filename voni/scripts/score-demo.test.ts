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
  assert.equal(result.status, 0, result.stderr + result.stdout);
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
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const artifact = JSON.parse(readFileSync(out, "utf8")) as {
    gates: { name: string; status: string; detail: string }[];
  };
  const gate = artifact.gates.find((g) => g.name === "dead-air");
  assert.equal(gate?.status, "FAIL");
  assert.ok(gate?.detail.includes("caller"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
  assert.equal(result.status, 0, result.stderr + result.stdout);
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
  assert.equal(result.status, 0, result.stderr + result.stdout);
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

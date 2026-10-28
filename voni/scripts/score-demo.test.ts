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

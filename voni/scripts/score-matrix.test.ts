import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";
import { VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "../src/lib/agents/voices";

const SCRIPT = new URL("./score-matrix.mts", import.meta.url).pathname;

function run(args: string[], cwd: string) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
  });
}

test("dry-run matrix across two voices writes per-voice PASS rows and a table", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(
    ["--dry-run", "--gate-voice", "anna", "--voices", "anna,lola", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(out), "matrix artifact exists");
  const matrix = JSON.parse(readFileSync(out, "utf8")) as {
    schemaVersion: number;
    gateVoice: string;
    voices: string[];
    results: { voice: string; isGate: boolean; status: string }[];
    gains: { voice: string; isGate: boolean; gain: number; outputVolume: number; status: string }[];
    gates: { name: string; status: string }[];
  };
  assert.equal(matrix.schemaVersion, 4);
  assert.equal(matrix.gateVoice, "anna");
  assert.deepEqual(matrix.voices, ["anna", "lola"]);
  assert.ok(matrix.results.every((r) => r.status === "PASS"), JSON.stringify(matrix.results));
  assert.ok(matrix.results.find((r) => r.voice === "anna")?.isGate);
  assert.ok(!matrix.results.find((r) => r.voice === "lola")?.isGate);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "PASS");
  // Gain applied is reported per matrix voice, not only the gate voice.
  assert.deepEqual(matrix.gains.map((row) => row.voice), ["anna", "lola"]);
  assert.equal(matrix.gains[0]?.isGate, true);
  for (const row of matrix.gains) {
    assert.equal(row.outputVolume, VOICE_OUTPUT_VOLUME, `${row.voice} server level is the registry constant`);
    assert.equal(row.gain, voicePlaybackGain(row.voice), `${row.voice} client gain comes from the registry`);
    assert.equal(row.status, "PASS");
  }
  assert.match(result.stdout, /anna/);
  assert.match(result.stdout, /lola/);
  assert.match(result.stdout, /gain=0\.93/, "lola's applied gain is printed");
  assert.match(result.stdout, /2\/2 clean/);
});

test("dry-run matrix defaults to every registry voice", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(["--dry-run", "--out", out], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = JSON.parse(readFileSync(out, "utf8")) as { voices: string[] };
  assert.deepEqual([...matrix.voices].sort(), [...DEMO_VOICE_IDS].sort());
});

test("unknown matrix voice fails fast with no artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(["--dry-run", "--voices", "anna,nope", "--out", out], new URL("../", import.meta.url).pathname);
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /unknown gate voice/);
});

function scoreArtifact(voice: string, probes: Record<string, number>, redacted: string[]) {
  return { voice, probes, transcripts: { redacted } };
}

test("--from re-analyzes saved runs: FAIL rows recorded, --strict fails the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "anna.json"),
    JSON.stringify(scoreArtifact("anna", { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, ["send it with Lime 42 in the subject"])),
  );
  writeFileSync(
    join(from, "lola.json"),
    JSON.stringify(scoreArtifact("lola", { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 }, ["send it with Lime 42 in the subject"])),
  );
  writeFileSync(
    join(from, "estelle.json"),
    JSON.stringify(scoreArtifact("estelle", { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, ["your tag is Coral 17"])),
  );

  const laxOut = join(dir, "lax.json");
  const lax = run(
    ["--from", from, "--gate-voice", "anna", "--voices", "anna,lola,estelle", "--out", laxOut],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(lax.status, 0, lax.stderr + lax.stdout);
  const laxMatrix = JSON.parse(readFileSync(laxOut, "utf8")) as {
    results: { voice: string; status: string; detail: string }[];
    gains: { voice: string; gain: number; status: string }[];
    gates: { name: string; status: string }[];
  };
  assert.equal(laxMatrix.results.find((r) => r.voice === "anna")?.status, "PASS");
  // Fixtures predate the artifact gain table: gain still comes from the registry.
  assert.deepEqual(laxMatrix.gains.map((row) => row.voice), ["anna", "lola", "estelle"]);
  assert.equal(laxMatrix.gains.find((row) => row.voice === "estelle")?.gain, voicePlaybackGain("estelle"));
  assert.ok(laxMatrix.gains.every((row) => row.status === "PASS"));
  const lola = laxMatrix.results.find((r) => r.voice === "lola");
  assert.equal(lola?.status, "FAIL");
  assert.ok(lola?.detail.includes("clip"));
  const estelle = laxMatrix.results.find((r) => r.voice === "estelle");
  assert.equal(estelle?.status, "FAIL");
  assert.ok(estelle?.detail.includes("coral 17"));
  assert.equal(laxMatrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.match(lax.stdout, /1\/3 clean/);

  const strictOut = join(dir, "strict.json");
  const strict = run(
    ["--from", from, "--gate-voice", "anna", "--voices", "anna,lola,estelle", "--out", strictOut, "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(strict.status, 0);
  assert.ok(existsSync(strictOut), "strict still writes the artifact before failing");
});

test("--from with a missing voice file fails fast", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  writeFileSync(
    join(from, "anna.json"),
    JSON.stringify(scoreArtifact("anna", { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, ["Lime 42 here"])),
  );
  const out = join(dir, "matrix.json");
  const result = run(
    ["--from", from, "--gate-voice", "anna", "--voices", "anna,lola", "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(out));
  assert.match(result.stderr + result.stdout, /lola/);
  assert.ok(!readdirSync(from).includes("lola.json"));
});

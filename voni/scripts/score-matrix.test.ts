import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";

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
    gates: { name: string; status: string }[];
  };
  assert.equal(matrix.schemaVersion, 4);
  assert.equal(matrix.gateVoice, "anna");
  assert.deepEqual(matrix.voices, ["anna", "lola"]);
  assert.ok(matrix.results.every((r) => r.status === "PASS"), JSON.stringify(matrix.results));
  assert.ok(matrix.results.find((r) => r.voice === "anna")?.isGate);
  assert.ok(!matrix.results.find((r) => r.voice === "lola")?.isGate);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "PASS");
  // No client gain row: the browser never alters level (voice-parity ticket 36).
  assert.equal("gains" in matrix, false, "the matrix carries no gain rows");
  assert.match(result.stdout, /anna/);
  assert.match(result.stdout, /lola/);
  assert.doesNotMatch(result.stdout, /gain=/, "no applied gain is printed");
  assert.match(result.stdout, /2\/2 clean/);
});

test("dry-run matrix shows the gate verdict and sub-scores beside regression rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const out = join(dir, "matrix.json");
  const result = run(
    ["--dry-run", "--gate-voice", DEMO_VOICE_IDS[0], "--voices", `${DEMO_VOICE_IDS[0]},${DEMO_VOICE_IDS[1]}`, "--out", out],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const matrix = JSON.parse(readFileSync(out, "utf8")) as {
    gate: {
      voice: string;
      status: string;
      gates: { name: string; status: string }[];
      subScores: { name: string; status: string }[];
    };
    gates: { name: string; status: string }[];
  };
  assert.equal(matrix.gate.voice, DEMO_VOICE_IDS[0], "the gate verdict belongs to the locked gate voice");
  assert.equal(matrix.gate.status, "PASS", "dry-run gate artifact has no failing gate");
  assert.ok(matrix.gate.gates.some((g) => g.name === "plumbing"));
  assert.equal(matrix.gate.subScores.length, 5);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "PASS");
  assert.match(result.stdout, /GATE\s+\S+\s+gate \S+: PASS/);
  assert.match(result.stdout, /sub-scores responsiveness/);
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
    gates: { name: string; status: string }[];
  };
  assert.equal(laxMatrix.results.find((r) => r.voice === "anna")?.status, "PASS");
  // Fixtures predate the artifact gain table; there is no gain row to carry over.
  assert.equal("gains" in laxMatrix, false, "the matrix carries no gain rows");
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

test("--from carries the gate verdict beside regression rows and never rewrites the gate artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const from = join(dir, "runs");
  mkdirSync(from, { recursive: true });
  const gateArtifact = {
    ...scoreArtifact(
      "anna",
      { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
      ["send it with Lime 42 in the subject"],
    ),
    gates: [
      { name: "plumbing", status: "PASS", detail: "eval runner finished" },
      { name: "reply-gap", status: "PASS", detail: "p50 900ms (budget 1500ms)" },
      { name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" },
    ],
    subScores: [
      {
        name: "responsiveness",
        label: "Responsiveness p50/p95",
        status: "PASS",
        detail: "reply-gap: p50 900ms",
        gates: ["reply-gap", "end-of-turn"],
      },
      {
        name: "barge-in",
        label: "Barge-in cut",
        status: "FAIL",
        detail: "barge-in-cut: cut 1841ms exceeds 1500ms",
        gates: ["barge-in-cut", "filler-resume"],
      },
    ],
  };
  const gatePath = join(from, "anna.json");
  writeFileSync(gatePath, JSON.stringify(gateArtifact));
  const gateBytes = readFileSync(gatePath, "utf8");
  writeFileSync(
    join(from, "lola.json"),
    JSON.stringify(scoreArtifact("lola", { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, ["Lime 42 in the subject"])),
  );
  writeFileSync(
    join(from, "estelle.json"),
    JSON.stringify(scoreArtifact("estelle", { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 }, ["Lime 42 in the subject"])),
  );

  const cleanOut = join(dir, "clean.json");
  const clean = run(
    ["--from", from, "--gate-voice", "anna", "--voices", "anna,lola", "--out", cleanOut],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  const dirtyOut = join(dir, "dirty.json");
  const dirty = run(
    ["--from", from, "--gate-voice", "anna", "--voices", "anna,lola,estelle", "--out", dirtyOut, "--strict"],
    new URL("../", import.meta.url).pathname,
  );
  assert.notEqual(dirty.status, 0, "--strict still reports the dirty regression voice");

  type Matrix = {
    gate: { voice: string; status: string; failing: string[]; detail: string; gates: unknown[]; subScores: unknown[] };
    gates: { name: string; status: string }[];
  };
  const cleanMatrix = JSON.parse(readFileSync(cleanOut, "utf8")) as Matrix;
  const dirtyMatrix = JSON.parse(readFileSync(dirtyOut, "utf8")) as Matrix;

  // The gate verdict is the gate artifact's own, carried verbatim.
  assert.equal(cleanMatrix.gate.voice, "anna");
  assert.equal(cleanMatrix.gate.status, "FAIL");
  assert.deepEqual(cleanMatrix.gate.failing, ["barge-in-cut"]);
  assert.deepEqual(cleanMatrix.gate.gates, gateArtifact.gates);
  assert.deepEqual(cleanMatrix.gate.subScores, gateArtifact.subScores);
  assert.match(clean.stdout, /GATE\s+anna\s+gate anna: FAIL/);
  assert.match(clean.stdout, /sub-scores responsiveness PASS, barge-in FAIL/);

  // A clean regression set never greens the required gate, and a dirty one
  // never changes it: only the namespaced regression rows move.
  assert.equal(cleanMatrix.gates.find((g) => g.name === "matrix")?.status, "PASS");
  assert.equal(dirtyMatrix.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.deepEqual(dirtyMatrix.gate, cleanMatrix.gate);
  assert.ok(!dirtyMatrix.gates.some((g) => g.name === "barge-in-cut"), "gate rows stay out of the matrix gates");
  assert.equal(readFileSync(gatePath, "utf8"), gateBytes, "the matrix never rewrites the gate artifact");
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

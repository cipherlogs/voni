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
  assert.equal(steering.status, 0, "gate FAIL still writes the artifact (exit 0)");
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
  assert.equal(filler.status, 0);
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

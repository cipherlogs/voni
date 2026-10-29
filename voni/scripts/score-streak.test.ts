import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";
import {
  BEHAVIOR_RUN_EVIDENCE_KIND,
  BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
  STREAK_INFORMATIONAL_GATES,
  STREAK_REQUIRED_GATES,
  type ScoreboardGate,
} from "../src/lib/demo/scoreboard";

const SCRIPT = new URL("./score-streak.mts", import.meta.url).pathname;
const GATE_VOICE = DEMO_VOICE_IDS[0];
const FP = { head: "a".repeat(40), dirty: false, dirtyHash: "d".repeat(64) };

function run(args: string[], cwd: string) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
  });
}

function gates(overrides: Record<string, ScoreboardGate> = {}): ScoreboardGate[] {
  const required = STREAK_REQUIRED_GATES.map((name) => ({ name, status: "PASS" as const, detail: `${name} measured` }));
  const provenance = [
    {
      name: "measurements",
      status: "INFO" as const,
      reason: "measured-evidence" as const,
      detail: "measured evidence present (gaps, real-cut)",
    },
  ];
  const informational = STREAK_INFORMATIONAL_GATES.map((name) => ({
    name,
    status: "INFO" as const,
    detail: `${name} review-only`,
  }));
  const all: ScoreboardGate[] = [...required, ...provenance, ...informational];
  return all.filter((gate) => overrides[gate.name] === undefined).concat(Object.values(overrides));
}

function artifact(index: number, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    recordedAt: new Date(Date.UTC(2026, 9, 29, 12, index)).toISOString(),
    voice: GATE_VOICE,
    runId: `run-${index}`,
    gates: gates(),
    subScores: [],
    codeFingerprint: FP,
    ...overrides,
  };
}

function writeArtifact(dir: string, index: number, overrides: Record<string, unknown> = {}) {
  const path = join(dir, `score-20261029-12000${index}-${GATE_VOICE}.json`);
  writeFileSync(path, `${JSON.stringify(artifact(index, overrides), null, 2)}\n`);
  return path;
}

function greenBehavior(overrides: Record<string, unknown> = {}) {
  return {
    kind: BEHAVIOR_RUN_EVIDENCE_KIND,
    schemaVersion: BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
    mode: "behavior",
    passed: true,
    exitCode: 0,
    recordedAt: "2026-10-29T12:05:00.000Z",
    command: "npm run test:e2e:behavior",
    codeFingerprint: FP,
    ...overrides,
  };
}

function writeGreenBehavior(dir: string, overrides: Record<string, unknown> = {}) {
  const path = join(dir, "behavior.json");
  writeFileSync(path, `${JSON.stringify(greenBehavior(overrides), null, 2)}\n`);
  return path;
}

test("three all-required-PASS artifacts plus a green behavior run pass the streak", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  for (const index of [1, 2, 3]) writeArtifact(dir, index);
  const behavior = writeGreenBehavior(dir);
  const result = run(["--dir", dir, "--behavior", behavior], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /streak: PASS/);
  assert.match(result.stdout, /behavior .*PASS/);
  assert.match(result.stdout, /run-3/);
});

test("a required gate that is INFO or FAIL fails the streak and names the run and gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  writeArtifact(dir, 1);
  writeArtifact(dir, 2, {
    gates: gates({ "reply-gap": { name: "reply-gap", status: "INFO", detail: "unmeasured" } }),
  });
  writeArtifact(dir, 3);
  const behavior = writeGreenBehavior(dir);
  const result = run(["--dir", dir, "--behavior", behavior], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /streak: FAIL/);
  assert.match(result.stdout, /run-2/);
  assert.match(result.stdout, /reply-gap/);
});

test("a differing code fingerprint fails the streak and names the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  writeArtifact(dir, 1);
  writeArtifact(dir, 2);
  writeArtifact(dir, 3, {
    codeFingerprint: { head: "b".repeat(40), dirty: true, dirtyHash: "e".repeat(64) },
  });
  const behavior = writeGreenBehavior(dir);
  const result = run(["--dir", dir, "--behavior", behavior], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /run-3/);
  assert.match(result.stdout, /code fingerprint/);
});

test("a missing or red behavior run fails the streak claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  for (const index of [1, 2, 3]) writeArtifact(dir, index);
  const missing = run(["--dir", dir], new URL("../", import.meta.url).pathname);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /behavior/);
  assert.match(missing.stdout, /npm run test:e2e:behavior/);

  const red = run(
    ["--dir", dir, "--behavior", writeGreenBehavior(dir, { passed: false, exitCode: 1 })],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(red.status, 1);
  assert.match(red.stdout, /candidate behavior run is red/);
});

test("the last three artifacts are judged; an older failed run is not part of the streak", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  writeArtifact(dir, 1, {
    gates: gates({ "dead-air": { name: "dead-air", status: "FAIL", detail: "older 3200ms" } }),
  });
  for (const index of [2, 3, 4]) writeArtifact(dir, index);
  const behavior = writeGreenBehavior(dir);
  const result = run(["--dir", dir, "--behavior", behavior], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /older 3200ms/);
});

test("manual review rows can fail or disappear without blocking the streak", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  for (const index of [1, 2, 3]) {
    writeArtifact(dir, index, {
      gates: gates({
        "accent-human": { name: "accent-human", status: "FAIL", detail: "one ballot" },
        "phone-checklist": { name: "phone-checklist", status: "FAIL", detail: "not run" },
      }).filter((gate) => gate.name !== "talk-hold-pinned"),
    });
  }
  const behavior = writeGreenBehavior(dir);
  const result = run(["--dir", dir, "--behavior", behavior], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /streak: PASS/);
});

test("a typed exit result is refused: only the behavior evidence file can carry a green", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  for (const index of [1, 2, 3]) writeArtifact(dir, index);
  const fingerprint = `${FP.head}:${FP.dirtyHash}:clean`;
  const typed = run(
    ["--dir", dir, "--behavior-exit", "0", "--behavior-fingerprint", fingerprint],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(typed.status, 1, "a human cannot type a green streak");
  assert.match(typed.stderr + typed.stdout, /--behavior-exit is not evidence/);
  assert.match(typed.stderr + typed.stdout, /--evidence/);
});

test("behavior evidence must be the runner's own kind with a code fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  for (const index of [1, 2, 3]) writeArtifact(dir, index);
  const wrongKind = join(dir, "wrong-kind.json");
  writeFileSync(wrongKind, JSON.stringify({ ...greenBehavior(), kind: "something-else" }));
  const wrong = run(["--dir", dir, "--behavior", wrongKind], new URL("../", import.meta.url).pathname);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr + wrong.stdout, /not a behavior-run evidence file/);

  const noFingerprint = join(dir, "no-fingerprint.json");
  writeFileSync(noFingerprint, JSON.stringify({ ...greenBehavior(), codeFingerprint: null }));
  const unbound = run(["--dir", dir, "--behavior", noFingerprint], new URL("../", import.meta.url).pathname);
  assert.equal(unbound.status, 1);
  assert.match(unbound.stdout, /no code fingerprint/);
});

test("an unreadable artifact in the evaluated window fails the streak by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  // The newest run crashed and wrote a truncated artifact. It must break the
  // three-consecutive claim instead of being skipped as "not an artifact".
  for (const index of [1, 2, 3]) writeArtifact(dir, index);
  const broken = join(dir, "score-20261029-120004-gate.json");
  writeFileSync(broken, '{"schemaVersion": 4, "voice": "');
  const crashedAt = new Date(Date.UTC(2026, 9, 29, 12, 4));
  utimesSync(broken, crashedAt, crashedAt);
  const behavior = writeGreenBehavior(dir);
  const result = run(["--dir", dir, "--behavior", behavior], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /streak: FAIL/);
  assert.match(result.stdout, /is unreadable/);
  assert.match(result.stdout, /score-20261029-120004-gate\.json/);
});

test("an unreadable artifact older than the window does not break the streak", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  const broken = join(dir, "score-20261029-110000-gate.json");
  writeFileSync(broken, "{not json");
  // mtime order matters for an unreadable run; keep it older than the greens.
  const past = new Date(Date.now() - 60_000);
  utimesSync(broken, past, past);
  for (const index of [1, 2, 3]) writeArtifact(dir, index);
  const behavior = writeGreenBehavior(dir);
  const result = run(["--dir", dir, "--behavior", behavior], new URL("../", import.meta.url).pathname);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /streak: PASS/);
});


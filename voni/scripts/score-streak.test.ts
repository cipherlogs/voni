import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";
import {
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
    { name: "measurements", status: "INFO" as const, detail: "measured evidence present (gaps, real-cut)" },
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
    kind: "voni-behavior-run",
    schemaVersion: 1,
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

test("an exit result is accepted when it is explicitly bound to the streak code", () => {
  const dir = mkdtempSync(join(tmpdir(), "streak-"));
  for (const index of [1, 2, 3]) writeArtifact(dir, index);
  const fingerprint = `${FP.head}:${FP.dirtyHash}:clean`;
  const green = run(
    ["--dir", dir, "--behavior-exit", "0", "--behavior-fingerprint", fingerprint],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(green.status, 0, green.stderr + green.stdout);
  assert.match(green.stdout, /streak: PASS/);

  const red = run(
    ["--dir", dir, "--behavior-exit", "1", "--behavior-fingerprint", fingerprint],
    new URL("../", import.meta.url).pathname,
  );
  assert.equal(red.status, 1);
  assert.match(red.stdout, /candidate behavior run is red/);

  const unbound = run(["--dir", dir, "--behavior-exit", "0"], new URL("../", import.meta.url).pathname);
  assert.equal(unbound.status, 1, "an exit result without its code is not evidence");
  assert.match(unbound.stderr + unbound.stdout, /--behavior-fingerprint/);
});

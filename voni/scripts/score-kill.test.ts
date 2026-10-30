/**
 * The kill-criterion gate (ticket 119) is only a gate if its caller runs.
 * These tests spawn `score-kill.mts` against fixture artifacts; no live vendor,
 * no browser, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildSkeletonArtifact,
  CASCADE_NO_COMMIT_MARK_ABSENCE,
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  DEFAULT_GATE_VOICE,
  STREAK_REQUIRED_GATES,
  type CodeFingerprint,
  type ScoreboardArtifact,
  type ScoreboardGate,
} from "../src/lib/demo/scoreboard";
import { resolveCascadeSubject, type SubjectRecord } from "../src/lib/demo/subject";

const SCRIPT = new URL("./score-kill.mts", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;

const CLEAN_CODE: CodeFingerprint = {
  head: "a".repeat(40),
  dirty: false,
  dirtyHash: "0".repeat(64),
};

const ANNA = resolveCascadeSubject({ voice: DEFAULT_GATE_VOICE });
const LOLA = resolveCascadeSubject({ voice: "lola" });

const PASS_GATES: ScoreboardGate[] = STREAK_REQUIRED_GATES.map((name) => ({
  name,
  status: "PASS",
  detail: "measured",
}));

function capture(name: string) {
  return { path: `artifacts/${name}.wav`, sha256: "a".repeat(64) };
}

/** One cascade run with every required gate PASS unless `failGate` names one. */
function cascadeRun(
  subject: SubjectRecord,
  gapMs: number,
  options: { runId: string; recordedAt: string; failGate?: string },
): ScoreboardArtifact {
  const voice = subject.agent.kind === "demo" ? subject.agent.voice : subject.agent.agentId;
  const artifact = buildSkeletonArtifact({
    voice,
    subject,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    runId: options.runId,
    codeFingerprint: CLEAN_CODE,
    engine: {
      pipeline: "cascade",
      run: {
        runId: options.runId,
        variant: "cascade",
        startedAt: "2026-10-29T10:00:00.000Z",
        finishedAt: "2026-10-29T10:00:03.000Z",
      },
      captures: {
        reference: capture("reference"),
        platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
        delivered: capture("delivered"),
      },
      eligibility: { eligible: true },
    },
  });
  return {
    ...artifact,
    recordedAt: options.recordedAt,
    gates: PASS_GATES.map((gate) =>
      gate.name === options.failGate ? { ...gate, status: "FAIL" as const } : gate,
    ),
    latency: {
      ...artifact.latency,
      replyGapP50Ms: gapMs,
      // Cascade has no commit mark (ticket 117): the reader refuses a silent
      // absence, so the fixture records the named N/A like a real artifact.
      commitToFirstPlayoutMs: { absent: CASCADE_NO_COMMIT_MARK_ABSENCE },
    },
  };
}

function run(args: string[]) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
  });
}

function writeRound(
  root: string,
  label: string,
  gaps: { anna: [number, number]; lola: [number, number] },
  options: { failGate?: string; roundIndex?: number } = {},
): void {
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  const roundIndex = options.roundIndex ?? 0;
  const runs: Array<[SubjectRecord, string, number, number]> = [
    [ANNA, "anna-1", gaps.anna[0], 0],
    [LOLA, "lola-1", gaps.lola[0], 1],
    [ANNA, "anna-2", gaps.anna[1], 2],
    [LOLA, "lola-2", gaps.lola[1], 3],
  ];
  for (const [subject, name, gapMs, slot] of runs) {
    const artifact = cascadeRun(subject, gapMs, {
      runId: `${label}-${name}`,
      // Measured order, not filename order: the runs land seconds apart.
      recordedAt: `2026-10-29T10:00:${String(roundIndex * 10 + slot).padStart(2, "0")}.000Z`,
      ...(options.failGate && slot === 1 ? { failGate: options.failGate } : {}),
    });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(artifact));
  }
}

function writeAcceptance(path: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    path,
    JSON.stringify({
      kind: "risk-acceptance",
      owner: "demo-owner",
      acceptedOn: "2026-10-30",
      decisionRecord: "docs/adr/0012-cascade-cutover-risk.md",
      evidence: ["round-1", "round-2", "round-3"],
      ...overrides,
    }),
  );
}

const FAILING = { anna: [1800, 1800] as [number, number], lola: [1800, 1800] as [number, number] };
const PASSING = { anna: [900, 950] as [number, number], lola: [1000, 1050] as [number, number] };

test("three measured rounds failing the reply gap print KILLED and exit non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const rounds = join(dir, "rounds");
  writeRound(rounds, "round-1", FAILING, { roundIndex: 0 });
  writeRound(rounds, "round-2", FAILING, { roundIndex: 1 });
  writeRound(rounds, "round-3", FAILING, { roundIndex: 2 });

  const result = run(["--from", rounds]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /3 measured, 0 re-run/);
  assert.match(result.stdout, /round-1\s+measured\s+reply-gap FAIL/);
  assert.match(result.stdout, /round-3\s+measured\s+reply-gap FAIL/);
  assert.match(result.stdout, /^KILLED\s/m);
  assert.match(result.stdout, /routing stays off/);
});

test("three measured rounds inside the reply gap print OK and exit zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const rounds = join(dir, "rounds");
  writeRound(rounds, "round-1", PASSING, { roundIndex: 0 });
  writeRound(rounds, "round-2", PASSING, { roundIndex: 1 });
  writeRound(rounds, "round-3", PASSING, { roundIndex: 2 });

  const result = run(["--from", rounds]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^OK\s/m);
  assert.match(result.stdout, /automatic cutover may proceed/);
  assert.match(result.stdout, /3 measured/);
});

test("a passing reply gap with another required gate FAIL prints BLOCKED, not KILLED", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const rounds = join(dir, "rounds");
  writeRound(rounds, "round-1", PASSING, { roundIndex: 0 });
  writeRound(rounds, "round-2", PASSING, { roundIndex: 1, failGate: "barge-in-cut" });
  writeRound(rounds, "round-3", PASSING, { roundIndex: 2 });

  const result = run(["--from", rounds]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^BLOCKED\s/m);
  assert.match(result.stdout, /barge-in-cut/);
  assert.doesNotMatch(result.stdout, /^KILLED\s/m);
  assert.match(result.stdout, /kill criterion did not fire/);
});

test("a dated risk acceptance is reported and still does not pass the gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const rounds = join(dir, "rounds");
  writeRound(rounds, "round-1", FAILING, { roundIndex: 0 });
  writeRound(rounds, "round-2", FAILING, { roundIndex: 1 });
  writeRound(rounds, "round-3", FAILING, { roundIndex: 2 });
  const acceptance = join(dir, "acceptance.json");
  writeAcceptance(acceptance);

  const result = run(["--from", rounds, "--acceptance", acceptance]);
  assert.notEqual(result.status, 0, "a risk acceptance is a decision record, never a pass");
  assert.match(result.stdout, /^RISK-ACCEPTED\s/m);
  assert.match(result.stdout, /not a pass/);
  assert.match(result.stdout, /acceptance: demo-owner on 2026-10-30/);
  assert.doesNotMatch(result.stdout, /^OK\s/m);
});

test("an undated or unevidenced acceptance is refused by field", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const rounds = join(dir, "rounds");
  writeRound(rounds, "round-1", PASSING);
  const acceptance = join(dir, "acceptance.json");
  writeAcceptance(acceptance, { acceptedOn: "soon" });

  const result = run(["--from", rounds, "--acceptance", acceptance]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /risk acceptance is invalid/);
  assert.match(result.stderr, /acceptedOn/);
});

test("a flat directory is one round and cannot clear the three-round bar", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const one = join(dir, "one-round");
  // A flat directory of runs: writeRound puts the four artifacts straight in.
  writeRound(dir, "one-round", PASSING);

  const result = run(["--from", one]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^INCOMPLETE\s/m);
  assert.match(result.stdout, /1 measured/);
  assert.match(result.stdout, /one-round\s+measured/);
});

test("a directory with no artifacts fails by name instead of judging nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const result = run(["--from", join(dir, "missing")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a directory/);

  const empty = join(dir, "empty");
  mkdirSync(empty);
  const emptyResult = run(["--from", empty]);
  assert.notEqual(emptyResult.status, 0);
  assert.match(emptyResult.stderr, /no round artifacts/);
});

test("a malformed artifact is named by its path and round", () => {
  const dir = mkdtempSync(join(tmpdir(), "kill-"));
  const rounds = join(dir, "rounds");
  writeRound(rounds, "round-1", PASSING);
  writeFileSync(join(rounds, "round-1", "broken.json"), JSON.stringify({ not: "an artifact" }));

  const result = run(["--from", rounds]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /kill criterion cannot read round-1\/broken\.json/);
});

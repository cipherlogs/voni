import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("./score-demo.mts", import.meta.url).pathname;

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
  const result = run(["--dry-run", "--voice", "anna", "--out", out], new URL("../", import.meta.url).pathname);
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

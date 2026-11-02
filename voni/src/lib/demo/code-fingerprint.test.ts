/**
 * The code fingerprint must name the bytes a run measured. Porcelain status
 * collapses an untracked directory to `?? dir/`, so two different trees could
 * share a `dirtyHash`; the untracked file contents close that hole. A clean
 * tree keeps the exact hash earlier fingerprints recorded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codeFingerprintFromGit, readCodeFingerprint } from "./scoreboard";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("a clean tree keeps the fingerprint earlier runs recorded", () => {
  const clean = codeFingerprintFromGit({ head: "abc123", status: "", diff: "" });
  assert.equal(clean?.dirty, false);
  assert.equal(clean?.dirtyHash, sha("\n"), "the clean hash is unchanged");
  assert.equal(
    codeFingerprintFromGit({ head: "abc123", status: "", diff: "", untracked: "" })
      ?.dirtyHash,
    sha("\n"),
    "an empty untracked set adds nothing",
  );
});

test("untracked file contents move the dirty hash", () => {
  const shared = { head: "abc123", status: "?? caller/\n", diff: "" };
  const one = codeFingerprintFromGit({
    ...shared,
    untracked: `caller/a.ts\0${sha("one")}\n`,
  });
  const two = codeFingerprintFromGit({
    ...shared,
    untracked: `caller/a.ts\0${sha("two")}\n`,
  });
  assert.equal(one?.dirty, true);
  assert.equal(two?.dirty, true);
  assert.notEqual(one?.dirtyHash, two?.dirtyHash);
  assert.notEqual(one?.dirtyHash, codeFingerprintFromGit(shared)?.dirtyHash);
});

test("readCodeFingerprint sees a tracked edit and an untracked edit", () => {
  const repo = mkdtempSync(join(tmpdir(), "dv-code-fingerprint-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(repo, "tracked.txt"), "committed\n", "utf8");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "init");

    const clean = readCodeFingerprint(repo);
    assert.ok(clean);
    assert.equal(clean.dirty, false);
    assert.equal(clean.dirtyHash, sha("\n"), "a clean repo keeps the old hash");

    writeFileSync(join(repo, "tracked.txt"), "edited\n", "utf8");
    const tracked = readCodeFingerprint(repo);
    assert.ok(tracked);
    assert.equal(tracked.dirty, true);
    assert.notEqual(tracked.dirtyHash, clean.dirtyHash, "a tracked edit moves the hash");
    git("checkout", "--", "tracked.txt");

    mkdirSync(join(repo, "caller"), { recursive: true });
    const untracked = join(repo, "caller", "a.ts");
    writeFileSync(untracked, "export const one = 1;\n", "utf8");
    const first = readCodeFingerprint(repo);
    assert.ok(first);
    assert.equal(first.dirty, true);

    writeFileSync(untracked, "export const one = 2;\n", "utf8");
    const second = readCodeFingerprint(repo);
    assert.ok(second);
    assert.notEqual(
      second.dirtyHash,
      first.dirtyHash,
      "content inside an already-untracked directory moves the hash",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

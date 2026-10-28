import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireTimingLock, TimingLockHeldError } from "./timing-lock";

function fakeLock(dir: string, pid: number, scenario = "stop-over"): string {
  const path = join(dir, "timing.lock");
  writeFileSync(path, JSON.stringify({ pid, at: new Date().toISOString(), scenario }));
  return path;
}

test("a timing run takes the lock for itself and releases it", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-lock-"));
  const path = join(dir, "timing.lock");
  const lock = acquireTimingLock({ path, scenario: "stop-over" });
  const held = JSON.parse(readFileSync(path, "utf8")) as { pid: number; scenario: string };
  assert.equal(held.pid, process.pid);
  assert.equal(held.scenario, "stop-over");
  lock.release();
  assert.equal(existsSync(path), false);
  const again = acquireTimingLock({ path });
  assert.equal(again.pid, process.pid);
  again.release();
});

test("a second timing run refuses with a clear error while another holds the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-lock-"));
  const path = fakeLock(dir, process.pid);
  assert.throws(
    () => acquireTimingLock({ path, isAlive: () => true }),
    (error: unknown) => {
      assert.ok(error instanceof TimingLockHeldError);
      assert.match(error.message, /another timing run holds the lock/);
      assert.match(error.message, new RegExp(String(process.pid)));
      assert.match(error.message, /stop-over/);
      return true;
    },
  );
  assert.ok(existsSync(path), "a held lock is never deleted");
});

test("a lock left by a dead run is reclaimed instead of blocking forever", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-lock-"));
  const path = fakeLock(dir, 999_999, "greeting-cut");
  const lock = acquireTimingLock({ path, isAlive: () => false });
  const held = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
  assert.equal(held.pid, process.pid);
  lock.release();
});

test("releasing is idempotent and never deletes another run's lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-lock-"));
  const path = join(dir, "timing.lock");
  const lock = acquireTimingLock({ path });
  // Simulate the lock being reclaimed by another process after ours was held.
  writeFileSync(path, JSON.stringify({ pid: process.pid + 1, at: new Date().toISOString(), scenario: "other" }));
  lock.release();
  lock.release();
  assert.ok(existsSync(path), "the other owner's lock survives our release");
});

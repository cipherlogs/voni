/**
 * The dev sink that writes a delivered capture to disk. The WAV itself is
 * built and tested in delivered-capture.test.ts; this covers the path rules
 * and the gitignored working location.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureFilePath, writeDeliveredCapture } from "./delivered-capture-store";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("delivered capture store: writes the WAV under .captures/ in the working root", async () => {
  const root = mkdtempSync(join(tmpdir(), "delivered-capture-"));
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const path = await writeDeliveredCapture("delivered-20261029-140506.wav", bytes, root);
  assert.equal(path, join(root, ".captures", "delivered-20261029-140506.wav"));
  assert.deepEqual(Array.from(readFileSync(path)), [1, 2, 3, 4]);
});

test("delivered capture store: refuses a name that could escape the capture dir", () => {
  for (const name of ["../evil.wav", "sub/evil.wav", "/etc/evil.wav", "evil.txt", ""]) {
    assert.throws(() => captureFilePath(name, "/tmp/root"), /capture name/i, name);
  }
});

test("delivered capture dir is gitignored, never committed evidence", () => {
  const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^voni\/\.captures\/$/m);
});

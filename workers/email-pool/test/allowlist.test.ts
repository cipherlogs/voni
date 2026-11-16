import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowlistFromTargetsFile,
  hostsFromTargets,
  TARGETS_FILE,
} from "../scripts/allowlist.mjs";

test("hostsFromTargets keeps first-appearance order and de-duplicates", () => {
  assert.deepEqual(
    hostsFromTargets([
      "https://voni.cc/test",
      "https://cipherlogs.github.io/print/",
      "https://voni.cc/other",
      "https://VONI.cc/third",
      "https://www.voni.cc/",
    ]),
    ["voni.cc", "cipherlogs.github.io", "www.voni.cc"],
  );
});

test("hostsFromTargets strips the default https port but keeps others", () => {
  assert.deepEqual(
    hostsFromTargets([
      "https://voni.cc:443/test",
      "https://Pool.Example:8443/click",
      "https://cipherlogs.github.io/print/",
    ]),
    ["voni.cc", "pool.example:8443", "cipherlogs.github.io"],
  );
});

test("hostsFromTargets rejects non-https entries and names them", () => {
  for (const entry of ["http://voni.cc/test", "ftp://voni.cc/test"]) {
    assert.throws(
      () => hostsFromTargets([entry]),
      (error: Error) =>
        error.message.includes(entry) && /https/i.test(error.message),
    );
  }
});

test("hostsFromTargets rejects path-only entries and names them", () => {
  assert.throws(
    () => hostsFromTargets(["/print/"]),
    (error: Error) =>
      error.message.includes("/print/") &&
      /absolute https URL/i.test(error.message),
  );
});

test("hostsFromTargets rejects non-string entries and names them", () => {
  assert.throws(
    () => hostsFromTargets([42]),
    (error: Error) => /42/.test(error.message) && /https/i.test(error.message),
  );
});

test("hostsFromTargets rejects a non-array payload", () => {
  assert.throws(
    () => hostsFromTargets("https://voni.cc/test" as unknown as string[]),
    /array/i,
  );
});

test("allowlistFromTargetsFile derives the allowlist from the real voni file", () => {
  // The targets file is data: adding a target is a one-file edit (see
  // docs/agents/email-pool.md), so this test must not snapshot today's entries.
  // What it proves is that the default argument resolves the real voni file and
  // that every host in it reaches the allowlist.
  const entries = JSON.parse(readFileSync(TARGETS_FILE, "utf8")) as string[];
  const expected = hostsFromTargets(entries).join(",");

  assert.ok(expected.length > 0, "the real targets file must yield a host");
  assert.equal(allowlistFromTargetsFile(), expected);
  assert.match(TARGETS_FILE, /voni[\\/]src[\\/]lib[\\/]email[\\/]targets\.json$/);
});

test("allowlistFromTargetsFile reads an arbitrary targets file", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-pool-allowlist-"));
  const file = join(dir, "targets.json");
  try {
    writeFileSync(
      file,
      JSON.stringify(["https://www.voni.cc/a", "https://voni.cc:443/b"]),
    );
    assert.equal(allowlistFromTargetsFile(file), "www.voni.cc,voni.cc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowlistFromTargetsFile throws a message naming a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-pool-allowlist-"));
  const missing = join(dir, "absent-targets.json");
  try {
    assert.throws(
      () => allowlistFromTargetsFile(missing),
      (error: Error) =>
        error.message.includes(missing) &&
        /allowlist is derived/i.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowlistFromTargetsFile rejects a non-array targets file", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-pool-allowlist-"));
  const file = join(dir, "targets.json");
  try {
    writeFileSync(file, JSON.stringify({ targets: ["https://voni.cc"] }));
    assert.throws(
      () => allowlistFromTargetsFile(file),
      (error: Error) => /array/i.test(error.message) && error.message.includes(file),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

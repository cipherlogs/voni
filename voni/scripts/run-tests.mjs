#!/usr/bin/env node
/**
 * Run every unit test without maintaining a path list in package.json.
 *
 * `node --test` needs the files up front, so discover them here: every
 * `*.test.ts` / `*.test.tsx` under src/ and scripts/. Playwright specs live in
 * tests/e2e and are not unit tests.
 */
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "scripts"];
const skip = new Set(["node_modules", ".next", ".open-next", "dist", "build"]);

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      collect(path, out);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(relative(root, path));
    }
  }
}

const files = [];
for (const dir of roots) collect(join(root, dir), files);
files.sort();

if (files.length === 0) {
  console.error("run-tests: no *.test.ts(x) files found under src/ or scripts/");
  process.exit(1);
}

console.log(`run-tests: ${files.length} files`);
const verbose = process.env.RUN_TESTS_VERBOSE === "1";
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { cwd: root, encoding: "utf8" },
);
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
if (verbose || result.status !== 0) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} else {
  // On success print the summary only. A worker's teardown stack is noise that
  // reads like a crash; keep it available with RUN_TESTS_VERBOSE=1.
  const summary = stdout.trim().split("\n").filter(Boolean).slice(-8).join("\n");
  if (summary) console.log(summary);
  if (stderr.trim()) {
    console.error(`run-tests: ${stderr.trim().split("\n").length} stderr lines suppressed on success (RUN_TESTS_VERBOSE=1 to see them)`);
  }
}
process.exit(result.status ?? 1);

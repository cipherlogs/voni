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
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);

#!/usr/bin/env node
/**
 * Run a command and print stderr only when it fails.
 *
 * Some tooling (tsx workers) prints a native teardown stack on success. That
 * reads like a crash in a CI log. Keep stdout, keep failures loud, drop the
 * noise on success. Set RUN_QUIET_VERBOSE=1 to see everything.
 */
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("run-quiet: no command");
  process.exit(2);
}

const result = spawnSync(command, args, { encoding: "utf8" });
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";

if (result.status !== 0 || process.env.RUN_QUIET_VERBOSE === "1") {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} else {
  // Some workers print a native teardown stack on stdout even when the
  // command succeeded. Keep the real output, drop those lines.
  const lines = stdout.split("\n");
  const stack = lines.filter((line) => /^\s*\d+:\s+0x[0-9a-f]+\s+\[node\]$/i.test(line));
  process.stdout.write(lines.filter((line) => !stack.includes(line)).join("\n"));
  if (stack.length) {
    console.error(`run-quiet: ${stack.length} native stack lines suppressed on success (RUN_QUIET_VERBOSE=1 to see them)`);
  }
  if (stderr.trim()) {
    console.error(
      `run-quiet: ${stderr.trim().split("\n").length} stderr lines suppressed on success (RUN_QUIET_VERBOSE=1 to see them)`,
    );
  }
}

process.exit(result.status ?? 1);

/**
 * "Was this script run, or was it imported?"
 *
 * The Windows runs of `browser-check` clicked from a pool that had never filled:
 * `browser-click: pass 1 failed (the pool answered 503 not-ready)` on four of five
 * targets, while the ubuntu run of the same dispatch waited 4 s in the gate and
 * clicked from ten distinct exits. The gate was the difference, and the gate was
 * a no-op: its entry-point guard compared `import.meta.url` with
 * `\`file://${process.argv[1]}\``, and on a Windows runner those strings are
 * `file:///D:/a/voni/...` and `file://D:\a\voni\...`. They never match, so
 * `main()` never ran, so the step exited 0 without waiting, without a report, and
 * the click step started 320 ms after the client did.
 *
 * These tests pin the decision itself, in the Windows form, and pin the guard's
 * shape in every runner script, so a copy of the literal comparison fails here
 * before it fails on a runner.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { fileUrlOfPath, isEntryPoint } from "./entry-point.mjs";

const VONI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);

/** Every runner script that decides between "run" and "import". */
const ENTRY_SCRIPTS = [
  "scripts/browser-click.mjs",
  "scripts/browser-pool-gate.mjs",
  "scripts/tuxler-exit-leak.mjs",
  "scripts/tuxler-probe.mts",
];

test("a Windows runner's argv[1] is the module that is running", () => {
  // The exact pair the Windows runner produced: argv[1] straight from Node, and
  // the `import.meta.url` of the same file. The old literal guard compared
  // `file://D:\a\voni\voni\scripts\browser-pool-gate.mjs` with the second string
  // and was therefore never true.
  const argv1 = "D:\\a\\voni\\voni\\scripts\\browser-pool-gate.mjs";
  const moduleUrl = "file:///D:/a/voni/voni/scripts/browser-pool-gate.mjs";

  assert.equal(isEntryPoint(argv1, moduleUrl), true);
  assert.notEqual(`file://${argv1}`, moduleUrl, "the literal guard can never have matched");

  // Git Bash may hand Node either separator style; both name the same file.
  assert.equal(isEntryPoint("D:/a/voni/voni/scripts/browser-pool-gate.mjs", moduleUrl), true);
  assert.equal(isEntryPoint("C:\\a\\voni\\voni\\scripts\\browser-pool-gate.mjs", moduleUrl), false);
});

test("a POSIX path is the entry point only for its own file", () => {
  const url = pathToFileURL(THIS_FILE).href;
  assert.equal(isEntryPoint(THIS_FILE, url), true);
  assert.equal(fileUrlOfPath(THIS_FILE), url);
  assert.equal(isEntryPoint(join(VONI, "scripts", "browser-pool-gate.mjs"), url), false);
  assert.equal(isEntryPoint(undefined, url), false);
  assert.equal(isEntryPoint("", url), false);
});

test("a path with a space matches the URL Node encodes", () => {
  // The same guard, broken on Linux, in a checkout under "…/leadcalls copy/": the
  // literal form leaves the space raw and the file URL says `%20`.
  const argv1 = "/home/runner/leadcalls copy/voni/scripts/browser-pool-gate.mjs";
  const moduleUrl = "file:///home/runner/leadcalls%20copy/voni/scripts/browser-pool-gate.mjs";
  assert.equal(isEntryPoint(argv1, moduleUrl), true);
  assert.notEqual(`file://${argv1}`, moduleUrl);
});

test("an imported runner script does not start its main", async () => {
  // Nothing in this file invoked the gate; importing it must stay quiet, or the
  // suite would run a gate (and write a report) as a side effect.
  const gate = await import("./browser-pool-gate.mjs");
  assert.equal(typeof gate.evaluatePoolGate, "function");
});

test("every runner script decides with the shared guard, and none keeps the literal", () => {
  for (const relative of ENTRY_SCRIPTS) {
    const text = readFileSync(join(VONI, relative), "utf8");
    assert.match(
      text,
      /isEntryPoint\(process\.argv\[1\], import\.meta\.url\)/,
      `${relative} must decide with isEntryPoint, which is the only form true on Windows`,
    );
    assert.doesNotMatch(
      text,
      /file:\/\/\$\{/,
      `${relative} still builds a file URL by concatenation, which never matches on Windows`,
    );
  }
});

test("the gate in a directory with a space runs its own main", () => {
  // A behavioural proof of the guard rather than of the helper: the gate is
  // copied into a path the literal comparison cannot encode, and asked to run
  // while the flag is off. Its documented answer is exit 2 and a sentence; a
  // guard that never fires answers exit 0 and nothing at all — which is exactly
  // what the Windows runner did, and what the workflow read as "ready".
  const root = mkdtempSync(join(tmpdir(), "gate space-"));
  try {
    const scripts = join(root, "scripts");
    const timing = join(root, "src", "lib", "tuxler");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(timing, { recursive: true });
    for (const name of ["browser-pool-gate.mjs", "browser-exit-pool.mjs", "entry-point.mjs"]) {
      copyFileSync(join(VONI, "scripts", name), join(scripts, name));
    }
    copyFileSync(join(VONI, "src", "lib", "tuxler", "timing.ts"), join(timing, "timing.ts"));

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["TUXLER_ENABLED", "TUXLER_CONTROL_URL"]) delete env[name];
    env.TUXLER_ENABLED = "false";
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(scripts, "browser-pool-gate.mjs")],
      { cwd: VONI, env, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(
      result.status,
      2,
      `expected the gate to run; it printed ${JSON.stringify(result.stdout)}`,
    );
    assert.match(result.stderr, /TUXLER_ENABLED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
